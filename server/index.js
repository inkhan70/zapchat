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
const MONGODB_URI = process.env.MONGODB_URI;

// ——— MongoDB Connection Setup ———
let isMongoConnected = false;

if (MONGODB_URI) {
  // Performance optimizations for Mongoose production connections
  mongoose.connect(MONGODB_URI, {
    maxPoolSize: 10,       // Maintains up to 10 parallel socket connections
    minPoolSize: 2,        // Keeps at least 2 connections open
    socketTimeoutMS: 45000,// Close sockets after 45s of inactivity
  })
  .then(() => {
    isMongoConnected = true;
    console.log('✅ MongoDB connected successfully');
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
  });
}

// ─── Optimized MongoDB Schemas & Compound Indexes ──────────────────────────
const UserSchema = new mongoose.Schema({
  id:           { type: String, required: true, unique: true },
  username:     { type: String, required: true, unique: true, index: true }, // Optimized user lookups
  passwordHash: { type: String, required: true },
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

// CRITICAL PERFORMANCE FIX: Compound Index for fast retrieval and status updates
MessageSchema.index({ roomId: 1, timestamp: 1 });
MessageSchema.index({ roomId: 1, to: 1, read: 1 }); 

const UserModel    = mongoose.models.User    || mongoose.model('User',    UserSchema);
const MessageModel = mongoose.models.Message || mongoose.model('Message', MessageSchema);

// ─── In-Memory Fallback Store ──────────────────────────────────────────────
const users       = new Map();
const messages    = new Map();
const onlineUsers = new Map(); // username -> socket.id

// ─── Express Middleware ─────────────────────────────────────────────────────
app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helper Functions ───────────────────────────────────────────────────────
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

// Helper to determine if DB logic should execute safely
function useDB() {
  return isMongoConnected && mongoose.connection.readyState === 1;
}

// ─── REST API ───────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3)     return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 4)     return res.status(400).json({ error: 'Password must be at least 4 characters' });

  const cleanUsername = username.trim();

  if (useDB()) {
    const exists = await UserModel.findOne({ username: cleanUsername }).select('_id').lean();
    if (exists) return res.status(409).json({ error: 'Username already taken' });
  } else {
    if (users.has(cleanUsername)) return res.status(409).json({ error: 'Username already taken' });
  }

  // Cost factor 10 balances cryptographic safety and password processing speeds
  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(), 
    username: cleanUsername, 
    passwordHash,
    avatar: cleanUsername.charAt(0).toUpperCase(),
    status: 'Hey there! I am using ZapChat.',
    createdAt: new Date(),
  };

  if (useDB()) {
    await UserModel.create(user);
  } else {
    users.set(cleanUsername, user);
  }

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar, status: user.status } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  let user;
  if (useDB()) {
    // Optimization: lean() drops Mongoose overhead, select limits network payload
    user = await UserModel.findOne({ username: username.trim() }).lean();
  } else {
    user = users.get(username.trim());
  }

  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar, status: user.status } });
});

app.get('/api/users', async (req, res) => {
  const decoded = verifyToken(req, res);
  if (!decoded) return;

  let allUsers;
  if (useDB()) {
    allUsers = await UserModel.find({ username: { $ne: decoded.username } })
      .select('id username avatar status')
      .lean();
  } else {
    allUsers = Array.from(users.values()).filter(u => u.username !== decoded.username);
  }

  res.json(allUsers.map(u => ({
    id: u.id, 
    username: u.username, 
    avatar: u.avatar, 
    status: u.status,
    online: onlineUsers.has(u.username),
  })));
});

app.get('/api/messages/:with', async (req, res) => {
  const decoded = verifyToken(req, res);
  if (!decoded) return;

  const roomId = getRoomId(decoded.username, req.params.with);
  let msgs;
  if (useDB()) {
    msgs = await MessageModel.find({ roomId })
      .sort({ timestamp: 1 })
      .select('id from to text timestamp read')
      .lean();
  } else {
    msgs = messages.get(roomId) || [];
  }
  res.json(msgs);
});

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'UP', 
    database: useDB() ? 'CONNECTED' : 'FALLBACK_MEMORY',
    timestamp: new Date() 
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Optimized Socket.IO Architecture ───────────────────────────────────────
const io = new Server(server, {
  cors: { origin: CLIENT_URL, methods: ['GET', 'POST'], credentials: true },
  transports: ['websocket', 'polling'], // Prioritize stable modern WebSockets first
  pingTimeout: 30000,
  pingInterval: 15000,
  allowUpgrades: true,
  cookie: false
});

// Authentication Interceptor Middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { 
    next(new Error('Invalid token')); 
  }
});

io.on('connection', (socket) => {
  const { username } = socket.user;
  
  onlineUsers.set(username, socket.id);
  console.log(`✅ ${username} connected (${socket.id})`);

  // Broadcast presence efficiently
  socket.broadcast.emit('user_status', { username, online: true });
  socket.emit('online_users', Array.from(onlineUsers.keys()));

  socket.on('private_message', async ({ to, text }) => {
    if (!text?.trim() || !to) return;
    
    const msg = {
      id: uuidv4(), 
      from: username, 
      to,
      text: text.trim(), 
      timestamp: new Date(), 
      read: false,
    };

    const roomId = getRoomId(username, to);
    
    // Fire-and-forget DB save asynchronously so real-time socket delivery isn't delayed
    if (useDB()) {
      MessageModel.create({ ...msg, roomId }).catch(err => console.error('Database message save failed:', err));
    } else {
      if (!messages.has(roomId)) messages.set(roomId, []);
      messages.get(roomId).push(msg);
    }

    const recipientSocketId = onlineUsers.get(to);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('private_message', msg);
    }
    socket.emit('message_sent', msg);
  });

  socket.on('typing_start', ({ to }) => {
    const recipientId = onlineUsers.get(to);
    if (recipientId) io.to(recipientId).emit('typing_start', { from: username });
  });

  socket.on('typing_stop', ({ to }) => {
    const recipientId = onlineUsers.get(to);
    if (recipientId) io.to(recipientId).emit('typing_stop', { from: username });
  });

  socket.on('mark_read', async ({ from }) => {
    const roomId = getRoomId(username, from);
    
    if (useDB()) {
      MessageModel.updateMany(
        { roomId, to: username, read: false }, // Only update unread messages to minimize write IOPS
        { $set: { read: true } }
      ).catch(err => console.error('Read receipt sync error:', err));
    } else {
      const roomMsgs = messages.get(roomId) || [];
      for (let i = 0; i < roomMsgs.length; i++) {
        if (roomMsgs[i].to === username) roomMsgs[i].read = true;
      }
    }

    const senderSocket = onlineUsers.get(from);
    if (senderSocket) io.to(senderSocket).emit('messages_read', { by: username });
  });

  socket.on('disconnect', () => {
    // Only delete entry if it matches the active socket session to prevent multi-tab disconnect collisions
    if (onlineUsers.get(username) === socket.id) {
      onlineUsers.delete(username);
      socket.broadcast.emit('user_status', { username, online: false });
    }
    console.log(`❌ ${username} disconnected`);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 ZapChat server running on port ${PORT}`);
});
