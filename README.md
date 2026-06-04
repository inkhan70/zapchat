# ⚡ ZapChat — Full Stack Real-Time Chat App

> A production-ready, WhatsApp-style real-time messaging app built with **Node.js**, **Socket.IO**, **Express**, and vanilla **HTML/CSS/JS**.

![ZapChat](https://img.shields.io/badge/ZapChat-v1.0-25d366?style=for-the-badge&logo=whatsapp)
![Node](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js)
![Socket.IO](https://img.shields.io/badge/Socket.IO-4.7-010101?style=for-the-badge&logo=socket.io)
![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)

---

## ✨ Features

| Feature | Details |
|---|---|
| 🔐 **JWT Authentication** | Register & login with bcrypt-hashed passwords |
| 💬 **Real-Time Messaging** | Socket.IO private messages with instant delivery |
| ✍️ **Typing Indicators** | Live "typing..." shown to the recipient |
| ✅ **Read Receipts** | Single ✓ (sent) → Double ✓✓ (read, green) |
| 🟢 **Online Presence** | Live online/offline status per user |
| 📜 **Message History** | Persistent in-session chat history via REST API |
| 🔔 **Toast Notifications** | Pop-up alerts for messages in other chats |
| 😀 **Emoji Picker** | 30-emoji quick picker in composer |
| 📱 **Fully Responsive** | Mobile-first, slide-in chat panel |
| 🌑 **Dark Theme** | Premium dark UI inspired by WhatsApp |

---

## 🏗 Architecture

```
zapchat/
├── server/                  # Node.js + Express + Socket.IO backend
│   ├── index.js             # Main server (REST API + WebSocket logic)
│   ├── package.json
│   └── .env.example
│
├── client/
│   └── public/              # Static frontend (served by Express)
│       ├── index.html       # App shell + auth screens
│       ├── style.css        # Full dark UI (CSS variables, animations)
│       └── app.js           # ZapChat class (all client logic)
│
├── package.json             # Root scripts
├── .gitignore
└── README.md
```

### Tech Stack

**Backend**
- **Express** — REST endpoints (`/api/register`, `/api/login`, `/api/users`, `/api/messages/:with`)
- **Socket.IO** — Real-time bidirectional events
- **JWT (jsonwebtoken)** — Stateless auth on both REST and WebSocket
- **bcryptjs** — Secure password hashing
- **uuid** — Unique message IDs

**Frontend**
- Vanilla HTML/CSS/JS — Zero framework, zero build step
- Socket.IO client — WebSocket connection
- CSS Variables + Animations — Premium dark theme
- Mobile responsive — Slide-in panel on `< 768px`

### Socket.IO Events

| Event | Direction | Payload |
|---|---|---|
| `private_message` | Client → Server | `{ to, text }` |
| `private_message` | Server → Client | `{ id, from, to, text, timestamp }` |
| `message_sent` | Server → Sender | Same message object (confirmation) |
| `typing_start` | Client ↔ Server | `{ to }` / `{ from }` |
| `typing_stop` | Client ↔ Server | `{ to }` / `{ from }` |
| `mark_read` | Client → Server | `{ from }` |
| `messages_read` | Server → Sender | `{ by }` |
| `user_status` | Server → All | `{ username, online }` |
| `online_users` | Server → Client | `string[]` |

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ ([nodejs.org](https://nodejs.org))
- npm 9+

### 1. Clone the repo
```bash
git clone https://github.com/YOUR_USERNAME/zapchat.git
cd zapchat
```

### 2. Install dependencies
```bash
cd server
npm install
```

### 3. Set up environment
```bash
cp .env.example .env
# Edit .env — change JWT_SECRET to a strong random string
```

### 4. Run the server
```bash
# Development (with auto-restart)
npm run dev

# Production
npm start
```

### 5. Open the app
```
http://localhost:5000
```

> The server also serves the static frontend. Open two browser tabs/windows, register different usernames, and chat in real time!

---

## 🌐 Deploy to Production

### Option A — Railway (free tier)
1. Push to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Set env vars: `JWT_SECRET`, `PORT=5000`, `CLIENT_URL=https://your-app.railway.app`
4. Done ✅

### Option B — Render (free tier)
1. [render.com](https://render.com) → New Web Service → connect repo
2. Build command: `cd server && npm install`
3. Start command: `node server/index.js`
4. Add env vars

### Option C — VPS (Ubuntu)
```bash
git clone https://github.com/YOUR_USERNAME/zapchat.git
cd zapchat/server
npm install
cp .env.example .env && nano .env
npm install -g pm2
pm2 start index.js --name zapchat
pm2 save && pm2 startup
```

---

## 📦 Publishing to GitHub

```bash
# 1. Create a new repo on github.com named "zapchat"

# 2. In the project root:
git init
git add .
git commit -m "🚀 Initial commit — ZapChat full-stack chat app"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/zapchat.git
git push -u origin main
```

---

## 🔮 Roadmap (Future Features)

- [ ] PostgreSQL / MongoDB persistence
- [ ] Group chats & channels
- [ ] File & image sharing
- [ ] Voice/video calls (WebRTC)
- [ ] Push notifications (PWA)
- [ ] Message reactions & replies
- [ ] End-to-end encryption (Signal Protocol)
- [ ] Docker + docker-compose setup

---

## 📄 License

MIT © ZapChat Contributors
