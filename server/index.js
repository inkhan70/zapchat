require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const mongoose  = require('mongoose');

// ─── Environment ─────────────────────────────────────────────────────────────
const JWT_SECRET   = process.env.JWT_SECRET   || 'zapchat_super_secret_key_2024';
const PORT         = process.env.PORT         || 5000;
const MONGODB_URI  = process.env.MONGODB_URI;

// Google OAuth Environment Configurations
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://zapchat-5ru.pages.dev';
const GOOGLE_CALLBACK_URL = 'https://zapchat-production.up.railway.app/api/auth/google/callback';

// ✅ FIXED: Updated configuration names to fully match your Vercel panel settings
const METERED_APP_DOMAIN = process.env.METERED_DOMAIN || process.env.METERED_APP_DOMAIN || 'zapchat-server.metered.live';
const METERED_SECRET_KEY = process.env.METERED_SECRET_KEY;
const METERED_API_BASE   = `https://${METERED_APP_DOMAIN}/api/v1`;

// Explicit allowed-origin list. Whitelisted Cloudflare Pages URL
const ALLOWED_ORIGINS = [
  'https://zapchat-5ru.pages.dev', // Added Cloudflare production domain
  'https://zapchat-server.vercel.app',
  'https://zapchat-server-inkhan.vercel.app',
  'https://inkhan70-zapchat.vercel.app',
  'http://localhost:3000',
  'http://localhost:5000',
  'http://127.0.0.1:5000',
  'https://echochat-fvq5kwvs.b4a.run',
  'https://echochat-wf63zbz0.b4a.run',
  'https://echochat-pjabun7d.b4a.run',
  ...(process.env.BACKEND_URL ? [process.env.BACKEND_URL.replace(/\/$/, '')] : []),
];

if (process.env.VERCEL_FRONTEND_ORIGINS) {
  for (const o of process.env.VERCEL_FRONTEND_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)) {
    if (!ALLOWED_ORIGINS.includes(o)) ALLOWED_ORIGINS.push(o);
  }
}

const VERCEL_HOST_RE = /^https:\/\/([\w-]+-)?inkhan70-zapchat(-[\w-]+)?\.vercel\.app$/;

function corsOriginValidator(origin, callback) {
  if (!origin) return callback(null, true);
  if (ALLOWED_ORIGINS.includes(origin)) return callback(null, origin);
  if (VERCEL_HOST_RE.test(origin))       return callback(null, origin);
  callback(new Error(`CORS policy: origin '${origin}' is not allowed`));
}

// ─── Express App & HTTP Server ───────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ✅ CRITICAL FOR RAILWAY: Trust upstream reverse proxy layers for secure headers/cookies
app.set('trust proxy', 1);

// ─── MongoDB ─────────────────────────────────────────────────────────────────
let isMongoConnected = false;

if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI, {
    maxPoolSize:     10,
    minPoolSize:     2,
    socketTimeoutMS: 45000,
  })
  .then(() => { isMongoConnected = true; console.log('✅ MongoDB connected'); })
  .catch(err => console.error('❌ MongoDB error:', err.message));

  mongoose.connection.on('disconnected', () => {
    isMongoConnected = false;
    console.warn('⚠️ MongoDB disconnected — falling back to in-memory storage');
  });
  mongoose.connection.on('reconnected', () => {
    isMongoConnected = true;
    console.log('✅ MongoDB reconnected');
  });
} else {
  console.warn('⚠️ No MONGODB_URI set — running in IN-MEMORY mode permanently.');
}

// ─── Schemas & Models ────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  id:           { type: String, required: true, unique: true },
  username:     { type: String, required: true, unique: true, index: true },
  email:        { type: String, unique: true, sparse: true },
  passwordHash: { type: String }, // Nullable for Google OAuth accounts
  avatar:       { type: String },
  status:       { type: String, default: 'Hey there! I am using ZapChat.' },
  createdAt:    { type: Date, default: Date.now },
});

const MessageSchema = new mongoose.Schema({
  id:        { type: String, required: true, unique: true },
  roomId:    { type: String, required: true },
  from:      { type: String, required: true },
  to:        { type: String, required: true },
  text:      { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  read:      { type: Boolean, default: false },
});
MessageSchema.index({ roomId: 1, timestamp: 1 });
MessageSchema.index({ roomId: 1, to: 1, read: 1 });

const UserModel    = mongoose.models.User    || mongoose.model('User',    UserSchema);
const MessageModel = mongoose.models.Message || mongoose.model('Message', MessageSchema);

// ─── In-Memory Fallback ──────────────────────────────────────────────────────
const users       = new Map();
const messages    = new Map();
const onlineUsers = new Map();

// ─── Express Middleware ──────────────────────────────────────────────────────
app.use(cors({
  origin:      corsOriginValidator,
  credentials: true,
  methods:     ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getRoomId(a, b) { return [a, b].sort().join('::'); }

function verifyToken(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  try {
    return jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
  } catch {
    res.status(401).json({ error: 'Invalid token' }); return null;
  }
}

function useDB() {
  return isMongoConnected && mongoose.connection.readyState === 1;
}

// ─── REST: Auth ───────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)    return res.status(400).json({ error: 'Username and password required' });
  const clean = username.trim();
  const dbActive = useDB();

  if (dbActive) {
    const exists = await UserModel.findOne({ username: clean }).select('_id').lean();
    if (exists) return res.status(409).json({ error: 'Username already taken' });
  } else {
    if (users.has(clean)) return res.status(409).json({ error: 'Username already taken' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(), username: clean, passwordHash,
    avatar: clean.charAt(0).toUpperCase(),
    status: 'Hey there! I am using ZapChat.',
    createdAt: new Date(),
  };

  if (dbActive) {
    await UserModel.create(user);
  } else {
    users.set(clean, user);
  }

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar, status: user.status } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const dbActive = useDB();
  let user;
  if (dbActive) user = await UserModel.findOne({ username: username.trim() }).lean();
  else          user = users.get(username.trim());

  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!user.passwordHash) return res.status(401).json({ error: 'Account registered via Google login. Use Gmail instead.' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar, status: user.status } });
});

// ─── ✅ NEW: GOOGLE OAUTH FLOW ENDPOINTS ──────────────────────────────────────
app.get('/api/auth/google', (req, res) => {
  const rootUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
  const options = {
    redirect_uri: GOOGLE_CALLBACK_URL,
    client_id: GOOGLE_CLIENT_ID,
    access_type: 'offline',
    response_type: 'code',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' '),
  };

  const qs = new URLSearchParams(options);
  return res.redirect(`${rootUrl}?${qs.toString()}`);
});

app.get('/api/auth/google/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect(`${FRONTEND_URL}?error=oauth_failed`);

  try {
    // 1. Exchange standard auth code for verification payload token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_CALLBACK_URL,
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokens.error_description || 'Failed to exchange token');

    // 2. Extract specific email identity payload markers
    const profileRes = await fetch(`https://www.googleapis.com/oauth2/v1/userinfo?alt=json&access_token=${tokens.access_token}`);
    const profile = await profileRes.json();

    const email = profile.email;
    let username = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '');
    const dbActive = useDB();

    let user = null;
    if (dbActive) {
      user = await UserModel.findOne({ email }).lean();
      if (!user) {
        // Enforce uniqueness for custom placeholder names
        const uniqueCheck = await UserModel.findOne({ username }).select('_id').lean();
        if (uniqueCheck) username += Math.floor(1000 + Math.random() * 9000);

        user = {
          id: uuidv4(),
          username,
          email,
          avatar: profile.picture || username.charAt(0).toUpperCase(),
          status: 'Hey there! I am using ZapChat.',
          createdAt: new Date(),
        };
        await UserModel.create(user);
      }
    } else {
      user = Array.from(users.values()).find(u => u.email === email);
      if (!user) {
        if (users.has(username)) username += Math.floor(1000 + Math.random() * 9000);
        user = {
          id: uuidv4(),
          username,
          email,
          avatar: profile.picture || username.charAt(0).toUpperCase(),
          status: 'Hey there! I am using ZapChat.',
          createdAt: new Date(),
        };
        users.set(username, user);
      }
    }

    // 3. Issue systemic authentication JWT token mapping
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    
    // Redirect cleanly back to the dashboard, passing structural session payloads
    return res.redirect(`${FRONTEND_URL}?token=${token}&user=${encodeURIComponent(JSON.stringify({
      id: user.id,
      username: user.username,
      avatar: user.avatar,
      status: user.status
    }))}`);

  } catch (err) {
    console.error('❌ Google OAuth processing failure:', err);
    return res.redirect(`${FRONTEND_URL}?error=server_auth_error`);
  }
});

// ─── REST: Users ──────────────────────────────────────────────────────────────
app.get('/api/users', async (req, res) => {
  const decoded = verifyToken(req, res);
  if (!decoded) return;

  let all;
  if (useDB()) {
    all = await UserModel.find({ username: { $ne: decoded.username } })
      .select('id username avatar status').lean();
  } else {
    all = Array.from(users.values()).filter(u => u.username !== decoded.username);
  }

  res.json(all.map(u => ({
    id: u.id, username: u.username, avatar: u.avatar, status: u.status,
    online: onlineUsers.has(u.username),
  })));
});

// ─── REST: Messages ───────────────────────────────────────────────────────────
app.get('/api/messages/:with', async (req, res) => {
  const decoded = verifyToken(req, res);
  if (!decoded) return;

  const roomId = getRoomId(decoded.username, req.params.with);
  let msgs;
  if (useDB()) {
    msgs = await MessageModel.find({ roomId })
      .sort({ timestamp: 1 })
      .select('id from to text timestamp read').lean();
  } else {
    msgs = messages.get(roomId) || [];
  }
  res.json(msgs);
});

// ─── REST: Secure TURN Server Credential Proxy ──────────────────────
app.get('/api/turn-credentials', async (req, res) => {
  const decoded = verifyToken(req, res);
  if (!decoded) return;

  if (!METERED_SECRET_KEY) {
    return res.status(500).json({ error: 'Metered secret key not configured on server variables.' });
  }

  try {
    const response = await fetch(`https://${METERED_APP_DOMAIN}/api/v1/turn/credentials?apiKey=${METERED_SECRET_KEY}`);
    if (!response.ok) {
        throw new Error(`Metered provider platform returned status code: ${response.status}`);
    }
    const iceServers = await response.json();
    res.json(iceServers);
  } catch (err) {
    console.error('❌ /api/turn-credentials error:', err);
    return res.status(500).json({ error: 'Internal error loading secure signaling tokens', detail: err.message });
  }
});

// ─── REST: Metered Room Creation ─────────────────────────────────────────────
app.post('/api/create-room', async (req, res) => {
  const decoded = verifyToken(req, res);
  if (!decoded) return;

  if (!METERED_SECRET_KEY) {
    return res.status(500).json({ error: 'Metered secret key not configured on server.' });
  }

  const withUser = (req.body && typeof req.body.with === 'string') ? req.body.with.trim() : '';
  const explicit = (req.body && typeof req.body.roomName === 'string') ? req.body.roomName.trim() : '';
  
  const roomName = (explicit
    || [decoded.username, withUser].filter(Boolean).sort().join('-').toLowerCase()
                                   .replace(/[^a-z0-9-]/g, '-')
    || `zc-${decoded.username.toLowerCase()}-${Date.now()}`)
                      .slice(0, 60);
  const privacy = (req.body && req.body.privacy === 'private') ? 'private' : 'public';

  try {
    let room = null;
    try {
      const existing = await fetch(
        `${METERED_API_BASE}/room/${encodeURIComponent(roomName)}?secretKey=${encodeURIComponent(METERED_SECRET_KEY)}`
      );
      if (existing.ok) room = await existing.json();
    } catch (_) {}

    if (!room) {
      const createRes = await fetch(
        `${METERED_API_BASE}/room?secretKey=${encodeURIComponent(METERED_SECRET_KEY)}`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            roomName,
            privacy,
            autoJoin:              true,
            joinVideoOn:           true,
            joinAudioOn:           true,
            enableScreenSharing:   true,
            enableChat:            true,
            ejectAtRoomExp:        false,
          }),
        }
      );

      const raw = await createRes.text();
      if (!createRes.ok) {
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
        const detail = parsed?.message || parsed?.error || raw || createRes.statusText;
        const maskedUrl = `${METERED_API_BASE}/room?secretKey=***${METERED_SECRET_KEY.slice(-4)}`;
        console.error('❌ Metered create-room failed', {
          status:    createRes.status,
          domain:    METERED_APP_DOMAIN,
          roomName,
          privacy,
          url:       maskedUrl,
          detail,
          rawBody:   raw.slice(0, 500),
        });
        return res.status(createRes.status).json({
          error:  'Metered create-room failed',
          detail,
          domain: METERED_APP_DOMAIN,
        });
      }
      room = JSON.parse(raw);
    }

    return res.json({
      roomName:      room.roomName,
      roomId:        room._id,
      privacy:       room.privacy,
      roomURL:       `https://${METERED_APP_DOMAIN}/${room.roomName}`,
      appDomain:     METERED_APP_DOMAIN,
      publicURL:     `https://${METERED_APP_DOMAIN}/${room.roomName}`,
      context:       withUser ? { self: decoded.username, with: withUser } : null,
    });
  } catch (err) {
    console.error('❌ /api/create-room error:', err);
    return res.status(500).json({ error: 'Internal error creating room', detail: err.message });
  }
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.status(200).json({
    status:    'UP',
    database:  useDB() ? 'CONNECTED' : 'FALLBACK_MEMORY',
    timestamp: new Date().toISOString(),
  });
});

// ─── Wildcard SPA Fallback ────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Socket.io Configuration ─────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin:      ALLOWED_ORIGINS,
    methods:     ['GET', 'POST'],
    credentials: true,
  },
  transports:    ['websocket', 'polling'],
  pingTimeout:   30000,
  pingInterval:  15000,
  allowUpgrades: true,
  cookie:        false,
});

// ─── Socket Auth Middleware ───────────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { next(new Error('Invalid token')); }
});

// ─── Socket Event Handlers ────────────────────────────────────────────────────
io.on('connection', socket => {
  const { username } = socket.user;
  onlineUsers.set(username, socket.id);
  console.log(`✅ ${username} connected via ${socket.conn.transport.name} (${socket.id})`);

  socket.broadcast.emit('user_status', { username, online: true });
  socket.emit('online_users', Array.from(onlineUsers.keys()));

  socket.on('private_message', async ({ to, text }) => {
    if (!text?.trim() || !to) return;
    const msg = {
      id: uuidv4(), from: username, to,
      text: text.trim(), timestamp: new Date(), read: false,
    };
    const roomId = getRoomId(username, to);

    if (useDB()) {
      MessageModel.create({ ...msg, roomId }).catch(err => console.error('DB save error:', err));
    } else {
      if (!messages.has(roomId)) messages.set(roomId, []);
      messages.get(roomId).push(msg);
    }

    const recipientSocket = onlineUsers.get(to);
    if (recipientSocket) io.to(recipientSocket).emit('private_message', msg);
    socket.emit('message_sent', msg);
  });

  socket.on('typing_start', ({ to }) => {
    const sid = onlineUsers.get(to);
    if (sid) io.to(sid).emit('typing_start', { from: username });
  });

  socket.on('typing_stop', ({ to }) => {
    const sid = onlineUsers.get(to);
    if (sid) io.to(sid).emit('typing_stop', { from: username });
  });

  socket.on('mark_read', async ({ from }) => {
    const roomId = getRoomId(username, from);
    if (useDB()) {
      MessageModel.updateMany(
        { roomId, to: username, read: false },
        { $set: { read: true } }
      ).catch(err => console.error('mark_read error:', err));
    } else {
      (messages.get(roomId) || []).forEach(m => { if (m.to === username) m.read = true; });
    }
    const senderSocket = onlineUsers.get(from);
    if (senderSocket) io.to(senderSocket).emit('messages_read', { by: username });
  });

  // ─── CALL SIGNALING SYSTEM ──────────────────────────────────────────────────
  socket.on('call_invite', ({ to, callType, roomURL, roomName }) => {
    const targetSocket = onlineUsers.get(to);
    if (!targetSocket) {
      socket.emit('call_failed', { reason: 'User is offline' });
      return;
    }
    io.to(targetSocket).emit('call_invite', {
      from: username,
      callType,   
      roomURL,
      roomName,
    });
  });

  socket.on('call_accept', ({ to, roomURL, roomName }) => {
    const callerSocket = onlineUsers.get(to);
    if (callerSocket) {
      io.to(callerSocket).emit('call_accepted', { from: username, roomURL, roomName });
    }
  });

  socket.on('call_reject', ({ to }) => {
    const callerSocket = onlineUsers.get(to);
    if (callerSocket) {
      io.to(callerSocket).emit('call_rejected', { from: username });
    }
  });

  socket.on('call_end', ({ to }) => {
    const otherSocket = onlineUsers.get(to);
    if (otherSocket) {
      io.to(otherSocket).emit('call_ended', { from: username });
    }
  });

  socket.on('disconnect', reason => {
    onlineUsers.delete(username);
    console.log(`🔴 ${username} disconnected: ${reason}`);
    socket.broadcast.emit('user_status', { username, online: false });
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`🚀 ZapChat server running on port ${PORT}`);
});
