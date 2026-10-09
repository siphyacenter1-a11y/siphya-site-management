// api-client.js - REST API Client with JWT Auth & Toast Notifications
const API = {
  getToken() {
    return localStorage.getItem('auth_token') || '';
  },

  setToken(token) {
    if (token) {
      localStorage.setItem('auth_token', token);
    } else {
      localStorage.removeItem('auth_token');
    }
  },

  getUser() {
    try {
      const u = localStorage.getItem('auth_user');
      return u ? JSON.parse(u) : null;
    } catch (e) {
      return null;
    }
  },

  setUser(user) {
    if (user) {
      localStorage.setItem('auth_user', JSON.stringify(user));
    } else {
      localStorage.removeItem('auth_user');
    }
  },

  async request(url, options = {}) {
    const headers = options.headers || {};
    const token = API.getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const config = { ...options, headers };
    const res = await fetch(url, config);

    // If 401 Unauthorized and not on login page, redirect to login
    if (res.status === 401 && !window.location.pathname.includes('login')) {
      API.setToken(null);
      API.setUser(null);
      window.location.href = '/login';
      return;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Server error');
    }
    return await res.json();
  },

  async get(url, params = {}) {
    const query = new URLSearchParams(params).toString();
    const fullUrl = query ? `${url}?${query}` : url;
    return API.request(fullUrl, { method: 'GET' });
  },

  async post(url, data = {}) {
    return API.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  },

  async login(username, password) {
    const res = await API.post('/api/auth/login', { username, password });
    if (res.ok && res.token) {
      API.setToken(res.token);
      API.setUser(res.user);
    }
    return res;
  },

  async logout() {
    try {
      await API.post('/api/auth/logout');
    } catch (e) {}
    API.setToken(null);
    API.setUser(null);
    window.location.href = '/login';
  }
};

function hubToast(msg, ms = 3000) {
  let el = document.getElementById('hubToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'hubToast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(window.__hubToastTimer);
  window.__hubToastTimer = setTimeout(() => {
    el.classList.remove('show');
  }, ms);
}

// Global User Nav bar injector
function setupUserNav() {
  const user = API.getUser();
  const navContainer = document.getElementById('userNavBlock');
  if (!navContainer) return;

  if (user) {
    const isAdmin = user.role === 'admin';
    const notice = document.getElementById('adminNoticeBanner');
    if (notice && isAdmin) {
      notice.style.display = 'flex';
    }
    navContainer.innerHTML = `
      <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
        ${isAdmin ? `<a href="/admin" class="btn" style="background:#F2B705; color:#0B1F4B; font-weight:700; text-decoration:none; padding:6px 14px; font-size:12.5px; border-radius:8px;">📊 แดชบอร์ดแอดมิน</a>` : ''}
        <div style="display:flex; align-items:center; gap:8px;">
          <div style="width:32px; height:32px; border-radius:50%; background:rgba(255,255,255,0.2); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:13px; color:#fff;">
            ${user.username.charAt(0).toUpperCase()}
          </div>
          <div style="text-align:left; line-height:1.2;">
            <div style="font-size:13px; font-weight:600; color:#fff;">${user.full_name}</div>
            <div style="font-size:11px; color:#A3BBEB; text-transform:uppercase;">${user.role}</div>
          </div>
        </div>
        <button onclick="API.logout()" class="btn" style="background:rgba(255,255,255,0.12); color:#fff; padding:6px 12px; font-size:12px; border-radius:8px; border:1px solid rgba(255,255,255,0.2);">ออกจากระบบ</button>
      </div>
    `;
  } else {
    navContainer.innerHTML = `
      <a href="/login" class="btn" style="background:#F2B705; color:#0B1F4B; font-weight:700; text-decoration:none; padding:7px 16px; font-size:13px; border-radius:8px;">🔐 เข้าสู่ระบบ</a>
    `;
  }
}

document.addEventListener('DOMContentLoaded', setupUserNav);
