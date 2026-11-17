# ⚡ fchat — Ephemeral Real-Time Chat Platform

> Zero-database · No accounts · Temporary server memory · Auto-destroyed

A full-stack ephemeral chat application. Create a "Space" (room), share the link, and start chatting — all data lives **only in RAM** and vanishes when the room closes.

## 🚀 Quick Start

```bash
cd fchat
npm install
npm run dev    # development (with nodemon)
# OR
npm start      # production
```


## ✨ Features

- Ephemeral spaces with shareable `/space/<id>` URLs
- 1-on-1 and Group Chat modes
- Image sharing (≤10MB), Video sharing (≤50MB)
- Voice Notes via MediaRecorder API (≤2 min)
- Live voice and video room calls (up to 6 participants), with microphone mute, speaker on/off, and volume controls
- Video calls start with the camera off; enable it explicitly and choose the front or back camera
- Drag-and-drop media upload
- Emoji reactions + reply threads
- Live typing indicators
- XSS sanitization + rate limiting
- Auto room garbage collection
- Bounded RAM: unjoined spaces expire after 1 minute and each message after 2 minutes; limits of 250 spaces, 500 connections, and 256MB retained media per server process

## Calls

Chat messages and shared media are temporarily readable by the server in RAM; they are not end-to-end encrypted. HTTPS protects transport when enabled on your host. View-once/twice restricts server retrieval, but cannot stop an authorized recipient from copying received media or taking screenshots. No message contents are written to application logs.

The first participant can lock the space from the sidebar to block new joins and unlock it to admit others. Management transfers to another participant when the manager leaves. Existing participants remain connected. Duplicate display names receive a numeric suffix, and the participant list shows temporary identifiers. Names and identifiers do not verify real identities; keep room links private.

HTTP/HTTPS links and `www.` links in chat open in a new browser tab using your browser settings. Web pages cannot force a particular browser app or override the operating system default. Plain text is rendered safely without interpreting HTML.

Socket events validate payload types and sizes before handlers run, with separate event limits and an aggregate request limit per connection. Media retrieval has a per-connection byte budget. The 70 MB transport ceiling accommodates a 50 MB video encoded as base64; retained-media quotas still apply. These safeguards reduce abuse but are not a guarantee against denial-of-service attacks. Render changes require deploying the updated files; local edits do not update the hosted service automatically.

Use the phone or video icon in the chat header to call everyone currently in that space. Participants see the caller's name with Accept and Decline controls; the caller sees a ringing status. Incoming calls do not access the microphone or camera until accepted. Calls time out after 30 seconds without an answer, and caller cancellation dismisses the incoming call. Only one call can run in a space at a time; participants can use either header icon to join an existing call. Ringtones depend on browser autoplay permissions and may require a click in the page first. Calls ring connected participants with the space open; there are no background push notifications.

Accepting requests microphone access; camera access is requested only when you turn the camera on. Hang up to release the microphone and camera. Speaker on/off controls incoming audio playback, not the device's earpiece/speaker routing. Volume support follows the browser's media controls; some mobile browsers use device volume instead.

Calls require HTTPS in production (localhost works for development). WebRTC uses a public STUN server for discovery and supports an optional TURN relay through server environment variables. Without real TURN credentials, restrictive networks may still prevent calls. Calls use peer-to-peer connections and are intended for small groups. Media is not recorded or stored by this app.

Calls display Connecting, Connected, Reconnecting, or Connection failed. The timer starts at the local WebRTC connection, rather than when someone accepts. Participant tiles show microphone and camera status, and received audio levels highlight speaking participants. Expand call provides a larger layout and a small self-preview, with native fullscreen where supported.

Network changes attempt ICE recovery for up to 20 seconds while the space connection survives. Losing the Socket.IO connection ends the call and releases devices; explicitly rejoin after reconnecting. Microphone interruptions show a Resume microphone button. Device changes mute the microphone until you resume it. Browser and operating system restrictions can still suspend calls during screen locking, backgrounding, or incoming phone calls. The app does not automatically turn the camera back on after an interruption. A space waits 10 seconds after each call ends before another call can ring it; joining an existing call is unaffected.

### Optional TURN setup

TURN forwards encrypted call traffic when devices cannot connect directly. It requires an externally hosted relay or a self-hosted TURN server; the Node chat server is not itself a TURN server. No provider account is required for local testing. A relay has not been provisioned or activated by this repository.

Copy `.env.example` to `.env` and fill in values supplied by your TURN service:

```ini
TURN_URLS=turn:your-relay.example:3478,turns:your-relay.example:5349
TURN_USERNAME=your-provider-username
TURN_PASSWORD=your-provider-password
```

For a coturn server configured with shared-secret authentication, set `TURN_SECRET` instead of the username/password pair. The server signs credentials that expire in one hour and sends them only to connected space members. Shared signing secrets stay on the server; browser clients necessarily receive the temporary relay login. Long-lived provider usernames/passwords are also visible to participating browsers, so use limited credentials. Calls that need new relay allocations after credentials expire should be rejoined.

Set these environment variables in your hosting service. For local Node 20.6+ development, `node --env-file=.env server.js` loads the file. `npm start` on its own uses the existing process environment and does not load `.env`. Keep `.env` out of version control. Use `TURN_RELAY_ONLY=true` to verify a configured relay: calls should connect and the selected WebRTC candidate pair should have candidate type `relay`. Leave this false for normal direct-or-relay selection. TURN setup follows the [WebRTC configuration guide](https://webrtc.org/getting-started/turn-server).

The six-person mesh limit remains. Larger calls need an SFU media service and a different media architecture; setting TURN credentials does not increase group capacity.

### Verification

`npm test` checks room isolation, ringing, decline, cancellation, the cooldown, the unanswered timeout, and TURN credential generation. With the app running, `npm run test:calls:browser` uses Chrome with synthetic microphone/camera devices to verify two-way media, controls, participant mute status, an emulated mobile layout, interruption recovery, and cleanup. Set `CHROME_PATH` if Chrome is installed elsewhere and `CALL_TEST_URL` to use another app URL. Browser tests expect the default 10-second cooldown; adjust `CALL_TEST_COOLDOWN_MS` if you changed it.

Before relying on calls on real phones, open the same HTTPS space on iPhone Safari and Android Chrome and check:

- Ringing, accepting, declining, cancellation, and joining a running group call.
- Voice in both directions, microphone mute, speaker playback, and device volume.
- Camera-off startup, both physical lenses, camera off/on, and expanded layout.
- Headphone disconnect, microphone permission revocation, an incoming phone call, backgrounding, and screen locking; resume only when ready.
- Wi-Fi/mobile-data switching and restrictive networks, with relay-only mode when TURN is configured.

Physical phone testing and live TURN relay connectivity have not been verified by the synthetic browser tests.

Run the call signaling integration check with `node --test test/calls.test.js`. Real microphone, camera switching, audio playback, and cross-network connectivity also require testing in browsers on the target devices.
