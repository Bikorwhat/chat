const { createHmac } = require('node:crypto');

function rtcConfig(userId, env = process.env, now = Date.now()) {
  const iceServers = [{ urls: env.STUN_URL || 'stun:stun.l.google.com:19302' }];
  const urls = (env.TURN_URLS || '').split(',').map(url => url.trim()).filter(Boolean);
  if (urls.some(url => !/^turns?:[^\s]+$/.test(url))) throw new Error('Invalid TURN_URLS configuration.');
  if (urls.length) {
    let username = env.TURN_USERNAME;
    let credential = env.TURN_PASSWORD;
    if (env.TURN_SECRET) {
      username = `${Math.floor(now / 1000) + 3600}:${userId}`;
      credential = createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
    }
    if (!username || !credential) throw new Error('TURN credentials are missing on the server.');
    iceServers.push({ urls, username, credential });
  }
  if (env.TURN_RELAY_ONLY === 'true' && !urls.length) throw new Error('Relay-only calls require TURN_URLS.');
  return { iceServers, iceTransportPolicy: env.TURN_RELAY_ONLY === 'true' ? 'relay' : 'all' };
}

module.exports = rtcConfig;
