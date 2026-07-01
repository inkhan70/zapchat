require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const User = require('./models/User');
const Message = require('./models/Message');
const {
  appendCookieHeader,
  clearSessionCookie,
  createResetToken,
  getSessionToken,
  hashToken,
  isProduction,
  makeSlug,
  normalizeEmail,
  normalizeUsername,
  parseCookies,
  requireAuth,
  serializeCookie,
  setSessionCookie,
  signSession,
} = require('./utils/auth');
const { sendPasswordResetEmail } = require('./utils/mailer');

const PORT = Number(process.env.PORT || 5000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const JWT_SECRET = process.env.JWT_SECRET;
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const CLIENT_URL = String(process.env.CLIENT_URL || process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
const BACKEND_URL = String(process.env.BACKEND_URL || process.env.SERVER_URL || process.env.API_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = String(process.env.GOOGLE_REDIRECT_URI || `${BACKEND_URL}/api/auth/google/callback`).replace(/\/+$/, '');
const GOOGLE_STATE_COOKIE = 'zapchat_google_state';
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || 'zapchat_session';
const METERED_APP_DOMAIN = process.env.METERED_APP_DOMAIN || '';
const METERED_SECRET_KEY = process.env.METERED_SECRET_KEY || '';
const METERED_API_BASE = METERED_APP_DOMAIN ? `https://${METERED_APP_DOMAIN}/api/v1` : '';

if (!JWT_SECRET) {
  console.error('JWT_SECRET is required');
  process.exit(1);
}

if (!MONGO_URI) {
  console.error('MONGO_URI (or MONGODB_URI) is required');
  process.exit(1);
}

const allowedOrigins = new Set(
  [
    CLIENT_URL,
    process.env.FRONTEND_URL,
    process.env.CORS_ORIGIN,
    'http://localhost:3000',
    'http://localhost:5000',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5000',
  ].filter(Boolean)
);

function createRateLimiter({ windowMs, max, message }) {
  const hits = new Map();

  return (req, res, next) => {
    const key = `${req.ip}:${req.originalUrl}`;
    const now = Date.now();
    const windowStart = now - windowMs;
    const entries = hits.get(key) || [];
    const recent = entries.filter((timestamp) => timestamp > windowStart);

    recent.push(now);
    hits.set(key, recent);

    if (recent.length > max) {
      return res.status(429).json({ error: message });
    }

    next();
  };
}

function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

function corsOriginValidator(origin, callback) {
  if (!origin || allowedOrigins.has(origin)) {
    callback(null, true);
    return;
  }
  callback(new Error(`CORS policy: origin '${origin}' is not allowed`));
}

function getRoomId(a, b) {
  return [String(a || '').toLowerCase(), String(b || '').toLowerCase()].sort().join('::');
}

function sanitizeUser(user) {
  if (!user) return null;
  const doc = typeof user.toObject === 'function' ? user.toObject() : user;
  return {
    id: String(doc._id || doc.id),
    username: doc.username,
    email: doc.email,
    displayName: doc.displayName || doc.username,
    avatar: doc.avatar || String(doc.username || '?').charAt(0).toUpperCase(),
    status: doc.status || 'Hey there! I am using ZapChat.',
    emailVerified: !!doc.emailVerified,
    authProviders: doc.authProviders || [],
    createdAt: doc.createdAt,
    lastLoginAt: doc.lastLoginAt,
  };
}

async function generateUniqueUsername(base) {
  const root = makeSlug(base || 'user');
  let candidate = root;
  let suffix = 1;

  while (await User.findOne({ username: candidate }).select('_id').lean()) {
    candidate = `${root}${suffix}`;
    suffix += 1;
  }

  return candidate;
}

async function findUserByIdentifier(identifier) {
  const normalized = String(identifier || '').trim().toLowerCase();
  if (!normalized) return null;

  return User.findOne({
    $or: [{ email: normalized }, { username: normalized }],
  })
    .select('username email passwordHash googleId displayName avatar status authProviders emailVerified lastLoginAt passwordChangedAt resetPasswordTokenHash resetPasswordExpiresAt createdAt')
    .lean();
}

async function ensureGoogleUser(profile) {
  const email = normalizeEmail(profile.email);
  const displayName = String(profile.name || profile.given_name || email.split('@')[0] || '').trim() || email.split('@')[0];
  const picture = String(profile.picture || '').trim();

  let user = await User.findOne({ $or: [{ googleId: profile.sub }, { email }] });
  if (user) {
    user.googleId = profile.sub;
    user.displayName = user.displayName || displayName;
    user.emailVerified = true;
    user.lastLoginAt = new Date();
    user.avatar = user.avatar || picture || user.username.charAt(0).toUpperCase();
    user.authProviders = Array.from(new Set([...(user.authProviders || []), 'google']));
    await user.save();
    return user;
  }

  const username = await generateUniqueUsername(displayName);
  user = await User.create({
    username,
    email,
    googleId: profile.sub,
    displayName,
    avatar: picture || username.charAt(0).toUpperCase(),
    authProviders: ['google'],
    emailVerified: true,
    lastLoginAt: new Date(),
  });

  return user;
}

async function createLocalUser({ username, email, password }) {
  const normalizedUsername = normalizeUsername(username);
  const normalizedEmail = normalizeEmail(email);

  const existing = await User.findOne({
    $or: [{ username: normalizedUsername }, { email: normalizedEmail }],
  }).select('_id').lean();

  if (existing) {
    const conflict = await User.findOne({
      $or: [{ username: normalizedUsername }, { email: normalizedEmail }],
    }).select('username email').lean();
    if (conflict?.username === normalizedUsername) {
      const err = new Error('Username already taken');
      err.statusCode = 409;
      throw err;
    }
    if (conflict?.email === normalizedEmail) {
      const err = new Error('Email already registered');
      err.statusCode = 409;
      throw err;
    }
  }

  const passwordHash = await bcrypt.hash(password, 12);

  return User.create({
    username: normalizedUsername,
    email: normalizedEmail,
    passwordHash,
    displayName: normalizedUsername,
    avatar: normalizedUsername.charAt(0).toUpperCase(),
    authProviders: ['password'],
    emailVerified: false,
    lastLoginAt: new Date(),
  });
}

function buildGoogleAuthUrl(state) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', GOOGLE_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  return url.toString();
}

async function exchangeGoogleCode(code) {
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: GOOGLE_REDIRECT_URI,
    }),
  });

  if (!tokenResponse.ok) {
    const body = await tokenResponse.text();
    throw new Error(`Google token exchange failed: ${body}`);
  }

  const tokens = await tokenResponse.json();
  if (!tokens.access_token) {
    throw new Error('Google token exchange did not return an access token');
  }

  const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!profileResponse.ok) {
    const body = await profileResponse.text();
    throw new Error(`Google profile lookup failed: ${body}`);
  }

  return profileResponse.json();
}

function getResetUrl(token) {
  return `${CLIENT_URL}/?resetToken=${encodeURIComponent(token)}`;
}

function createAuthRateLimiters() {
  return {
    signup: createRateLimiter({
      windowMs: 15 * 60 * 1000,
      max: 8,
      message: 'Too many signup attempts. Please try again later.',
    }),
    login: createRateLimiter({
      windowMs: 15 * 60 * 1000,
      max: 15,
      message: 'Too many login attempts. Please try again later.',
    }),
    forgot: createRateLimiter({
      windowMs: 60 * 60 * 1000,
      max: 5,
      message: 'Too many password reset requests. Please try again later.',
    }),
    reset: createRateLimiter({
      windowMs: 15 * 60 * 1000,
      max: 10,
      message: 'Too many password reset attempts. Please try again later.',
    }),
    google: createRateLimiter({
      windowMs: 15 * 60 * 1000,
      max: 20,
      message: 'Too many Google auth attempts. Please try again later.',
    }),
  };
}

async function start() {
  await mongoose.connect(MONGO_URI, {
    autoIndex: NODE_ENV !== 'production',
    maxPoolSize: 10,
    minPoolSize: 2,
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 45000,
  });

  mongoose.connection.on('connected', () => console.log('✅ MongoDB connected'));
  mongoose.connection.on('error', (err) => console.error('❌ MongoDB error:', err.message));

  const app = express();
  const server = http.createServer(app);
  const rateLimiters = createAuthRateLimiters();
  const io = new Server(server, {
    cors: {
      origin: Array.from(allowedOrigins),
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 30000,
    pingInterval: 15000,
    allowUpgrades: true,
    cookie: false,
  });

  app.set('trust proxy', 1);
  app.use(securityHeaders);
  app.use(cors({
    origin: corsOriginValidator,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.options(/.*/, cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(path.join(__dirname, 'public')));

  // Auth routes
  app.get('/api/auth/me', requireAuth, async (req, res) => {
    const user = await User.findById(req.auth.sub)
      .select('username email displayName avatar status emailVerified authProviders createdAt lastLoginAt')
      .lean();

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({ user: sanitizeUser(user) });
  });

  app.post('/api/auth/signup', rateLimiters.signup, async (req, res, next) => {
    try {
      const { username, email, password } = req.body || {};
      if (!username || !email || !password) {
        return res.status(400).json({ error: 'Username, email, and password are required' });
      }
      if (String(username).trim().length < 3) {
        return res.status(400).json({ error: 'Username must be at least 3 characters' });
      }
      if (String(password).length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }

      const user = await createLocalUser({ username, email, password });
      user.lastLoginAt = new Date();
      await user.save();

      const token = signSession(user);
      setSessionCookie(res, token);
      return res.status(201).json({ user: sanitizeUser(user) });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      return next(error);
    }
  });

  app.post('/api/register', rateLimiters.signup, async (req, res, next) => {
    try {
      const { username, email, password } = req.body || {};
      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }
      const resolvedUsername = username || normalizeUsername(String(email).split('@')[0]);
      const user = await createLocalUser({ username: resolvedUsername, email, password });
      const token = signSession(user);
      setSessionCookie(res, token);
      return res.status(201).json({ user: sanitizeUser(user) });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      return next(error);
    }
  });

  app.post('/api/auth/login', rateLimiters.login, async (req, res, next) => {
    try {
      const { identifier, username, email, password } = req.body || {};
      const loginKey = identifier || username || email;
      if (!loginKey || !password) {
        return res.status(400).json({ error: 'Email/username and password are required' });
      }

      const user = await findUserByIdentifier(loginKey);
      if (!user || !user.passwordHash) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const doc = await User.findById(user._id);
      doc.lastLoginAt = new Date();
      await doc.save();

      const token = signSession(doc);
      setSessionCookie(res, token);
      return res.json({ user: sanitizeUser(doc) });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/login', rateLimiters.login, async (req, res, next) => {
    try {
      const { username, email, password } = req.body || {};
      const user = await findUserByIdentifier(username || email);
      if (!user || !user.passwordHash) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const valid = await bcrypt.compare(password || '', user.passwordHash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const doc = await User.findById(user._id);
      doc.lastLoginAt = new Date();
      await doc.save();

      const token = signSession(doc);
      setSessionCookie(res, token);
      return res.json({ user: sanitizeUser(doc) });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/auth/logout', (_req, res) => {
    clearSessionCookie(res);
    return res.json({ message: 'Signed out' });
  });

  app.post('/api/auth/forgot-password', rateLimiters.forgot, async (req, res, next) => {
    try {
      const { email } = req.body || {};
      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }

      const normalizedEmail = normalizeEmail(email);
      const user = await User.findOne({ email: normalizedEmail });

      if (!user) {
        return res.json({ message: 'If that email exists, a reset link has been sent.' });
      }

      const { token, tokenHash } = createResetToken();
      user.resetPasswordTokenHash = tokenHash;
      user.resetPasswordExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
      await user.save();

      await sendPasswordResetEmail({
        to: user.email,
        username: user.username,
        resetUrl: getResetUrl(token),
      });

      return res.json({ message: 'If that email exists, a reset link has been sent.' });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/auth/reset-password', rateLimiters.reset, async (req, res, next) => {
    try {
      const { token, password, confirmPassword } = req.body || {};
      if (!token || !password) {
        return res.status(400).json({ error: 'Reset token and new password are required' });
      }
      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      if (confirmPassword && password !== confirmPassword) {
        return res.status(400).json({ error: 'Passwords do not match' });
      }

      const tokenHash = hashToken(token);
      const user = await User.findOne({
        resetPasswordTokenHash: tokenHash,
        resetPasswordExpiresAt: { $gt: new Date() },
      });

      if (!user) {
        return res.status(400).json({ error: 'Reset token is invalid or expired' });
      }

      user.passwordHash = await bcrypt.hash(password, 12);
      user.passwordChangedAt = new Date();
      user.resetPasswordTokenHash = null;
      user.resetPasswordExpiresAt = null;
      user.authProviders = Array.from(new Set([...(user.authProviders || []), 'password']));
      await user.save();

      const sessionToken = signSession(user);
      setSessionCookie(res, sessionToken);
      return res.json({ user: sanitizeUser(user) });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/auth/google', rateLimiters.google, (_req, res) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.status(500).json({ error: 'Google OAuth is not configured' });
    }

    const state = crypto.randomBytes(16).toString('hex');
    appendCookieHeader(
      res,
      serializeCookie(GOOGLE_STATE_COOKIE, state, {
        httpOnly: true,
        secure: isProduction(),
        sameSite: 'lax',
        path: '/',
        maxAge: 10 * 60 * 1000,
      })
    );

    return res.redirect(buildGoogleAuthUrl(state));
  });

  app.get('/api/auth/google/callback', async (req, res, next) => {
    try {
      const { code, state } = req.query || {};
      if (!code || !state) {
        return res.redirect(`${CLIENT_URL}/?auth=google_error`);
      }

      const cookies = parseCookies(req.headers.cookie || '');
      if (!cookies[GOOGLE_STATE_COOKIE] || cookies[GOOGLE_STATE_COOKIE] !== state) {
        return res.redirect(`${CLIENT_URL}/?auth=google_state_error`);
      }

      const profile = await exchangeGoogleCode(String(code));
      if (!profile.email) {
        return res.redirect(`${CLIENT_URL}/?auth=google_email_missing`);
      }

      const user = await ensureGoogleUser(profile);
      const token = signSession(user);
      setSessionCookie(res, token);
      appendCookieHeader(
        res,
        serializeCookie(GOOGLE_STATE_COOKIE, '', {
          httpOnly: true,
          secure: isProduction(),
          sameSite: 'lax',
          path: '/',
          maxAge: 0,
        })
      );

      return res.redirect(`${CLIENT_URL}/?auth=google_success`);
    } catch (error) {
      console.error('Google OAuth callback failed:', error.message);
      return next(error);
    }
  });

  // Chat routes
  app.get('/api/users', requireAuth, async (req, res, next) => {
    try {
      const me = await User.findById(req.auth.sub).select('username').lean();
      if (!me) {
        return res.status(404).json({ error: 'User not found' });
      }

      const users = await User.find({ username: { $ne: me.username } })
        .select('username email avatar status displayName emailVerified lastLoginAt')
        .sort({ username: 1 })
        .lean();

      return res.json(
        users.map((user) => ({
          ...sanitizeUser(user),
          online: onlineUsers.has(user.username),
        }))
      );
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/messages/:with', requireAuth, async (req, res, next) => {
    try {
      const me = await User.findById(req.auth.sub).select('username').lean();
      if (!me) {
        return res.status(404).json({ error: 'User not found' });
      }

      const withUsername = normalizeUsername(req.params.with);
      const roomId = getRoomId(me.username, withUsername);
      const messages = await Message.find({ roomId })
        .sort({ createdAt: 1 })
        .select('id from to text read createdAt')
        .lean();

      return res.json(messages.map((message) => ({
        id: message.id,
        from: message.from,
        to: message.to,
        text: message.text,
        read: message.read,
        status: message.read ? 'read' : 'sent',
        timestamp: message.createdAt,
      })));
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/create-room', requireAuth, async (req, res, next) => {
    try {
      if (!METERED_SECRET_KEY || !METERED_APP_DOMAIN) {
        return res.status(500).json({ error: 'Metered video configuration is missing' });
      }

      const me = await User.findById(req.auth.sub).select('username').lean();
      if (!me) {
        return res.status(404).json({ error: 'User not found' });
      }

      const withUser = String(req.body?.with || '').trim();
      const explicit = String(req.body?.roomName || '').trim();
      const privacy = req.body?.privacy === 'private' ? 'private' : 'public';
      const roomName = (
        explicit ||
        [me.username, withUser].filter(Boolean).sort().join('-').toLowerCase().replace(/[^a-z0-9-]/g, '-') ||
        `zc-${me.username}-${Date.now()}`
      ).slice(0, 60);

      let room = null;
      try {
        const existing = await fetch(`${METERED_API_BASE}/room/${encodeURIComponent(roomName)}?secretKey=${encodeURIComponent(METERED_SECRET_KEY)}`);
        if (existing.ok) {
          room = await existing.json();
        }
      } catch {
        // Ignore read errors and fall back to create.
      }

      if (!room) {
        const createRes = await fetch(`${METERED_API_BASE}/room?secretKey=${encodeURIComponent(METERED_SECRET_KEY)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            roomName,
            privacy,
            autoJoin: true,
            joinVideoOn: true,
            joinAudioOn: true,
            enableScreenSharing: true,
            enableChat: true,
            ejectAtRoomExp: false,
          }),
        });

        const raw = await createRes.text();
        if (!createRes.ok) {
          let detail = raw;
          try {
            detail = JSON.parse(raw).message || raw;
          } catch {
            // keep raw
          }
          return res.status(createRes.status).json({ error: 'Metered create-room failed', detail });
        }
        room = JSON.parse(raw);
      }

      return res.json({
        roomName: room.roomName,
        roomId: room._id,
        privacy: room.privacy,
        roomURL: `${METERED_APP_DOMAIN}/${room.roomName}`,
        appDomain: METERED_APP_DOMAIN,
        publicURL: `https://${METERED_APP_DOMAIN}/${room.roomName}`,
        context: withUser ? { self: me.username, with: withUser } : null,
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/health', async (_req, res) => {
    res.status(200).json({
      status: 'UP',
      database: mongoose.connection.readyState === 1 ? 'CONNECTED' : 'DISCONNECTED',
      auth: {
        cookies: true,
        jwt: true,
        googleOAuth: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI),
        passwordResetEmail: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
      },
      timestamp: new Date().toISOString(),
    });
  });

  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  const onlineUsers = new Map();

  io.use((socket, next) => {
    const token = getSessionToken({ headers: socket.request.headers });
    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      socket.user = require('jsonwebtoken').verify(token, JWT_SECRET);
      return next();
    } catch {
      return next(new Error('Invalid session'));
    }
  });

  io.on('connection', (socket) => {
    const username = normalizeUsername(socket.user.username);
    onlineUsers.set(username, socket.id);

    socket.broadcast.emit('user_status', { username, online: true });
    socket.emit('online_users', Array.from(onlineUsers.keys()));

    socket.on('private_message', async ({ to, text }) => {
      const cleanText = String(text || '').trim();
      const target = normalizeUsername(to);
      if (!cleanText || !target) return;

      const msg = {
        id: uuidv4(),
        roomId: getRoomId(username, target),
        from: username,
        to: target,
        text: cleanText,
        read: false,
      };

      const saved = await Message.create(msg);
      const payload = {
        id: saved.id,
        from: saved.from,
        to: saved.to,
        text: saved.text,
        read: saved.read,
        timestamp: saved.createdAt,
        status: 'sent',
      };

      const recipientSocket = onlineUsers.get(target);
      if (recipientSocket) {
        io.to(recipientSocket).emit('private_message', payload);
      }
      socket.emit('message_sent', payload);
    });

    socket.on('typing_start', ({ to }) => {
      const target = onlineUsers.get(normalizeUsername(to));
      if (target) io.to(target).emit('typing_start', { from: username });
    });

    socket.on('typing_stop', ({ to }) => {
      const target = onlineUsers.get(normalizeUsername(to));
      if (target) io.to(target).emit('typing_stop', { from: username });
    });

    socket.on('mark_read', async ({ from }) => {
      const sender = normalizeUsername(from);
      if (!sender) return;
      const roomId = getRoomId(username, sender);
      await Message.updateMany({ roomId, to: username, read: false }, { $set: { read: true } });
      const senderSocket = onlineUsers.get(sender);
      if (senderSocket) io.to(senderSocket).emit('messages_read', { by: username });
    });

    socket.on('call_invite', ({ to, callType, roomURL, roomName }) => {
      const targetSocket = onlineUsers.get(normalizeUsername(to));
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
      const callerSocket = onlineUsers.get(normalizeUsername(to));
      if (callerSocket) {
        io.to(callerSocket).emit('call_accepted', { from: username, roomURL, roomName });
      }
    });

    socket.on('call_reject', ({ to }) => {
      const callerSocket = onlineUsers.get(normalizeUsername(to));
      if (callerSocket) {
        io.to(callerSocket).emit('call_rejected', { from: username });
      }
    });

    socket.on('call_end', ({ to }) => {
      const otherSocket = onlineUsers.get(normalizeUsername(to));
      if (otherSocket) {
        io.to(otherSocket).emit('call_ended', { from: username });
      }
    });

    socket.on('disconnect', (reason) => {
      onlineUsers.delete(username);
      socket.broadcast.emit('user_status', { username, online: false });
      console.log(`🔴 ${username} disconnected: ${reason}`);
    });
  });

  app.use((err, _req, res, _next) => {
    console.error('❌ Unhandled error:', err.message);
    if (res.headersSent) return;
    if (String(err.message || '').startsWith('CORS policy')) {
      return res.status(403).json({ error: 'Origin not allowed by CORS policy.' });
    }
    res.status(500).json({ error: 'Internal server error.' });
  });

  server.listen(PORT, () => {
    console.log(`🚀 ZapChat server running on port ${PORT}`);
    console.log(`🌐 Allowed origins: ${Array.from(allowedOrigins).join(', ')}`);
    console.log(`🔐 Session cookie: ${SESSION_COOKIE}`);
    console.log(`🔑 Google OAuth redirect: ${GOOGLE_REDIRECT_URI}`);
  });
}

start().catch((error) => {
  console.error('Failed to start ZapChat:', error);
  process.exit(1);
});
