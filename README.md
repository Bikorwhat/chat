# ⚡ fchat — Ephemeral Real-Time Chat Platform

> Zero-database · No accounts · End-to-end encrypted · Auto-destroyed

A full-stack ephemeral chat application. Create a "Space" (room), share the link, and start chatting — all data lives **only in RAM** and vanishes when the room closes.

## 🚀 Quick Start

```bash
cd fchat
npm install
npm run dev    # development (with nodemon)
# OR
npm start      # production
```

Open **http://localhost:3000**

## ✨ Features

- Ephemeral spaces with shareable `/space/<id>` URLs
- 1-on-1 and Group Chat modes
- Image sharing (≤10MB), Video sharing (≤50MB)
- Voice Notes via MediaRecorder API (≤2 min)
- Drag-and-drop media upload
- Emoji reactions + reply threads
- Live typing indicators
- XSS sanitization + rate limiting
- Auto room garbage collection
- Bounded RAM: unjoined spaces expire after 1 minute and each message after 2 minutes; limits of 250 spaces, 500 connections, and 256MB retained media per server process
