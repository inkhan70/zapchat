require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);

const JWT_SECRET = process.env.JWT_SECRET || 'zapchat_super_secret_key_2024';
const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

// ─── In-Memory Store (replace with DB in production) ───────────────────────
const users = new Map();        // username → { id, username, passwordHash, avatar, createdAt }
const sessions = new Map();     // socketId → { userId, username }
const messages = new Map();     // roomId → [{ id, from, to, text, timestamp, read }]
const onlineUsers = new Map();  // username → socketId

// ─── Express Middleware ─────────────────────────────────────────────────────
app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client/public')));

// ─── REST API ───────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  if (users.has(username)) return res.status(409).json({ error: 'Username already taken' });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    username,
    passwordHash,
    avatar: username.charAt(0).toUpperCase(),
    status: 'Hey there! I am using ZapChat.',
    createdAt: new Date().toISOString()
  };
  users.set(username, user);
  const token = jwt.sign({ id: user.id, username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username, avatar: user.avatar, status: user.status } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = users.get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username, avatar: user.avatar, status: user.status } });
});

app.get('/api/users', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const allUsers = Array.from(users.values())
      .filter(u => u.username !== decoded.username)
      .map(u => ({
        id: u.id,
        username: u.username,
        avatar: u.avatar,
        status: u.status,
        online: onlineUsers.has(u.username)
      }));
    res.json(allUsers);
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.get('/api/messages/:with', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const roomId = getRoomId(decoded.username, req.params.with);
    const roomMessages = messages.get(roomId) || [];
    res.json(roomMessages);
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Serve client on non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/public/index.html'));
});

// ─── Socket.IO ──────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: CLIENT_URL, methods: ['GET', 'POST'], credentials: true }
});

function getRoomId(a, b) {
  return [a, b].sort().join('::');
}

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = decoded;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const { username } = socket.user;
  onlineUsers.set(username, socket.id);
  sessions.set(socket.id, { username });

  console.log(`✅ ${username} connected (${socket.id})`);

  // Broadcast online status
  io.emit('user_status', { username, online: true });

  // Send current online users list
  const onlineList = Array.from(onlineUsers.keys());
  socket.emit('online_users', onlineList);

  // ── Private Message ──────────────────────────────
  socket.on('private_message', ({ to, text }) => {
    if (!text || !text.trim() || !to) return;
    const msg = {
      id: uuidv4(),
      from: username,
      to,
      text: text.trim(),
      timestamp: new Date().toISOString(),
      read: false
    };

    const roomId = getRoomId(username, to);
    if (!messages.has(roomId)) messages.set(roomId, []);
    messages.get(roomId).push(msg);

    // Send to recipient if online
    const recipientSocketId = onlineUsers.get(to);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('private_message', msg);
    }

    // Echo back to sender
    socket.emit('message_sent', msg);
  });

  // ── Typing Indicator ─────────────────────────────
  socket.on('typing_start', ({ to }) => {
    const recipientSocketId = onlineUsers.get(to);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('typing_start', { from: username });
    }
  });

  socket.on('typing_stop', ({ to }) => {
    const recipientSocketId = onlineUsers.get(to);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('typing_stop', { from: username });
    }
  });

  // ── Read Receipts ────────────────────────────────
  socket.on('mark_read', ({ from }) => {
    const roomId = getRoomId(username, from);
    const roomMessages = messages.get(roomId) || [];
    roomMessages.forEach(msg => {
      if (msg.to === username) msg.read = true;
    });

    const senderSocketId = onlineUsers.get(from);
    if (senderSocketId) {
      io.to(senderSocketId).emit('messages_read', { by: username });
    }
  });

  // ── Disconnect ───────────────────────────────────
  socket.on('disconnect', () => {
    onlineUsers.delete(username);
    sessions.delete(socket.id);
    io.emit('user_status', { username, online: false });
    console.log(`❌ ${username} disconnected`);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 ZapChat server running on http://localhost:${PORT}`);
});
