const API = window.ZAPCHAT_API_URL || (() => {
  const { hostname, port, origin } = window.location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return port === '3000' ? 'http://localhost:5000' : origin;
  }
  if (origin.includes('pages.dev')) return 'https://zapchat-production.up.railway.app';
  return origin;
})();

const EMOJIS = ['😀','😂','🥰','😎','🤔','😢','😡','🔥','❤️','👍','👎','🎉','🙌','💯','✅','🚀','💬','⚡','🌟','😮','🤣','😅','🥳','😴','🤝','🙏','👋','💪','🎊','🌈'];

class ZapChat {
  constructor() {
    this.api = API;
    this.user = null;
    this.socket = null;
    this.activeChat = null;
    this.chats = new Map();
    this.onlineSet = new Set();
    this.typingTimer = null;
    this.isTyping = false;
    this.resetToken = new URLSearchParams(window.location.search).get('resetToken') || '';
    this.callRoom = null;
    this.boundApp = false;

    this.dom = {
      authScreen: document.getElementById('auth-screen'),
      authTabs: document.querySelector('.auth-tabs'),
      loginPanel: document.getElementById('login-panel'),
      registerPanel: document.getElementById('register-panel'),
      forgotPanel: document.getElementById('forgot-panel'),
      resetPanel: document.getElementById('reset-panel'),
      loginError: document.getElementById('login-error'),
      signupError: document.getElementById('signup-error'),
      forgotError: document.getElementById('forgot-error'),
      resetError: document.getElementById('reset-error'),
      loginIdentifier: document.getElementById('login-identifier'),
      loginPassword: document.getElementById('login-password'),
      signupUsername: document.getElementById('signup-username'),
      signupEmail: document.getElementById('signup-email'),
      signupPassword: document.getElementById('signup-password'),
      forgotEmail: document.getElementById('forgot-email'),
      resetPassword: document.getElementById('reset-password'),
      resetConfirm: document.getElementById('reset-confirm'),
      loginBtn: document.getElementById('login-btn'),
      signupBtn: document.getElementById('signup-btn'),
      forgotBtn: document.getElementById('forgot-btn'),
      resetBtn: document.getElementById('reset-btn'),
      googleLoginBtn: document.getElementById('google-login-btn'),
      googleSignupBtn: document.getElementById('google-signup-btn'),
      showForgotBtn: document.getElementById('show-forgot-btn'),
      backFromForgotBtn: document.getElementById('back-to-login-from-forgot'),
      backFromResetBtn: document.getElementById('back-to-login-from-reset'),
      authScreenHiddenClass: 'hidden',
      app: document.getElementById('app'),
      meAvatar: document.getElementById('me-avatar'),
      meName: document.getElementById('me-name'),
      logoutBtn: document.getElementById('logout-btn'),
      searchInput: document.getElementById('search-input'),
      chatsSection: document.getElementById('chats-section'),
      contactsSection: document.getElementById('contacts-section'),
      usersList: document.getElementById('users-list'),
      chatEmpty: document.getElementById('chat-empty'),
      activeChat: document.getElementById('active-chat'),
      chatName: document.getElementById('chat-name'),
      chatAvatar: document.getElementById('chat-avatar'),
      chatStatus: document.getElementById('chat-status'),
      messagesArea: document.getElementById('messages-area'),
      messageInput: document.getElementById('message-input'),
      sendBtn: document.getElementById('send-btn'),
      backBtn: document.getElementById('back-btn'),
      emojiBtn: document.querySelector('.emoji-btn'),
      emojiPicker: document.getElementById('emoji-picker'),
      voiceCallBtn: document.getElementById('voice-call-btn'),
      videoCallBtn: document.getElementById('video-call-btn'),
      callModal: document.getElementById('call-modal'),
      callTitleText: document.getElementById('call-title-text'),
      callStatusText: document.getElementById('call-status-text'),
      callRemoteGrid: document.getElementById('call-remote-grid'),
      callEmpty: document.getElementById('call-empty'),
      callRosterList: document.getElementById('call-roster-list'),
      callRosterCount: document.getElementById('call-roster-count'),
      callHangupBtn: document.getElementById('call-hangup-btn'),
    };

    this.bindAuthUI();
    this.initAuthState();
  }

  bindAuthUI() {
    document.querySelectorAll('.auth-tab').forEach((tab) => {
      tab.addEventListener('click', () => this.showAuthPanel(tab.dataset.tab));
    });

    this.dom.loginBtn?.addEventListener('click', () => this.login());
    this.dom.signupBtn?.addEventListener('click', () => this.signup());
    this.dom.forgotBtn?.addEventListener('click', () => this.forgotPassword());
    this.dom.resetBtn?.addEventListener('click', () => this.resetPassword());
    this.dom.googleLoginBtn?.addEventListener('click', () => this.startGoogleAuth());
    this.dom.googleSignupBtn?.addEventListener('click', () => this.startGoogleAuth());
    this.dom.showForgotBtn?.addEventListener('click', () => this.showAuthPanel('forgot'));
    this.dom.backFromForgotBtn?.addEventListener('click', () => this.showAuthPanel('login'));
    this.dom.backFromResetBtn?.addEventListener('click', () => this.showAuthPanel('login'));

    this.dom.loginPassword?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.login();
    });
    this.dom.signupPassword?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.signup();
    });
    this.dom.resetConfirm?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.resetPassword();
    });
  }

  showAuthPanel(name) {
    const panels = [this.dom.loginPanel, this.dom.registerPanel, this.dom.forgotPanel, this.dom.resetPanel];
    panels.forEach((panel) => panel?.classList.remove('active'));

    const mapping = {
      login: this.dom.loginPanel,
      register: this.dom.registerPanel,
      forgot: this.dom.forgotPanel,
      reset: this.dom.resetPanel,
    };

    mapping[name]?.classList.add('active');
    this.dom.authTabs?.classList.toggle('hidden', name === 'reset' || name === 'forgot');
  }

  async initAuthState() {
    if (this.resetToken) {
      this.showAuthPanel('reset');
    } else {
      this.showAuthPanel('login');
    }

    try {
      const res = await fetch(`${this.api}/api/auth/me`, { credentials: 'include' });
      if (!res.ok) {
        return;
      }
      const data = await res.json();
      this.user = data.user;
      this.enterApp();
    } catch {
      // stay on auth screen
    }
  }

  async login() {
    this.clearErrors();
    const identifier = this.dom.loginIdentifier.value.trim();
    const password = this.dom.loginPassword.value;
    if (!identifier || !password) {
      this.dom.loginError.textContent = 'Enter your username/email and password.';
      return;
    }

    try {
      const res = await fetch(`${this.api}/api/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.dom.loginError.textContent = data.error || 'Login failed.';
        return;
      }
      this.user = data.user;
      this.enterApp();
    } catch {
      this.dom.loginError.textContent = 'Cannot connect to server.';
    }
  }

  async signup() {
    this.clearErrors();
    const username = this.dom.signupUsername.value.trim();
    const email = this.dom.signupEmail.value.trim();
    const password = this.dom.signupPassword.value;
    if (!username || !email || !password) {
      this.dom.signupError.textContent = 'Fill in username, email, and password.';
      return;
    }

    try {
      const res = await fetch(`${this.api}/api/auth/signup`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.dom.signupError.textContent = data.error || 'Signup failed.';
        return;
      }
      this.user = data.user;
      this.enterApp();
    } catch {
      this.dom.signupError.textContent = 'Cannot connect to server.';
    }
  }

  async forgotPassword() {
    this.clearErrors();
    const email = this.dom.forgotEmail.value.trim();
    if (!email) {
      this.dom.forgotError.textContent = 'Enter the email address for your account.';
      return;
    }

    try {
      const res = await fetch(`${this.api}/api/auth/forgot-password`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.dom.forgotError.textContent = data.error || 'Could not send reset email.';
        return;
      }
      this.dom.forgotError.textContent = data.message || 'If the email exists, a reset link has been sent.';
    } catch {
      this.dom.forgotError.textContent = 'Cannot connect to server.';
    }
  }

  async resetPassword() {
    this.clearErrors();
    const password = this.dom.resetPassword.value;
    const confirmPassword = this.dom.resetConfirm.value;
    if (!this.resetToken) {
      this.dom.resetError.textContent = 'Missing reset token.';
      return;
    }
    if (!password || !confirmPassword) {
      this.dom.resetError.textContent = 'Enter and confirm your new password.';
      return;
    }

    try {
      const res = await fetch(`${this.api}/api/auth/reset-password`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: this.resetToken, password, confirmPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.dom.resetError.textContent = data.error || 'Reset failed.';
        return;
      }
      window.history.replaceState({}, document.title, window.location.pathname);
      this.user = data.user;
      this.enterApp();
    } catch {
      this.dom.resetError.textContent = 'Cannot connect to server.';
    }
  }

  startGoogleAuth() {
    window.location.href = `${this.api}/api/auth/google`;
  }

  async logout() {
    try {
      await fetch(`${this.api}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // ignore
    }
    if (this.socket) this.socket.disconnect();
    this.socket = null;
    this.user = null;
    this.activeChat = null;
    this.chats.clear();
    this.onlineSet.clear();
    this.boundApp = false;
    this.dom.app.classList.add('hidden');
    this.dom.authScreen.classList.remove('hidden');
    this.showAuthPanel('login');
  }

  clearErrors() {
    this.dom.loginError.textContent = '';
    this.dom.signupError.textContent = '';
    this.dom.forgotError.textContent = '';
    this.dom.resetError.textContent = '';
  }

  enterApp() {
    this.dom.authScreen.classList.add('hidden');
    this.dom.app.classList.remove('hidden');
    this.dom.meAvatar.textContent = this.user.username.charAt(0).toUpperCase();
    this.dom.meName.textContent = this.user.displayName || this.user.username;

    if (!this.boundApp) {
      this.bindAppUI();
      this.boundApp = true;
    }

    this.connectSocket();
    this.fetchUsers();
  }

  bindAppUI() {
    this.dom.logoutBtn?.addEventListener('click', () => {
      if (confirm('Sign out?')) this.logout();
    });

    document.querySelectorAll('.s-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.s-tab').forEach((item) => item.classList.remove('active'));
        tab.classList.add('active');
        const section = tab.dataset.section;
        this.dom.chatsSection.classList.toggle('hidden', section !== 'chats');
        this.dom.contactsSection.classList.toggle('hidden', section !== 'contacts');
      });
    });

    this.dom.searchInput?.addEventListener('input', (event) => this.filterContacts(event.target.value));
    this.dom.messageInput?.addEventListener('input', () => this.onInputChange());
    this.dom.messageInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.sendMessage();
      }
    });
    this.dom.sendBtn?.addEventListener('click', () => this.sendMessage());
    this.dom.backBtn?.addEventListener('click', () => this.closeChatMobile());
    this.dom.emojiBtn?.addEventListener('click', (event) => {
      event.stopPropagation();
      this.dom.emojiPicker.classList.toggle('hidden');
      if (!this.dom.emojiPicker.children.length) this.buildEmojiPicker();
    });
    document.addEventListener('click', () => this.dom.emojiPicker.classList.add('hidden'));
    this.dom.voiceCallBtn?.addEventListener('click', () => this.initiateCall('audio'));
    this.dom.videoCallBtn?.addEventListener('click', () => this.initiateCall('video'));
    this.dom.callHangupBtn?.addEventListener('click', () => this.endCall());
  }

  connectSocket() {
    if (this.socket) this.socket.disconnect();
    this.socket = io(this.api, {
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
      reconnectionDelay: 1500,
    });

    this.socket.on('connect_error', (error) => {
      this.showToast('Connection error', error.message || 'Could not connect to server.', 'error');
    });

    this.socket.on('online_users', (users) => {
      this.onlineSet = new Set(users);
      this.refreshOnlineStatus();
    });

    this.socket.on('user_status', ({ username, online }) => {
      if (online) this.onlineSet.add(username);
      else this.onlineSet.delete(username);
      this.refreshOnlineStatus();
      if (username === this.activeChat) {
        this.dom.chatStatus.textContent = online ? '🟢 Online' : '🔒 Encrypted';
      }
    });

    this.socket.on('private_message', (message) => this.receiveMessage(message));
    this.socket.on('message_sent', (message) => this.onMessageSent(message));
    this.socket.on('typing_start', ({ from }) => this.onTypingStart(from));
    this.socket.on('typing_stop', ({ from }) => this.onTypingStop(from));
    this.socket.on('messages_read', ({ by }) => this.onMessagesRead(by));

    this.socket.on('call_invite', ({ from, callType, roomURL, roomName }) => {
      const accept = confirm(`Incoming ${callType} call from ${from}. Accept?`);
      if (accept) {
        this.callRoom = { roomName, with: from, url: roomURL };
        this.socket.emit('call_accept', { to: from, roomURL, roomName });
        window.open(roomURL, 'ZapChat Call', 'width=1000,height=720');
      } else {
        this.socket.emit('call_reject', { to: from });
      }
    });

    this.socket.on('call_accepted', ({ from }) => this.showToast('Call accepted', `${from} joined the call.`));
    this.socket.on('call_rejected', ({ from }) => this.showToast('Call declined', `${from} declined the call.`, 'error'));
    this.socket.on('call_failed', ({ reason }) => this.showToast('Call failed', reason || 'Could not reach that user.', 'error'));
    this.socket.on('call_ended', ({ from }) => this.showToast('Call ended', `${from} ended the call.`));
  }

  async fetchUsers() {
    try {
      const res = await fetch(`${this.api}/api/users`, {
        credentials: 'include',
      });
      if (!res.ok) return;
      const users = await res.json();
      this.renderContacts(users);
    } catch {
      this.showToast('Contacts unavailable', 'Could not load users.', 'error');
    }
  }

  renderContacts(users) {
    const list = this.dom.usersList;
    list.innerHTML = '';
    if (!users?.length) {
      list.innerHTML = '<div class="empty-state"><i class="fas fa-user-slash"></i><p>No other users yet.</p></div>';
      return;
    }
    const fragment = document.createDocumentFragment();
    users.forEach((user) => fragment.appendChild(this.createContactEl(user)));
    list.appendChild(fragment);
  }

  createContactEl(user) {
    const chat = this.chats.get(user.username) || {};
    const item = document.createElement('div');
    item.className = 'contact-item';
    item.dataset.username = user.username;
    item.innerHTML = `
      <div class="c-avatar ${user.online ? 'online' : ''}">${(user.avatar || user.username.charAt(0)).charAt(0).toUpperCase()}</div>
      <div class="c-info">
        <div class="c-name">${this.escHtml(user.displayName || user.username)}</div>
        <div class="c-last ${chat.typing ? 'typing' : ''}">${chat.typing ? '✍️ typing…' : this.escHtml(chat.lastMsg || user.status || 'Start a conversation')}</div>
      </div>
      <div class="c-meta">
        <div class="c-time">${chat.lastTime ? this.formatTime(chat.lastTime) : ''}</div>
        ${chat.unread ? `<div class="c-badge">${chat.unread > 9 ? '9+' : chat.unread}</div>` : ''}
      </div>
    `;
    item.addEventListener('click', () => this.openChat(user.username));
    return item;
  }

  refreshOnlineStatus() {
    document.querySelectorAll('.contact-item').forEach((item) => {
      const username = item.dataset.username;
      const avatar = item.querySelector('.c-avatar');
      if (avatar) avatar.classList.toggle('online', this.onlineSet.has(username));
    });
  }

  filterContacts(query) {
    const term = query.toLowerCase();
    document.querySelectorAll('.contact-item').forEach((item) => {
      const username = item.dataset.username.toLowerCase();
      item.style.display = username.includes(term) ? '' : 'none';
    });
  }

  ensureChat(username) {
    if (!this.chats.has(username)) {
      this.chats.set(username, { messages: [], unread: 0, lastMsg: '', lastTime: '', typing: false });
    }
  }

  async openChat(username) {
    if (this.activeChat === username) return;
    this.activeChat = username;
    this.ensureChat(username);
    this.chats.get(username).unread = 0;
    this.socket?.emit('mark_read', { from: username });

    this.dom.chatName.textContent = username;
    this.dom.chatAvatar.textContent = username.charAt(0).toUpperCase();
    this.dom.chatStatus.textContent = this.onlineSet.has(username) ? '🟢 Online' : '🔒 Encrypted';
    this.dom.chatEmpty.classList.add('hidden');
    this.dom.activeChat.classList.remove('hidden');
    document.querySelector('.chat-panel').classList.add('visible');
    document.querySelector('.sidebar').classList.add('hidden-mobile');
    document.querySelectorAll('.contact-item').forEach((item) => item.classList.toggle('active', item.dataset.username === username));

    this.dom.messagesArea.innerHTML = '<div class="messages-date-divider"><span>Today</span></div>';

    try {
      const res = await fetch(`${this.api}/api/messages/${encodeURIComponent(username)}`, { credentials: 'include' });
      const history = await res.json();
      this.chats.get(username).messages = history;
      const fragment = document.createDocumentFragment();
      history.forEach((message) => this.renderMessage(message, fragment));
      this.dom.messagesArea.appendChild(fragment);
    } catch {
      const fragment = document.createDocumentFragment();
      this.chats.get(username).messages.forEach((message) => this.renderMessage(message, fragment));
      this.dom.messagesArea.appendChild(fragment);
    }

    this.scrollBottom();
    this.dom.messageInput.focus();
    this.removeTypingIndicator();
    if (this.chats.get(username).typing) this.showTypingIndicator();
    this.updateChatListItem(username);
  }

  closeChatMobile() {
    document.querySelector('.chat-panel').classList.remove('visible');
    document.querySelector('.sidebar').classList.remove('hidden-mobile');
    this.activeChat = null;
  }

  sendMessage() {
    const text = this.dom.messageInput.value.trim();
    if (!text || !this.activeChat) return;
    this.socket?.emit('private_message', { to: this.activeChat, text });
    this.dom.messageInput.value = '';
    this.dom.messageInput.style.height = 'auto';
    this.stopTyping();
  }

  onMessageSent(message) {
    const chat = this.chats.get(message.to);
    if (!chat) return;
    message.status = 'sent';
    chat.messages.push(message);
    chat.lastMsg = message.text;
    chat.lastTime = message.timestamp;
    if (this.activeChat === message.to) {
      this.renderMessage(message, this.dom.messagesArea);
      this.scrollBottom();
    }
    this.updateChatListItem(message.to);
  }

  receiveMessage(message) {
    this.ensureChat(message.from);
    const chat = this.chats.get(message.from);
    message.status = 'received';
    chat.messages.push(message);
    chat.lastMsg = message.text;
    chat.lastTime = message.timestamp;
    if (this.activeChat === message.from) {
      this.removeTypingIndicator();
      this.renderMessage(message, this.dom.messagesArea);
      this.scrollBottom();
      this.socket?.emit('mark_read', { from: message.from });
    } else {
      chat.unread += 1;
      this.showToast(message.from, message.text);
    }
    this.updateChatListItem(message.from);
  }

  renderMessage(message, target) {
    const sent = message.from === this.user.username;
    const row = document.createElement('div');
    row.className = `msg-row ${sent ? 'sent' : 'received'}`;
    row.dataset.id = message.id;
    const status = sent ? `<span class="msg-status ${message.status || 'sent'}">${message.status === 'read' ? '✓✓' : '✓'}</span>` : '';
    row.innerHTML = `
      <div class="msg-bubble">
        <div class="msg-text">${this.escHtml(message.text)}</div>
        <div class="msg-meta">
          <span class="msg-time">${this.formatTime(message.timestamp)}</span>
          ${status}
        </div>
      </div>
    `;
    target.appendChild(row);
  }

  onTypingStart(from) {
    this.ensureChat(from);
    this.chats.get(from).typing = true;
    this.updateChatListItem(from);
    if (this.activeChat === from) this.showTypingIndicator();
  }

  onTypingStop(from) {
    if (this.chats.has(from)) this.chats.get(from).typing = false;
    this.updateChatListItem(from);
    if (this.activeChat === from) this.removeTypingIndicator();
  }

  onMessagesRead(by) {
    if (!this.chats.has(by)) return;
    const messages = this.chats.get(by).messages;
    messages.forEach((message) => {
      if (message.from === this.user.username) message.status = 'read';
    });
    if (this.activeChat === by) this.updateReadStatuses();
  }

  onInputChange() {
    const input = this.dom.messageInput;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    if (!this.activeChat) return;
    if (!this.isTyping) {
      this.isTyping = true;
      this.socket?.emit('typing_start', { to: this.activeChat });
    }
    clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.stopTyping(), 2000);
  }

  stopTyping() {
    if (this.isTyping && this.activeChat) {
      this.isTyping = false;
      this.socket?.emit('typing_stop', { to: this.activeChat });
    }
    clearTimeout(this.typingTimer);
  }

  showTypingIndicator() {
    if (document.getElementById('typing-indicator')) return;
    const row = document.createElement('div');
    row.className = 'msg-row received typing-indicator';
    row.id = 'typing-indicator';
    row.innerHTML = '<div class="msg-bubble"><div class="typing-dots"><span></span><span></span><span></span></div></div>';
    this.dom.messagesArea.appendChild(row);
    this.scrollBottom();
  }

  removeTypingIndicator() {
    document.getElementById('typing-indicator')?.remove();
  }

  updateReadStatuses() {
    this.dom.messagesArea.querySelectorAll('.msg-row.sent .msg-status').forEach((node) => {
      node.className = 'msg-status read';
      node.textContent = '✓✓';
    });
  }

  updateChatListItem(username) {
    const chat = this.chats.get(username);
    document.querySelectorAll(`.contact-item[data-username="${username}"]`).forEach((item) => {
      const avatar = item.querySelector('.c-avatar');
      const last = item.querySelector('.c-last');
      const time = item.querySelector('.c-time');
      const meta = item.querySelector('.c-meta');
      if (avatar) avatar.className = `c-avatar ${this.onlineSet.has(username) ? 'online' : ''}`;
      if (last) {
        last.className = `c-last ${chat?.typing ? 'typing' : ''}`;
        last.textContent = chat?.typing ? '✍️ typing…' : (chat?.lastMsg || 'Start a conversation');
      }
      if (time) time.textContent = chat?.lastTime ? this.formatTime(chat.lastTime) : '';
      const badge = item.querySelector('.c-badge');
      if (badge) badge.remove();
      if (chat?.unread) {
        const node = document.createElement('div');
        node.className = 'c-badge';
        node.textContent = chat.unread > 9 ? '9+' : chat.unread;
        meta?.appendChild(node);
      }
    });

    const section = this.dom.chatsSection;
    const empty = section.querySelector('.empty-state');
    if (empty) empty.remove();
    const existing = section.querySelector(`.contact-item[data-username="${username}"]`);
    if (existing) {
      if (section.firstChild !== existing) existing.remove();
      else return;
    }
    const el = this.createContactEl({ username, avatar: username.charAt(0), status: '' });
    section.insertBefore(el, section.firstChild);
  }

  buildEmojiPicker() {
    const fragment = document.createDocumentFragment();
    EMOJIS.forEach((emoji) => {
      const item = document.createElement('span');
      item.className = 'emoji-btn-item';
      item.textContent = emoji;
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        this.dom.messageInput.value += emoji;
        this.dom.messageInput.focus();
        this.dom.emojiPicker.classList.add('hidden');
      });
      fragment.appendChild(item);
    });
    this.dom.emojiPicker.appendChild(fragment);
  }

  async initiateCall(callType) {
    if (!this.activeChat) return;
    if (!this.onlineSet.has(this.activeChat)) {
      this.showToast('Cannot call', `${this.activeChat} is offline.`, 'error');
      return;
    }

    try {
      const res = await fetch(`${this.api}/api/create-room`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ with: this.activeChat, privacy: 'private' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not create call room.');

      this.callRoom = { roomName: data.roomName, with: this.activeChat, url: data.publicURL };
      this.socket?.emit('call_invite', {
        to: this.activeChat,
        callType,
        roomURL: data.publicURL,
        roomName: data.roomName,
      });
      window.open(data.publicURL, 'ZapChat Call', 'width=1000,height=720');
    } catch (error) {
      this.showToast('Call error', error.message || 'Could not connect to call services.', 'error');
    }
  }

  endCall() {
    if (!this.callRoom?.with) return;
    this.socket?.emit('call_end', { to: this.callRoom.with });
    this.callRoom = null;
  }

  showToast(title, body, type = 'message') {
    let container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'toast';
    if (type === 'error') toast.style.borderLeftColor = 'var(--danger)';
    toast.innerHTML = `<div class="toast-title">${this.escHtml(title)}</div><div class="toast-body">${this.escHtml(String(body).slice(0, 80))}</div>`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4200);
  }

  scrollBottom() {
    requestAnimationFrame(() => {
      this.dom.messagesArea.scrollTop = this.dom.messagesArea.scrollHeight;
    });
  }

  formatTime(value) {
    const date = new Date(value);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  escHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new ZapChat();
});
