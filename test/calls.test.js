const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const io = require('../node_modules/socket.io/client-dist/socket.io.js');

const event = (socket, name, wait = 4000) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`Timed out: ${name}`)), wait);
  socket.once(name, data => { clearTimeout(timeout); resolve(data); });
});

test('room calls require membership, relay signals, and clean up on disconnect', async () => {
  const port = 32000 + Math.floor(Math.random() * 10000);
  const base = `http://localhost:${port}`;
  const server = spawn(process.execPath, ['server.js'], { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, PORT: String(port), CALL_COOLDOWN_MS: '1000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const sockets = [];
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server startup timeout')), 25000);
      server.stdout.once('data', () => { clearTimeout(timeout); resolve(); });
      server.once('error', reject);
    });
    const room = async () => (await (await fetch(`${base}/api/create-room`)).json()).roomId;
    const roomId = await room();
    const otherRoom = await room();
    async function join(id) {
      const socket = io(base, { transports: ['websocket'], reconnection: false, forceNew: true });
      sockets.push(socket);
      await event(socket, 'connect');
      const history = event(socket, 'room-history');
      socket.emit('join-room', { roomId: id, displayName: 'Tester' });
      await history;
      return socket;
    }
    const a = await join(roomId), b = await join(roomId), c = await join(roomId), outsider = await join(otherRoom);
    const callJoin = (socket, callId) => new Promise((resolve, reject) => socket.timeout(3000).emit('call-join', { callId }, (err, data) => err ? reject(err) : resolve(data)));
    const bRing = event(b, 'call-incoming'), cRing = event(c, 'call-incoming');
    let leaked = false;
    outsider.on('call-incoming', () => { leaked = true; });
    const started = await callJoin(a);
    const { callId } = started;
    assert.deepEqual(started.peers, []);
    assert.equal((await bRing).id, callId);
    assert.equal((await cRing).id, callId);
    assert.match((await callJoin(b)).error, /already in progress/);
    assert.match((await callJoin(outsider, callId)).error, /ended/);
    assert.deepEqual((await callJoin(b, callId)).peers, [a.id]);
    c.emit('call-decline', { callId });
    const signal = event(b, 'call-signal');
    a.emit('call-signal', { to: b.id, callId, description: { type: 'offer', sdp: 'test' } });
    assert.equal((await signal).from, a.id);
    outsider.on('call-signal', () => { leaked = true; });
    a.emit('call-signal', { to: outsider.id, callId, description: { type: 'offer', sdp: 'test' } });
    // A subsequent acknowledged event establishes that the server processed the signal.
    await callJoin(a, callId);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(leaked, false);
    const endedOnDisconnect = event(a, 'call-ended');
    b.disconnect();
    assert.equal((await endedOnDisconnect).callId, callId);
    assert.match((await callJoin(a)).error, /Please wait/);
    await new Promise(resolve => setTimeout(resolve, 1100));
    const next = await callJoin(a);
    const canceled = event(c, 'call-ended');
    a.emit('call-leave', { callId: next.callId });
    assert.equal((await canceled).callId, next.callId);
    await new Promise(resolve => setTimeout(resolve, 1100));
    const last = await callJoin(a);
    const declined = event(a, 'call-ended');
    c.emit('call-decline', { callId: last.callId });
    assert.equal((await declined).reason, 'Everyone declined');
    await new Promise(resolve => setTimeout(resolve, 1100));
    await callJoin(a);
    assert.equal((await event(a, 'call-ended', 35000)).reason, 'No answer');
  } finally {
    sockets.forEach(socket => socket.disconnect());
    server.kill();
  }
});
