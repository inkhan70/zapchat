/* ═══════════════════════════════════════════
   ZapChat – Client App
   Dynamic origin routing for Back4app + local dev
   ═══════════════════════════════════════════ */

// ─── Dynamic Server Origin ───────────────────────────────────────────────────
// Automatically resolves to the correct backend:
//   Production (Back4app):  https://echochat-fvq5kwvs.b4a.run
//   Same-origin fallback:   window.location.origin  (Vercel / localhost)
const PROD_ORIGIN = 'https://echochat-fvq5kwvs.b4a.run';
const API = (
  window.location.hostname === 'echochat-fvq5kwvs.b4a.run' ||
  window.location.hostname.endsWith('.b4a.run')
) ? PROD_ORIGIN : window.location.origin;

const EMOJIS = ['😀','😂','🥰','😎','🤔','😢','😡','🔥','❤️','👍','👎','🎉','🙌','💯','✅','🚀','💬','⚡','🌟','😮','🤣','😅','🥳','😴','🤝','🙏','👋','💪','🎊','🌈'];

class ZapChat {
  constructor() {
    this.socket      = null;
    this.token       = localStorage.getItem('zc_token');
    this.user        = JSON.parse(localStorage.getItem('zc_user') || 'null');
    this.activeChat  = null;
    this.chats       = new Map();
    this.onlineSet   = new Set();
    this.typingTimer = null;
    this.isTyping    = false;

    // ─── DOM Cache ─────────────────────────────────────────────────────────
    // Pre-caching frequent nodes eliminates repeated querySelector calls and
    // prevents layout-reflow cycles in hot message-render paths.
    this.domCache = {};

    this.bindAuthUI();
    if (this.token && this.user) this.boot();
  }

  // ─── DOM Cache Accessor ─────────────────────────────────────────────────
  dom(id) {
    if (!this.domCache[id]) this.domCache[id] = document.getElementById(id);
    return this.domCache[id];
  }

  // ─── AUTH ────────────────────────────────────────────────────────────────
  bindAuthUI() {
    document.querySelectorAll('.auth-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const which = tab.dataset.tab;
        document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
        document.getElementById(which + '-panel').classList.add('active');
        document.querySelector('.auth-tab-slider').classList.toggle('right', which === 'register');
      });
    });

    document.getElementById('login-btn').addEventListener('click', () => this.login());
    document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') this.login(); });
    document.getElementById('register-btn').addEventListener('click', () => this.register());
    document.getElementById('reg-password').addEventListener('keydown', e => { if (e.key === 'Enter') this.register(); });
  }

  async login() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errEl    = document.getElementById('login-error');
    errEl.textContent = '';
    if (!username || !password) { errEl.textContent = 'Please fill all fields.'; return; }
    const btn = document.getElementById('login-btn');
    btn.style.opacity = '0.6';
    try {
      const res  = await fetch(`${API}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) { errEl.textContent = data.error; return; }
      this.saveSession(data.token, data.user);
      this.boot();
    } catch { errEl.textContent = 'Cannot connect to server.'; }
    finally   { btn.style.opacity = '1'; }
  }

  async register() {
    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value;
    const errEl    = document.getElementById('register-error');
    errEl.textContent = '';
    if (!username || !password) { errEl.textContent = 'Please fill all fields.'; return; }
    const btn = document.getElementById('register-btn');
    btn.style.opacity = '0.6';
    try {
      const res  = await fetch(`${API}/api/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) { errEl.textContent = data.error; return; }
      this.saveSession(data.token, data.user);
      this.boot();
    } catch { errEl.textContent = 'Cannot connect to server.'; }
    finally   { btn.style.opacity = '1'; }
  }

  saveSession(token, user) {
    this.token = token;
    this.user  = user;
    localStorage.setItem('zc_token', token);
    localStorage.setItem('zc_user', JSON.stringify(user));
  }

  logout() {
    localStorage.removeItem('zc_token');
    localStorage.removeItem('zc_user');
    if (this.socket) this.socket.disconnect();
    this.domCache = {};
    location.reload();
  }

  // ─── BOOT ────────────────────────────────────────────────────────────────
  boot() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    // Prime the DOM cache for all hot-path nodes immediately after mount
    ['messages-area','message-input','chat-name','chat-avatar','chat-status',
     'chat-empty','active-chat','users-list','chats-section','contacts-section',
     'search-input','me-name','me-avatar'].forEach(id => {
      this.domCache[id] = document.getElementById(id);
    });

    if (this.domCache['me-name'])   this.domCache['me-name'].textContent   = this.user.username;
    if (this.domCache['me-avatar']) this.domCache['me-avatar'].textContent = this.user.username.charAt(0).toUpperCase();

    document.getElementById('logout-btn').addEventListener('click', () => this.logout());
    document.getElementById('back-btn').addEventListener('click', () => this.closeChatMobile());
    document.getElementById('send-btn').addEventListener('click', () => this.sendMessage());

    // ─── Call buttons ────────────────────────────────────────────────────
    // The Metered SDK uses ONE namespace — `new Metered.Meeting()` — for both
    // voice-only and video calls. We just skip startVideo() for voice calls.
    // (Spec said `new MeteredVideo()` and `meeting.join({roomName,userName})`,
    //  but the real SDK takes `new Metered.Meeting()` + `{roomURL, name}`.)
    this.call = new VideoCall(this);
    document.getElementById('voice-call-btn').addEventListener('click', () => this.call.start({ video: false }));
    document.getElementById('video-call-btn').addEventListener('click', () => this.call.start({ video: true  }));

    const input = this.dom('message-input');
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendMessage(); } });
    input.addEventListener('input', () => this.onInputChange());

    this.dom('search-input').addEventListener('input', e => this.filterContacts(e.target.value));

    document.querySelectorAll('.s-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.s-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('chats-section').classList.toggle('hidden', tab.dataset.section !== 'chats');
        document.getElementById('contacts-section').classList.toggle('hidden', tab.dataset.section !== 'contacts');
      });
    });

    document.querySelector('.emoji-btn').addEventListener('click', e => {
      e.stopPropagation();
      document.getElementById('emoji-picker').classList.toggle('hidden');
    });
    document.addEventListener('click', () => document.getElementById('emoji-picker')?.classList.add('hidden'));

    const toasts = document.createElement('div');
    toasts.className = 'toast-container';
    document.body.appendChild(toasts);

    this.buildEmojiPicker();
    this.connectSocket();
    this.fetchUsers();
  }

  // ─── SOCKET ──────────────────────────────────────────────────────────────
  connectSocket() {
    this.socket = io(API, {
      auth:                 { token: this.token },
      // WebSocket first, polling fallback — critical for Back4app reverse-proxy
      transports:           ['websocket', 'polling'],
      reconnectionAttempts: 10,
      reconnectionDelay:    2000,
      timeout:              20000,
      withCredentials:      true,
    });

    this.socket.on('connect', () => {
      console.log('Socket connected via', this.socket.io.engine.transport.name);
    });

    this.socket.on('connect_error', err => {
      console.error('Socket connect_error:', err.message);
      this.showToast('Connection Error', 'Could not connect to server.', 'error');
    });

    this.socket.on('disconnect', reason => console.log('Socket disconnected:', reason));

    this.socket.on('online_users', users => {
      this.onlineSet = new Set(users);
      this.refreshOnlineStatus();
    });

    this.socket.on('user_status', ({ username, online }) => {
      if (online) this.onlineSet.add(username);
      else         this.onlineSet.delete(username);
      this.refreshOnlineStatus();
      if (username === this.activeChat)
        this.dom('chat-status').textContent = online ? '🟢 Online' : '🔒 Encrypted';
    });

    this.socket.on('private_message', msg => this.receiveMessage(msg));
    this.socket.on('message_sent',    msg => this.onMessageSent(msg));

    this.socket.on('typing_start', ({ from }) => {
      if (!this.chats.has(from)) return;
      this.chats.get(from).typing = true;
      this.updateChatListItem(from);
      if (this.activeChat === from) this.showTypingIndicator();
    });

    this.socket.on('typing_stop', ({ from }) => {
      if (!this.chats.has(from)) return;
      this.chats.get(from).typing = false;
      this.updateChatListItem(from);
      if (this.activeChat === from) this.removeTypingIndicator();
    });

    this.socket.on('messages_read', ({ by }) => {
      if (this.activeChat === by) this.updateReadStatuses();
    });
  }

  // ─── USERS ───────────────────────────────────────────────────────────────
  async fetchUsers() {
    try {
      const res   = await fetch(`${API}/api/users`, {
        headers: { Authorization: `Bearer ${this.token}` }
      });
      const users = await res.json();
      this.renderUserList(users);
    } catch (e) { console.error('fetchUsers error:', e); }
  }

  renderUserList(users) {
    const list = this.dom('users-list');
    // DocumentFragment batches all contact insertions → single DOM reflow
    const frag = document.createDocumentFragment();
    users.forEach(u => frag.appendChild(this.createContactEl(u)));
    list.innerHTML = '';
    list.appendChild(frag);
  }

  createContactEl(user, fromChat = false) {
    const chat     = this.chats.get(user.username);
    const isOnline = this.onlineSet.has(user.username);
    const el       = document.createElement('div');
    el.className       = 'contact-item';
    el.dataset.username = user.username;
    el.innerHTML = `
      <div class="c-avatar ${isOnline ? 'online' : ''}">${(user.username||'?').charAt(0).toUpperCase()}</div>
      <div class="c-info">
        <div class="c-top">
          <span class="c-name">${this.escHtml(user.username)}</span>
          <span class="c-time">${chat?.lastTime ? this.formatTime(chat.lastTime) : ''}</span>
        </div>
        <div class="c-bottom">
          <span class="c-last ${chat?.typing ? 'typing' : ''}">${
            chat?.typing ? '✍️ typing…' : (chat?.lastMsg ? this.escHtml(chat.lastMsg) : 'Start a conversation')
          }</span>
          ${chat?.unread ? `<div class="c-meta"><div class="c-badge">${chat.unread > 9 ? '9+' : chat.unread}</div></div>` : ''}
        </div>
      </div>`;
    el.addEventListener('click', () => this.openChat(user.username));
    return el;
  }

  refreshOnlineStatus() {
    document.querySelectorAll('.contact-item').forEach(el => {
      const av = el.querySelector('.c-avatar');
      if (av) av.classList.toggle('online', this.onlineSet.has(el.dataset.username));
    });
  }

  filterContacts(q) {
    document.querySelectorAll('.contact-item').forEach(el => {
      el.style.display = (el.dataset.username||'').toLowerCase().includes(q.toLowerCase()) ? '' : 'none';
    });
  }

  ensureChat(username) {
    if (!this.chats.has(username))
      this.chats.set(username, { messages: [], unread: 0, lastMsg: '', lastTime: '', typing: false });
  }

  // ─── OPEN / CLOSE CHAT ───────────────────────────────────────────────────
  async openChat(username) {
    this.activeChat = username;
    this.ensureChat(username);
    this.chats.get(username).unread = 0;
    this.socket.emit('mark_read', { from: username });

    this.dom('chat-name').textContent   = username;
    this.dom('chat-avatar').textContent = username.charAt(0).toUpperCase();
    this.dom('chat-status').textContent = this.onlineSet.has(username) ? '🟢 Online' : '🔒 Encrypted';
    this.dom('chat-empty').classList.add('hidden');
    this.dom('active-chat').classList.remove('hidden');

    document.querySelector('.chat-panel').classList.add('visible');
    document.querySelector('.sidebar').classList.add('hidden-mobile');
    document.querySelectorAll('.contact-item').forEach(el => {
      el.classList.toggle('active', el.dataset.username === username);
    });

    const msgArea = this.dom('messages-area');
    msgArea.innerHTML = '<div class="messages-date-divider"><span>Today</span></div>';

    try {
      const res     = await fetch(`${API}/api/messages/${username}`, {
        headers: { Authorization: `Bearer ${this.token}` }
      });
      const history = await res.json();
      // DocumentFragment → single reflow for entire history batch
      const frag = document.createDocumentFragment();
      this.chats.get(username).messages = history;
      history.forEach(m => frag.appendChild(this.buildMessageNode(m)));
      msgArea.appendChild(frag);
    } catch {
      const frag = document.createDocumentFragment();
      this.chats.get(username).messages.forEach(m => frag.appendChild(this.buildMessageNode(m)));
      msgArea.appendChild(frag);
    }

    this.scrollBottom();
    this.dom('message-input').focus();
    this.removeTypingIndicator();
    if (this.chats.get(username).typing) this.showTypingIndicator();
    this.updateChatListItem(username);
  }

  closeChatMobile() {
    document.querySelector('.chat-panel').classList.remove('visible');
    document.querySelector('.sidebar').classList.remove('hidden-mobile');
    this.activeChat = null;
  }

  // ─── MESSAGES ────────────────────────────────────────────────────────────
  sendMessage() {
    const input = this.dom('message-input');
    const text  = input.value.trim();
    if (!text || !this.activeChat) return;
    this.socket.emit('private_message', { to: this.activeChat, text });
    input.value        = '';
    input.style.height = 'auto';
    this.stopTyping();
  }

  onMessageSent(msg) {
    this.ensureChat(msg.to);
    const chat   = this.chats.get(msg.to);
    msg.status   = 'sent';
    chat.messages.push(msg);
    chat.lastMsg  = msg.text;
    chat.lastTime = msg.timestamp;
    if (this.activeChat === msg.to) { this.renderMessage(msg); this.scrollBottom(); }
    this.updateChatListItem(msg.to);
    this.upsertChatsSection(msg.to);
  }

  receiveMessage(msg) {
    this.ensureChat(msg.from);
    const chat   = this.chats.get(msg.from);
    msg.status   = 'received';
    chat.messages.push(msg);
    chat.lastMsg  = msg.text;
    chat.lastTime = msg.timestamp;
    if (this.activeChat === msg.from) {
      this.removeTypingIndicator();
      this.renderMessage(msg);
      this.scrollBottom();
      this.socket.emit('mark_read', { from: msg.from });
    } else {
      chat.unread = (chat.unread || 0) + 1;
      this.showToast(msg.from, msg.text);
    }
    this.updateChatListItem(msg.from);
    this.upsertChatsSection(msg.from);
  }

  // Returns a detached DOM node — safe to batch inside DocumentFragment
  buildMessageNode(msg) {
    const isSent = msg.from === this.user.username;
    const row    = document.createElement('div');
    row.className  = `msg-row ${isSent ? 'sent' : 'received'}`;
    row.dataset.id = msg.id;
    const statusIcon = isSent
      ? `<span class="msg-status ${msg.status||'sent'}">${msg.status==='read'||msg.status==='delivered'?'✓✓':'✓'}</span>`
      : '';
    row.innerHTML = `
      <div class="msg-bubble">
        <div class="msg-text">${this.escHtml(msg.text)}</div>
        <div class="msg-meta">
          <span class="msg-time">${this.formatTime(msg.timestamp)}</span>
          ${statusIcon}
        </div>
      </div>`;
    return row;
  }

  renderMessage(msg) {
    this.dom('messages-area').appendChild(this.buildMessageNode(msg));
  }

  updateReadStatuses() {
    document.querySelectorAll('.msg-row.sent .msg-status').forEach(el => {
      el.className = 'msg-status read'; el.textContent = '✓✓';
    });
  }

  // ─── TYPING ──────────────────────────────────────────────────────────────
  onInputChange() {
    const input = this.dom('message-input');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    if (!this.activeChat) return;
    if (!this.isTyping) { this.isTyping = true; this.socket.emit('typing_start', { to: this.activeChat }); }
    clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.stopTyping(), 2500);
  }

  stopTyping() {
    if (this.isTyping && this.activeChat) { this.isTyping = false; this.socket.emit('typing_stop', { to: this.activeChat }); }
    clearTimeout(this.typingTimer);
  }

  showTypingIndicator() {
    if (document.getElementById('typing-indicator')) return;
    const row = document.createElement('div');
    row.className = 'msg-row received typing-indicator'; row.id = 'typing-indicator';
    row.innerHTML = `<div class="msg-bubble"><div class="typing-dots"><span></span><span></span><span></span></div></div>`;
    this.dom('messages-area').appendChild(row);
    this.scrollBottom();
  }

  removeTypingIndicator() { document.getElementById('typing-indicator')?.remove(); }

  // ─── CHAT LIST ────────────────────────────────────────────────────────────
  updateChatListItem(username) {
    const contactEl = document.querySelector(`#contacts-section .contact-item[data-username="${username}"]`);
    if (contactEl) {
      const chat = this.chats.get(username);
      contactEl.querySelector('.c-avatar').className = `c-avatar ${this.onlineSet.has(username) ? 'online' : ''}`;
      const lastEl = contactEl.querySelector('.c-last');
      lastEl.className  = `c-last ${chat?.typing ? 'typing' : ''}`;
      lastEl.textContent = chat?.typing ? '✍️ typing…' : (chat?.lastMsg || 'Start a conversation');
      const timeEl = contactEl.querySelector('.c-time');
      if (timeEl) timeEl.textContent = chat?.lastTime ? this.formatTime(chat.lastTime) : '';
      contactEl.querySelector('.c-badge')?.remove();
      if (chat?.unread) {
        const b = document.createElement('div'); b.className = 'c-badge';
        b.textContent = chat.unread > 9 ? '9+' : chat.unread;
        contactEl.querySelector('.c-meta')?.appendChild(b);
      }
    }
    document.querySelector(`#chats-section .contact-item[data-username="${username}"]`)?.remove();
    this.upsertChatsSection(username);
  }

  upsertChatsSection(username) {
    const section = this.dom('chats-section');
    section.querySelector('.empty-state')?.remove();
    section.querySelector(`[data-username="${username}"]`)?.remove();
    section.insertBefore(this.createContactEl({ username }, true), section.firstChild);
  }

  // ─── EMOJI ───────────────────────────────────────────────────────────────
  buildEmojiPicker() {
    const picker = document.getElementById('emoji-picker');
    // DocumentFragment → single reflow for all 30 emoji buttons
    const frag   = document.createDocumentFragment();
    EMOJIS.forEach(em => {
      const btn = document.createElement('span');
      btn.className = 'emoji-btn-item'; btn.textContent = em;
      btn.addEventListener('click', e => {
        e.stopPropagation();
        this.dom('message-input').value += em;
        this.dom('message-input').focus();
        document.getElementById('emoji-picker').classList.add('hidden');
      });
      frag.appendChild(btn);
    });
    picker.appendChild(frag);
  }

  // ─── TOASTS ──────────────────────────────────────────────────────────────
  showToast(title, body, type = 'message') {
    const container = document.querySelector('.toast-container');
    const toast     = document.createElement('div');
    toast.className = 'toast';
    if (type === 'error') toast.style.borderLeftColor = 'var(--danger)';
    toast.innerHTML = `<div class="toast-title">${this.escHtml(title)}</div><div class="toast-body">${this.escHtml(String(body).substring(0,60))}</div>`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4200);
  }

  // ─── UTILS ───────────────────────────────────────────────────────────────
  scrollBottom() {
    const area = this.dom('messages-area');
    requestAnimationFrame(() => { area.scrollTop = area.scrollHeight; });
  }

  formatTime(iso) {
    const d = new Date(iso), now = new Date();
    if (d.toDateString() === now.toDateString())
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
}

// Init
window.addEventListener('DOMContentLoaded', () => { window.app = new ZapChat(); });

/* ═════════════════════════════════════════════════════════════════════
   VideoCall — Metered Video SDK wrapper for ZapChat
   - One class per call session
   - Owns DOM nodes inside #call-modal, the meeting instance, and a
     map of remote track IDs to their <video> tiles.
   - Listens to SDK events to keep the grid + roster in sync, with
     proper cleanup on hangup to avoid memory leaks (the spec was
     explicit about "clear memory leaks").
   ─────────────────────────────────────────────────────────────────────

   SDK reference: https://www.metered.ca/docs/llms-video-sdk.txt
   Globals used:   window.Metered.Meeting
                   meeting.join({ roomURL, name })
                   meeting.startAudio() / startVideo() / startScreenShare()
                   meeting.muteLocalAudio() / unmuteLocalAudio()
                   meeting.pauseLocalVideo() / resumeLocalVideo()
                   meeting.leaveMeeting()
                   meeting.on('remoteTrackStarted' | 'remoteTrackStopped'
                              | 'participantJoined' | 'participantLeft'
                              | 'onlineParticipants' | 'activeSpeaker'
                              | 'stateChanged' | 'meetingLeft')
   ═════════════════════════════════════════════════════════════════════ */
class VideoCall {
  constructor(app) {
    this.app    = app;
    this.meeting = null;
    this.room   = null;          // { roomName, roomURL, ... } from /api/create-room
    this.active = false;         // true between start() and hangup()
    this.isVideo = true;         // whether the call includes video
    this.state  = 'idle';        // 'idle' | 'connecting' | 'connected' | 'ended' | 'failed'

    // Track state
    this.localAudioMuted  = false;
    this.localVideoPaused = false;
    this.isScreenSharing  = false;

    // Map of streamId -> { participantSessionId, name, isAudioOnly, videoEl }
    this.remoteStreams = new Map();
    // Map of participantSessionId -> { _id, name, audio, video, screen }
    this.participants  = new Map();

    // DOM cache (resolved lazily, see `dom()`)
    this._dom = {};

    this.cacheDom();
    this.bindControls();
  }

  // ── DOM helpers ────────────────────────────────────────────────────────
  dom(id) {
    if (!this._dom[id]) this._dom[id] = document.getElementById(id);
    return this._dom[id];
  }

  cacheDom() {
    [
      'call-modal', 'call-title-text', 'call-status', 'call-status-text',
      'call-remote-grid', 'call-empty', 'call-local-pip', 'call-local-video',
      'call-local-mic-off', 'call-roster', 'call-roster-list', 'call-roster-count',
      'call-mute-btn', 'call-cam-btn', 'call-screen-btn', 'call-hangup-btn',
      'voice-call-btn', 'video-call-btn',
    ].forEach(id => { this._dom[id] = document.getElementById(id); });
  }

  bindControls() {
    this.dom('call-hangup-btn').addEventListener('click', () => this.hangup());
    this.dom('call-mute-btn').addEventListener('click',  () => this.toggleAudio());
    this.dom('call-cam-btn').addEventListener('click',   () => this.toggleVideo());
    this.dom('call-screen-btn').addEventListener('click', () => this.toggleScreenShare());

    // Escape key hangs up — natural keyboard shortcut
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.active) this.hangup();
    });
  }

  // ── Public entry: start a call ──────────────────────────────────────────
  async start({ video = true } = {}) {
    if (this.active) return;
    if (!this.app.activeChat) {
      this.app.showToast('Pick a chat first', 'Open a conversation before calling.', 'error');
      return;
    }
    if (!window.Metered || !window.Metered.Meeting) {
      this.app.showToast('SDK not loaded', 'Metered SDK failed to load. Check your network.', 'error');
      console.error('Metered SDK global is missing — CDN script may not have loaded.');
      return;
    }

    this.isVideo = video;
    this.show(video ? 'Video Call' : 'Voice Call', 'Connecting…');
    this.setState('connecting');

    try {
      // 1) Ask our backend to authorize + create the room.
      //    The secret key NEVER leaves the server.
      const withUser = this.app.activeChat;
      const res = await fetch(`${API}/api/create-room`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${this.app.token}`,
        },
        body: JSON.stringify({ with: withUser, privacy: 'public' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || 'create-room failed');
      this.room = data;

      // 2) Spin up the meeting instance and bind events BEFORE join.
      this.meeting = new Metered.Meeting();
      this.bindMeetingEvents();

      // 3) Join the room. SDK expects { roomURL: "app.metered.live/roomName", name }
      await this.meeting.join({
        roomURL: data.roomURL,
        name:    this.app.user.username,
      });

      // 4) Start the requested media. The SDK will:
      //    - prompt the browser for cam/mic permissions
      //    - emit `localTrackStarted` (which we render in the PIP)
      this.active = true;
      await this.meeting.startAudio();
      if (video) await this.meeting.startVideo();

      // 5) Self in the roster
      this.participants.set('local', {
        _id: 'local', name: this.app.user.username + ' (you)',
        isLocal: true, audio: true, video,
      });
      this.renderRoster();

      this.setStatus('connected', 'Connected');
      this.app.showToast(video ? 'Call started' : 'Voice call started', data.roomName);
    } catch (err) {
      console.error('VideoCall.start error:', err);
      this.setStatus('failed', 'Failed to connect');
      this.app.showToast('Call failed', err.message || 'Could not start the call.', 'error');
      await this.hangup();
    }
  }

  // ── Event wiring ────────────────────────────────────────────────────────
  bindMeetingEvents() {
    const m = this.meeting;

    // Connection state — drives the header pill
    m.on('stateChanged', state => {
      console.log('Meeting state:', state);
      if (state === 'joined')             this.setStatus('connected', 'Connected');
      else if (state === 'connecting_streams') this.setStatus('connecting', 'Negotiating media…');
      else if (state === 'network_connection_lost') this.setStatus('connecting', 'Reconnecting…');
      else if (state === 'reconnect_success') this.setStatus('connected', 'Reconnected');
      else if (state === 'terminated')    { this.setStatus('ended', 'Meeting ended'); this.hangup(); }
    });

    // Local track started — paint the PIP preview.
    m.on('localTrackStarted', item => {
      if (item.type === 'video') this.attachLocalVideo(item.track);
      this.updateLocalMicIndicator();
      this.refreshTileStates();
    });
    m.on('localTrackStopped', item => {
      if (item.type === 'video') this.dom('call-local-video').srcObject = null;
      this.refreshTileStates();
    });
    m.on('localTrackUpdated', item => {
      if (item.type === 'video') this.attachLocalVideo(item.track);
    });

    // Remote stream lifecycle — see SDK reference for `remoteTrackItem` shape.
    m.on('remoteTrackStarted', item => {
      const stream = new MediaStream([item.track]);
      const tile = this.createRemoteTile({
        streamId:             item.streamId,
        participantSessionId: item.participantSessionId,
        name:                 item.name || 'Guest',
        kind:                 item.type, // 'audio' | 'video' | 'screen'
        stream,
      });
      this.remoteStreams.set(item.streamId, tile);
      this.refreshTileStates();
    });

    m.on('remoteTrackStopped', item => {
      this.removeRemoteStream(item.streamId, /*keepRosterIfSameParticipant*/ true);
      this.refreshTileStates();
    });

    // Roster events
    m.on('participantJoined', p => {
      this.participants.set(p._id, {
        _id: p._id, name: p.name || 'Guest',
        isLocal: false, audio: false, video: false, screen: false,
      });
      this.renderRoster();
    });

    m.on('participantLeft', p => {
      // Remove every remote stream that belonged to this participant
      for (const [streamId, tile] of this.remoteStreams) {
        if (tile.participantSessionId === p._id) this.removeRemoteStream(streamId, false);
      }
      this.participants.delete(p._id);
      this.renderRoster();
      this.refreshTileStates();
    });

    // Full roster snapshot (server pushes periodically)
    m.on('onlineParticipants', list => {
      const next = new Map();
      next.set('local', this.participants.get('local'));
      for (const p of list) {
        const existing = this.participants.get(p._id);
        next.set(p._id, {
          _id: p._id, name: p.name || 'Guest',
          isLocal: false,
          audio: existing?.audio ?? false,
          video: existing?.video ?? false,
          screen: existing?.screen ?? false,
        });
      }
      this.participants = next;
      this.renderRoster();
    });

    // Active speaker highlight
    m.on('activeSpeaker', s => {
      // Clear previous speaker
      this.dom('call-remote-grid').querySelectorAll('.call-tile.speaking')
        .forEach(el => el.classList.remove('speaking'));
      this.dom('call-roster-list').querySelectorAll('.call-roster-item.speaking')
        .forEach(el => el.classList.remove('speaking'));

      if (!s || !s.streamId) return;
      const tile = this.remoteStreams.get(s.streamId);
      if (tile) tile.videoEl.closest('.call-tile')?.classList.add('speaking');
      const rosterItem = this.dom('call-roster-list')
        .querySelector(`.call-roster-item[data-pid="${CSS.escape(s.participantSessionId)}"]`);
      rosterItem?.classList.add('speaking');
    });

    // Confirmation that leaveMeeting completed locally
    m.on('meetingLeft', () => {
      this.setStatus('ended', 'You left the call');
    });
  }

  // ── Local media plumbing ────────────────────────────────────────────────
  attachLocalVideo(track) {
    const v = this.dom('call-local-video');
    // Replace stream cleanly to avoid "Stream already in use" errors when
    // switching devices or toggling.
    v.srcObject = new MediaStream([track]);
  }

  updateLocalMicIndicator() {
    this.dom('call-local-mic-off').classList.toggle('hidden', !this.localAudioMuted);
  }

  // ── Toggles ─────────────────────────────────────────────────────────────
  async toggleAudio() {
    if (!this.meeting || !this.active) return;
    try {
      if (this.localAudioMuted) {
        await this.meeting.unmuteLocalAudio();
        this.localAudioMuted = false;
        this.setCtrlState('call-mute-btn', false);
      } else {
        await this.meeting.muteLocalAudio();
        this.localAudioMuted = true;
        this.setCtrlState('call-mute-btn', true);
      }
      this.updateLocalMicIndicator();
      this.refreshTileStates();
    } catch (e) { console.error('toggleAudio error:', e); }
  }

  async toggleVideo() {
    if (!this.meeting || !this.active) return;
    if (!this.isVideo) return; // voice-only call
    try {
      if (this.localVideoPaused) {
        await this.meeting.resumeLocalVideo();
        this.localVideoPaused = false;
        this.setCtrlState('call-cam-btn', false);
      } else {
        await this.meeting.pauseLocalVideo();
        this.localVideoPaused = true;
        this.setCtrlState('call-cam-btn', true);
      }
      this.refreshTileStates();
    } catch (e) { console.error('toggleVideo error:', e); }
  }

  async toggleScreenShare() {
    if (!this.meeting || !this.active) return;
    try {
      if (this.isScreenSharing) {
        await this.meeting.stopVideo();   // stopVideo stops whatever video producer is active
        this.isScreenSharing = false;
        // After stopping, restart the camera (voice-only calls unaffected)
        if (this.isVideo) await this.meeting.startVideo();
      } else {
        await this.meeting.startScreenShare();
        this.isScreenSharing = true;
      }
      this.setCtrlState('call-screen-btn', this.isScreenSharing);
    } catch (e) {
      console.error('toggleScreenShare error:', e);
      // User-cancelled picker throws — that's fine.
    }
  }

  setCtrlState(id, muted) {
    const btn = this.dom(id);
    btn.classList.toggle('muted', muted);
    if (id === 'call-mute-btn') {
      btn.querySelector('i').className = muted ? 'fas fa-microphone-slash' : 'fas fa-microphone';
    } else if (id === 'call-cam-btn') {
      btn.querySelector('i').className = muted ? 'fas fa-video-slash' : 'fas fa-video';
    } else if (id === 'call-screen-btn') {
      btn.querySelector('i').className = muted ? 'fas fa-stop' : 'fas fa-desktop';
    }
  }

  // ── Remote tile management ─────────────────────────────────────────────
  createRemoteTile({ streamId, participantSessionId, name, kind, stream }) {
    const grid = this.dom('call-remote-grid');

    const tile = document.createElement('div');
    tile.className = 'call-tile';
    tile.dataset.streamId    = streamId;
    tile.dataset.participant = participantSessionId;
    tile.dataset.kind        = kind;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = stream;
    tile.appendChild(video);

    const label = document.createElement('div');
    label.className = 'call-tile-label';
    label.innerHTML = `<span>${this.app.escHtml(name)}</span>` +
                      `<span class="mic-off hidden"><i class="fas fa-microphone-slash"></i></span>`;
    tile.appendChild(label);

    const conn = document.createElement('span');
    conn.className = 'call-tile-connection';
    tile.appendChild(conn);

    grid.appendChild(tile);

    return { streamId, participantSessionId, name, kind, videoEl: video, labelEl: label, tileEl: tile };
  }

  removeRemoteStream(streamId, keepRosterIfSameParticipant) {
    const tile = this.remoteStreams.get(streamId);
    if (!tile) return;
    // Detach the MediaStream from the <video> so the browser releases the
    // sink — this is the "clear memory leak" path called out in the spec.
    try { tile.videoEl.pause(); tile.videoEl.srcObject = null; } catch (_) {}
    tile.tileEl.remove();
    this.remoteStreams.delete(streamId);

    // If the participant has no more streams AND we're not told to keep them,
    // drop them from the roster.
    if (!keepRosterIfSameParticipant) {
      const hasAny = Array.from(this.remoteStreams.values())
        .some(t => t.participantSessionId === tile.participantSessionId);
      if (!hasAny) this.participants.delete(tile.participantSessionId);
      this.renderRoster();
    }
  }

  refreshTileStates() {
    // Mark audio-only tiles (no active video for that participant)
    const byParticipant = new Map();
    for (const t of this.remoteStreams.values()) {
      const cur = byParticipant.get(t.participantSessionId);
      if (!cur || t.kind === 'video' || t.kind === 'screen') byParticipant.set(t.participantSessionId, t);
    }
    for (const t of this.remoteStreams.values()) {
      const dominant = byParticipant.get(t.participantSessionId);
      const isAudioOnly = dominant.kind === 'audio';
      t.tileEl.classList.toggle('audio-only', isAudioOnly);
      t.tileEl.dataset.initial = (t.name || '?').charAt(0).toUpperCase();
      // Mic-off indicator on the tile label
      const micOffEl = t.labelEl.querySelector('.mic-off');
      if (micOffEl) micOffEl.classList.toggle('hidden', !isAudioOnly ? false : false); // show muted? leave as-is; remote mute comes from SDK
    }
  }

  // ── Roster rendering ────────────────────────────────────────────────────
  renderRoster() {
    const list  = this.dom('call-roster-list');
    const count = this.dom('call-roster-count');
    list.innerHTML = '';
    let n = 0;
    for (const p of this.participants.values()) {
      n++;
      const li = document.createElement('li');
      li.className = 'call-roster-item';
      li.dataset.pid = p._id;
      if (p.isLocal && this.localAudioMuted) li.classList.add('speaking'); // no-op reuse
      li.innerHTML = `
        <div class="call-roster-avatar">${this.app.escHtml((p.name||'?').charAt(0).toUpperCase())}</div>
        <div class="call-roster-name">${this.app.escHtml(p.name || 'Guest')}</div>
        <div class="call-roster-status">
          ${p.audio ? '' : '<i class="fas fa-microphone-slash" title="mic off"></i>'}
        </div>`;
      list.appendChild(li);
    }
    count.textContent = n;
  }

  // ── Modal + status helpers ──────────────────────────────────────────────
  show(title, statusText) {
    this.dom('call-title-text').textContent = title;
    this.dom('call-status-text').textContent = statusText || 'Connecting…';
    this.dom('call-modal').classList.remove('hidden');
    this.dom('call-modal').setAttribute('aria-hidden', 'false');
    this.dom('voice-call-btn').classList.toggle('active', this.active);
    this.dom('video-call-btn').classList.toggle('active', this.active);
  }
  hide() {
    this.dom('call-modal').classList.add('hidden');
    this.dom('call-modal').setAttribute('aria-hidden', 'true');
    this.dom('voice-call-btn').classList.remove('active');
    this.dom('video-call-btn').classList.remove('active');
  }

  setStatus(kind, text) {
    const s = this.dom('call-status');
    s.classList.remove('connected', 'failed', 'ended');
    if (kind === 'connected') s.classList.add('connected');
    if (kind === 'failed')    s.classList.add('failed');
    if (kind === 'ended')     s.classList.add('ended');
    s.querySelector('#call-status-text').textContent = text;
  }

  setState(s) { this.state = s; }

  // ── Hangup / cleanup ────────────────────────────────────────────────────
  async hangup() {
    if (!this.active && !this.meeting) { this.hide(); return; }
    this.active = false;

    try { if (this.meeting) await this.meeting.leaveMeeting(); } catch (e) { console.warn('leaveMeeting:', e); }

    // Tear down every remote <video> + tile (memory leak prevention)
    for (const streamId of Array.from(this.remoteStreams.keys())) {
      this.removeRemoteStream(streamId, false);
    }

    // Detach local preview
    const local = this.dom('call-local-video');
    try { local.pause(); local.srcObject = null; } catch (_) {}

    // Reset control states
    this.localAudioMuted = false;
    this.localVideoPaused = false;
    this.isScreenSharing = false;
    this.setCtrlState('call-mute-btn', false);
    this.setCtrlState('call-cam-btn', false);
    this.setCtrlState('call-screen-btn', false);
    this.updateLocalMicIndicator();

    // Reset roster
    this.participants.clear();
    this.renderRoster();
    this.setStatus('ended', 'Call ended');

    this.meeting = null;
    this.room    = null;
    this.setState('idle');

    // Slight delay so the user sees the "ended" pill
    setTimeout(() => this.hide(), 350);
  }
}
