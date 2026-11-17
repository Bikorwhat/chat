const limits = {
  'room-lock': [6, 10000],
  'join-room': [6, 10000], 'send-message': [12, 10000], 'send-media': [4, 30000],
  'request-media': [6, 30000], 'finish-media-view': [12, 10000],
  'typing-start': [10, 10000], 'typing-stop': [10, 10000], react: [20, 10000],
  'call-config': [12, 10000], 'call-join': [12, 10000], 'call-decline': [12, 10000],
  'call-leave': [12, 10000], 'call-media': [30, 10000], 'call-signal': [120, 10000],
};
const id = value => typeof value === 'string' && /^[\w.-]{1,100}$/.test(value);
const short = (value, max) => typeof value === 'string' && value.length <= max;
const optionalId = value => value == null || id(value);
function valid(event, p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  if (event === 'room-lock') return typeof p.locked === 'boolean';
  if (event === 'join-room') return id(p.roomId) && short(p.displayName, 100);
  if (event === 'send-message') return short(p.text, 500) && optionalId(p.replyTo);
  if (event === 'send-media') return short(p.mimeType, 100) && /^(image|video|audio)\/[a-zA-Z0-9.+-]+(?:;[\w=.+ -]+)?$/.test(p.mimeType)
    && short(p.data, 4 * Math.ceil(50 * 1024 * 1024 / 3))
    && (p.previewData == null || short(p.previewData, 200000))
    && [1, 2].includes(p.viewLimit)
    && (p.duration == null || (typeof p.duration === 'number' && Number.isFinite(p.duration) && p.duration >= 0 && p.duration <= 86400));
  if (event === 'request-media') return id(p.msgId) && id(p.requestId);
  if (event === 'finish-media-view') return id(p.msgId);
  if (event === 'react') return id(p.msgId) && short(p.emoji, 20);
  if (event.startsWith('call-') && !optionalId(p.callId)) return false;
  if (event === 'call-signal') {
    if (!id(p.to)) return false;
    if (p.description && (!['offer', 'answer'].includes(p.description.type) || !short(p.description.sdp, 65536))) return false;
    if (p.candidate && (!short(p.candidate.candidate, 4096) || !(p.candidate.sdpMid == null || short(p.candidate.sdpMid, 100))
      || !(p.candidate.sdpMLineIndex == null || Number.isInteger(p.candidate.sdpMLineIndex)))) return false;
  }
  return true;
}

function installGuard(socket) {
  const buckets = new Map();
  let lastError = 0;
  function allow(key, count, ms) {
    const now = Date.now();
    let entry = buckets.get(key);
    if (!entry || now >= entry.reset) { entry = { count: 0, reset: now + ms }; buckets.set(key, entry); }
    return ++entry.count <= count;
  }
  socket.use((packet, next) => {
    const [event] = packet;
    if (!limits[event]) return;
    const reply = typeof packet[packet.length - 1] === 'function' ? packet[packet.length - 1] : null;
    const reject = message => {
      if (event === 'request-media' && id(packet[1]?.msgId) && id(packet[1]?.requestId)) {
        socket.emit('media-unavailable', { msgId: packet[1].msgId, requestId: packet[1].requestId, reason: 'rate-limit' });
      }
      if (reply) reply({ error: message });
      else if (Date.now() - lastError > 1000) { lastError = Date.now(); socket.emit('error', { message }); }
    };
    if (!allow('all', 240, 10000) || !allow(event, ...limits[event])) return reject('Too many requests. Please wait.');
    // Payload-free typing events remain compatible with existing clients.
    if (event.startsWith('typing-')) packet[1] = {};
    const p = packet[1];
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(p) || ''); } catch { return reject('Invalid request.'); }
    const max = event === 'send-media' ? 70 * 1024 * 1024 : event === 'call-signal' ? 80 * 1024 : 8192;
    if (bytes > max || !valid(event, p)) return reject('Invalid or oversized request.');
    next();
  });
}

function base64Bytes(data) {
  if (typeof data !== 'string' || !data.length || data.length % 4 || /[^A-Za-z0-9+/=]/.test(data)) return -1;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  if (data.slice(0, data.length - padding).includes('=')) return -1;
  return data.length / 4 * 3 - padding;
}

module.exports = { installGuard, base64Bytes };
