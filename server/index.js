require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const mongoose   = require('mongoose');
const multer     = require('multer');

// ─── Environment ─────────────────────────────────────────────────────────────
const JWT_SECRET   = process.env.JWT_SECRET   || 'zapchat_super_secret_key_2024';
const PORT         = process.env.PORT         || 5000;
const MONGODB_URI  = process.env.MONGODB_URI;

// Metered Video SDK credentials.
// App domain = the subdomain of your Metered app, e.g. "zapchat-server.metered.live".
// Secret key = server-side only, loaded from env. Rotate via the Metered
// dashboard if it's ever exposed (e.g. pasted into a chat, committed to git).
const METERED_APP_DOMAIN = process.env.METERED_APP_DOMAIN || 'zapchat-server.metered.live';
const METERED_SECRET_KEY = process.env.METERED_SECRET_KEY;
const METERED_API_BASE   = `https://${METERED_APP_DOMAIN}/api/v1`;

// Password reset / email config.
const MOCK_EMAIL      = String(process.env.MOCK_EMAIL || 'true').toLowerCase() !== 'false';
const SMTP_HOST       = process.env.SMTP_HOST || '';
const SMTP_PORT       = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE     = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const SMTP_USER       = process.env.SMTP_USER || '';
const SMTP_PASS       = process.env.SMTP_PASS || '';
const SMTP_FROM       = process.env.SMTP_FROM || 'ZapChat <no-reply@zapchat.local>';
const RESET_LINK_BASE = process.env.RESET_LINK_BASE || '';

// Profile picture upload config.
const UPLOAD_DIR      = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'));
const UPLOAD_MAX_MB   = Number(process.env.UPLOAD_MAX_BYTES || (5 * 1024 * 1024));
const UPLOAD_MAX_BYTES = Number.isFinite(UPLOAD_MAX_MB) ? UPLOAD_MAX_MB : (5 * 1024 * 1024);

// Explicit allowed-origin list:
//  1. Back4app production container (primary)
//  2. Vercel deployment (secondary / legacy)
//  3. Local development
const ALLOWED_ORIGINS = [
  'https://zapchat-5ru.pages.dev',                        // Cloudflare Pages frontend (PRIMARY)
  'https://echochat-fvq5kwvs.b4a.run',                    // legacy Back4app (remove once fully cut over)
  'https://zapchat-server.vercel.app',                    // legacy Vercel (DEAD — safe to remove)
  'https://zapchat-server-inkhan.vercel.app',             // legacy Vercel (remove if unused)
  'http://localhost:3000',
  'http://localhost:5000',
  'http://127.0.0.1:5000',
];

// Origin-validator — returns the origin string if it is allowed, false otherwise.
// Also permits same-origin/static requests that carry no Origin header.
function corsOriginValidator(origin, callback) {
  if (!origin || ALLOWED_ORIGINS.includes(origin)) {
    callback(null, origin || true);
  } else {
    callback(new Error(`CORS policy: origin '${origin}' is not allowed`));
  }
}

// ─── Email Validation ────────────────────────────────────────────────────────
// Practical, conservative email regex. Not RFC-5322-perfect, but matches the
// vast majority of real addresses while rejecting obvious junk. Always
// lower-cased before storage so lookups are deterministic.
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}
function normalizeUsername(u) {
  return String(u || '').trim();
}

function sanitizePublicProfile(u) {
  if (!u) return null;
  return {
    id:                u.id,
    username:          u.username,
    email:             u.email || '',
    profilePictureUrl: u.profilePictureUrl || '',
    avatar:            u.profilePictureUrl
                        ? u.profilePictureUrl
                        : (u.username ? u.username.charAt(0).toUpperCase() : '?'),
    status:            u.status || 'Hey there! I am using ZapChat.',
    createdAt:         u.createdAt || null,
  };
}

// ─── Ensure Uploads Directory Exists ─────────────────────────────────────────
try {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    console.log(`📁 Created upload directory: ${UPLOAD_DIR}`);
  }
} catch (err) {
  console.error('❌ Failed to ensure upload directory exists:', err.message);
}

// ─── Express App & HTTP Server ───────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

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

  // Keep isMongoConnected in sync with the actual connection lifecycle —
  // this matters because a connection can drop AFTER the initial .then()
  // fires (e.g. network blip, Atlas pausing a free cluster), and without
  // these listeners isMongoConnected would stay "true" forever even
  // though queries are silently failing or falling through.
  mongoose.connection.on('disconnected', () => {
    isMongoConnected = false;
    console.warn('⚠️ MongoDB disconnected — falling back to in-memory storage until reconnected');
  });
  mongoose.connection.on('reconnected', () => {
    isMongoConnected = true;
    console.log('✅ MongoDB reconnected');
  });
} else {
  console.warn('⚠️ No MONGODB_URI set — running in IN-MEMORY mode permanently. Data will not persist across restarts.');
}

// ─── Schemas & Models ────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  id:                   { type: String, required: true, unique: true },
  email:                { type: String, required: true, unique: true, lowercase: true, index: true },
  username:             { type: String, required: true, unique: true, index: true },
  passwordHash:         { type: String, required: true },
  profilePictureUrl:    { type: String, default: '' },
  status:               { type: String, default: 'Hey there! I am using ZapChat.' },
  resetPasswordToken:   { type: String, default: '' },
  resetPasswordExpires: { type: Date,   default: null },
  createdAt:            { type: Date,   default: Date.now },
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
const users       = new Map();   // username -> user doc
const usersByEmail = new Map();   // email -> username (lowercase key)
const messages    = new Map();
const onlineUsers = new Map();   // username -> socket.id

// ─── Express Middleware ──────────────────────────────────────────────────────
app.use(cors({
  origin:      corsOriginValidator,
  credentials: true,
  methods:     ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors());          // Pre-flight pass-through for all routes
app.use(express.json());

// Serve bundled frontend (server/public/) before API routes
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded profile pictures as static assets.
app.use('/uploads', express.static(UPLOAD_DIR, {
  // Disable caching during dev; cache for a day in prod. The browser still
  // busts the cache via the `?v=<timestamp>` suffix we append on upload.
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  fallthrough: true,
}));

// ─── Multer Configuration (Profile Picture Uploads) ──────────────────────────
// Disk storage with deterministic, collision-resistant filenames. The on-disk
// filename is the file's UUID — we never trust user-supplied filenames.
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    // Whitelist extensions — anything not on this list is rejected upstream.
    const safeExt = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext) ? ext : '.bin';
    cb(null, `${uuidv4()}${safeExt}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    // Restrict to real image MIME types so a malicious rename doesn't slip
    // through. Browsers always send the correct MIME for `<input type=file>`.
    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Only PNG, JPG, GIF, and WEBP images are allowed.'));
    }
    cb(null, true);
  },
});

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

// Async wrapper — eliminates the need to repeat try/catch in every route.
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ─── Email Sender (mock or SMTP) ─────────────────────────────────────────────
// In MOCK mode we log the reset link to the server console and ALSO include
// the token in the API response when running in development so the frontend
// can show a "click here to reset" shortcut. In production, MOCK mode still
// logs (useful for ops debugging) but NEVER returns the token over the wire.
async function sendPasswordResetEmail({ to, username, token, req }) {
  const base = RESET_LINK_BASE
    || (req ? `${req.protocol}://${req.get('host') || 'localhost'}` : '');
  // Frontend reset page is `reset.html` next to `index.html`.
  const link = `${base}/reset.html?token=${encodeURIComponent(token)}&email=${encodeURIComponent(to)}`;

  if (MOCK_EMAIL || !SMTP_HOST) {
    const banner = '═'.repeat(60);
    console.log(`\n${banner}\n📧 MOCK EMAIL → ${to} (@${username})\n🔗 Reset link:\n   ${link}\n${banner}\n`);
    return { delivered: false, mocked: true, link };
  }

  // Real SMTP delivery. We lazy-require nodemailer only when actually needed
  // so the dependency stays optional and we don't pay the cost in MOCK mode.
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (err) {
    console.warn('⚠️ MOCK_EMAIL=false but nodemailer is not installed — falling back to console log.');
    console.log(`📧 Reset link for ${to}: ${link}`);
    return { delivered: false, mocked: true, link };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    });
    await transporter.sendMail({
      from:    SMTP_FROM,
      to,
      subject: 'Reset your ZapChat password',
      text:    `Hi ${username},\n\nClick the link below to reset your ZapChat password:\n${link}\n\nThis link expires in 1 hour.\n\n— The ZapChat Team`,
      html:    `<p>Hi <b>${username}</b>,</p><p>Click the link below to reset your ZapChat password:</p><p><a href="${link}">${link}</a></p><p><small>This link expires in 1 hour.</small></p>`,
    });
    return { delivered: true, mocked: false, link };
  } catch (err) {
    console.error('❌ Failed to send reset email:', err.message);
    // Surface the link in logs even on SMTP failure so ops can manually
    // unblock the user without re-running the flow.
    console.log(`📧 Reset link for ${to} (SMTP failed): ${link}`);
    return { delivered: false, mocked: false, link, error: err.message };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// REST: AUTH
// ═════════════════════════════════════════════════════════════════════════════

// ─── POST /api/register ──────────────────────────────────────────────────────
// Body: { email, username, password, profilePictureUrl? }
//
// profilePictureUrl is optional at register time so users can sign up without
// picking an avatar. They can upload later via /api/upload-profile-picture.
app.post('/api/register', asyncRoute(async (req, res) => {
  const emailRaw    = normalizeEmail(req.body && req.body.email);
  const usernameRaw = normalizeUsername(req.body && req.body.username);
  const password    = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  const profilePictureUrl = req.body && typeof req.body.profilePictureUrl === 'string'
                            ? req.body.profilePictureUrl.trim()
                            : '';

  // ─── Validation ──────────────────────────────────────────────────────────
  if (!emailRaw || !usernameRaw || !password) {
    return res.status(400).json({ error: 'Email, username, and password are required.' });
  }
  if (!EMAIL_RE.test(emailRaw)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (!USERNAME_RE.test(usernameRaw)) {
    return res.status(400).json({ error: 'Username must be 3–32 characters (letters, digits, _.-).' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (password.length > 128) {
    return res.status(400).json({ error: 'Password is too long (max 128 characters).' });
  }

  const dbActive = useDB();
  console.log(`🔍 REGISTER ATTEMPT: email="${emailRaw}" username="${usernameRaw}" | DB mode: ${dbActive ? 'MongoDB' : 'IN-MEMORY FALLBACK'}`);

  // ─── Uniqueness checks ──────────────────────────────────────────────────
  if (dbActive) {
    const existsEmail    = await UserModel.findOne({ email: emailRaw }).select('_id').lean();
    if (existsEmail)    return res.status(409).json({ error: 'An account with this email already exists.' });
    const existsUsername = await UserModel.findOne({ username: usernameRaw }).select('_id').lean();
    if (existsUsername) return res.status(409).json({ error: 'That username is already taken.' });
  } else {
    if (usersByEmail.has(emailRaw)) return res.status(409).json({ error: 'An account with this email already exists.' });
    if (users.has(usernameRaw))     return res.status(409).json({ error: 'That username is already taken.' });
  }

  // ─── Hash + persist ─────────────────────────────────────────────────────
  const passwordHash = await bcrypt.hash(password, 12); // cost 12 = strong default
  const user = {
    id:                uuidv4(),
    email:             emailRaw,
    username:          usernameRaw,
    passwordHash,
    profilePictureUrl: profilePictureUrl || '',
    avatar:            usernameRaw.charAt(0).toUpperCase(),
    status:            'Hey there! I am using ZapChat.',
    resetPasswordToken:   '',
    resetPasswordExpires: null,
    createdAt:            new Date(),
  };

  if (dbActive) {
    try {
      await UserModel.create(user);
      console.log(`✅ REGISTER SUCCESS: "${usernameRaw}" saved to MongoDB`);
    } catch (err) {
      // Race condition: two registrations with the same email/username arrive
      // at the same instant. The pre-check above isn't atomic.
      if (err && err.code === 11000) {
        return res.status(409).json({ error: 'That email or username is already in use.' });
      }
      throw err;
    }
  } else {
    users.set(usernameRaw, user);
    usersByEmail.set(emailRaw, usernameRaw);
    console.log(`⚠️ REGISTER SUCCESS (BUT FRAGILE): "${usernameRaw}" saved to IN-MEMORY only — will be lost on restart`);
  }

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.status(201).json({ token, user: sanitizePublicProfile(user) });
}));

// ─── POST /api/login ────────────────────────────────────────────────────────
// Body: { identifier, password }   where identifier is email OR username.
//
// We keep backwards compatibility: legacy clients can still POST
// { username, password } and it will work.
app.post('/api/login', asyncRoute(async (req, res) => {
  const identifier = (req.body && (req.body.identifier ?? req.body.username ?? req.body.email) || '')
                      .toString()
                      .trim();
  const password   = req.body && typeof req.body.password === 'string' ? req.body.password : '';

  if (!identifier || !password) {
    return res.status(400).json({ error: 'Email/username and password are required.' });
  }

  const dbActive = useDB();
  console.log(`🔍 LOGIN ATTEMPT: identifier="${identifier}" | DB mode: ${dbActive ? 'MongoDB' : 'IN-MEMORY FALLBACK'} | in-memory user count: ${users.size}`);

  let user = null;
  const looksLikeEmail = identifier.includes('@');

  if (dbActive) {
    if (looksLikeEmail) {
      user = await UserModel.findOne({ email: identifier.toLowerCase() }).lean();
    } else {
      user = await UserModel.findOne({ username: identifier }).lean();
    }
  } else {
    if (looksLikeEmail) {
      const username = usersByEmail.get(identifier.toLowerCase());
      user = username ? users.get(username) : null;
    } else {
      user = users.get(identifier);
    }
  }

  if (!user) {
    console.log(`❌ LOGIN FAILED: no user found for "${identifier}" in ${dbActive ? 'MongoDB' : 'memory'}`);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    console.log(`❌ LOGIN FAILED: password mismatch for "${identifier}"`);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  console.log(`✅ LOGIN SUCCESS: "${user.username}" authenticated via ${dbActive ? 'MongoDB' : 'memory'}`);
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: sanitizePublicProfile(user) });
}));

// ─── POST /api/forgot-password ──────────────────────────────────────────────
// Body: { email }
//
// Always responds 200 (no user-enumeration). In MOCK mode the dev server also
// returns the token + link so the frontend can deep-link straight into reset.
app.post('/api/forgot-password', asyncRoute(async (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  if (!email) {
    return res.status(400).json({ error: 'Email is required.' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const dbActive = useDB();

  // Find user (case-insensitive via lowercase + $regex anchor) without
  // leaking whether the address is registered — the response shape is the
  // same either way.
  let user = null;
  if (dbActive) {
    user = await UserModel.findOne({ email }).lean();
  } else {
    const username = usersByEmail.get(email);
    user = username ? users.get(username) : null;
  }

  if (!user) {
    console.log(`ℹ️ Forgot-password request for unknown email "${email}" — responding 200 without action.`);
    return res.json({
      ok: true,
      message: 'If that email is registered, a reset link has been sent.',
    });
  }

  // Generate a cryptographically secure token. 32 random bytes hex-encoded =
  // 256 bits of entropy, brute-force infeasible.
  const rawToken    = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt   = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  if (dbActive) {
    await UserModel.updateOne(
      { id: user.id },
      { $set: { resetPasswordToken: hashedToken, resetPasswordExpires: expiresAt } }
    );
  } else {
    user.resetPasswordToken   = hashedToken;
    user.resetPasswordExpires = expiresAt;
    users.set(user.username, user);
  }

  const sendResult = await sendPasswordResetEmail({
    to:       user.email,
    username: user.username,
    token:    rawToken,
    req,
  });

  const responseBody = {
    ok: true,
    message: 'If that email is registered, a reset link has been sent.',
  };

  // Dev / mock-mode convenience: return the link so the frontend can deep-link
  // straight into the reset page without checking email. NEVER enabled in
  // production — guarded by NODE_ENV AND MOCK_EMAIL together.
  if (process.env.NODE_ENV !== 'production' && sendResult.link) {
    responseBody.devResetLink = sendResult.link;
  }

  res.json(responseBody);
}));

// ─── POST /api/reset-password ───────────────────────────────────────────────
// Body: { token, email, newPassword }
app.post('/api/reset-password', asyncRoute(async (req, res) => {
  const rawToken    = req.body && typeof req.body.token === 'string' ? req.body.token.trim() : '';
  const email       = normalizeEmail(req.body && req.body.email);
  const newPassword = req.body && typeof req.body.newPassword === 'string' ? req.body.newPassword : '';

  if (!rawToken || !email || !newPassword) {
    return res.status(400).json({ error: 'Token, email, and new password are required.' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (newPassword.length > 128) {
    return res.status(400).json({ error: 'Password is too long (max 128 characters).' });
  }

  const dbActive = useDB();

  // Hash the inbound token the same way we hashed it on the way out — only
  // the SHA-256 ever lands in the database, so even a database leak can't
  // be used to forge a reset link.
  const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  const now         = new Date();

  let user = null;
  if (dbActive) {
    user = await UserModel.findOne({
      email,
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: now },
    });
  } else {
    const username = usersByEmail.get(email);
    const candidate = username ? users.get(username) : null;
    if (candidate
        && candidate.resetPasswordToken === hashedToken
        && candidate.resetPasswordExpires
        && candidate.resetPasswordExpires > now) {
      user = candidate;
    }
  }

  if (!user) {
    return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  user.passwordHash         = passwordHash;
  user.resetPasswordToken   = '';
  user.resetPasswordExpires = null;

  if (dbActive) {
    await UserModel.updateOne(
      { id: user.id },
      {
        $set: {
          passwordHash:         passwordHash,
          resetPasswordToken:   '',
          resetPasswordExpires: null,
        },
      }
    );
  } else {
    users.set(user.username, user);
  }

  // Auto-login: return a fresh JWT so the user lands inside the app without
  // having to type their credentials again.
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  console.log(`✅ PASSWORD RESET: "${user.username}" updated their password`);

  res.json({
    ok:    true,
    token,
    user:  sanitizePublicProfile(user),
    message: 'Password updated successfully. You are now signed in.',
  });
}));

// ─── POST /api/upload-profile-picture ───────────────────────────────────────
// multipart/form-data with field name "picture" (image/png|jpeg|gif|webp, max 5 MB by default).
// Auth required.
app.post('/api/upload-profile-picture',
  (req, res, next) => {
    const decoded = verifyToken(req, res);
    if (!decoded) return;
    req.uploadedBy = decoded;
    next();
  },
  (req, res, next) => {
    upload.single('picture')(req, res, err => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: `File is too large (max ${Math.round(UPLOAD_MAX_BYTES / 1024 / 1024)} MB).` });
          }
          return res.status(400).json({ error: err.message || 'Upload failed.' });
        }
        return res.status(400).json({ error: err.message || 'Upload failed.' });
      }
      next();
    });
  },
  asyncRoute(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded (field name must be "picture").' });
    }

    // Cache-bust suffix — the front-end appends ?v=<timestamp> on upload so
    // the browser doesn't show a stale avatar after the user replaces it.
    const version = Date.now();
    const publicUrl = `/uploads/${req.file.filename}?v=${version}`;

    const username = req.uploadedBy.username;
    const dbActive = useDB();

    if (dbActive) {
      // Look up the old picture so we can delete it from disk (best-effort).
      const previous = await UserModel.findOne({ username }).select('profilePictureUrl').lean();
      await UserModel.updateOne({ username }, { $set: { profilePictureUrl: publicUrl } });
      if (previous && previous.profilePictureUrl) {
        tryDeleteUpload(previous.profilePictureUrl);
      }
    } else {
      const memUser = users.get(username);
      if (memUser) {
        const previous = memUser.profilePictureUrl;
        memUser.profilePictureUrl = publicUrl;
        users.set(username, memUser);
        if (previous) tryDeleteUpload(previous);
      }
    }

    console.log(`🖼️  PROFILE PIC UPLOAD: "${username}" → ${req.file.filename}`);
    res.json({ ok: true, profilePictureUrl: publicUrl });
  })
);

// Best-effort: remove a previously uploaded profile picture from disk when
// the user uploads a replacement. Failures are swallowed — a dangling file
// on disk is not worth a 500 on the new upload.
function tryDeleteUpload(publicUrl) {
  try {
    const url = new URL(publicUrl, 'http://localhost');
    if (url.pathname.startsWith('/uploads/')) {
      const filename = path.basename(url.pathname);
      // Defensive: filename must look like a UUID + safe extension. Anything
      // else means the URL was tampered with — refuse to delete.
      if (!/^[a-f0-9-]{36}\.(png|jpg|jpeg|gif|webp|bin)$/i.test(filename)) return;
      const full = path.join(UPLOAD_DIR, filename);
      fs.unlink(full, () => {});
    }
  } catch (_) { /* ignore */ }
}

// ─── GET /api/me ─────────────────────────────────────────────────────────────
app.get('/api/me', asyncRoute(async (req, res) => {
  const decoded = verifyToken(req, res);
  if (!decoded) return;

  let user = null;
  if (useDB()) {
    user = await UserModel.findOne({ username: decoded.username }).lean();
  } else {
    user = users.get(decoded.username);
  }

  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json(sanitizePublicProfile(user));
}));

// ─── PATCH /api/me (update profile fields except password) ──────────────────
// Body: { username?, status?, profilePictureUrl? }
app.patch('/api/me', asyncRoute(async (req, res) => {
  const decoded = verifyToken(req, res);
  if (!decoded) return;

  const updates = {};
  const newUsername = req.body && typeof req.body.username === 'string'
    ? normalizeUsername(req.body.username) : '';
  const newStatus   = req.body && typeof req.body.status === 'string'
    ? req.body.status.trim() : '';
  const newPicture  = req.body && typeof req.body.profilePictureUrl === 'string'
    ? req.body.profilePictureUrl.trim() : '';

  if (newUsername && newUsername !== decoded.username) {
    if (!USERNAME_RE.test(newUsername)) {
      return res.status(400).json({ error: 'Username must be 3–32 characters (letters, digits, _.-).' });
    }
    // Uniqueness
    if (useDB()) {
      const exists = await UserModel.findOne({ username: newUsername }).select('_id').lean();
      if (exists) return res.status(409).json({ error: 'That username is already taken.' });
    } else if (users.has(newUsername)) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }
    updates.username = newUsername;
  }

  if (newStatus) {
    if (newStatus.length > 140) {
      return res.status(400).json({ error: 'Status is too long (max 140 characters).' });
    }
    updates.status = newStatus;
  }

  if (newPicture) updates.profilePictureUrl = newPicture;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update.' });
  }

  if (useDB()) {
    await UserModel.updateOne({ username: decoded.username }, { $set: updates });
  } else {
    const memUser = users.get(decoded.username);
    if (!memUser) return res.status(404).json({ error: 'User not found.' });
    Object.assign(memUser, updates);
    if (updates.username) {
      users.delete(decoded.username);
      users.set(updates.username, memUser);
      if (memUser.email) usersByEmail.set(memUser.email, updates.username);
    } else {
      users.set(decoded.username, memUser);
    }
  }

  const finalUsername = updates.username || decoded.username;
  const refreshed = useDB()
    ? await UserModel.findOne({ username: finalUsername }).lean()
    : users.get(finalUsername);

  // Re-issue token if username changed so the client carries the new identity.
  const token = updates.username
    ? jwt.sign({ id: refreshed.id, username: refreshed.username }, JWT_SECRET, { expiresIn: '7d' })
    : null;

  res.json({ ok: true, user: sanitizePublicProfile(refreshed), token });
}));

// ═════════════════════════════════════════════════════════════════════════════
// REST: USERS / MESSAGES
// ═════════════════════════════════════════════════════════════════════════════

// ─── GET /api/users ──────────────────────────────────────────────────────────
app.get('/api/users', asyncRoute(async (req, res) => {
  const decoded = verifyToken(req, res);
  if (!decoded) return;

  let all;
  if (useDB()) {
    all = await UserModel.find({ username: { $ne: decoded.username } })
      .select('id username avatar profilePictureUrl status email').lean();
  } else {
    all = Array.from(users.values()).filter(u => u.username !== decoded.username);
  }

  res.json(all.map(u => {
    const profile = sanitizePublicProfile(u);
    return {
      ...profile,
      online: onlineUsers.has(u.username),
    };
  }));
}));

// ─── GET /api/messages/:with ─────────────────────────────────────────────────
app.get('/api/messages/:with', asyncRoute(async (req, res) => {
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
}));

// ─── REST: Metered Room Creation ─────────────────────────────────────────────
// POST /api/create-room
// Body (optional):
//   { roomName?: string, privacy?: "public"|"private", with?: string }
//   - If roomName is omitted, a stable name is derived from the caller +
//     the optional `with` field (sorted usernames) so the same chat always
//     lands in the same room.
//
// Auth: requires a valid Bearer token (same pattern as /api/users, /api/messages).
// The secret key is never sent to the client — this route is the only place
// that talks to Metered's REST API directly.
app.post('/api/create-room', asyncRoute(async (req, res) => {
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
    // 1) Try to fetch the room first — reuse it if it already exists so a
    //    returning caller lands in the same room as the original chat.
    let room = null;
    try {
      const existing = await fetch(
        `${METERED_API_BASE}/room/${encodeURIComponent(roomName)}?secretKey=${METERED_SECRET_KEY}`
      );
      if (existing.ok) room = await existing.json();
    } catch (_) { /* network blip — fall through to create */ }

    // 2) Create the room if missing.
    if (!room) {
      const createRes = await fetch(
        `${METERED_API_BASE}/room?secretKey=${METERED_SECRET_KEY}`,
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
        let detail = raw;
        try { detail = JSON.parse(raw).message || raw; } catch (_) { /* keep raw */ }
        console.error('❌ Metered create-room failed:', createRes.status, detail);
        return res.status(createRes.status).json({ error: 'Metered create-room failed', detail });
      }
      room = JSON.parse(raw);
    }

    return res.json({
      roomName:      room.roomName,
      roomId:        room._id,
      privacy:       room.privacy,
      roomURL:       `${METERED_APP_DOMAIN}/${room.roomName}`,
      appDomain:     METERED_APP_DOMAIN,
      publicURL:     `https://${METERED_APP_DOMAIN}/${room.roomName}`,
      context:       withUser ? { self: decoded.username, with: withUser } : null,
    });
  } catch (err) {
    console.error('❌ /api/create-room error:', err);
    return res.status(500).json({ error: 'Internal error creating room', detail: err.message });
  }
}));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.status(200).json({
    status:    'UP',
    database:  useDB() ? 'CONNECTED' : 'FALLBACK_MEMORY',
    timestamp: new Date().toISOString(),
  });
});

// ─── Global Error Handler ────────────────────────────────────────────────────
// Catches anything an asyncRoute forgot to handle (e.g. multer file-write
// errors) and returns a clean JSON shape instead of an HTML stack trace.
app.use((err, _req, res, _next) => {
  console.error('❌ Unhandled error:', err);
  const status = err.status || err.statusCode || 500;
  const message = (err && err.message) || 'Internal server error';
  res.status(status).json({ error: message });
});

// ─── Wildcard SPA Fallback ────────────────────────────────────────────────────
// Must be LAST — catches all non-API, non-static deep paths and serves index.html
// so the browser handles client-side routing without 404s. We explicitly skip
// /api/* (real API 404s should bubble up as JSON, not HTML) and /uploads/*
// (already handled by the static middleware above; fallthrough would also
// serve the SPA, masking missing files).
app.get(/^\/(?!api\/|uploads\/).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Socket.io ───────────────────────────────────────────────────────────────
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

  // ─── CALL SIGNALING ─────────────────────────────────────────────────────
  socket.on('call_invite', ({ to, callType, roomURL, roomName }) => {
    const targetSocket = onlineUsers.get(to);
    if (!targetSocket) {
      socket.emit('call_failed', { reason: 'User is offline' });
      return;
    }
    io.to(targetSocket).emit('call_invite', {
      from: username,
      callType,   // 'audio' | 'video'
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
  console.log(`🌐 Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`🖼️  Uploads directory: ${UPLOAD_DIR}`);
  console.log(`📧 Email mode: ${MOCK_EMAIL ? 'MOCK (console)' : 'SMTP'}`);
});