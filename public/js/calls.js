'use strict';

// Each participant explicitly joins. Media travels over WebRTC, not chat history.
(() => {
  const el = id => document.getElementById(`js-${id}`);
  const peers = new Map();
  let stream = null;
  let active = false;
  let generation = 0;
  let videoMode = false;
  let cameraBusy = false;
  let speakerMuted = false;
  let participants = [];
  let timer;
  let currentCall = null;
  let callId = null;
  let incoming = null;
  let ringInterval;
  let ringAudio;
  let connectedAt = null;
  let previousFocus;
  let rtcOptions;
  let statsBusy = false;
  let mediaPublishTimer;
  let captureBusy = false;
  let interruption = '';
  const panel = el('call-panel');
  const local = el('local-video');
  const status = el('call-status');

  function updateStatus() {
    const connections = [...peers.values()].map(p => p.pc.connectionState);
    const connected = connections.includes('connected');
    if (connected && !connectedAt) connectedAt = Date.now();
    const phase = peers.size && [...peers.values()].every(p => p.exhausted) ? 'Connection failed' : !navigator.onLine || connections.some(s => ['disconnected', 'failed'].includes(s))
      ? 'Reconnecting' : connected ? 'Connected' : currentCall?.ringing.length && participants.length < 2 ? 'Ringing everyone in this space' : 'Connecting';
    status.textContent = `${phase} · ${videoMode ? 'Video' : 'Voice'} call · ${participants.length} participants${connectedAt ? ` · ${formatDuration((Date.now() - connectedAt) / 1000)}` : ''}`;
    for (const id of ['voice-call', 'video-call']) {
      el(id).title = participants.length ? `Join call (${participants.length} participants)` : 'Start call';
    }
  }

  function notice(message) {
    el('call-notice').textContent = message;
    el('call-notice').hidden = !message;
  }

  function publishMedia() {
    clearTimeout(mediaPublishTimer);
    mediaPublishTimer = setTimeout(() => {
      if (!active || !callId) return;
      const audio = stream?.getAudioTracks()[0];
      socket.emit('call-media', { callId, muted: !audio?.enabled || audio.muted || audio.readyState !== 'live',
        camera: stream.getVideoTracks().some(t => t.readyState === 'live' && !t.muted) });
    }, 180);
  }

  function watchTrack(track) {
    const refresh = () => {
      if (!active || !stream?.getTracks().includes(track)) return;
      if (track.kind === 'audio') {
        const unavailable = track.readyState === 'ended' || track.muted;
        el('call-resume').hidden = !unavailable;
        interruption = unavailable ? 'Microphone interrupted. Resume when it is available.' : '';
        notice(interruption);
      } else updateCameraUI();
      publishMedia();
    };
    track.addEventListener('ended', refresh);
    track.addEventListener('mute', refresh);
    track.addEventListener('unmute', refresh);
  }

  async function recoverPeer(id, requested = false) {
    const peer = peers.get(id);
    if (!active || !peer || peer.pc.connectionState === 'closed') return;
    if (Date.now() - (peer.lastAttempt || 0) < 5000 || peer.exhausted) return;
    peer.lastAttempt = Date.now();
    // One side owns restart offers, preventing simultaneous offer collisions.
    if (socket.id > id) {
      if (!requested) socket.emit('call-signal', { to: id, callId, restart: true });
      return;
    }
    if (peer.restarting || peer.pc.signalingState !== 'stable' || peer.retries >= 3) return;
    peer.restarting = true;
    peer.retries++;
    try {
      await peer.pc.setLocalDescription(await peer.pc.createOffer({ iceRestart: true }));
      if (active && peers.get(id) === peer) socket.emit('call-signal', { to: id, callId, description: peer.pc.localDescription.toJSON() });
    } catch (error) { if (active) failure(error); }
    finally { peer.restarting = false; }
  }

  async function updateParticipants() {
    if (!active || statsBusy) return;
    statsBusy = true;
    try {
      for (const [id, peer] of peers) {
        const media = currentCall?.media?.find(m => m.id === id);
        const stats = await peer.pc.getStats();
        if (peers.get(id) !== peer) continue;
        const speaking = !media?.muted && [...stats.values()].some(s => s.type === 'inbound-rtp' && s.kind === 'audio' && s.audioLevel > 0.04);
        peer.tile.classList.toggle('is-speaking', speaking);
        peer.label.textContent = `${state.users.get(id)?.name || 'Participant'} · ${media?.muted ? 'Muted' : 'Mic on'} · ${media?.camera ? 'Camera on' : 'Camera off'} · ${peer.pc.connectionState}${speaking ? ' · Speaking' : ''}`;
      }
    } catch { /* A peer may close while stats are being collected. */ }
    finally { statsBusy = false; }
  }

  function stopRinging() {
    clearInterval(ringInterval);
    ringInterval = null;
    if (ringAudio) { ringAudio.close().catch(() => {}); ringAudio = null; }
  }

  function ring() {
    if (ringInterval) return;
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      ringAudio = new Audio();
      const tone = () => {
        if (ringAudio?.state !== 'running') return;
        for (const offset of [0, 0.4]) {
          const oscillator = ringAudio.createOscillator();
          const gain = ringAudio.createGain();
          oscillator.frequency.value = incoming ? 660 : 440;
          gain.gain.setValueAtTime(0, ringAudio.currentTime + offset);
          gain.gain.linearRampToValueAtTime(0.08, ringAudio.currentTime + offset + 0.02);
          gain.gain.linearRampToValueAtTime(0, ringAudio.currentTime + offset + 0.3);
          oscillator.connect(gain).connect(ringAudio.destination);
          oscillator.start(ringAudio.currentTime + offset);
          oscillator.stop(ringAudio.currentTime + offset + 0.32);
        }
      };
      ringAudio.resume().then(tone).catch(() => {});
      ringInterval = setInterval(tone, 2200);
    } catch { /* The visual incoming call remains available without audio. */ }
  }

  function hideIncoming() {
    incoming = null;
    el('incoming-call').hidden = true;
    stopRinging();
    if (previousFocus?.isConnected) previousFocus.focus();
    previousFocus = null;
  }

  function play(media) {
    media.play().catch(() => { el('call-play').hidden = false; });
  }

  function removePeer(id) {
    const peer = peers.get(id);
    if (!peer) return;
    peers.delete(id);
    clearTimeout(peer.recoveryTimer);
    clearTimeout(peer.failureTimer);
    peer.pc.close();
    peer.audio.pause();
    peer.audio.srcObject = null;
    peer.media.srcObject = null;
    peer.tile.remove();
  }

  function end(notify = true) {
    generation++;
    active = false;
    clearTimeout(timer);
    clearTimeout(mediaPublishTimer);
    if (notify && socket.connected && callId) socket.emit('call-leave', { callId });
    callId = null;
    connectedAt = null;
    hideIncoming();
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    local.srcObject = null;
    for (const id of [...peers.keys()]) removePeer(id);
    panel.hidden = true;
    panel.classList.remove('call-expanded');
    el('call-fullscreen').textContent = 'Expand call';
    el('call-fullscreen').setAttribute('aria-pressed', 'false');
    if (document.fullscreenElement === panel) document.exitFullscreen().catch(() => {});
    el('call-resume').hidden = true;
    interruption = '';
    notice('');
    el('voice-call').disabled = false;
    el('video-call').disabled = false;
  }

  function failure(error) {
    showToast(error?.message || 'Call could not connect.', 'error');
  }

  function createPeer(id, initiator = false) {
    if (peers.has(id)) return peers.get(id);
    const pc = new RTCPeerConnection(rtcOptions);
    const tile = document.createElement('div');
    tile.className = 'call-tile';
    const media = document.createElement('video');
    media.autoplay = true;
    media.playsInline = true;
    // Never combine audio with the reserved, initially muted video track:
    // browsers can wait for video frames before playing a combined stream.
    media.muted = true;
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.muted = speakerMuted;
    audio.volume = Number(el('call-volume').value) / 100;
    const label = document.createElement('span');
    label.textContent = state.users.get(id)?.name || 'Participant';
    tile.append(media, audio, label);
    el('call-videos').append(tile);
    pc.addTrack(stream.getAudioTracks()[0], stream);
    // Reserve a video sender even with the camera off, avoiding renegotiation.
    // Answerers must use the offered transceiver after setRemoteDescription.
    // Preallocating one there can leave the negotiated video receive-only.
    const video = initiator ? pc.addTransceiver('video', { direction: 'sendrecv', streams: [stream] }) : null;
    const track = stream.getVideoTracks()[0];
    const peer = { pc, tile, media, audio, label, video, retries: 0, candidates: [], ready: track && video ? video.sender.replaceTrack(track) : Promise.resolve() };
    peers.set(id, peer);
    pc.onicecandidate = event => {
      if (event.candidate && active) socket.emit('call-signal', { to: id, candidate: event.candidate.toJSON(), callId });
    };
    pc.ontrack = event => {
      const target = event.track.kind === 'audio' ? audio : media;
      if (!target.srcObject) target.srcObject = new MediaStream();
      target.srcObject.addTrack(event.track);
      play(target);
      event.track.addEventListener('unmute', () => play(target));
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        clearTimeout(timer);
        clearTimeout(peer.recoveryTimer);
        clearTimeout(peer.failureTimer);
        peer.failureTimer = null;
        peer.retries = 0;
        peer.exhausted = false;
      } else if (['disconnected', 'failed'].includes(pc.connectionState)) {
        clearTimeout(peer.recoveryTimer);
        peer.recoveryTimer = setTimeout(() => recoverPeer(id), 1500);
        if (!peer.failureTimer) peer.failureTimer = setTimeout(() => {
          if (peers.get(id) !== peer || pc.connectionState === 'connected') return;
          notice('Connection failed for a participant. Hang up and retry when your network is available.');
          peer.exhausted = true;
          peer.label.textContent = `${state.users.get(id)?.name || 'Participant'} · Connection failed`;
          updateStatus();
        }, 20000);
      }
      updateStatus();
    };
    return peer;
  }

  async function start(video, joiningId = currentCall?.id || null) {
    if (active) {
      videoMode = videoMode || video;
      updateCameraUI();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
      return showToast('Calls require HTTPS (or localhost) and a browser with microphone support.', 'error');
    }
    const token = ++generation;
    callId = joiningId;
    hideIncoming();
    el('voice-call').disabled = el('video-call').disabled = true;
    try {
      rtcOptions = await new Promise((resolve, reject) => socket.timeout(10000).emit('call-config', {}, (err, config) => {
        if (err || config?.error) reject(new Error(config?.error || 'Could not load call configuration.'));
        else resolve(config);
      }));
      if (token !== generation) return;
      const captured = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (token !== generation || !socket.connected) { captured.getTracks().forEach(t => t.stop()); return; }
      cancelRecording();
      stream = captured;
      active = true;
      stream.getTracks().forEach(watchTrack);
      videoMode = video;
      speakerMuted = false;
      el('call-mute').textContent = 'Mute microphone';
      el('call-mute').setAttribute('aria-pressed', 'false');
      el('call-speaker').textContent = 'Speaker on';
      el('call-speaker').setAttribute('aria-pressed', 'false');
      el('call-play').hidden = true;
      panel.hidden = false;
      local.srcObject = stream;
      updateCameraUI();
      updateStatus();
      socket.timeout(10000).emit('call-join', { video, callId: joiningId }, async (err, response) => {
        if (token !== generation) {
          if (response?.callId && socket.connected) socket.emit('call-leave', { callId: response.callId });
          return;
        }
        if (err || response?.error) { end(); failure(new Error(response?.error || 'Joining the call timed out.')); return; }
        callId = response.callId;
        publishMedia();
        videoMode = response.video;
        updateCameraUI();
        try {
          for (const id of response.peers) {
            const peer = createPeer(id, true);
            await peer.ready;
            if (token !== generation) return;
            await peer.pc.setLocalDescription(await peer.pc.createOffer());
            socket.emit('call-signal', { to: id, description: peer.pc.localDescription.toJSON(), callId });
          }
        } catch (error) { if (active) { failure(error); end(); } }
      });
      timer = setTimeout(() => {
        if (active && peers.size && ![...peers.values()].some(p => p.pc.connectionState === 'connected')) {
          showToast('Call connection timed out. Retry or use a different network; a TURN relay may be needed.', 'error', 7000);
          end();
        }
      }, 35000);
    } catch (error) { if (token === generation) { end(); failure(error); } }
    finally {
      if (token === generation) el('voice-call').disabled = el('video-call').disabled = false;
    }
  }

  socket.on('call-state', ({ participants: ids, call }) => {
    currentCall = call;
    participants = ids;
    if (incoming && (!call || call.id !== incoming.id || !call.ringing.includes(socket.id))) hideIncoming();
    if (active && call?.id === callId) {
      videoMode = call.video || videoMode;
      updateCameraUI();
      if (ids.length > 1) stopRinging();
      else if (call.ringing.length) ring();
    }
    for (const id of peers.keys()) if (!ids.includes(id)) removePeer(id);
    updateStatus();
  });
  socket.on('call-incoming', call => {
    if (active || incoming?.id === call.id) return;
    incoming = call;
    previousFocus = document.activeElement;
    el('incoming-title').textContent = `Incoming ${call.video ? 'video' : 'voice'} call`;
    el('incoming-caller').textContent = `${call.callerName} is calling this space`;
    el('incoming-call').hidden = false;
    el('call-accept').focus();
    ring();
  });
  socket.on('call-ended', ({ callId: endedId, reason }) => {
    if (callId === endedId || incoming?.id === endedId) {
      end(false);
      showToast(reason, 'info');
    }
  });
  el('call-accept').onclick = () => {
    if (incoming) start(incoming.video, incoming.id);
  };
  el('call-decline').onclick = () => {
    if (incoming) socket.emit('call-decline', { callId: incoming.id });
    hideIncoming();
  };
  el('incoming-call').addEventListener('keydown', event => {
    if (event.key === 'Escape') el('call-decline').click();
    if (event.key === 'Tab') {
      event.preventDefault();
      (document.activeElement === el('call-accept') ? el('call-decline') : el('call-accept')).focus();
    }
  });
  // Browsers may require a user gesture before they allow ringtone playback.
  document.addEventListener('pointerdown', () => { ringAudio?.resume().catch(() => {}); });
  setInterval(() => {
    if (!active) return;
    updateStatus();
    updateParticipants();
    for (const [id, peer] of peers) if (['disconnected', 'failed'].includes(peer.pc.connectionState)) recoverPeer(id);
  }, 500);
  // Serialize descriptions and ICE candidates for each incoming signaling event.
  let signaling = Promise.resolve();
  socket.on('call-signal', payload => {
    const token = generation;
    signaling = signaling.then(async () => {
      if (!active || token !== generation || payload.callId !== callId) return;
      const { from, description, candidate } = payload;
      const peer = createPeer(from);
      if (payload.restart) { await recoverPeer(from, true); return; }
      await peer.ready;
      if (description) {
        await peer.pc.setRemoteDescription(description);
        for (const ice of peer.candidates.splice(0)) await peer.pc.addIceCandidate(ice);
        if (description.type === 'offer') {
          peer.video = peer.pc.getTransceivers().find(t => t.receiver.track.kind === 'video');
          if (peer.video) {
            peer.video.direction = 'sendrecv';
            peer.video.sender.setStreams(stream);
            await peer.video.sender.replaceTrack(stream.getVideoTracks()[0] || null);
          }
          await peer.pc.setLocalDescription(await peer.pc.createAnswer());
          socket.emit('call-signal', { to: from, description: peer.pc.localDescription.toJSON(), callId });
        }
      } else if (candidate) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(candidate);
        else peer.candidates.push(candidate);
      }
    }).catch(error => { if (active && token === generation) failure(error); });
  });

  function updateCameraUI() {
    const on = Boolean(stream?.getVideoTracks().some(t => t.readyState === 'live'));
    el('call-camera').hidden = el('camera-choice').hidden = !videoMode;
    el('call-camera').textContent = on ? 'Turn camera off' : 'Turn camera on';
    el('call-camera').setAttribute('aria-pressed', String(on));
    const audio = stream?.getAudioTracks()[0];
    el('local-tile').querySelector('span').textContent = `You · ${audio?.enabled && !audio.muted && audio.readyState === 'live' ? 'Mic on' : 'Muted'} · ${on ? 'Camera on' : 'Camera off'}`;
    local.style.transform = el('call-facing').value === 'user' ? 'scaleX(-1)' : '';
  }

  async function setCamera(on) {
    if (!active || cameraBusy) return;
    cameraBusy = true;
    const token = generation;
    el('call-camera').disabled = el('call-facing').disabled = true;
    // Release the current device before opening the other camera on mobile.
    const old = stream.getVideoTracks()[0];
    if (old) { old.stop(); stream.removeTrack(old); }
    let captured;
    try {
      await Promise.all([...peers.values()].filter(p => p.video).map(p => p.video.sender.replaceTrack(null)));
      if (on) {
        const facing = el('call-facing').value;
        const supportsFacing = navigator.mediaDevices.getSupportedConstraints().facingMode;
        if (facing === 'environment' && !supportsFacing) throw new Error('This browser cannot select the back camera. Camera remains off.');
        captured = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
          // Back selection must never silently activate the front camera.
          facingMode: facing === 'environment' ? { exact: facing } : { ideal: facing },
          width: { ideal: 640 }, height: { ideal: 480 }
        } });
        if (token !== generation || !active) { captured.getTracks().forEach(t => t.stop()); return; }
        const track = captured.getVideoTracks()[0];
        stream.addTrack(track);
        watchTrack(track);
        await Promise.all([...peers.values()].filter(p => p.video).map(p => p.video.sender.replaceTrack(track)));
      }
    } catch (error) {
      captured?.getTracks().forEach(t => { t.stop(); stream?.removeTrack(t); });
      if (token === generation) failure(error.name === 'OverconstrainedError' ? new Error('The requested camera is unavailable. Camera remains off.') : error);
    } finally {
      cameraBusy = false;
      el('call-camera').disabled = el('call-facing').disabled = false;
      updateCameraUI();
      publishMedia();
    }
  }

  el('voice-call').onclick = () => start(false);
  el('video-call').onclick = () => start(true);
  el('call-end').onclick = () => end();
  el('call-camera').onclick = () => setCamera(!stream?.getVideoTracks().some(t => t.readyState === 'live'));
  el('call-facing').onchange = () => { if (stream?.getVideoTracks().length) setCamera(true); };
  el('call-mute').onclick = () => {
    const track = stream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    el('call-mute').textContent = track.enabled ? 'Mute microphone' : 'Unmute microphone';
    el('call-mute').setAttribute('aria-pressed', String(!track.enabled));
    updateCameraUI();
    publishMedia();
  };
  function updateAudio() {
    for (const { audio } of peers.values()) {
      audio.muted = speakerMuted;
      audio.volume = Number(el('call-volume').value) / 100;
    }
  }
  el('call-speaker').onclick = () => {
    speakerMuted = !speakerMuted;
    el('call-speaker').textContent = speakerMuted ? 'Speaker off' : 'Speaker on';
    el('call-speaker').setAttribute('aria-pressed', String(speakerMuted));
    updateAudio();
  };
  el('call-volume').oninput = updateAudio;
  el('call-play').onclick = () => {
    el('call-play').hidden = true;
    for (const { media, audio } of peers.values()) { play(audio); play(media); }
  };
  el('call-resume').onclick = async () => {
    if (!active || captureBusy) return;
    captureBusy = true;
    const token = generation;
    let captured;
    try {
      captured = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (!active || token !== generation) { captured.getTracks().forEach(t => t.stop()); return; }
      const track = captured.getAudioTracks()[0];
      const old = stream.getAudioTracks()[0];
      // Resuming is an explicit user action to restore the microphone.
      await Promise.all([...peers.values()].map(p => p.pc.getSenders().find(s => s.track?.kind === 'audio')?.replaceTrack(track)));
      if (!active || token !== generation) { track.stop(); return; }
      if (old) { stream.removeTrack(old); old.stop(); }
      stream.addTrack(track);
      watchTrack(track);
      el('call-mute').textContent = 'Mute microphone';
      el('call-mute').setAttribute('aria-pressed', 'false');
      el('call-resume').hidden = true;
      interruption = '';
      notice('');
      updateCameraUI();
      publishMedia();
    } catch (error) { captured?.getTracks().forEach(t => t.stop()); if (active) failure(error); }
    finally { captureBusy = false; }
  };
  el('call-fullscreen').onclick = async () => {
    const expanded = panel.classList.toggle('call-expanded');
    el('call-fullscreen').textContent = expanded ? 'Minimize call' : 'Expand call';
    el('call-fullscreen').setAttribute('aria-pressed', String(expanded));
    try {
      if (expanded && panel.requestFullscreen) await panel.requestFullscreen();
      else if (!expanded && document.fullscreenElement === panel) await document.exitFullscreen();
    } catch { /* The expanded layout also works without fullscreen permission. */ }
  };
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
      panel.classList.remove('call-expanded');
      el('call-fullscreen').textContent = 'Expand call';
      el('call-fullscreen').setAttribute('aria-pressed', 'false');
    }
  });
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !document.fullscreenElement) {
      panel.classList.remove('call-expanded');
      el('call-fullscreen').textContent = 'Expand call';
      el('call-fullscreen').setAttribute('aria-pressed', 'false');
    }
  });
  navigator.mediaDevices?.addEventListener('devicechange', () => {
    if (!active) return;
    const audio = stream?.getAudioTracks()[0];
    if (audio) audio.enabled = false;
    el('call-mute').textContent = 'Unmute microphone';
    el('call-mute').setAttribute('aria-pressed', 'true');
    el('call-resume').hidden = false;
    notice('Audio devices changed. Microphone muted; check your headphones and resume when ready.');
    updateCameraUI();
    publishMedia();
  });
  window.addEventListener('offline', () => { if (active) { notice('Network lost. Trying to reconnect…'); updateStatus(); } });
  window.addEventListener('online', () => {
    if (!active) return;
    notice(interruption);
    for (const id of peers.keys()) recoverPeer(id);
  });
  document.addEventListener('visibilitychange', () => {
    if (!active || document.hidden) return;
    for (const { media, audio } of peers.values()) { play(audio); play(media); }
    for (const [id, peer] of peers) if (['disconnected', 'failed'].includes(peer.pc.connectionState)) recoverPeer(id);
    publishMedia();
  });
  socket.on('disconnect', () => {
    if (active) showToast('Call ended because the space connection was lost. Rejoin the call after reconnecting.', 'error', 7000);
    end(false); participants = []; currentCall = null; updateStatus();
  });
  window.addEventListener('pagehide', () => end());
  window.addEventListener('beforeunload', () => end());
})();
