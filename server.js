// =============================================================================
// server.js — fchat Ephemeral Real-Time Chat Server
// Node.js + Express + Socket.io, zero-database, in-memory only
// =============================================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { customAlphabet } = require('nanoid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 55 * 1024 * 1024, // 55MB for chunked media
  cors: {
    origin: process.env.CLIENT_ORIGIN || '*',
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ─── Security Middleware ────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'", 'fonts.googleapis.com', 'cdn.jsdelivr.net'],
        fontSrc: ["'self'", 'fonts.gstatic.com', 'cdn.jsdelivr.net'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api', limiter);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-Memory Store ────────────────────────────────────────────────────────
// rooms: Map<roomId, { users: Map<socketId, {name, color, joinedAt}>, history: Message[] }>
const rooms = new Map();
const MAX_HISTORY = 100; // keep last 100 messages in RAM
const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 8);

// User avatar colors palette
const COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316',
  '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
];

// ─── API Routes ─────────────────────────────────────────────────────────────
app.get('/api/create-room', (req, res) => {
  const roomId = `space-${nanoid()}`;
  res.json({ roomId });
});

app.get('/api/room/:roomId/exists', (req, res) => {
  const { roomId } = req.params;
  res.json({ exists: rooms.has(roomId), count: rooms.get(roomId)?.users?.size || 0 });
});

// SPA fallback: serve space.html for /space/* routes
app.get('/space/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'space.html'));
});

// ─── XSS Sanitizer (server-side, no DOM needed) ─────────────────────────────
function sanitizeText(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;')
    .trim()
    .slice(0, 500); // hard cap on message length
}

function sanitizeName(str) {
  if (typeof str !== 'string') return 'Anonymous';
  return str.replace(/[^a-zA-Z0-9_\- .]/g, '').trim().slice(0, 30) || 'Anonymous';
}

// ─── Socket.io Logic ────────────────────────────────────────────────────────
// Per-socket rate limiting for messages
const socketMsgCounts = new Map(); // socketId -> { count, resetAt }

function checkSocketRate(socketId, limit = 20, windowMs = 10000) {
  const now = Date.now();
  const entry = socketMsgCounts.get(socketId) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count++;
  socketMsgCounts.set(socketId, entry);
  return entry.count <= limit;
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUser = null;

  // ── Join Room ──────────────────────────────────────────────────────────────
  socket.on('join-room', ({ roomId, displayName }) => {
    const safeRoom = (typeof roomId === 'string' ? roomId : '').replace(/[^a-z0-9-]/g, '').slice(0, 50);
    const safeName = sanitizeName(displayName);

    if (!safeRoom) return socket.emit('error', { message: 'Invalid room ID.' });

    // Leave previous room if any
    if (currentRoom) {
      leaveRoom(socket, currentRoom);
    }

    currentRoom = safeRoom;
    const colorIndex = Math.abs(
      safeName.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
    ) % COLORS.length;

    currentUser = {
      id: socket.id,
      name: safeName,
      color: COLORS[colorIndex],
      joinedAt: Date.now(),
    };

    // Init room if new
    if (!rooms.has(safeRoom)) {
      rooms.set(safeRoom, { users: new Map(), history: [] });
    }
    const room = rooms.get(safeRoom);
    room.users.set(socket.id, currentUser);
    socket.join(safeRoom);

    // Send existing history to the new joiner
    socket.emit('room-history', {
      history: room.history,
      users: Array.from(room.users.values()),
      myId: socket.id,
    });

    // Notify all in room of new user
    io.to(safeRoom).emit('user-list', { users: Array.from(room.users.values()) });

    // System join message
    const joinMsg = {
      type: 'system',
      text: sanitizeText(`${safeName} joined the space`),
      timestamp: Date.now(),
      id: `sys-${Date.now()}-${Math.random()}`,
    };
    addToHistory(safeRoom, joinMsg);
    io.to(safeRoom).emit('message', joinMsg);

    console.log(`[JOIN] ${safeName} (${socket.id}) → ${safeRoom} (${room.users.size} users)`);
  });

  // ── Text Message ──────────────────────────────────────────────────────────
  socket.on('send-message', ({ text, replyTo }) => {
    if (!currentRoom || !currentUser) return;
    if (!checkSocketRate(socket.id)) {
      return socket.emit('error', { message: 'Slow down! You are sending messages too fast.' });
    }

    const safeText = sanitizeText(text);
    if (!safeText) return;

    const msg = {
      type: 'text',
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      text: safeText,
      sender: { id: currentUser.id, name: currentUser.name, color: currentUser.color },
      timestamp: Date.now(),
      replyTo: replyTo || null,
    };

    addToHistory(currentRoom, msg);
    io.to(currentRoom).emit('message', msg);
  });

  // ── Media (chunked transfer) ───────────────────────────────────────────────
  // Media is sent as a single payload (base64 encoded) for files < 50MB
  // This keeps architecture simple; for production you'd want proper chunking.
  socket.on('send-media', ({ mediaType, mimeType, data, fileName, duration }) => {
    if (!currentRoom || !currentUser) return;
    if (!checkSocketRate(socket.id, 5, 30000)) {
      return socket.emit('error', { message: 'Media rate limit hit. Please wait.' });
    }

    // Validate mime types
    const allowed = ['image/', 'video/', 'audio/'];
    const isAllowed = allowed.some((prefix) => (mimeType || '').startsWith(prefix));
    if (!isAllowed) {
      return socket.emit('error', { message: 'Invalid media type.' });
    }

    // Validate size limits (data is base64, so actual bytes ≈ data.length * 0.75)
    const approxBytes = (data?.length || 0) * 0.75;
    const limits = { image: 10 * 1024 * 1024, video: 50 * 1024 * 1024, audio: 10 * 1024 * 1024 };
    const category = mimeType.startsWith('image') ? 'image' : mimeType.startsWith('video') ? 'video' : 'audio';
    if (approxBytes > limits[category]) {
      return socket.emit('error', { message: `File exceeds size limit for ${category}.` });
    }

    const msg = {
      type: 'media',
      mediaType: category,
      mimeType,
      id: `media-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      data, // base64 string — lives only in RAM
      fileName: sanitizeText(fileName || 'file'),
      duration: duration || null,
      sender: { id: currentUser.id, name: currentUser.name, color: currentUser.color },
      timestamp: Date.now(),
    };

    // Store a lightweight reference in history (without raw data, to save RAM)
    addToHistory(currentRoom, { ...msg, data: '[media-ref]' });
    // Broadcast full data to room peers
    io.to(currentRoom).emit('message', msg);
  });

  // ── Typing Indicators ─────────────────────────────────────────────────────
  socket.on('typing-start', () => {
    if (!currentRoom || !currentUser) return;
    socket.to(currentRoom).emit('user-typing', { userId: socket.id, name: currentUser.name });
  });
  socket.on('typing-stop', () => {
    if (!currentRoom || !currentUser) return;
    socket.to(currentRoom).emit('user-stop-typing', { userId: socket.id });
  });

  // ── Reaction ──────────────────────────────────────────────────────────────
  socket.on('react', ({ msgId, emoji }) => {
    if (!currentRoom || !currentUser) return;
    const safeEmoji = (emoji || '').slice(0, 2);
    io.to(currentRoom).emit('reaction', {
      msgId,
      emoji: safeEmoji,
      userId: socket.id,
      userName: currentUser.name,
    });
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (currentRoom) leaveRoom(socket, currentRoom);
    socketMsgCounts.delete(socket.id);
  });

  function leaveRoom(sock, roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    const user = room.users.get(sock.id);
    room.users.delete(sock.id);
    sock.leave(roomId);

    if (user) {
      const leaveMsg = {
        type: 'system',
        text: sanitizeText(`${user.name} left the space`),
        timestamp: Date.now(),
        id: `sys-${Date.now()}-${Math.random()}`,
      };
      addToHistory(roomId, leaveMsg);
      io.to(roomId).emit('message', leaveMsg);
      io.to(roomId).emit('user-list', { users: Array.from(room.users.values()) });
      console.log(`[LEAVE] ${user.name} (${sock.id}) ← ${roomId} (${room.users.size} remaining)`);
    }

    // GC empty rooms after 30 seconds
    if (room.users.size === 0) {
      setTimeout(() => {
        const r = rooms.get(roomId);
        if (r && r.users.size === 0) {
          rooms.delete(roomId);
          console.log(`[GC] Room ${roomId} destroyed (empty)`);
        }
      }, 30000);
    }
  }
});

// ─── History helper ─────────────────────────────────────────────────────────
function addToHistory(roomId, msg) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.history.push(msg);
  if (room.history.length > MAX_HISTORY) {
    room.history.shift(); // drop oldest
  }
}

// ─── Start Server ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 chyatt server running at http://localhost:${PORT}\n`);
});

module.exports = app;
