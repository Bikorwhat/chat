const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const rtcConfig = require('../lib/rtc-config');

test('TURN uses expiring credentials without disclosing the signing secret', () => {
  const config = rtcConfig('member', { TURN_URLS: 'turn:relay.example:3478,turns:relay.example:5349', TURN_SECRET: 'test-secret', TURN_RELAY_ONLY: 'true' }, 1700000000000);
  const turn = config.iceServers[1];
  assert.equal(turn.username, '1700003600:member');
  assert.equal(turn.credential, createHmac('sha1', 'test-secret').update(turn.username).digest('base64'));
  assert.equal(config.iceTransportPolicy, 'relay');
  assert.equal(JSON.stringify(config).includes('test-secret'), false);
});

test('TURN supports provider credentials and rejects incomplete settings', () => {
  assert.equal(rtcConfig('member', {}).iceServers.length, 1);
  assert.throws(() => rtcConfig('member', { TURN_URLS: 'https://wrong.example' }));
  assert.throws(() => rtcConfig('member', { TURN_URLS: 'turn:relay.example' }));
  assert.throws(() => rtcConfig('member', { TURN_RELAY_ONLY: 'true' }));
  assert.equal(rtcConfig('member', { TURN_URLS: 'turn:relay.example', TURN_USERNAME: 'user', TURN_PASSWORD: 'password' }).iceServers[1].credential, 'password');
});
