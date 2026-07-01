/* ═══════════════════════════════════════════
   ZapChat – Client App
   ═══════════════════════════════════════════ */

// CRITICAL PRODUCTION FIX: Always use relative paths.
// app.js is served by the same Express server that hosts the API, so
// relative paths (`/api/...`) automatically resolve to whatever domain
// the page is currently loaded from — Back4app, Vercel, or localhost —
// with zero hardcoding and zero risk of pointing at the wrong host.
const API = '';

const EMOJIS = ['😀','😂','🥰','😎','🤔','😢','😡','🔥','❤️','👍','👎','🎉','🙌','💯','✅','🚀','💬','⚡','🌟','😮','🤣','😅','🥳','😴','🤝','🙏','👋','💪','🎊','🌈'];

// ─── Validators ───────────────────────────────────────────────────────────
const EMAIL_RE    = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const MAX_PIC_BYTES = 5 * 1024 * 1024;          // 5 MB
const MAX_PIC_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

// Estimate password strength on a 0–4 scale. Heuristic — good enough to
// nudge users toward longer, more varied passwords without being annoying.
function passwordStrength(pw) {
  if (!pw) return { score: 0, label: '—' };
  let score = 0;
  if (pw.length >= 6)  score++;
  if (pw.length >= 10) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw))   score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  // Cap at 4 — the meter has 4 buckets.
  score = Math.min(score, 4);
  const labels = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];
  return { score, label: labels[score] };
}

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

    // Profile picture selection during registration — kept in memory until
    // the registration POST goes out, so the user can preview it first.
    this.pendingProfilePic = null; // { dataUrl, file }

    // Call state
    this.meeting        = null;  // active Metered.Meeting instance
    this.pendingCall     = null; // { with, callType, roomURL, roomName } while ringing out
    this.incomingCall    = null; // { from, callType, roomURL, roomName } while ringing in
    this.currentCallWith = null; // username of the person on the other end of an active call
    this.isMuted    = false;
    this.isCamOff   = false;

    // Cache frequent DOM elements for rendering performance
    this.domCache = {
      messagesArea: document.getElementById('messages-area'),
      messageInput: document.getElementById('message-input'),
      chatStatus: document.getElementById('chat-status'),
      emojiPicker: document.getElementById('emoji-picker'),
      usersList: document.getElementById('users-list'),
      chatsSection: document.getElementById('chats-section'),
      contactsSection: document.getElementById('contacts-section'),
      meAvatar: document.getElementById('me-avatar'),
      meName: document.getElementById('me-name'),
    };

    this.bindAuthUI();
    this.bindProfileUI();

    // Pre-fill the reset panel from a `?token=…&email=…` query string so the
    // user lands directly on the new-password form after clicking the email link.
    this.maybeShowResetFromQuery();

    if (this.token && this.user) this.boot();
    else this.showAuthPanel('login');
  }

  // ════════════════════════════════════════════════════════════════════════
  // AUTH UI — Tab switcher, login, register, forgot, reset
  // ════════════════════════════════════════════════════════════════════════
  bindAuthUI() {
    // Tab buttons (Sign In / Create Account)
    document.querySelectorAll('#auth-tabs .auth-tab').forEach(tab => {
      tab.addEventListener('click', () => this.showAuthPanel(tab.dataset.tab));
    });

    // Cross-panel switchers (the inline "Create an account" / "Sign in" links
    // and the "Forgot password?" / "Back to sign in" links).
    document.querySelectorAll('.link-btn[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => this.showAuthPanel(btn.dataset.tab));
    });

    // Forgot password link
    const forgotLink = document.getElementById('forgot-link');
    if (forgotLink) forgotLink.addEventListener('click', () => this.showAuthPanel('forgot'));

    // Submit buttons + Enter-key convenience
    document.getElementById('login-btn').addEventListener('click', () => this.login());
    document.getElementById('login-password').addEventListener('keydown', e => {
      if (e.key === 'Enter') this.login();
    });
    document.getElementById('login-identifier').addEventListener('keydown', e => {
      if (e.key === 'Enter') this.login();
    });

    document.getElementById('register-btn').addEventListener('click', () => this.register());
    document.getElementById('reg-password-confirm').addEventListener('keydown', e => {
      if (e.key === 'Enter') this.register();
    });
    document.getElementById('reg-username').addEventListener('keydown', e => {
      if (e.key === 'Enter') this.register();
    });
    document.getElementById('reg-email').addEventListener('keydown', e => {
      if (e.key === 'Enter') this.register();
    });

    document.getElementById('forgot-btn').addEventListener('click', () => this.forgotPassword());
    document.getElementById('forgot-email').addEventListener('keydown', e => {
      if (e.key === 'Enter') this.forgotPassword();
    });

    document.getElementById('reset-btn').addEventListener('click', () => this.resetPassword());
    document.getElementById('reset-password-confirm').addEventListener('keydown', e => {
      if (e.key === 'Enter') this.resetPassword();
    });

    // Live password-strength meters
    const regPwInput = document.getElementById('reg-password');
    if (regPwInput) {
      regPwInput.addEventListener('input', () => {
        this.updatePasswordMeter('password-meter', regPwInput.value);
      });
    }
    const resetPwInput = document.getElementById('reset-password');
    if (resetPwInput) {
      resetPwInput.addEventListener('input', () => {
        this.updatePasswordMeter('reset-password-meter', resetPwInput.value);
      });
    }

    // Profile picture picker on the register panel
    const picPicker = document.getElementById('profile-pic-picker');
    const picInput  = document.getElementById('profile-pic-input');
    const picRemove = document.getElementById('profile-pic-remove');
    if (picPicker && picInput) {
      picPicker.addEventListener('click', e => {
        if (e.target.closest('#profile-pic-remove')) return; // ignore remove-button clicks
        picInput.click();
      });
      picInput.addEventListener('change', e => {
        const file = e.target.files && e.target.files[0];
        if (file) this.handleRegisterPicSelection(file);
      });
    }
    if (picRemove) {
      picRemove.addEventListener('click', e => {
        e.stopPropagation();
        this.clearRegisterPic();
      });
    }
  }

  bindProfileUI() {
    const profileBtn = document.getElementById('profile-btn');
    if (profileBtn) profileBtn.addEventListener('click', () => this.openProfileModal());

    const closeBtn = document.getElementById('profile-modal-close');
    if (closeBtn) closeBtn.addEventListener('click', () => this.closeProfileModal());

    const cancelBtn = document.getElementById('profile-cancel-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => this.closeProfileModal());

    const saveBtn = document.getElementById('profile-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', () => this.saveProfile());

    const uploadBtn = document.getElementById('profile-pic-upload-btn');
    const editInput = document.getElementById('profile-pic-edit-input');
    if (uploadBtn && editInput) {
      uploadBtn.addEventListener('click', () => editInput.click());
      editInput.addEventListener('change', e => {
        const file = e.target.files && e.target.files[0];
        if (file) this.handleProfilePicUpload(file);
      });
    }

    const removePicBtn = document.getElementById('profile-pic-remove-btn');
    if (removePicBtn) {
      removePicBtn.addEventListener('click', () => this.handleProfilePicRemove());
    }

    // ESC closes the profile modal
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        const modal = document.getElementById('profile-modal');
        if (modal && !modal.classList.contains('hidden')) this.closeProfileModal();
      }
    });
  }

  showAuthPanel(panelName) {
    const valid = ['login', 'register', 'forgot', 'reset'];
    if (!valid.includes(panelName)) return;

    // Clear any previous error/success state on the panel we're leaving.
    this.clearAuthMessages();

    document.querySelectorAll('#auth-tabs .auth-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === panelName);
    });
    const slider = document.querySelector('.auth-tab-slider');
    if (slider) {
      // The slider only animates between "login" (left) and "register" (right).
      slider.classList.toggle('right', panelName === 'register');
    }

    document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
    const target = document.getElementById(`${panelName}-panel`);
    if (target) target.classList.add('active');
  }

  maybeShowResetFromQuery() {
    try {
      const params = new URLSearchParams(window.location.search);
      const token  = params.get('token');
      const email  = params.get('email');
      if (token && email) {
        document.getElementById('reset-token').value = token;
        document.getElementById('reset-email').value = email;
        document.getElementById('reset-email-display').textContent = email;
        this.showAuthPanel('reset');
        // Clean the URL so a page refresh doesn't re-trigger.
        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, document.title, cleanUrl);
      }
    } catch (_) { /* ignore — not a real link */ }
  }

  // ─── Validation helpers ─────────────────────────────────────────────────
  setAuthError(panelId, msg) {
    const el = document.getElementById(`${panelId}-error`);
    if (el) el.textContent = msg || '';
  }
  setAuthSuccess(panelId, msg) {
    const el = document.getElementById(`${panelId}-success`);
    if (el) {
      el.textContent = msg || '';
      el.classList.toggle('hidden', !msg);
    }
  }
  clearAuthMessages() {
    ['login', 'register', 'forgot', 'reset'].forEach(p => {
      this.setAuthError(p, '');
      this.setAuthSuccess(p, '');
    });
  }

  updatePasswordMeter(meterId, password) {
    const fillEl  = document.getElementById(`${meterId}-fill`);
    const labelEl = document.getElementById(`${meterId}-label`);
    if (!fillEl || !labelEl) return;
    const { score, label } = passwordStrength(password);
    fillEl.style.width = `${(score / 4) * 100}%`;
    fillEl.dataset.score = String(score);
    labelEl.textContent = `Strength: ${label}`;
  }

  // ─── Profile picture selection (register flow) ──────────────────────────
  handleRegisterPicSelection(file) {
    const errEl = document.getElementById('register-error');
    errEl.textContent = '';

    if (!file) return;
    if (!MAX_PIC_TYPES.includes(file.type)) {
      errEl.textContent = 'Profile picture must be PNG, JPG, GIF, or WEBP.';
      return;
    }
    if (file.size > MAX_PIC_BYTES) {
      errEl.textContent = `Profile picture must be under ${MAX_PIC_BYTES / 1024 / 1024} MB.`;
      return;
    }

    const reader = new FileReader();
    reader.onload = e => {
      this.pendingProfilePic = { dataUrl: e.target.result, file };
      this.renderProfilePicPreview('profile-pic-preview', e.target.result);
      document.getElementById('profile-pic-remove').classList.remove('hidden');
    };
    reader.onerror = () => {
      errEl.textContent = 'Could not read that image. Please try another.';
    };
    reader.readAsDataURL(file);
  }

  clearRegisterPic() {
    this.pendingProfilePic = null;
    const preview = document.getElementById('profile-pic-preview');
    if (preview) {
      preview.innerHTML = '<i class="fas fa-camera"></i>';
      preview.style.backgroundImage = '';
    }
    document.getElementById('profile-pic-remove').classList.add('hidden');
    const input = document.getElementById('profile-pic-input');
    if (input) input.value = '';
  }

  renderProfilePicPreview(previewId, url) {
    const el = document.getElementById(previewId);
    if (!el) return;
    el.style.backgroundImage = `url('${url}')`;
    el.innerHTML = '';
  }

  // ─── LOGIN ──────────────────────────────────────────────────────────────
  async login() {
    const identifier = document.getElementById('login-identifier').value.trim();
    const password   = document.getElementById('login-password').value;
    const errEl      = document.getElementById('login-error');
    errEl.textContent = '';

    if (!identifier || !password) { errEl.textContent = 'Please fill all fields.'; return; }

    const btn = document.getElementById('login-btn');
    btn.style.opacity = '0.6';
    btn.disabled = true;
    try {
      const res = await fetch(`${API}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      });
      const data = await res.json();
      if (!res.ok) { errEl.textContent = data.error || 'Sign-in failed.'; return; }
      this.saveSession(data.token, data.user);
      this.boot();
    } catch {
      errEl.textContent = 'Cannot connect to server.';
    } finally {
      btn.style.opacity = '1';
      btn.disabled = false;
    }
  }

  // ─── REGISTER ───────────────────────────────────────────────────────────
  async register() {
    const email    = document.getElementById('reg-email').value.trim();
    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value;
    const confirm  = document.getElementById('reg-password-confirm').value;
    const errEl    = document.getElementById('register-error');
    errEl.textContent = '';

    // Client-side validation — fast feedback before a round-trip.
    if (!email || !username || !password || !confirm) {
      errEl.textContent = 'Please fill all fields.'; return;
    }
    if (!EMAIL_RE.test(email)) {
      errEl.textContent = 'Please enter a valid email address.'; return;
    }
    if (!USERNAME_RE.test(username)) {
      errEl.textContent = 'Username must be 3–32 characters (letters, digits, _.-).'; return;
    }
    if (password.length < 6) {
      errEl.textContent = 'Password must be at least 6 characters.'; return;
    }
    if (password !== confirm) {
      errEl.textContent = 'Passwords do not match.'; return;
    }

    const btn = document.getElementById('register-btn');
    btn.style.opacity = '0.6';
    btn.disabled = true;
    try {
      // If the user picked a profile picture, upload it FIRST so we can pass
      // the resulting URL on the registration POST. The upload endpoint
      // requires auth, so we register without it then upload — the cleanest
      // way is to register first, then upload via /api/upload-profile-picture.
      const regRes = await fetch(`${API}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, username, password }),
      });
      const regData = await regRes.json();
      if (!regRes.ok) { errEl.textContent = regData.error || 'Registration failed.'; return; }

      // Profile picture is optional — upload only if the user picked one.
      let profilePictureUrl = regData.user.profilePictureUrl || '';
      if (this.pendingProfilePic && this.pendingProfilePic.file) {
        try {
          const uploaded = await this.uploadProfilePicture(this.pendingProfilePic.file, regData.token);
          if (uploaded) profilePictureUrl = uploaded;
        } catch (err) {
          // Don't fail registration just because the pic upload hiccuped —
          // we already created the account. Inform but proceed.
          console.warn('Profile picture upload failed during register:', err);
          this.showToast('Heads up', 'Account created, but profile picture upload failed. You can retry from your profile.', 'error');
        }
      }

      const finalUser = { ...regData.user, profilePictureUrl };
      this.saveSession(regData.token, finalUser);
      this.boot();
    } catch {
      errEl.textContent = 'Cannot connect to server.';
    } finally {
      btn.style.opacity = '1';
      btn.disabled = false;
    }
  }

  // ─── FORGOT PASSWORD ────────────────────────────────────────────────────
  async forgotPassword() {
    const email = document.getElementById('forgot-email').value.trim();
    const errEl = document.getElementById('forgot-error');
    const okEl  = document.getElementById('forgot-success');
    errEl.textContent = '';
    okEl.classList.add('hidden');
    okEl.textContent = '';

    if (!email) { errEl.textContent = 'Please enter your email address.'; return; }
    if (!EMAIL_RE.test(email)) { errEl.textContent = 'Please enter a valid email address.'; return; }

    const btn = document.getElementById('forgot-btn');
    btn.style.opacity = '0.6';
    btn.disabled = true;
    try {
      const res = await fetch(`${API}/api/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      // Always show a success message regardless of whether the email was
      // found — that's how we prevent user-enumeration.
      okEl.textContent = data.message || 'If that email is registered, a reset link has been sent.';
      okEl.classList.remove('hidden');

      // Dev convenience — if the server included a reset link in the response
      // (only happens in non-prod + MOCK mode), let the user click straight
      // through to the reset form.
      if (data.devResetLink) {
        const link = document.createElement('a');
        link.href = data.devResetLink;
        link.className = 'dev-reset-link';
        link.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Dev shortcut: open reset link';
        link.addEventListener('click', e => {
          e.preventDefault();
          try {
            const url = new URL(data.devResetLink);
            const token = url.searchParams.get('token');
            const mail  = url.searchParams.get('email');
            if (token && mail) {
              document.getElementById('reset-token').value = token;
              document.getElementById('reset-email').value  = mail;
              document.getElementById('reset-email-display').textContent = mail;
              this.showAuthPanel('reset');
            }
          } catch (_) { /* ignore */ }
        });
        okEl.appendChild(document.createElement('br'));
        okEl.appendChild(link);
      }
    } catch {
      errEl.textContent = 'Cannot connect to server.';
    } finally {
      btn.style.opacity = '1';
      btn.disabled = false;
    }
  }

  // ─── RESET PASSWORD ─────────────────────────────────────────────────────
  async resetPassword() {
    const token       = document.getElementById('reset-token').value.trim();
    const email       = document.getElementById('reset-email').value.trim();
    const newPassword = document.getElementById('reset-password').value;
    const confirm     = document.getElementById('reset-password-confirm').value;
    const errEl       = document.getElementById('reset-error');
    errEl.textContent = '';

    if (!token) { errEl.textContent = 'Missing reset token. Please request a new link.'; return; }
    if (!newPassword || !confirm) { errEl.textContent = 'Please fill all fields.'; return; }
    if (newPassword.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; return; }
    if (newPassword !== confirm) { errEl.textContent = 'Passwords do not match.'; return; }

    const btn = document.getElementById('reset-btn');
    btn.style.opacity = '0.6';
    btn.disabled = true;
    try {
      const res = await fetch(`${API}/api/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, email, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) { errEl.textContent = data.error || 'Reset failed.'; return; }
      this.saveSession(data.token, data.user);
      this.boot();
    } catch {
      errEl.textContent = 'Cannot connect to server.';
    } finally {
      btn.style.opacity = '1';
      btn.disabled = false;
    }
  }

  // ─── Profile picture upload (used by register & profile editor) ─────────
  async uploadProfilePicture(file, explicitToken) {
    const formData = new FormData();
    formData.append('picture', file);
    const token = explicitToken || this.token;
    if (!token) throw new Error('Not signed in.');
    const res = await fetch(`${API}/api/upload-profile-picture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed.');
    return data.profilePictureUrl;
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

  // ════════════════════════════════════════════════════════════════════════
  // PROFILE EDITOR MODAL
  // ════════════════════════════════════════════════════════════════════════
  openProfileModal() {
    if (!this.user) return;
    const modal = document.getElementById('profile-modal');
    if (!modal) return;

    // Populate fields
    document.getElementById('profile-email').value    = this.user.email || '';
    document.getElementById('profile-username').value = this.user.username || '';
    document.getElementById('profile-status').value   = this.user.status || '';

    const preview = document.getElementById('profile-pic-edit-preview');
    if (preview) {
      if (this.user.profilePictureUrl) {
        preview.style.backgroundImage = `url('${this.user.profilePictureUrl}')`;
        preview.innerHTML = '';
      } else {
        preview.style.backgroundImage = '';
        preview.innerHTML = '<i class="fas fa-user"></i>';
      }
    }

    const removeBtn = document.getElementById('profile-pic-remove-btn');
    if (removeBtn) {
      removeBtn.classList.toggle('hidden', !this.user.profilePictureUrl);
    }

    document.getElementById('profile-error').textContent = '';
    document.getElementById('profile-success').classList.add('hidden');

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
  }

  closeProfileModal() {
    const modal = document.getElementById('profile-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  }

  async handleProfilePicUpload(file) {
    const errEl = document.getElementById('profile-error');
    const okEl  = document.getElementById('profile-success');
    errEl.textContent = '';
    okEl.classList.add('hidden');

    if (!file) return;
    if (!MAX_PIC_TYPES.includes(file.type)) {
      errEl.textContent = 'Profile picture must be PNG, JPG, GIF, or WEBP.'; return;
    }
    if (file.size > MAX_PIC_BYTES) {
      errEl.textContent = `Profile picture must be under ${MAX_PIC_BYTES / 1024 / 1024} MB.`; return;
    }

    try {
      // Show a local preview immediately for snappy UX.
      const reader = new FileReader();
      reader.onload = e => {
        this.renderProfilePicPreview('profile-pic-edit-preview', e.target.result);
      };
      reader.readAsDataURL(file);

      const url = await this.uploadProfilePicture(file);
      this.user.profilePictureUrl = url;
      localStorage.setItem('zc_user', JSON.stringify(this.user));
      this.applyMyAvatar();
      document.getElementById('profile-pic-remove-btn').classList.remove('hidden');
      okEl.textContent = 'Profile picture updated.';
      okEl.classList.remove('hidden');
    } catch (err) {
      errEl.textContent = err.message || 'Upload failed.';
      // Restore the previous preview on failure.
      if (this.user.profilePictureUrl) {
        this.renderProfilePicPreview('profile-pic-edit-preview', this.user.profilePictureUrl);
      } else {
        const preview = document.getElementById('profile-pic-edit-preview');
        preview.style.backgroundImage = '';
        preview.innerHTML = '<i class="fas fa-user"></i>';
      }
    }
  }

  async handleProfilePicRemove() {
    if (!this.user) return;
    const errEl = document.getElementById('profile-error');
    const okEl  = document.getElementById('profile-success');
    errEl.textContent = '';
    okEl.classList.add('hidden');

    try {
      const res = await fetch(`${API}/api/me`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ profilePictureUrl: '' }),
      });
      const data = await res.json();
      if (!res.ok) { errEl.textContent = data.error || 'Could not remove picture.'; return; }

      this.user = data.user;
      localStorage.setItem('zc_user', JSON.stringify(this.user));
      this.applyMyAvatar();

      const preview = document.getElementById('profile-pic-edit-preview');
      preview.style.backgroundImage = '';
      preview.innerHTML = '<i class="fas fa-user"></i>';
      document.getElementById('profile-pic-remove-btn').classList.add('hidden');
      okEl.textContent = 'Profile picture removed.';
      okEl.classList.remove('hidden');
    } catch {
      errEl.textContent = 'Cannot connect to server.';
    }
  }

  async saveProfile() {
    const username = document.getElementById('profile-username').value.trim();
    const status   = document.getElementById('profile-status').value.trim();
    const errEl    = document.getElementById('profile-error');
    const okEl     = document.getElementById('profile-success');
    errEl.textContent = '';
    okEl.classList.add('hidden');

    if (username && !USERNAME_RE.test(username)) {
      errEl.textContent = 'Username must be 3–32 characters (letters, digits, _.-).'; return;
    }

    const btn = document.getElementById('profile-save-btn');
    btn.style.opacity = '0.6';
    btn.disabled = true;
    try {
      const res = await fetch(`${API}/api/me`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ username: username || undefined, status }),
      });
      const data = await res.json();
      if (!res.ok) { errEl.textContent = data.error || 'Save failed.'; return; }

      this.user = data.user;
      if (data.token) this.token = data.token;
      localStorage.setItem('zc_user', JSON.stringify(this.user));
      if (data.token) localStorage.setItem('zc_token', data.token);

      this.applyMyAvatar();
      okEl.textContent = 'Profile saved.';
      okEl.classList.remove('hidden');
    } catch {
      errEl.textContent = 'Cannot connect to server.';
    } finally {
      btn.style.opacity = '1';
      btn.disabled = false;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // BOOT — main app shell after auth
  // ════════════════════════════════════════════════════════════════════════
  boot() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    this.applyMyAvatar();
    this.domCache.meName.textContent = this.user.username;

    document.getElementById('logout-btn').addEventListener('click', () => {
      if (confirm('Sign out?')) this.logout();
    });

    document.querySelectorAll('.s-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.s-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const sec = tab.dataset.section;
        this.domCache.chatsSection.classList.toggle('hidden', sec !== 'chats');
        this.domCache.contactsSection.classList.toggle('hidden', sec !== 'contacts');
      });
    });

    document.getElementById('search-input').addEventListener('input', e => this.filterContacts(e.target.value));

    const input = this.domCache.messageInput;
    input.addEventListener('input', () => this.onInputChange());
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendMessage(); }
    });

    document.getElementById('send-btn').addEventListener('click', () => this.sendMessage());
    document.getElementById('back-btn').addEventListener('click', () => this.closeChatMobile());

    // Call buttons
    document.getElementById('voice-call-btn').addEventListener('click', () => this.startCall('audio'));
    document.getElementById('video-call-btn').addEventListener('click', () => this.startCall('video'));

    document.querySelector('.emoji-btn').addEventListener('click', e => {
      e.stopPropagation();
      const picker = this.domCache.emojiPicker;
      picker.classList.toggle('hidden');
      if (!picker.children.length) this.buildEmojiPicker();
    });
    document.addEventListener('click', () => this.domCache.emojiPicker.classList.add('hidden'));

    if (!document.querySelector('.toast-container')) {
      const toasts = document.createElement('div');
      toasts.className = 'toast-container';
      document.body.appendChild(toasts);
    }

    this.connectSocket();
    this.fetchUsers();
    this.refreshMyProfile();
  }

  applyMyAvatar() {
    const avatarEl = this.domCache.meAvatar;
    if (!avatarEl) return;
    if (this.user && this.user.profilePictureUrl) {
      avatarEl.classList.add('has-image');
      avatarEl.style.backgroundImage = `url('${this.user.profilePictureUrl}')`;
      avatarEl.textContent = '';
    } else {
      avatarEl.classList.remove('has-image');
      avatarEl.style.backgroundImage = '';
      avatarEl.textContent = (this.user && this.user.username ? this.user.username.charAt(0).toUpperCase() : '?');
    }
  }

  async refreshMyProfile() {
    // Pull the freshest profile data so the avatar / username are always
    // up-to-date even after the user changes them on another device.
    try {
      const res = await fetch(`${API}/api/me`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (!res.ok) return;
      const fresh = await res.json();
      this.user = { ...this.user, ...fresh };
      localStorage.setItem('zc_user', JSON.stringify(this.user));
      this.applyMyAvatar();
      this.domCache.meName.textContent = this.user.username;
    } catch (_) { /* offline / network blip — keep cached profile */ }
  }

  // ════════════════════════════════════════════════════════════════════════
  // SOCKET
  // ════════════════════════════════════════════════════════════════════════
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

    // Call signaling
    this.socket.on('call_invite', (data) => this.onIncomingCall(data));
    this.socket.on('call_accepted', (data) => this.onCallAccepted(data));
    this.socket.on('call_rejected', () => this.onCallRejected());
    this.socket.on('call_ended', () => this.endCallUI());
    this.socket.on('call_failed', ({ reason }) => this.showToast('Call Failed', reason, 'error'));
  }

  // ════════════════════════════════════════════════════════════════════════
  // USERS / CONTACTS
  // ════════════════════════════════════════════════════════════════════════
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

    const avatarBg = user.profilePictureUrl
      ? `style="background-image:url('${user.profilePictureUrl}')"`
      : '';

    div.innerHTML = `
      <div class="c-avatar ${isOnline ? 'online' : ''} ${user.profilePictureUrl ? 'has-image' : ''}" ${avatarBg}>${user.profilePictureUrl ? '' : this.escHtml(user.username.charAt(0).toUpperCase())}</div>
      <div class="c-info">
        <div class="c-name">${this.escHtml(user.username)}</div>
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

  // ════════════════════════════════════════════════════════════════════════
  // OPEN / CLOSE CHAT
  // ════════════════════════════════════════════════════════════════════════
  async openChat(username) {
    if (this.activeChat === username) return;

    this.activeChat = username;
    this.ensureChat(username);

    this.chats.get(username).unread = 0;
    this.socket.emit('mark_read', { from: username });

    document.getElementById('chat-name').textContent = username;

    const avatar = document.getElementById('chat-avatar');
    // Try to find this user's profile picture from the cached contacts list
    const cached = this.findCachedUser(username);
    if (cached && cached.profilePictureUrl) {
      avatar.classList.add('has-image');
      avatar.style.backgroundImage = `url('${cached.profilePictureUrl}')`;
      avatar.textContent = '';
    } else {
      avatar.classList.remove('has-image');
      avatar.style.backgroundImage = '';
      avatar.textContent = username.charAt(0).toUpperCase();
    }

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

  findCachedUser(username) {
    // Search the contacts list DOM cache for the matching row's avatar URL.
    const row = this.domCache.usersList.querySelector(`.contact-item[data-username="${username}"]`);
    if (!row) return null;
    const avatar = row.querySelector('.c-avatar');
    if (!avatar) return null;
    const bg = avatar.style.backgroundImage;
    if (!bg) return null;
    const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
    return match ? { profilePictureUrl: match[1] } : null;
  }

  closeChatMobile() {
    document.querySelector('.chat-panel').classList.remove('visible');
    document.querySelector('.sidebar').classList.remove('hidden-mobile');
    this.activeChat = null;
  }

  // ════════════════════════════════════════════════════════════════════════
  // MESSAGES
  // ════════════════════════════════════════════════════════════════════════
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

  // ════════════════════════════════════════════════════════════════════════
  // TYPING
  // ════════════════════════════════════════════════════════════════════════
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

  // ════════════════════════════════════════════════════════════════════════
  // CHAT LIST MANAGEMENT
  // ════════════════════════════════════════════════════════════════════════
  updateChatListItem(username) {
    const chat = this.chats.get(username);
    const isOnline = this.onlineSet.has(username);

    const containers = [this.domCache.chatsSection, this.domCache.contactsSection];

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

  // ════════════════════════════════════════════════════════════════════════
  // EMOJI
  // ════════════════════════════════════════════════════════════════════════
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

  // ════════════════════════════════════════════════════════════════════════
  // CALLING
  // ════════════════════════════════════════════════════════════════════════
  async startCall(callType) {
    if (!this.activeChat) return;
    const toUser = this.activeChat;

    try {
      const res = await fetch(`${API}/api/create-room`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ with: toUser }),
      });
      const data = await res.json();
      if (!res.ok) {
        this.showToast('Call Failed', data.error || 'Could not create room', 'error');
        return;
      }

      this.pendingCall = { with: toUser, callType, roomURL: data.roomURL, roomName: data.roomName };
      this.socket.emit('call_invite', {
        to: toUser,
        callType,
        roomURL: data.roomURL,
        roomName: data.roomName,
      });

      this.openCallModal(callType, toUser, 'Calling…');
    } catch (err) {
      console.error('startCall error:', err);
      this.showToast('Call Failed', 'Could not reach server.', 'error');
    }
  }

  onIncomingCall({ from, callType, roomURL, roomName }) {
    this.incomingCall = { from, callType, roomURL, roomName };
    const label = callType === 'video' ? 'Video call' : 'Voice call';
    const accept = confirm(`${label} from ${from}. Accept?`);

    if (accept) {
      this.socket.emit('call_accept', { to: from, roomURL, roomName });
      this.joinCall(callType, from, roomURL);
    } else {
      this.socket.emit('call_reject', { to: from });
    }
    this.incomingCall = null;
  }

  onCallAccepted({ from, roomURL }) {
    if (!this.pendingCall) return;
    this.joinCall(this.pendingCall.callType, from, roomURL);
  }

  onCallRejected() {
    this.closeCallModal();
    this.pendingCall = null;
    this.showToast('Call Declined', 'The other user declined the call.');
  }

  async joinCall(callType, withUser, roomURL) {
    this.openCallModal(callType, withUser, 'Connecting…');
    this.currentCallWith = withUser;

    try {
      this.meeting = new Metered.Meeting();
      await this.meeting.join({ roomURL, name: this.user.username });

      await this.meeting.startAudio();
      if (callType === 'video') await this.meeting.startVideo();

      document.getElementById('call-status-text').textContent = 'Connected';
      document.getElementById('call-status-dot').classList.add('connected');

      this.meeting.on('localTrackStarted', (item) => {
        if (item.type === 'video') {
          const stream = new MediaStream([item.track]);
          document.getElementById('call-local-video').srcObject = stream;
        }
      });

      this.meeting.on('remoteTrackStarted', (item) => {
        document.getElementById('call-empty')?.remove();
        const grid = document.getElementById('call-remote-grid');

        if (item.type === 'video') {
          let videoEl = document.getElementById(`remote-${item.streamId}`);
          if (!videoEl) {
            videoEl = document.createElement('video');
            videoEl.id = `remote-${item.streamId}`;
            videoEl.autoplay = true;
            videoEl.playsInline = true;
            videoEl.className = 'call-remote-video';
            grid.appendChild(videoEl);
          }
          videoEl.srcObject = new MediaStream([item.track]);
        } else if (item.type === 'audio') {
          let audioEl = document.getElementById(`remote-audio-${item.streamId}`);
          if (!audioEl) {
            audioEl = document.createElement('audio');
            audioEl.id = `remote-audio-${item.streamId}`;
            audioEl.autoplay = true;
            document.body.appendChild(audioEl);
          }
          audioEl.srcObject = new MediaStream([item.track]);
        }
      });

      this.meeting.on('remoteTrackStopped', (item) => {
        document.getElementById(`remote-${item.streamId}`)?.remove();
        document.getElementById(`remote-audio-${item.streamId}`)?.remove();
      });

      this.meeting.on('participantLeft', () => {
        this.showToast('Call Ended', `${withUser} left the call.`);
        this.endCallUI();
      });

    } catch (err) {
      console.error('joinCall error:', err);
      this.showToast('Call Failed', 'Could not connect to call.', 'error');
      this.closeCallModal();
    }
  }

  hangupCall() {
    if (this.currentCallWith) {
      this.socket.emit('call_end', { to: this.currentCallWith });
    }
    this.endCallUI();
  }

  endCallUI() {
    if (this.meeting) {
      try { this.meeting.leaveMeeting(); } catch (_) {}
      this.meeting = null;
    }
    this.closeCallModal();
    this.pendingCall = null;
    this.currentCallWith = null;
  }

  openCallModal(callType, withUser, statusText) {
    const modal = document.getElementById('call-modal');
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.getElementById('call-title-text').textContent =
      callType === 'video' ? `Video Call with ${withUser}` : `Voice Call with ${withUser}`;
    document.getElementById('call-status-text').textContent = statusText;
    document.getElementById('call-status-dot').classList.remove('connected');

    document.getElementById('call-hangup-btn').onclick = () => this.hangupCall();
    document.getElementById('call-mute-btn').onclick = () => this.toggleMute();
    document.getElementById('call-cam-btn').onclick = () => this.toggleCamera();
  }

  closeCallModal() {
    const modal = document.getElementById('call-modal');
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    document.getElementById('call-remote-grid').innerHTML =
      '<div class="call-empty" id="call-empty"><i class="fas fa-user-group"></i><p>Waiting for the other side to join…</p></div>';
    document.getElementById('call-local-video').srcObject = null;
  }

  async toggleMute() {
    if (!this.meeting) return;
    this.isMuted = !this.isMuted;
    if (this.isMuted) await this.meeting.stopAudio();
    else await this.meeting.startAudio();
    document.getElementById('call-local-mic-off').classList.toggle('hidden', !this.isMuted);
  }

  async toggleCamera() {
    if (!this.meeting) return;
    this.isCamOff = !this.isCamOff;
    if (this.isCamOff) await this.meeting.stopVideo();
    else await this.meeting.startVideo();
  }

  // ════════════════════════════════════════════════════════════════════════
  // TOASTS
  // ════════════════════════════════════════════════════════════════════════
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

  // ════════════════════════════════════════════════════════════════════════
  // UTILS
  // ════════════════════════════════════════════════════════════════════════
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