const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const io = require('../node_modules/socket.io/client-dist/socket.io.js');
const { base64Bytes } = require('../lib/socket-guard');
const once = (socket, event, wait = 5000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timeout: ${event}`)), wait);
  socket.once(event, data => { clearTimeout(timer); resolve(data); });
});
const ack = (socket, event, payload) => new Promise((resolve, reject) => socket.timeout(4000).emit(event, payload, (err, data) => err ? reject(err) : resolve(data)));

test('malformed events cannot crash the server; chat, locks, names and media remain functional', async () => {
  const port = 42000 + Math.floor(Math.random() * 10000);
  const base = `http://localhost:${port}`;
  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const sockets = [];
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Startup timeout')), 25000);
      server.stdout.once('data', () => { clearTimeout(timer); resolve(); });
      server.once('error', reject);
    });
    async function connect() {
      const socket = io(base, { transports: ['websocket'], forceNew: true, reconnection: false });
      sockets.push(socket); await once(socket, 'connect'); return socket;
    }
    const a = await connect();
    for (const event of ['join-room', 'send-message', 'send-media', 'react', 'request-media', 'finish-media-view', 'call-decline', 'call-leave']) {
      assert.match((await ack(a, event, null)).error, /Invalid/);
    }
    assert.equal((await fetch(base)).status, 200);
    const { roomId } = await (await fetch(`${base}/api/create-room`)).json();
    const join = async socket => {
      const history = once(socket, 'room-history');
      socket.emit('join-room', { roomId, displayName: 'Same name' });
      return history;
    };
    await join(a);
    const b = await connect();
    const history = await join(b);
    assert.equal(new Set(history.users.map(user => user.name.toLowerCase())).size, 2);
    const text = 'Hello & <world> https://example.com/path?a=1&b=2';
    const received = once(b, 'message'); a.emit('send-message', { text, replyTo: null });
    assert.equal((await received).text, text);
    assert.match((await ack(a, 'send-message', { text: 'bad', replyTo: { big: 'x'.repeat(9000) } })).error, /Invalid/);
    assert.match((await ack(a, 'send-media', { mimeType: 7, data: 'AAAA', viewLimit: 1 })).error, /Invalid/);
    const mediaEvent = once(b, 'message');
    a.emit('send-media', { mimeType: 'audio/webm', data: 'AAAA', viewLimit: 1, duration: 1 });
    const media = await mediaEvent;
    const content = once(b, 'media-content');
    b.emit('request-media', { msgId: media.id, requestId: 'one' });
    assert.equal((await content).data, 'AAAA');
    const unavailable = once(b, 'media-unavailable');
    b.emit('request-media', { msgId: media.id, requestId: 'two' });
    assert.equal((await unavailable).reason, 'already-open');
    const locked = once(a, 'room-access'); a.emit('room-lock', { locked: true });
    assert.equal((await locked).locked, true);
    b.emit('room-lock', { locked: false }); await ack(b, 'call-config', {});
    const c = await connect();
    const denied = once(c, 'error'); c.emit('join-room', { roomId, displayName: 'Other' });
    assert.match((await denied).message, /locked/);
    const unlocked = once(a, 'room-access'); a.emit('room-lock', { locked: false }); await unlocked;
    await join(c);
    let typing = 0;
    b.on('user-typing', () => { typing++; });
    for (let i = 0; i < 30; i++) c.emit('typing-start');
    await ack(c, 'call-config', {});
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(typing, 10);
    // Exercise the actual base64 transport boundary, rather than just the UI limit.
    const videoEvent = once(b, 'message', 20000);
    a.emit('send-media', { mimeType: 'video/mp4', data: Buffer.alloc(50 * 1024 * 1024).toString('base64'), viewLimit: 1 });
    assert.equal((await videoEvent).mediaType, 'video');
    assert.equal((await fetch(base)).status, 200);
  } finally { sockets.forEach(socket => socket.disconnect()); server.kill(); }
});

test('base64 validation counts decoded bytes and rejects malformed data', () => {
  assert.equal(base64Bytes('YQ=='), 1);
  assert.equal(base64Bytes('YWI='), 2);
  for (const invalid of ['x', '====', 'AA=A', '<bad', '', null]) assert.equal(base64Bytes(invalid), -1);
});
