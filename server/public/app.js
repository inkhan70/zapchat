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

  // ✅ FIXED: Extracted Google OAuth tokens arriving from URL parameters cleanly
  async initAuthState() {
    const urlParams = new URLSearchParams(window.location.search);
    const oauthToken = urlParams.get('token');
    const oauthUserData = urlParams.get('user');

    if (oauthToken && oauthUserData) {
      try {
        localStorage.setItem('zapchat_token', oauthToken);
        const parsedUser = JSON.parse(decodeURIComponent(oauthUserData));
        localStorage.setItem('zapchat_user', JSON.stringify(parsedUser));
        this.user = parsedUser;
        
        // Clear parameters out of the address bar cleanly
        window.history.replaceState({}, document.title, window.location.pathname);
        this.enterApp();
        return;
      } catch (err) {
        console.error("Failed processing incoming payload parameters", err);
      }
    }

    // Fall back to existing local sessions if available
    const storedToken = localStorage.getItem('zapchat_token');
    const storedUser = localStorage.getItem('zapchat_user');

    if (storedToken && storedUser) {
      try {
        this.user = JSON.parse(storedUser);
        this.enterApp();
        return;
      } catch (_) {
        this.logout();
      }
    }

    if (this.resetToken) {
      this.showAuthPanel('reset');
    } else {
      this.showAuthPanel('login');
    }
  }

  // ✅ FIXED: Matches Server endpoint route: '/api/login' and saves to localStorage
  async login() {
    this.clearErrors();
    const username = this.dom.loginIdentifier.value.trim();
    const password = this.dom.loginPassword.value;
    if (!username || !password) {
      this.dom.loginError.textContent = 'Enter your username and password.';
      return;
    }

    try {
      const res = await fetch(`${this.api}/api/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.dom.loginError.textContent = data.error || 'Login failed.';
        return;
      }
      
      localStorage.setItem('zapchat_token', data.token);
      localStorage.setItem('zapchat_user', JSON.stringify(data.user));
      this.user = data.user;
      this.enterApp();
    } catch {
      this.dom.loginError.textContent = 'Cannot connect to server.';
    }
  }

  // ✅ FIXED: Matches Server endpoint route: '/api/register' and saves to localStorage
  async signup() {
    this.clearErrors();
    const username = this.dom.signupUsername.value.trim();
    const password = this.dom.signupPassword.value;
    if (!username || !password) {
      this.dom.signupError.textContent = 'Fill in username and password.';
      return;
    }

    try {
      const res = await fetch(`${this.api}/api/register`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.dom.signupError.textContent = data.error || 'Signup failed.';
        return;
      }

      localStorage.setItem('zapchat_token', data.token);
      localStorage.setItem('zapchat_user', JSON.stringify(data.user));
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
      
      localStorage.setItem('zapchat_token', data.token);
      localStorage.setItem('zapchat_user', JSON.stringify(data.user));
      this.user = data.user;
      this.enterApp();
    } catch {
      this.dom.resetError.textContent = 'Cannot connect to server.';
    }
  }

  startGoogleAuth() {
    window.location.href = `${this.api}/api/auth/google`;
  }

  // ✅ FIXED: Empties localStorage cache blocks thoroughly upon termination
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
    
    localStorage.removeItem('zapchat_token');
    localStorage.removeItem('zapchat_user');
    
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

  // ✅ FIXED: Attaches the required bearer token within socket handshake payload headers
  connectSocket() {
    if (this.socket) this.socket.disconnect();
    
    const token = localStorage.getItem('zapchat_token');
    
    this.socket = io(this.api, {
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
      reconnectionDelay: 1500,
      auth: { token }
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

    // ─── Call signaling — spec event names (initiate-call / accept-call / end-call) ───
    this.socket.on('incoming-call', (data) => this.onIncomingCall(data));
    this.socket.on('call-accepted', ({ roomName }) => this.onCallAccepted({ roomName }));
    this.socket.on('call-failed', ({ reason }) => {
      this.showToast('Call failed', reason || 'Could not reach that user.', 'error');
      this.terminateLocalCallSession();
    });
    this.socket.on('call-ended', () => this.onCallEnded());
    this.socket.on('user-disconnected', () => {
      // Peer socket vanished — tear down our WebRTC session cleanly so we
      // don't keep charging Metered for an orphaned room.
      if (this.meetingSession) this.terminateLocalCallSession();
    });
  }

  // ✅ FIXED: Added standard Authorization headers across data request calls
  async fetchUsers() {
    try {
      const token = localStorage.getItem('zapchat_token');
      const res = await fetch(`${this.api}/api/users`, {
        credentials: 'include',
        headers: {
          'Authorization': `Bearer ${token}`
        }
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

  // ✅ FIXED: Transmits Bearer Authentication tokens for historical conversation downloads
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
      const token = localStorage.getItem('zapchat_token');
      const res = await fetch(`${this.api}/api/messages/${encodeURIComponent(username)}`, { 
        credentials: 'include',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
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

  // ─── WebRTC Calling Engine (Metered SDK embedded) ─────────────────────────
  // Task 3 + 4 + 5 spec implementation.
  //
  // Flow:
  //   1. caller → POST /api/call/create-room (idempotent Metered get-or-create)
  //   2. caller → socket emit 'initiate-call' with {targetUserId, roomName, callType}
  //   3. callee receives 'incoming-call' → onIncomingCall() asks user, then
  //      emits 'accept-call' (or end-call to reject) and runs
  //      startVideoAudioCall(roomName, callType).
  //   4. caller receives 'call-accepted' → runs startVideoAudioCall() locally.
  //   5. Either side hangs up → socket emit 'end-call' + terminateLocalCallSession().
  //   6. 30-second unanswered timer (callTimeoutTracker) auto-drops the call.

  // Single active meeting session — null when idle.
  meetingSession = null;
  // 30s unanswered-call watchdog (Task 5)
  callTimeoutTracker = null;
  // Tracks the peer + call metadata for the lifecycle of one call.
  pendingCallTarget = null;
  pendingCallType = null;
  pendingCallRoomName = null;

  /**
   * Task 3 spec — Embedded Metered MeetingSession initializer.
   * Pulls validated room + domain from the backend (which proxies
   * Metered.ca REST), joins, starts audio/video hardware, and binds
   * remote-track events to the DOM grid.
   */
  async startVideoAudioCall(roomName, callType) {
    try {
      // 1. Fetch official validation tokens from the backend.
      const token = localStorage.getItem('zapchat_token');
      const backendResponse = await fetch(`${this.api}/api/call/create-room`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ roomName }),
      });
      const callData = await backendResponse.json().catch(() => ({}));
      if (!backendResponse.ok || !callData.success) {
        throw new Error(callData.error || 'Backend failed to synchronize call room mapping.');
      }

      // 2. Instantiate the Metered Meeting Session.
      // Metered SDK exposes window.Metered.MeetingSession in 1.4.6+.
      const MeetingCtor = (window.metered && window.metered.MeetingSession)
        || (window.Metered && window.Metered.MeetingSession);
      if (!MeetingCtor) throw new Error('Metered SDK not loaded');

      this.meetingSession = new MeetingCtor();

      await this.meetingSession.join({
        roomName: callData.roomName,
        // Backend returns the canonical subdomain like 'zapchat-server.metered.live'
        // and we pass it directly to the SDK's roomDomain.
        roomDomain: callData.appMetricDomain,
        name: this.user?.username || 'ZapChat User',
      });

      console.log('Successfully joined the encrypted communication matrix');

      // 3. Hardware stream ingestion.
      if (callType === 'video') {
        await this.meetingSession.startVideo();
        await this.meetingSession.startAudio();
      } else {
        await this.meetingSession.startAudio(); // audio-only configuration
      }

      // 4. Local video binding (mirror to BOTH legacy and spec element IDs).
      this.meetingSession.on('localTrackStarted', (trackItem) => {
        if (trackItem.type === 'video' && trackItem.stream) {
          const localCanvas = document.getElementById('localVideoTrackGrid')
            || document.getElementById('call-local-video');
          if (localCanvas) localCanvas.srcObject = trackItem.stream;
        }
      });

      // 5. Remote track binding — Task 4 spec implementation.
      this.meetingSession.on('remoteTrackStarted', (trackItem) => {
        console.log(`Remote media track detected: [${trackItem.type}] from participant: [${trackItem.participantSessionId}]`);
        const grid = document.getElementById('remoteVideoTrackGrid')
          || document.getElementById('call-remote-grid');
        if (!grid) return;

        if (trackItem.type === 'video') {
          // Find-or-create the remote video element keyed by participantSessionId.
          let remoteVideoNode = document.getElementById(`remote-video-${trackItem.participantSessionId}`);
          if (!remoteVideoNode) {
            remoteVideoNode = document.createElement('video');
            remoteVideoNode.id = `remote-video-${trackItem.participantSessionId}`;
            remoteVideoNode.autoplay = true;
            remoteVideoNode.playsInline = true;
            remoteVideoNode.className = 'remote-video-frame mirrors-default-style';
            grid.appendChild(remoteVideoNode);
          }
          remoteVideoNode.srcObject = trackItem.stream;
        } else if (trackItem.type === 'audio') {
          // Audio-only peers get a hidden <audio> element so their voice plays.
          let audioEl = document.getElementById(`remote-audio-${trackItem.participantSessionId}`);
          if (!audioEl) {
            audioEl = document.createElement('audio');
            audioEl.id = `remote-audio-${trackItem.participantSessionId}`;
            audioEl.autoplay = true;
            document.body.appendChild(audioEl);
          }
          audioEl.srcObject = trackItem.stream;
        }

        // Reflect connected state on the legacy status overlay.
        const overlay = document.getElementById('connectionStatusOverlay')
          || document.getElementById('call-status-text');
        if (overlay) overlay.textContent = 'Connected';
      });

      // Task 4 — remote track cleanup (camera revoked, network drop, etc.)
      this.meetingSession.on('remoteTrackStopped', (trackItem) => {
        const remoteVideoNode = document.getElementById(`remote-video-${trackItem.participantSessionId}`);
        if (remoteVideoNode && trackItem.type === 'video') {
          remoteVideoNode.srcObject = null;
          remoteVideoNode.remove();
          console.log(`Cleaned up video element for track session: ${trackItem.participantSessionId}`);
        }
        const audioEl = document.getElementById(`remote-audio-${trackItem.participantSessionId}`);
        if (audioEl && trackItem.type === 'audio') audioEl.remove();
      });

      // Participant dropped out entirely → close our session.
      this.meetingSession.on('participantLeft', () => {
        console.log('Remote peer connection dropped out.');
        this.terminateLocalCallSession();
      });

      // Show the embedded grid, hide the legacy modal backdrop.
      const gridWrap = document.getElementById('videoCallGridWrapper');
      if (gridWrap) gridWrap.classList.remove('hidden');
      const modal = document.getElementById('call-modal');
      if (modal) modal.classList.add('hidden');

      // Call answered → clear the 30s watchdog (Task 5).
      if (this.callTimeoutTracker) {
        clearTimeout(this.callTimeoutTracker);
        this.callTimeoutTracker = null;
        console.log('Call successfully established across WebRTC tunnels.');
      }
    } catch (err) {
      console.error('WebRTC Signaling Error:', err);
      this.showToast('Connection failed', 'Please check camera/microphone permissions and network firewalls.', 'error');
      this.terminateLocalCallSession();
    }
  }

  /**
   * Task 3 spec — clean teardown of local WebRTC session.
   * Leaves the Metered room, drops all MediaStream references so the
   * browser stops charging the device, and clears the DOM grid.
   */
  terminateLocalCallSession() {
    if (this.callTimeoutTracker) {
      clearTimeout(this.callTimeoutTracker);
      this.callTimeoutTracker = null;
    }
    if (this.meetingSession) {
      try { this.meetingSession.leave(); } catch (_) { /* ignore */ }
      this.meetingSession = null;
    }
    // Clear HTML streams — legacy IDs + spec IDs.
    const localEl = document.getElementById('localVideoTrackGrid')
      || document.getElementById('call-local-video');
    if (localEl) localEl.srcObject = null;
    const remoteGrid = document.getElementById('remoteVideoTrackGrid')
      || document.getElementById('call-remote-grid');
    if (remoteGrid) {
      remoteGrid.querySelectorAll('video, audio').forEach(el => el.remove());
    }
    document.querySelectorAll('[id^="remote-video-"], [id^="remote-audio-"]').forEach(el => el.remove());

    const gridWrap = document.getElementById('videoCallGridWrapper');
    if (gridWrap) gridWrap.classList.add('hidden');

    this.pendingCallTarget = null;
    this.pendingCallType = null;
    this.pendingCallRoomName = null;
    console.log('WebRTC session terminated cleanly.');
  }

  /**
   * Task 5 spec — 30-second unanswered-call watchdog.
   * If the peer doesn't answer in time, drop the call like WhatsApp does.
   */
  initiateCallTimeoutCounter(targetUserId, roomName) {
    if (this.callTimeoutTracker) clearTimeout(this.callTimeoutTracker);
    this.callTimeoutTracker = setTimeout(() => {
      console.log('Call timed out - No response from remote peer.');
      this.socket?.emit('end-call', { targetUserId, roomName });
      this.terminateLocalCallSession();
      const overlay = document.getElementById('connectionStatusOverlay')
        || document.getElementById('call-status-text');
      if (overlay) overlay.textContent = 'No answer';
      this.showToast('Call timed out', 'User did not answer.');
    }, 30000);
  }

  // ─── Caller entrypoint ───────────────────────────────────────────────────
  async initiateCall(callType) {
    if (!this.activeChat) return;
    if (!this.onlineSet.has(this.activeChat)) {
      this.showToast('Cannot call', `${this.activeChat} is offline.`, 'error');
      return;
    }

    const targetUserId = this.activeChat;
    try {
      // Pre-mint the room so we can pass `roomName` on the wire.
      const token = localStorage.getItem('zapchat_token');
      const res = await fetch(`${this.api}/api/call/create-room`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ with: targetUserId, privacy: 'private' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not create call room.');

      const roomName = data.roomName;
      this.pendingCallTarget = targetUserId;
      this.pendingCallType = callType;
      this.pendingCallRoomName = roomName;

      // Show the spec grid overlay with a connecting state.
      const gridWrap = document.getElementById('videoCallGridWrapper');
      if (gridWrap) gridWrap.classList.remove('hidden');
      const overlay = document.getElementById('connectionStatusOverlay')
        || document.getElementById('call-status-text');
      if (overlay) overlay.textContent = 'Ringing…';

      // Fire the spec socket event.
      this.socket?.emit('initiate-call', {
        targetUserId,
        callerInfo: { username: this.user?.username },
        roomName,
        callType,
      });

      // Start the 30s unanswered watchdog.
      this.initiateCallTimeoutCounter(targetUserId, roomName);
    } catch (error) {
      this.showToast('Call error', error.message || 'Could not connect to call services.', 'error');
      this.terminateLocalCallSession();
    }
  }

  // ─── Callee entrypoint ───────────────────────────────────────────────────
  onIncomingCall({ callerInfo, roomName, callType }) {
    const from = callerInfo?.username || 'someone';
    const label = callType === 'video' ? 'Video call' : 'Voice call';
    const accept = confirm(`${label} from ${from}. Accept?`);
    if (accept) {
      // Spec event name + start the local session.
      this.socket?.emit('accept-call', { targetUserId: from, roomName });
      this.startVideoAudioCall(roomName, callType);
    } else {
      this.socket?.emit('end-call', { targetUserId: from, roomName });
    }
  }

  // ─── Caller side: callee accepted ────────────────────────────────────────
  onCallAccepted({ roomName }) {
    // Use the callType the caller originally requested (audio vs video).
    this.startVideoAudioCall(roomName, this.pendingCallType || 'video');
  }

  // ─── Either side: peer ended ─────────────────────────────────────────────
  onCallEnded() {
    this.showToast('Call ended', 'The other side ended the call.');
    this.terminateLocalCallSession();
  }

  // Hangup button handler
  endCall() {
    const targetUserId = this.pendingCallTarget;
    const roomName = this.pendingCallRoomName || '';
    if (!targetUserId && !this.meetingSession) return;
    this.socket?.emit('end-call', { targetUserId, roomName });
    this.terminateLocalCallSession();
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
