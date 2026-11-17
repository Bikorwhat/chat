// Real Chromium/WebRTC smoke test with synthetic microphone and camera devices.
const { spawn } = require('node:child_process');
const { mkdtemp, readFile } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'fchat-call-test-'));
  const chrome = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required', '--no-first-run', 'about:blank'
  ], { windowsHide: true, stdio: 'ignore' });
  let ws;
  const pending = new Map();
  let sequence = 0;
  const errors = [];
  try {
    let port;
    for (let i = 0; i < 100; i++) {
      try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { await delay(100); }
    }
    assert.ok(port, 'Chrome debugging endpoint started');
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    };
    function send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    }
    async function evaluate(session, expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, session);
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    async function until(session, expression, label) {
      for (let i = 0; i < 150; i++) {
        if (await evaluate(session, expression)) return;
        await delay(100);
      }
      console.error(JSON.stringify(await evaluate(session, '(async () => Promise.all(testPeers.map(async p => ({ state: p.connectionState, transceivers: p.getTransceivers().map(t => ({ mid: t.mid, direction: t.direction, current: t.currentDirection, sender: t.sender.track?.kind, receiver: t.receiver.track?.kind })), stats: [...(await p.getStats()).values()].filter(s => ["inbound-rtp", "outbound-rtp"].includes(s.type)) }))))()'), null, 2));
      throw new Error(`Timed out: ${label}; toasts: ${await evaluate(session, 'document.getElementById("js-toast").innerText')}`);
    }
    const base = process.env.CALL_TEST_URL || 'http://localhost:3000';
    const { roomId } = await (await fetch(`${base}/api/create-room`)).json();
    async function participant(name) {
      const { browserContextId } = await send('Target.createBrowserContext');
      const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      await send('Runtime.enable', {}, sessionId);
      await send('Page.enable', {}, sessionId);
      await send('Page.addScriptToEvaluateOnNewDocument', { source: `sessionStorage.setItem('chyatt_name', ${JSON.stringify(name)}); window.testPeers = []; window.testStreams = []; const OriginalPC = window.RTCPeerConnection; window.RTCPeerConnection = class extends OriginalPC { constructor(...args) { super(...args); window.testPeers.push(this); } }; const originalCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = async (...args) => { const stream = await originalCapture(...args); window.testStreams.push(stream); return stream; };` }, sessionId);
      await send('Page.navigate', { url: `${base}/space/${roomId}` }, sessionId);
      await until(sessionId, 'typeof state !== "undefined" && state.myId && !document.getElementById("js-app").hidden', 'join room');
      return sessionId;
    }
    const a = await participant('Caller A');
    const b = await participant('Caller B');
    const click = (session, id) => evaluate(session, `document.getElementById(${JSON.stringify(`js-${id}`)}).click()`);
    await click(a, 'voice-call');
    await until(a, '!document.getElementById("js-call-panel").hidden', 'first call join');
    await until(b, '!document.getElementById("js-incoming-call").hidden', 'incoming voice call');
    assert.equal(await evaluate(b, 'testStreams.length'), 0, 'ringing does not access microphone');
    await click(b, 'call-accept');
    for (const session of [a, b]) {
      await until(session, 'testPeers.some(p => p.connectionState === "connected")', 'WebRTC connected');
      await until(session, '(async () => { const stats = await testPeers[0].getStats(); return [...stats.values()].some(s => s.type === "inbound-rtp" && s.kind === "audio" && s.bytesReceived > 0); })()', 'audio packets received');
      await until(session, 'Array.from(document.querySelectorAll("#js-call-videos audio")).some(a => !a.paused && a.currentTime > 0.2 && a.srcObject.getVideoTracks().length === 0)', 'audio playing with cameras off');
      assert.equal(await evaluate(session, 'testStreams.flatMap(s => s.getVideoTracks()).length'), 0, 'camera off by default');
    }
    console.log('PASS: two voice callers connected; audio received in both directions; cameras off.');
    await click(a, 'call-mute');
    assert.equal(await evaluate(a, 'testStreams[0].getAudioTracks()[0].enabled'), false);
    await until(b, 'document.querySelector("#js-call-videos .call-tile:not(#js-local-tile) span").textContent.includes("Muted")', 'remote muted indicator');
    await click(a, 'call-mute');
    assert.equal(await evaluate(a, 'testStreams[0].getAudioTracks()[0].enabled'), true);
    await click(a, 'call-speaker');
    assert.equal(await evaluate(a, 'document.querySelector("#js-call-videos audio").muted'), true);
    await click(a, 'call-speaker');
    await evaluate(a, 'const volume = document.getElementById("js-call-volume"); volume.value = 35; volume.dispatchEvent(new Event("input"));');
    assert.equal(await evaluate(a, 'document.querySelector("#js-call-videos audio").volume'), 0.35);
    console.log('PASS: microphone mute/unmute, speaker mute/unmute, volume.');
    await click(a, 'call-end');
    await until(b, 'document.getElementById("js-call-panel").hidden', 'remote hangup');
    await delay(Number(process.env.CALL_TEST_COOLDOWN_MS) || 10100);
    await click(a, 'video-call');
    await until(b, '!document.getElementById("js-incoming-call").hidden', 'incoming video call');
    await click(b, 'call-accept');
    for (const session of [a, b]) {
      await until(session, '!document.getElementById("js-call-panel").hidden && !document.getElementById("js-call-camera").hidden', 'video call join');
      assert.equal(await evaluate(session, 'document.getElementById("js-local-video").srcObject.getVideoTracks().length'), 0);
      await until(session, 'Array.from(document.querySelectorAll("#js-call-videos audio")).some(a => !a.paused && a.currentTime > 0.2)', 'video-call audio playing before camera activation');
    }
    for (const session of [a, b]) {
      await click(session, 'call-camera');
      await until(session, 'document.getElementById("js-call-camera").getAttribute("aria-pressed") === "true"', 'enable camera');
    }
    for (const session of [a, b]) {
      await until(session, 'testPeers.some(p => p.connectionState === "connected")', 'video connected');
      await until(session, '(async () => { const pc = testPeers.find(p => p.connectionState === "connected"); if (!pc) return false; return [...(await pc.getStats()).values()].some(s => s.type === "inbound-rtp" && s.kind === "video" && s.framesDecoded > 0); })()', 'video frames decoded');
    }
    console.log('PASS: video calls start camera off; enabling cameras sends decodable video both ways.');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, a);
    await click(a, 'call-fullscreen');
    assert.equal(await evaluate(a, 'document.getElementById("js-call-fullscreen").getAttribute("aria-pressed")'), 'true');
    await click(a, 'call-fullscreen');
    await evaluate(a, 'navigator.mediaDevices.dispatchEvent(new Event("devicechange"));');
    assert.equal(await evaluate(a, 'document.getElementById("js-call-mute").getAttribute("aria-pressed")'), 'true');
    await click(a, 'call-resume');
    await until(a, 'document.getElementById("js-call-resume").hidden', 'resume microphone after device change');
    await evaluate(a, 'const interruptedAudio = document.getElementById("js-local-video").srcObject.getAudioTracks()[0]; interruptedAudio.stop(); interruptedAudio.dispatchEvent(new Event("ended"));');
    assert.equal(await evaluate(a, 'document.getElementById("js-call-resume").hidden'), false);
    await click(a, 'call-resume');
    await until(a, 'document.getElementById("js-call-resume").hidden && document.getElementById("js-local-video").srcObject.getAudioTracks()[0].readyState === "live"', 'replace interrupted microphone');
    await evaluate(a, 'window.dispatchEvent(new Event("offline"));');
    assert.equal(await evaluate(a, 'document.getElementById("js-call-notice").textContent.includes("Network lost")'), true);
    await evaluate(a, 'window.oldCallSdp = testPeers.find(p => p.connectionState === "connected").localDescription.sdp; window.dispatchEvent(new Event("online"));');
    await until(a, 'testPeers.some(p => p.connectionState === "connected" && p.localDescription?.sdp !== window.oldCallSdp)', 'ICE restart negotiated');
    await until(a, 'testPeers.some(p => p.connectionState === "connected" && p.signalingState === "stable")', 'connection after restart request');
    console.log('PASS: remote mute status, mobile expanded layout, device-change microphone recovery, network recovery request.');
    await evaluate(a, 'document.getElementById("js-call-facing").value = "environment"; document.getElementById("js-call-facing").dispatchEvent(new Event("change"));');
    await until(a, '!document.getElementById("js-call-camera").disabled && document.getElementById("js-local-video").srcObject.getVideoTracks().some(t => t.readyState === "live")', 'camera switch');
    await click(a, 'call-camera');
    await until(a, 'document.getElementById("js-local-video").srcObject.getVideoTracks().length === 0', 'camera off');
    await click(b, 'call-camera');
    await until(b, 'document.getElementById("js-local-video").srcObject.getVideoTracks().length === 0', 'second camera off');
    for (const session of [a, b]) {
      await evaluate(session, 'window.audioTimeBefore = document.querySelector("#js-call-videos audio").currentTime');
      await until(session, 'document.querySelector("#js-call-videos audio").currentTime > window.audioTimeBefore + 0.3 && !document.querySelector("#js-call-videos audio").paused', 'audio continues after both cameras switch off');
    }
    console.log('PASS: camera switch request and camera off (synthetic camera; physical lens selection unverified).');
    for (const session of [a, b]) {
      await click(session, 'call-end');
      assert.equal(await evaluate(session, 'testStreams.flatMap(s => s.getTracks()).every(t => t.readyState === "ended")'), true);
    }
    await until(a, 'document.getElementById("js-call-panel").hidden', 'all calls closed');
    await delay(Number(process.env.CALL_TEST_COOLDOWN_MS) || 10100);
    await click(a, 'voice-call');
    await until(b, '!document.getElementById("js-incoming-call").hidden', 'ring before decline');
    await click(b, 'call-decline');
    await until(a, 'document.getElementById("js-call-panel").hidden', 'decline closes outgoing call');
    await delay(Number(process.env.CALL_TEST_COOLDOWN_MS) || 10100);
    await click(a, 'voice-call');
    await until(b, '!document.getElementById("js-incoming-call").hidden', 'ring before cancellation');
    await click(a, 'call-end');
    await until(b, 'document.getElementById("js-incoming-call").hidden', 'caller cancellation stops ringing');
    console.log('PASS: decline ends unanswered call; caller cancellation dismisses incoming call.');
    assert.deepEqual(errors, [], 'no browser JavaScript exceptions');
    console.log('PASS: hang up releases all captured tracks; no browser JavaScript exceptions.');
  } finally {
    ws?.close();
    chrome.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

