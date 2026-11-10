/* Login screen, logout, and the 401 handling around fetch.
   Split out of console.js. These are classic scripts sharing one global
   scope; see channel/web/README.md before changing the load order. */

// =====================================================================
// Authentication
// =====================================================================
// Auth gate for background pollers. When a web_password is set, the /poll and
// /api/scheduler/runs loops must NOT run before the user logs in — otherwise
// they fire every few seconds with no cookie and spam the server log with
// "401 Unauthorized (credentials offered: none)". Both loops call
// requestAuthGatedStart(); the actual start is deferred until the login/auth
// check opens the gate via openAuthGate(). When no password is set the gate is
// opened immediately at startup so behavior is unchanged.
// This file loads after the pollers define their loops but before boot.js, the
// only caller that runs at load time, so the declarations are always in scope.
let authGateOpen = false;
const _pendingAuthGatedStarts = [];
function requestAuthGatedStart(fn) {
    if (authGateOpen) { fn(); return; }
    _pendingAuthGatedStarts.push(fn);
}
function openAuthGate() {
    if (authGateOpen) return;
    authGateOpen = true;
    while (_pendingAuthGatedStarts.length) {
        const fn = _pendingAuthGatedStarts.shift();
        try { fn(); } catch (_) {}
    }
}

function toggleLoginPassword() {
    const input = document.getElementById('login-password');
    const icon = document.querySelector('#login-toggle-pwd i');
    if (input.type === 'password') {
        input.type = 'text';
        icon.classList.replace('fa-eye', 'fa-eye-slash');
    } else {
        input.type = 'password';
        icon.classList.replace('fa-eye-slash', 'fa-eye');
    }
}
window.toggleLoginPassword = toggleLoginPassword;

// The overlay has two shapes. A single-password install keeps the form it
// always had; an instance with teacher accounts (users.json) adds a username
// field and a 注册 tab, because each account owns its own Agent workspace.
// /auth/check reports which one this is, so one page serves both.
let loginAccountMode = false;
let loginTab = 'login';

const LOGIN_STRINGS = {
    en: {
        subtitle: 'Enter password to access the console',
        subtitleAccount: 'Sign in with your teacher account',
        subtitleRegister: 'Create a teacher account with its own workspace',
        login: 'Login',
        register: 'Register',
        username: 'Username',
        name: 'Name (optional)',
        wrongPassword: 'Wrong username or password',
        taken: 'That username is already registered',
        short: 'Password must be at least 6 characters',
        missing: 'Username and password are required',
        locked: 'Too many attempts. Try again in {mins} min',
        network: 'Network error, please retry'
    },
    'zh-Hant': {
        subtitle: '請輸入密碼以存取控制台',
        subtitleAccount: '使用教師帳號登入',
        subtitleRegister: '建立教師帳號，擁有獨立的工作區與知識庫',
        login: '登入',
        register: '註冊',
        username: '使用者名稱',
        name: '姓名（選填）',
        wrongPassword: '使用者名稱或密碼錯誤',
        taken: '使用者名稱已被註冊',
        short: '密碼至少 6 位',
        missing: '請填寫使用者名稱和密碼',
        locked: '嘗試次數過多，請 {mins} 分鐘後再試',
        network: '網路錯誤，請重試'
    },
    zh: {
        subtitle: '请输入密码以访问控制台',
        subtitleAccount: '使用教师账号登录',
        subtitleRegister: '创建教师账号，拥有独立的工作区与知识库',
        login: '登录',
        register: '注册',
        username: '用户名',
        name: '姓名（选填）',
        wrongPassword: '用户名或密码错误',
        taken: '用户名已被注册',
        short: '密码至少 6 位',
        missing: '请填写用户名和密码',
        locked: '尝试次数过多，请 {mins} 分钟后再试',
        network: '网络错误，请重试'
    }
};

function _loginStrings() {
    return LOGIN_STRINGS[currentLang] || LOGIN_STRINGS.zh;
}

function _loginShowError(message) {
    const errEl = document.getElementById('login-error');
    if (!errEl) return;
    errEl.textContent = message;
    errEl.classList.remove('hidden');
}

function _loginHideError() {
    const errEl = document.getElementById('login-error');
    if (errEl) errEl.classList.add('hidden');
}

// Server refusal → the one line the person in front of the screen needs.
function _loginErrorText(data) {
    const s = _loginStrings();
    if (data && data.reason === 'locked') {
        const mins = Math.max(1, Math.ceil((data.retry_after || 60) / 60));
        return s.locked.replace('{mins}', String(mins));
    }
    if (data && data.reason === 'username_taken') return s.taken;
    if (data && data.reason === 'invalid') return data.message || s.missing;
    return s.wrongPassword;
}

function _loginSetTab(tab) {
    loginTab = tab === 'register' ? 'register' : 'login';
    const s = _loginStrings();
    const active = ['bg-primary-500', 'text-white'];
    const idle = ['text-slate-500', 'dark:text-slate-400', 'hover:text-slate-700', 'dark:hover:text-slate-200'];
    const paint = (el, on) => {
        if (!el) return;
        active.forEach(c => el.classList.toggle(c, on));
        idle.forEach(c => el.classList.toggle(c, !on));
    };

    const tabs = document.getElementById('login-tabs');
    if (tabs) tabs.classList.toggle('hidden', !loginAccountMode);
    const loginBtn = document.getElementById('login-tab-login');
    const registerBtn = document.getElementById('login-tab-register');
    if (loginBtn) loginBtn.textContent = s.login;
    if (registerBtn) registerBtn.textContent = s.register;
    paint(loginBtn, loginTab === 'login');
    paint(registerBtn, loginTab === 'register');

    const username = document.getElementById('login-username');
    if (username) {
        username.classList.toggle('hidden', !loginAccountMode);
        if (username.placeholder !== s.username) username.placeholder = s.username;
    }
    const name = document.getElementById('login-name');
    if (name) {
        name.classList.toggle('hidden', !(loginAccountMode && loginTab === 'register'));
        if (name.placeholder !== s.name) name.placeholder = s.name;
    }

    const subtitle = document.getElementById('login-subtitle');
    if (subtitle) {
        subtitle.textContent = !loginAccountMode
            ? s.subtitle
            : (loginTab === 'register' ? s.subtitleRegister : s.subtitleAccount);
    }
    const submit = document.getElementById('login-btn');
    if (submit) submit.textContent = loginTab === 'register' ? s.register : s.login;

    // A new password must not be offered the browser's saved one.
    const pwd = document.getElementById('login-password');
    if (pwd) pwd.autocomplete = loginTab === 'register' ? 'new-password' : 'current-password';
    _loginHideError();
}

// A teacher lands on the workbench; the single-password console keeps its own
// page, which is already loaded behind the overlay.
function _loginFinish(accountSession) {
    if (accountSession) {
        window.location.assign('/home');
        return;
    }
    const overlay = document.getElementById('login-overlay');
    if (overlay) overlay.classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    const logoutBtn = document.getElementById('logout-btn-header');
    if (logoutBtn) logoutBtn.classList.remove('hidden');
    // Now that the auth cookie is set, release the parked pollers.
    openAuthGate();
    initApp();
}

function _loginPost(url, payload) {
    return fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
    }).then(r => r.json());
}

function _loginSubmit() {
    const s = _loginStrings();
    const pwdInput = document.getElementById('login-password');
    const userInput = document.getElementById('login-username');
    const nameInput = document.getElementById('login-name');
    const btn = document.getElementById('login-btn');
    const password = pwdInput ? pwdInput.value : '';
    const username = userInput ? userInput.value.trim() : '';
    const displayName = nameInput ? nameInput.value.trim() : '';
    const registering = loginTab === 'register';
    const accountSession = registering || loginAccountMode;

    if (registering) {
        if (!username || !password) { _loginShowError(s.missing); return; }
        if (password.length < 6) { _loginShowError(s.short); return; }
    } else if (loginAccountMode) {
        if (!username || !password) { _loginShowError(s.missing); return; }
    } else if (!password) {
        return;
    }

    if (btn) btn.disabled = true;
    _loginHideError();

    let request;
    if (registering) {
        request = _loginPost('/api/account/register', {username, password, name: displayName});
    } else if (loginAccountMode) {
        request = _loginPost('/api/account/login', {username, password});
    } else {
        request = _loginPost('/auth/login', {password});
    }

    request.then(data => {
        if (data && data.status === 'success') {
            _loginFinish(accountSession);
            return;
        }
        _loginShowError(_loginErrorText(data));
        if (pwdInput) {
            pwdInput.value = '';
            pwdInput.focus();
        }
    }).catch(() => {
        _loginShowError(s.network);
    }).finally(() => {
        if (btn) btn.disabled = false;
    });
}

function showLoginScreen() {
    const overlay = document.getElementById('login-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');

    const form = document.getElementById('login-form');
    const pwdInput = document.getElementById('login-password');
    if (pwdInput) pwdInput.focus();

    const loginBtn = document.getElementById('login-tab-login');
    const registerBtn = document.getElementById('login-tab-register');
    if (loginBtn) loginBtn.onclick = () => _loginSetTab('login');
    if (registerBtn) registerBtn.onclick = () => _loginSetTab('register');

    _loginSetTab(loginTab);
    if (form) {
        form.onsubmit = function(e) {
            e.preventDefault();
            _loginSubmit();
            return false;
        };
    }

    // Whether accounts exist decides if the username field and the 注册 tab are
    // shown at all. /auth/check is idempotent and already fetched at boot;
    // asking again keeps this page self-contained, including on a 401.
    fetch('/auth/check').then(r => r.json()).then(data => {
        const mode = !!(data && data.account_mode);
        if (mode !== loginAccountMode) {
            loginAccountMode = mode;
            if (!mode) loginTab = 'login';
        }
        _loginSetTab(loginTab);
    }).catch(() => {});
}

function handleLogout() {
    fetch('/auth/logout', {
        method: 'POST'
    }).then(r => r.json()).then(data => {
        if (data.status === 'success') {
            window.location.reload();
        }
    }).catch(() => {
        window.location.reload();
    });
}
window.handleLogout = handleLogout;

// Intercept 401 responses globally to show login screen on session expiry
const _originalFetch = window.fetch;
window.fetch = function(...args) {
    return _originalFetch.apply(this, args).then(response => {
        if (response.status === 401) {
            const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            if (!url.startsWith('/auth/')) {
                showLoginScreen();
            }
        }
        return response;
    });
};

function initApp() {
    applyI18n();
    menuLoad();
    _applyInputTooltips();
    _restoreSessionPanel();
    refreshWorkspaceSelector();
    refreshSessionSettings();

    fetch('/api/knowledge/list').then(r => r.json()).then(data => {
        if (data.status === 'success') {
            _knowledgeTreeData = data.tree || [];
            _knowledgeRootFiles = data.root_files || [];
        }
    }).catch(() => {});

    fetch('/api/version').then(r => r.json()).then(data => {
        APP_VERSION = `v${data.version}`;
        UPDATE_META = {
            version: data.version || '',
            install_kind: data.install_kind || 'unknown',
            update_supported: !!data.update_supported,
            unsupported_reason: data.unsupported_reason || ''
        };
        _setSidebarVersionLabel(APP_VERSION);
    }).catch(() => {
        _setSidebarVersionLabel('');
    });
    chatInput.focus();
    // Last, and only from here: initApp() runs once auth has settled, on all
    // three paths into the app. Opening the routed view any earlier would
    // switch views behind the login overlay.
    routeApply();
}

