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
