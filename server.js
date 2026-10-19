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
const MAX_ROOM_MEDIA_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_MEDIA_BYTES = 256 * 1024 * 1024;
const MAX_ROOMS = 250;
const MAX_CONNECTIONS = 500;
const EMPTY_ROOM_TTL_MS = 60 * 1000;
const MESSAGE_TTL_MS = 2 * 60 * 1000;
const ROOM_CLEANUP_INTERVAL_MS = 1000;
const MESSAGE_CLEANUP_INTERVAL_MS = 1000;
const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 8);
const ALLOWED_REACTIONS = new Set(['👍', '❤️', '😂', '👀', '😮', '🍑', '😢', '🔥', '👏', '🎉', '💦', '😭', '😉', '🥵']);
let totalMediaBytes = 0;

function destroyRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  totalMediaBytes -= room.mediaBytes;
  rooms.delete(roomId);
}

function cleanupExpiredEmptyRooms(now = Date.now()) {
  for (const [roomId, room] of rooms) {
    if (room.users.size === 0 && now - room.createdAt >= EMPTY_ROOM_TTL_MS) {
      destroyRoom(roomId);
    }
  }
}

const roomCleanupInterval = setInterval(cleanupExpiredEmptyRooms, ROOM_CLEANUP_INTERVAL_MS);
roomCleanupInterval.unref();

const messageCleanupInterval = setInterval(cleanupExpiredMessages, MESSAGE_CLEANUP_INTERVAL_MS);
messageCleanupInterval.unref();

io.use((socket, next) => {
  if (io.engine.clientsCount > MAX_CONNECTIONS) {
    return next(new Error('Server is at capacity. Please try again shortly.'));
  }
  next();
});

// User avatar colors palette
const COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316',
  '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
];

// ─── API Routes ─────────────────────────────────────────────────────────────
app.get('/api/create-room', (req, res) => {
  cleanupExpiredEmptyRooms();
  if (rooms.size >= MAX_ROOMS) {
    return res.status(503).json({ error: 'Chat spaces are at capacity. Try again shortly.' });
  }

  const roomId = `space-${nanoid()}`;
  rooms.set(roomId, {
    users: new Map(),
    history: [],
    media: new Map(),
    mediaBytes: 0,
    reactions: new Map(),
    createdAt: Date.now(),
  });
  res.json({ roomId });
});

app.get('/api/room/:roomId/exists', (req, res) => {
  const { roomId } = req.params;
  res.json({ exists: rooms.has(roomId), count: rooms.get(roomId)?.users?.size || 0 });
});

// SPA fallback: serve space.html for /space/* routes
app.get('/space/:roomId', (req, res) => {
  cleanupExpiredEmptyRooms();
  if (!rooms.has(req.params.roomId)) return res.redirect('/');
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
    cleanupExpiredEmptyRooms();
    const room = rooms.get(safeRoom);
    if (!room) return socket.emit('error', { message: 'Space not found.' });
    if (currentRoom === safeRoom) return;
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

    room.users.set(socket.id, currentUser);
    socket.join(safeRoom);

    // Send existing history to the new joiner
    cleanupExpiredMessages(Date.now(), safeRoom);
    socket.emit('room-history', {
      history: room.history.map((message) => {
        const reactions = summarizeReactions(room.reactions.get(message.id));
        if (message.type !== 'media') return { ...message, reactions };
        const media = room.media.get(message.id);
        const isSender = media?.senderId === socket.id;
        const canViewMedia = Boolean(media && (
          media.viewLimit === null || isSender || media.recipientIds.has(socket.id)
        ));
        const viewsUsed = media?.viewsByRecipient.get(socket.id) || 0;
        return {
          ...message,
          reactions,
          canViewMedia,
          remainingViews: media?.viewLimit === null
            ? null
            : media ? Math.max(0, media.viewLimit - viewsUsed) : 0,
          expired: message.expired || !media,
        };
      }),
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
  socket.on('send-media', ({ mediaType, mimeType, data, previewData, viewLimit, duration }) => {
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

    if (typeof data !== 'string' || data.length === 0) {
      return socket.emit('error', { message: 'Invalid media data.' });
    }

    // Validate decoded file size; storage quotas also include the base64 preview.
    const approxBytes = data.length * 0.75;
    const limits = { image: 10 * 1024 * 1024, video: 50 * 1024 * 1024, audio: 10 * 1024 * 1024 };
    const category = mimeType.startsWith('image') ? 'image' : mimeType.startsWith('video') ? 'video' : 'audio';
    if (approxBytes > limits[category]) {
      return socket.emit('error', { message: `File exceeds size limit for ${category}.` });
    }

    const room = rooms.get(currentRoom);
    if (!room) return;
    const safePreviewData = typeof previewData === 'string' ? previewData.slice(0, 200000) : null;
    const storageBytes = Buffer.byteLength(data, 'utf8') + Buffer.byteLength(safePreviewData || '', 'utf8');
    if (room.mediaBytes + storageBytes > MAX_ROOM_MEDIA_BYTES) {
      return socket.emit('error', { message: 'This space has reached its temporary media storage limit.' });
    }
    if (totalMediaBytes + storageBytes > MAX_TOTAL_MEDIA_BYTES) {
      return socket.emit('error', { message: 'Temporary media storage is full. Try again later.' });
    }
    const safeViewLimit = Number(viewLimit);
    if (![1, 2].includes(safeViewLimit)) {
      return socket.emit('error', { message: 'Invalid media view limit.' });
    }
    const recipientIds = new Set(
      Array.from(room.users.keys()).filter((userId) => userId !== currentUser.id)
    );
    if (recipientIds.size === 0) {
      return socket.emit('error', { message: 'Join at least one recipient before sending view-limited media.' });
    }
    const msg = {
      type: 'media',
      mediaType: category,
      mimeType,
      id: `media-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      previewData: safePreviewData,
      viewLimit: safeViewLimit,
      duration: duration || null,
      sender: { id: currentUser.id, name: currentUser.name, color: currentUser.color },
      timestamp: Date.now(),
    };

    room.media.set(msg.id, {
      data,
      mimeType,
      sizeBytes: storageBytes,
      viewLimit: safeViewLimit,
      senderId: currentUser.id,
      recipientIds,
      viewsByRecipient: new Map(),
      activeViews: new Set(),
    });
    room.mediaBytes += storageBytes;
    totalMediaBytes += storageBytes;
    addToHistory(currentRoom, msg);
    io.to(currentRoom).emit('message', msg);
  });

  socket.on('request-media', ({ msgId, requestId } = {}) => {
    if (!currentRoom || !currentUser) return;
    const room = rooms.get(currentRoom);
    const media = room?.media.get(msgId);
    if (!media) return socket.emit('media-unavailable', { msgId, requestId });

    const isSender = currentUser.id === media.senderId;
    let remainingViews = null;
    if (!isSender && media.viewLimit !== null) {
      if (!media.recipientIds.has(socket.id)) {
        return socket.emit('media-unavailable', { msgId, requestId, reason: 'not-eligible' });
      }
      if (media.activeViews.has(socket.id)) {
        return socket.emit('media-unavailable', { msgId, requestId, reason: 'already-open' });
      }
      const viewsUsed = media.viewsByRecipient.get(socket.id) || 0;
      if (viewsUsed >= media.viewLimit) {
        return socket.emit('media-unavailable', { msgId, requestId, reason: 'views-used' });
      }
      media.viewsByRecipient.set(socket.id, viewsUsed + 1);
      media.activeViews.add(socket.id);
      remainingViews = media.viewLimit - viewsUsed - 1;
    }

    socket.emit('media-content', {
      msgId,
      requestId,
      data: media.data,
      mimeType: media.mimeType,
      senderPreview: isSender,
      remainingViews,
    });
  });

  socket.on('finish-media-view', ({ msgId } = {}) => {
    if (!currentRoom || !currentUser) return;
    const room = rooms.get(currentRoom);
    const media = room?.media.get(msgId);
    if (!media || !media.activeViews.delete(socket.id)) return;
    expireMediaIfFullyViewed(currentRoom, msgId, media);
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
    if (!ALLOWED_REACTIONS.has(emoji)) return;
    const room = rooms.get(currentRoom);
    if (!room?.history.some((message) => message.id === msgId && message.type !== 'system')) return;
    const messageReactions = room.reactions.get(msgId) || new Map();
    const previousReaction = messageReactions.get(socket.id);
    if (previousReaction?.emoji === emoji) return;

    messageReactions.set(socket.id, { emoji, name: currentUser.name });
    room.reactions.set(msgId, messageReactions);
    io.to(currentRoom).emit('reaction', {
      msgId,
      emoji,
      userId: socket.id,
      userName: currentUser.name,
      previousEmoji: previousReaction?.emoji || null,
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

    for (const [msgId, media] of room.media) {
      if (!media.recipientIds?.delete(sock.id)) continue;
      media.viewsByRecipient.delete(sock.id);
      media.activeViews.delete(sock.id);
      expireMediaIfFullyViewed(roomId, msgId, media);
    }

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

    if (room.users.size === 0) {
      destroyRoom(roomId);
      console.log(`[GC] Room ${roomId} destroyed (empty)`);
    }
  }
});

// ─── History helper ─────────────────────────────────────────────────────────
function addToHistory(roomId, msg) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.history.push(msg);
  if (room.history.length > MAX_HISTORY) {
    const removed = room.history.shift();
    room.reactions.delete(removed.id);
    io.to(roomId).emit('message-expired', { msgId: removed.id });
    if (removed.type === 'media') {
      const media = room.media.get(removed.id);
      if (media) {
        room.mediaBytes -= media.sizeBytes;
        totalMediaBytes -= media.sizeBytes;
      }
      room.media.delete(removed.id);
    }
  }
}

function summarizeReactions(messageReactions = new Map()) {
  const reactionsByEmoji = new Map();
  for (const [userId, reaction] of messageReactions) {
    const users = reactionsByEmoji.get(reaction.emoji) || [];
    users.push({ id: userId, name: reaction.name });
    reactionsByEmoji.set(reaction.emoji, users);
  }
  return Array.from(reactionsByEmoji, ([emoji, users]) => ({ emoji, users }));
}

function cleanupExpiredMessages(now = Date.now(), onlyRoomId = null) {
  const roomsToCheck = onlyRoomId
    ? [[onlyRoomId, rooms.get(onlyRoomId)]]
    : rooms;

  for (const [roomId, room] of roomsToCheck) {
    if (!room) continue;
    for (let index = room.history.length - 1; index >= 0; index--) {
      const message = room.history[index];
      if (now - message.timestamp >= MESSAGE_TTL_MS) {
        expireRoomMessage(roomId, message.id);
      }
    }
  }
}

function expireRoomMessage(roomId, msgId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const messageIndex = room.history.findIndex((message) => message.id === msgId);
  if (messageIndex === -1) return;

  const [message] = room.history.splice(messageIndex, 1);
  room.reactions.delete(msgId);
  if (message.type === 'media') {
    const media = room.media.get(msgId);
    if (media) {
      room.media.delete(msgId);
      room.mediaBytes -= media.sizeBytes;
      totalMediaBytes -= media.sizeBytes;
    }
  }
  io.to(roomId).emit('message-expired', { msgId });
}

function expireRoomMedia(roomId, msgId) {
  const room = rooms.get(roomId);
  const media = room?.media.get(msgId);
  if (!room || !media) return;

  room.media.delete(msgId);
  room.mediaBytes -= media.sizeBytes;
  totalMediaBytes -= media.sizeBytes;
  const historyMessage = room.history.find((message) => message.id === msgId);
  if (historyMessage) {
    historyMessage.expired = true;
    historyMessage.previewData = null;
  }
  io.to(roomId).emit('media-expired', { msgId });
  console.log(`[MEDIA EXPIRED] ${msgId} removed from ${roomId}`);
}

function expireMediaIfFullyViewed(roomId, msgId, media) {
  if (media.viewLimit === null || media.activeViews.size > 0) return;
  const allViewsUsed = Array.from(media.recipientIds).every((recipientId) =>
    (media.viewsByRecipient.get(recipientId) || 0) >= media.viewLimit
  );
  if (allViewsUsed) expireRoomMedia(roomId, msgId);
}

// ─── Start Server ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 chyatt server running at http://localhost:${PORT}\n`);
});

module.exports = app;
