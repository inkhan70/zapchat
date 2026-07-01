const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'zapchat_session';
const JWT_SECRET = process.env.JWT_SECRET;

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function getCookieOptions(maxAge = 7 * 24 * 60 * 60 * 1000) {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: isProduction() ? 'none' : 'lax',
    path: '/',
    maxAge,
  };
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge != null) parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${String(options.sameSite).charAt(0).toUpperCase()}${String(options.sameSite).slice(1)}`);

  return parts.join('; ');
}

function appendCookieHeader(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookie);
    return;
  }

  const next = Array.isArray(existing) ? existing.concat(cookie) : [existing, cookie];
  res.setHeader('Set-Cookie', next);
}

function parseCookies(header = '') {
  return header.split(';').reduce((acc, pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return acc;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function signSession(user) {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is required');
  }
  return jwt.sign(
    {
      sub: String(user._id || user.id),
      username: user.username,
      email: user.email,
      displayName: user.displayName || user.username,
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function setSessionCookie(res, token) {
  appendCookieHeader(res, serializeCookie(COOKIE_NAME, token, getCookieOptions()));
}

function clearSessionCookie(res) {
  appendCookieHeader(
    res,
    serializeCookie(COOKIE_NAME, '', { ...getCookieOptions(0), maxAge: 0 })
  );
}

function getBearerToken(req) {
  const authorization = req.headers.authorization || '';
  if (!authorization.startsWith('Bearer ')) return null;
  return authorization.slice(7).trim() || null;
}

function getSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return cookies[COOKIE_NAME] || getBearerToken(req) || null;
}

function requireAuth(req, res, next) {
  const token = getSessionToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.auth = payload;
    return next();
  } catch {
    return res.status(401).json({ error: 'Session expired or invalid' });
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createResetToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return {
    token,
    tokenHash: hashToken(token),
  };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function makeSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'user';
}

module.exports = {
  COOKIE_NAME,
  appendCookieHeader,
  clearSessionCookie,
  createResetToken,
  getCookieOptions,
  getSessionToken,
  hashToken,
  isProduction,
  makeSlug,
  normalizeEmail,
  normalizeUsername,
  requireAuth,
  serializeCookie,
  setSessionCookie,
  signSession,
  parseCookies,
};
