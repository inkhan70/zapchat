/* ═══════════════════════════════════════════
   ZapChat – Client App (With Call Support)
   ═══════════════════════════════════════════ */

// CRITICAL PRODUCTION FIX: Always use relative paths for basic APIs.
// However, call routing points explicitly to your secure backend.
const API = '';
const BACKEND_SERVER = 'https://zapchat-server.vercel.app';

const EMOJIS = ['😀','😂','🥰','😎','🤔','😢','😡','🔥','❤️','👍','👎','🎉','🙌','💯','✅','🚀','💬','⚡','🌟','😮','🤣','😅','🥳','😴','🤝','🙏','👋','💪','🎊','🌈'];

class ZapChat {
  constructor() {
    this.socket     = null;
    this.token      = localStorage.getItem('zc_token');
    this.user       = JSON.parse(localStorage.getItem('zc_user') || 'null');
    this.activeChat = null;      // username of current chat partner
    this.chats      = new Map();  // username → { messages[], unread, lastMsg, lastTime, typing }
    this.onlineSet  = new Set();
    this.typingTimer = null;
    this.isTyping   = false;

    // Cache frequent DOM elements for rendering performance
    this.domCache = {
      messagesArea: document.getElementById('messages-area'),
      messageInput: document.getElementById('message-input'),
      chatStatus: document.getElementById('chat-status'),
      emojiPicker: document.getElementById('emoji-picker'),
      usersList: document.getElementById('users-list'),
      chatsSection: document.getElementById('chats-section'),
    };

    this.bindAuthUI();
    if (this.token && this.user) this.boot();
  }

  // ─── AUTH ───────────────────────────────────────────────────────────────
  bindAuthUI() {
    // Tab switching
    document.querySelectorAll('.auth-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const which = tab.dataset.tab;
        document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
        document.getElementById(which + '-panel').classList.add('active');
        const slider = document.querySelector('.auth-tab-slider');
        if (slider) slider.classList.toggle('right', which === 'register');
      });
    });

    // Login
    document.getElementById('login-btn').addEventListener('click', () => this.login());
    document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') this.login(); });

    // Register
    document.getElementById('register-btn').addEventListener('click', () => this.register());
    document.getElementById('reg-password').addEventListener('keydown', e => { if (e.key === 'Enter') this.register(); });
  }

  async login() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errEl = document.getElementById('login-error');
    errEl.textContent = '';
    if (!username || !password) { errEl.textContent = 'Please fill all fields.'; return; }
    const btn = document.getElementById('login-btn');
    btn.style.opacity = '0.6';
    try {
      const res = await fetch(`${API}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) { errEl.textContent = data.error; return; }
      this.saveSession(data.token, data.user);
      this.boot();
    } catch { errEl.textContent = 'Cannot connect to server.'; }
    finally { btn.style.opacity = '1'; }
  }

  async register() {
    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value;
    const errEl = document.getElementById('register-error');
    errEl.textContent = '';
    if (!username || !password) { errEl.textContent = 'Please fill all fields.'; return; }
    const btn = document.getElementById('register-btn');
    btn.style.opacity = '0.6';
    try {
      const res = await fetch(`${API}/api/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) { errEl.textContent = data.error; return; }
      this.saveSession(data.token, data.user);
      this.boot();
    } catch { errEl.textContent = 'Cannot connect to server.'; }
    finally { btn.style.opacity = '1'; }
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
    location.reload();
  }

  // ─── BOOT ────────────────────────────────────────────────────────────────
  boot() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    // Set my avatar
    document.getElementById('me-avatar').textContent = this.user.username.charAt(0).toUpperCase();
    document.getElementById('me-name').textContent = this.user.username;

    // Logout
    document.getElementById('logout-btn').addEventListener('click', () => {
      if (confirm('Sign out?')) this.logout();
    });

    // Sidebar tabs
    document.querySelectorAll('.s-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.s-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const sec = tab.dataset.section;
        document.getElementById('chats-section').classList.toggle('hidden', sec !== 'chats');
        document.getElementById('contacts-section').classList.toggle('hidden', sec !== 'contacts');
      });
    });

    // Search
    document.getElementById('search-input').addEventListener('input', e => this.filterContacts(e.target.value));

    // Message input references
    const input = this.domCache.messageInput;
    input.addEventListener('input', () => this.onInputChange());
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendMessage(); }
    });

    // Send button
    document.getElementById('send-btn').addEventListener('click', () => this.sendMessage());

    // Back button (mobile)
    document.getElementById('back-btn').addEventListener('click', () => this.closeChatMobile());

    // Call Action Buttons (Voice & Video)
    const voiceBtn = document.getElementById('voice-call-btn');
    const videoBtn = document.getElementById('video-call-btn');
    if (voiceBtn) voiceBtn.addEventListener('click', () => this.initiateCall('voice'));
    if (videoBtn) videoBtn.addEventListener('click', () => this.initiateCall('video'));

    // Emoji
    document.querySelector('.emoji-btn').addEventListener('click', e => {
      e.stopPropagation();
      const picker = this.domCache.emojiPicker;
      picker.classList.toggle('hidden');
      if (!picker.children.length) this.buildEmojiPicker();
    });
    document.addEventListener('click', () => this.domCache.emojiPicker.classList.add('hidden'));

    // Toast container installation
    const toasts = document.createElement('div');
    toasts.className = 'toast-container';
    document.body.appendChild(toasts);

    this.connectSocket();
    this.fetchUsers();
  }

  // ─── CALL HANDLING ───────────────────────────────────────────────────────
  async initiateCall(type) {
    if (!this.activeChat) return;
    
    this.showToast('Calling...', `Starting ${type} call with ${this.activeChat}`, 'message');

    try {
      // Step 1: Query your separate backend Vercel server to build a space securely
      const response = await fetch(`${BACKEND_SERVER}/api/calls/room`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({
          roomName: `zapchat-${this.user.username}-${this.activeChat}-${Date.now()}`
        })
      });

      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Server rejected call setup request.');
      }

      // Step 2: Use the response token and properties to link the user to the WebRTC screen
      console.log('Metered room created successfully:', data.room.roomName);
      
      // Send a signaling link through websockets to alert the receiver
      this.socket.emit('call_incoming', {
        to: this.activeChat,
        roomName: data.room.roomName,
        type: type
      });

      this.joinCallRoom(data.room.roomName, type);

    } catch (err) {
      console.error('Failed to initiate call:', err);
      this.showToast('Call Error', err.message || 'Could not connect to voice/video services.', 'error');
    }
  }

  joinCallRoom(roomName, type) {
    // If you are using the Metered Embedded iframe or library script:
    // This dynamically configures an iframe area or overlay view.
    const domain = 'zapchat.metered.live'; // Your Metered domain string handle
    const callUrl = `https://${domain}/${roomName}?video=${type === 'video'}&audio=true`;
    
    // Simple popup/iframe system for standard deployment setups
    const callWindow = window.open(callUrl, 'ZapChat Call', 'width=800,height=600');
    if (!callWindow) {
      this.showToast('Popup Blocked', 'Please allow popups to enter the call screen room.', 'error');
    }
  }

  // ─── SOCKET ──────────────────────────────────────────────────────────────
  connectSocket() {
    this.socket = io(API, {
      auth: { token: this.token },
      transports: ['websocket', 'polling'],
      secure: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 2000
    });

    this.socket.on('connect', () => {
      console.log('🟢 Socket connected');
    });

    this.socket.on('connect_error', err => {
      console.error('Socket error:', err.message);
      this.showToast('Connection Error', 'Could not connect to server.', 'error');
    });

    this.socket.on('disconnect', () => {
      console.log('🔴 Socket disconnected');
    });

    // Incoming call signal receiver setup
    this.socket.on('incoming_call_signal', ({ from, roomName, type }) => {
      const accept = confirm(`Incoming ${type} call from ${from}. Accept?`);
      if (accept) {
        this.joinCallRoom(roomName, type);
      }
    });

    this.socket.on('online_users', users => {
      this.onlineSet = new Set(users);
      this.refreshOnlineStatus();
    });

    this.socket.on('user_status', ({ username, online }) => {
      if (online) this.onlineSet.add(username);
      else this.onlineSet.delete(username);
      this.refreshOnlineStatus();
      if (username === this.activeChat) {
        this.domCache.chatStatus.textContent = online ? '🟢 Online' : '🔒 Encrypted';
      }
    });

    this.socket.on('private_message', (msg) => {
      this.receiveMessage(msg);
    });

    this.socket.on('message_sent', (msg) => {
      this.onMessageSent(msg);
    });

    this.socket.on('typing_start', ({ from }) => {
      this.ensureChat(from);
      this.chats.get(from).typing = true;
      this.updateChatListItem(from);
      if (this.activeChat === from) this.showTypingIndicator();
    });

    this.socket.on('typing_stop', ({ from }) => {
      if (this.chats.has(from)) this.chats.get(from).typing = false;
      this.updateChatListItem(from);
      if (this.activeChat === from) this.removeTypingIndicator();
    });

    this.socket.on('messages_read', ({ by }) => {
      if (this.chats.has(by)) {
        const msgs = this.chats.get(by).messages;
        for (let i = 0; i < msgs.length; i++) {
          if (msgs[i].from === this.user.username) msgs[i].status = 'read';
        }
        if (this.activeChat === by) this.updateReadStatuses();
      }
    });
  }

  // ─── USERS / CONTACTS ────────────────────────────────────────────────────
  async fetchUsers() {
    try {
      const res = await fetch(`${API}/api/users`, {
        headers: { Authorization: `Bearer ${this.token}` }
      });
      const users = await res.json();
      this.renderContacts(users);
    } catch (err) {
      console.error('Failed to fetch contacts:', err);
    }
  }

  renderContacts(users) {
    const list = this.domCache.usersList;
    const fragment = document.createDocumentFragment();
    list.innerHTML = '';
    
    if (!users.length) {
      list.innerHTML = '<div class="empty-state"><i class="fas fa-user-slash"></i><p>No other users yet.</p></div>';
      return;
    }
    
    users.forEach(u => {
      if (this.onlineSet.has(u.username)) u.online = true;
      fragment.appendChild(this.createContactEl(u, false));
    });
    
    list.appendChild(fragment);
  }

  createContactEl(user, isChatItem = false) {
    const div = document.createElement('div');
    div.className = 'contact-item';
    div.dataset.username = user.username;

    const isOnline = this.onlineSet.has(user.username);
    const chatData = this.chats.get(user.username);
    const lastMsg  = chatData?.lastMsg || user.status || 'Start a conversation';
    const lastTime = chatData?.lastTime || '';
    const unread   = chatData?.unread || 0;
    const typing   = chatData?.typing || false;

    div.innerHTML = `
      <div class="c-avatar ${isOnline ? 'online' : ''}">${user.username.charAt(0).toUpperCase()}</div>
      <div class="c-info">
        <div class="c-name">${user.username}</div>
        <div class="c-last ${typing ? 'typing' : ''}">${typing ? '✍️ typing…' : this.escHtml(lastMsg)}</div>
      </div>
      <div class="c-meta">
        <div class="c-time">${lastTime ? this.formatTime(lastTime) : ''}</div>
        ${unread ? `<div class="c-badge">${unread > 9 ? '9+' : unread}</div>` : ''}
      </div>
    `;
    div.addEventListener('click', () => this.openChat(user.username));
    return div;
  }

  refreshOnlineStatus() {
    const items = this.domCache.usersList.getElementsByClassName('contact-item');
    for (let i = 0; i < items.length; i++) {
      const un = items[i].dataset.username;
      const avatar = items[i].querySelector('.c-avatar');
      if (avatar) avatar.classList.toggle('online', this.onlineSet.has(un));
    }
  }

  filterContacts(q) {
    const searchString = q.toLowerCase();
    document.querySelectorAll('.contact-item').forEach(el => {
      const name = el.dataset.username?.toLowerCase() || '';
      el.style.display = name.includes(searchString) ? '' : 'none';
    });
  }

  ensureChat(username) {
    if (!this.chats.has(username)) {
      this.chats.set(username, { messages: [], unread: 0, lastMsg: '', lastTime: '', typing: false });
    }
  }

  // ─── OPEN / CLOSE CHAT ───────────────────────────────────────────────────
  async openChat(username) {
    if (this.activeChat === username) return;
    
    this.activeChat = username;
    this.ensureChat(username);

    this.chats.get(username).unread = 0;
    this.socket.emit('mark_read', { from: username });

    document.getElementById('chat-name').textContent = username;
    document.getElementById('chat-avatar').textContent = username.charAt(0).toUpperCase();
    this.domCache.chatStatus.textContent = this.onlineSet.has(username) ? '🟢 Online' : '🔒 Encrypted';

    document.getElementById('chat-empty').classList.add('hidden');
    document.getElementById('active-chat').classList.remove('hidden');

    document.querySelector('.chat-panel').classList.add('visible');
    document.querySelector('.sidebar').classList.add('hidden-mobile');

    document.querySelectorAll('.contact-item').forEach(el => {
      el.classList.toggle('active', el.dataset.username === username);
    });

    const msgArea = this.domCache.messagesArea;
    msgArea.innerHTML = '<div class="messages-date-divider"><span>Today</span></div>';

    try {
      const res = await fetch(`${API}/api/messages/${username}`, {
        headers: { Authorization: `Bearer ${this.token}` }
      });
      const history = await res.json();
      this.chats.get(username).messages = history;
      
      const fragment = document.createDocumentFragment();
      history.forEach(m => this.renderMessage(m, fragment));
      msgArea.appendChild(fragment);
    } catch {
      const fragment = document.createDocumentFragment();
      this.chats.get(username).messages.forEach(m => this.renderMessage(m, fragment));
      msgArea.appendChild(fragment);
    }

    this.scrollBottom();
    this.domCache.messageInput.focus();

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
    const input = this.domCache.messageInput;
    const text = input.value.trim();
    if (!text || !this.activeChat) return;

    this.socket.emit('private_message', { to: this.activeChat, text });
    input.value = '';
    input.style.height = 'auto';

    this.stopTyping();
  }

  onMessageSent(msg) {
    this.ensureChat(msg.to);
    const chat = this.chats.get(msg.to);
    msg.status = 'sent';
    chat.messages.push(msg);
    chat.lastMsg  = msg.text;
    chat.lastTime = msg.timestamp;

    if (this.activeChat === msg.to) {
      this.renderMessage(msg, this.domCache.messagesArea);
      this.scrollBottom();
    }
    this.updateChatListItem(msg.to);
  }

  receiveMessage(msg) {
    this.ensureChat(msg.from);
    const chat = this.chats.get(msg.from);
    msg.status = 'received';
    chat.messages.push(msg);
    chat.lastMsg  = msg.text;
    chat.lastTime = msg.timestamp;

    if (this.activeChat === msg.from) {
      this.removeTypingIndicator();
      this.renderMessage(msg, this.domCache.messagesArea);
      this.scrollBottom();
      this.socket.emit('mark_read', { from: msg.from });
    } else {
      chat.unread = (chat.unread || 0) + 1;
      this.showToast(msg.from, msg.text);
    }

    this.updateChatListItem(msg.from);
  }

  renderMessage(msg, targetContainer) {
    const isSent = msg.from === this.user.username;
    const row = document.createElement('div');
    row.className = `msg-row ${isSent ? 'sent' : 'received'}`;
    row.dataset.id = msg.id;

    const statusIcon = isSent
      ? `<span class="msg-status ${msg.status || 'sent'}">
           ${msg.status === 'read' ? '✓✓' : '✓'}
         </span>`
      : '';

    row.innerHTML = `
      <div class="msg-bubble">
        <div class="msg-text">${this.escHtml(msg.text)}</div>
        <div class="msg-meta">
          <span class="msg-time">${this.formatTime(msg.timestamp)}</span>
          ${statusIcon}
        </div>
      </div>
    `;
    targetContainer.appendChild(row);
  }

  updateReadStatuses() {
    this.domCache.messagesArea.querySelectorAll('.msg-row.sent .msg-status').forEach(el => {
      el.className = 'msg-status read';
      el.textContent = '✓✓';
    });
  }

  // ─── TYPING ──────────────────────────────────────────────────────────────
  onInputChange() {
    const input = this.domCache.messageInput;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';

    if (!this.activeChat) return;
    if (!this.isTyping) {
      this.isTyping = true;
      this.socket.emit('typing_start', { to: this.activeChat });
    }
    clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.stopTyping(), 2000);
  }

  stopTyping() {
    if (this.isTyping && this.activeChat) {
      this.isTyping = false;
      this.socket.emit('typing_start', { to: this.activeChat });
      this.socket.emit('typing_stop', { to: this.activeChat });
    }
    clearTimeout(this.typingTimer);
  }

  showTypingIndicator() {
    if (document.getElementById('typing-indicator')) return;
    const row  = document.createElement('div');
    row.className = 'msg-row received typing-indicator';
    row.id = 'typing-indicator';
    row.innerHTML = `<div class="msg-bubble"><div class="typing-dots"><span></span><span></span><span></span></div></div>`;
    this.domCache.messagesArea.appendChild(row);
    this.scrollBottom();
  }

  removeTypingIndicator() {
    document.getElementById('typing-indicator')?.remove();
  }

  // ─── CHAT LIST MANAGEMENT ─────────────────────────────────────────────────
  updateChatListItem(username) {
    const chat = this.chats.get(username);
    const isOnline = this.onlineSet.has(username);

    const containers = [this.domCache.chatsSection, document.getElementById('contacts-section')];
    
    containers.forEach(container => {
      if (!container) return;
      const item = container.querySelector(`.contact-item[data-username="${username}"]`);
      if (item) {
        const avatar = item.querySelector('.c-avatar');
        if (avatar) avatar.className = `c-avatar ${isOnline ? 'online' : ''}`;
        
        const lastEl = item.querySelector('.c-last');
        if (lastEl) {
          lastEl.className = `c-last ${chat?.typing ? 'typing' : ''}`;
          lastEl.textContent = chat?.typing ? '✍️ typing…' : (chat?.lastMsg || 'Start a conversation');
        }
        
        const timeEl = item.querySelector('.c-time');
        if (timeEl) timeEl.textContent = chat?.lastTime ? this.formatTime(chat.lastTime) : '';
        
        const badge = item.querySelector('.c-badge');
        if (badge) badge.remove();
        if (chat?.unread) {
          const b = document.createElement('div');
          b.className = 'c-badge';
          b.textContent = chat.unread > 9 ? '9+' : chat.unread;
          item.querySelector('.c-meta')?.appendChild(b);
        }
      }
    });

    this.upsertChatsSection(username);
  }

  upsertChatsSection(username) {
    const section = this.domCache.chatsSection;
    const emptyState = section.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    const existingEntry = section.querySelector(`.contact-item[data-username="${username}"]`);
    
    if (existingEntry) {
      if (section.firstChild === existingEntry) return;
      existingEntry.remove();
    }

    const el = this.createContactEl({ username }, true);
    section.insertBefore(el, section.firstChild);
  }

  // ─── EMOJI ───────────────────────────────────────────────────────────────
  buildEmojiPicker() {
    const picker = this.domCache.emojiPicker;
    const fragment = document.createDocumentFragment();
    
    EMOJIS.forEach(em => {
      const btn = document.createElement('span');
      btn.className = 'emoji-btn-item';
      btn.textContent = em;
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const input = this.domCache.messageInput;
        input.value += em;
        input.focus();
        picker.classList.add('hidden');
      });
      fragment.appendChild(btn);
    });
    picker.appendChild(fragment);
  }

  // ─── TOASTS ──────────────────────────────────────────────────────────────
  showToast(title, body, type = 'message') {
    const container = document.querySelector('.toast-container');
    if (!container) return;
    
    const toast = document.createElement('div');
    toast.className = 'toast';
    if (type === 'error') toast.style.borderLeftColor = 'var(--danger)';
    
    toast.innerHTML = `<div class="toast-title">${this.escHtml(title)}</div><div class="toast-body">${this.escHtml(body.substring(0, 60))}</div>`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4200);
  }

  // ─── UTILS ───────────────────────────────────────────────────────────────
  scrollBottom() {
    const area = this.domCache.messagesArea;
    requestAnimationFrame(() => { area.scrollTop = area.scrollHeight; });
  }

  formatTime(iso) {
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  escHtml(str) {
    return String(str)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }
}

// Init
window.addEventListener('DOMContentLoaded', () => {
  window.app = new ZapChat();
});
