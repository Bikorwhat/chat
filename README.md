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

## 🌐 Deploy to Render

1. Push to GitHub
2. Render → New Web Service → connect repo
3. Build: `npm install` | Start: `npm start`
4. Deploy!

> Render is recommended over Vercel for Socket.io apps.
