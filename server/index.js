require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);

const JWT_SECRET = process.env.JWT_SECRET || 'zapchat_super_secret_key_2024';
const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || '*';
const MONGODB_URI = process.env.MONGODB_URI || '';

// ─── MongoDB Connection ─────────────────────────────────────────────────────
if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB error:', err.message));
}

// ─── MongoDB Schemas ────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  id:           { type: String, required: true, unique: true },
  username:     { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  avatar:       { type: String },
  status:       { type: String, default: 'Hey there! I am using ZapChat.' },
  createdAt:    { type: Date, default: Date.now },
});

const MessageSchema = new mongoose.Schema({
  id:        { type: String, required: true, unique: true },
  roomId:    { type: String, required: true, index: true },
  from:      { type: String, required: true },
  to:        { type: String, required: true },
  text:      { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  read:      { type: Boolean, default: false },
});

const UserModel    = mongoose.models.User    || mongoose.model('User',    UserSchema);
const MessageModel = mongoose.models.Message || mongoose.model('Message', MessageSchema);

// ─── In-Memory Fallback (used when MongoDB not connected) ───────────────────
const users      = new Map();
const sessions   = new Map();
const messages   = new Map();
const onlineUsers = new Map();

// ─── Express Middleware ─────────────────────────────────────────────────────
app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json());

// Serve bundled frontend from server/public/
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ────────────────────────────────────────────────────────────────
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

// ─── REST API ───────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)        return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3)           return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 4)           return res.status(400).json({ error: 'Password must be at least 4 characters' });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(), username, passwordHash,
    avatar: username.charAt(0).toUpperCase(),
    status: 'Hey there! I am using ZapChat.',
    createdAt: new Date().toISOString(),
  };

  if (MONGODB_URI && mongoose.connection.readyState === 1) {
    const exists = await UserModel.findOne({ username });
    if (exists) return res.status(409).json({ error: 'Username already taken' });
    await UserModel.create(user);
  } else {
    if (users.has(username)) return res.status(409).json({ error: 'Username already taken' });
    users.set(username, user);
  }

  const token = jwt.sign({ id: user.id, username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username, avatar: user.avatar, status: user.status } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  let user;
  if (MONGODB_URI && mongoose.connection.readyState === 1) {
    user = await UserModel.findOne({ username }).lean();
  } else {
    user = users.get(username);
  }

  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ id: user.id, username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username, avatar: user.avatar, status: user.status } });
});

app.get('/api/users', async (req, res) => {
  const decoded = verifyToken(req, res);
  if (!decoded) return;

  let allUsers;
  if (MONGODB_URI && mongoose.connection.readyState === 1) {
    allUsers = await UserModel.find({ username: { $ne: decoded.username } }).lean();
  } else {
    allUsers = Array.from(users.values()).filter(u => u.username !== decoded.username);
  }

  res.json(allUsers.map(u => ({
    id: u.id, username: u.username, avatar: u.avatar, status: u.status,
    online: onlineUsers.has(u.username),
  })));
});

app.get('/api/messages/:with', async (req, res) => {
  const decoded = verifyToken(req, res);
  if (!decoded) return;

  const roomId = getRoomId(decoded.username, req.params.with);
  let msgs;
  if (MONGODB_URI && mongoose.connection.readyState === 1) {
    msgs = await MessageModel.find({ roomId }).sort({ timestamp: 1 }).lean();
  } else {
    msgs = messages.get(roomId) || [];
  }
  res.json(msgs);
});
// Health check endpoint for deployment monitoring
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'UP', timestamp: new Date() });
});
// Serve frontend on all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Socket.IO ──────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: CLIENT_URL, methods: ['GET', 'POST'], credentials: true }
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { next(new Error('Invalid token')); }
});

io.on('connection', (socket) => {
  const { username } = socket.user;
  onlineUsers.set(username, socket.id);
  sessions.set(socket.id, { username });
  console.log(`✅ ${username} connected (${socket.id})`);

  io.emit('user_status', { username, online: true });
  socket.emit('online_users', Array.from(onlineUsers.keys()));

  socket.on('private_message', async ({ to, text }) => {
    if (!text?.trim() || !to) return;
    const msg = {
      id: uuidv4(), from: username, to,
      text: text.trim(), timestamp: new Date().toISOString(), read: false,
    };

    const roomId = getRoomId(username, to);
    if (MONGODB_URI && mongoose.connection.readyState === 1) {
      await MessageModel.create({ ...msg, roomId }).catch(console.error);
    } else {
      if (!messages.has(roomId)) messages.set(roomId, []);
      messages.get(roomId).push(msg);
    }

    const recipientSocketId = onlineUsers.get(to);
    if (recipientSocketId) io.to(recipientSocketId).emit('private_message', msg);
    socket.emit('message_sent', msg);
  });

  socket.on('typing_start', ({ to }) => {
    const r = onlineUsers.get(to);
    if (r) io.to(r).emit('typing_start', { from: username });
  });

  socket.on('typing_stop', ({ to }) => {
    const r = onlineUsers.get(to);
    if (r) io.to(r).emit('typing_stop', { from: username });
  });

  socket.on('mark_read', async ({ from }) => {
    const roomId = getRoomId(username, from);
    if (MONGODB_URI && mongoose.connection.readyState === 1) {
      await MessageModel.updateMany({ roomId, to: username }, { read: true }).catch(console.error);
    } else {
      (messages.get(roomId) || []).forEach(m => { if (m.to === username) m.read = true; });
    }
    const senderSocket = onlineUsers.get(from);
    if (senderSocket) io.to(senderSocket).emit('messages_read', { by: username });
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(username);
    sessions.delete(socket.id);
    io.emit('user_status', { username, online: false });
    console.log(`❌ ${username} disconnected`);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 ZapChat server running on http://localhost:${PORT}`);
  console.log(`📦 MongoDB: ${MONGODB_URI ? 'configured' : 'using in-memory store'}`);
});
