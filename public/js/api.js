// ==================== API Client ====================

const API = (() => {
  const TOKEN_KEY = 'nd_auth_token';
  const USER_KEY = 'nd_auth_user';

  async function request(path, method = 'GET', body = null, auth = true) {
    const headers = { 'Content-Type': 'application/json' };
    const token = localStorage.getItem(TOKEN_KEY);
    if (auth && token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });

    let data = null;
    try { data = await res.json(); } catch (e) { /* empty */ }

    if (!res.ok) {
      const err = new Error(data?.error || I18N.t('err.http', { status: res.status }));
      err.status = res.status;
      err.data = data;
      if (res.status === 401 && auth) {
        clearAuth();
        if (!path.startsWith('/auth/login') && !path.includes('share/public')) {
          window.location.href = '/';
        }
      }
      throw err;
    }
    return data;
  }

  function setAuth(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function getCurrentUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY));
    } catch {
      return null;
    }
  }

  function clearAuth() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  async function login(email, password) {
    const data = await request('/auth/login', 'POST', { email, password }, false);
    setAuth(data.token, data.user);
    return data.user;
  }

  async function logout() {
    clearAuth();
  }

  // Public summary (no auth)
  async function getSummary() {
    return request('/analytics/summary', 'GET', null, false);
  }

  // Share public access
  async function getShareData(token) {
    return request(`/share/public/${token}`, 'GET', null, false);
  }

  return {
    request,
    login,
    logout,
    setAuth,
    getToken,
    getCurrentUser,
    clearAuth,
    getSummary,
    getShareData
  };
})();

// ==================== Utilities ====================

function locale() {
  return I18N.getLang() === 'ar' ? 'ar-EG' : 'en-GB';
}

function formatNumber(num) {
  return new Intl.NumberFormat(locale()).format(Number(num) || 0);
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString(locale(), {
    year: 'numeric', month: 'long', day: 'numeric'
  });
}

function formatDateTime(dateStr) {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString(locale(), {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function showToast(message, type = 'success') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icon = type === 'error'
    ? '<circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line>'
    : '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>';
  toast.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      ${icon}
    </svg>
    <span>${message}</span>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease-out';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function monthName(monthId) {
  return I18N.t('months.' + Number(monthId)) || monthId;
}

function statusBadge(status) {
  const map = {
    submitted: [I18N.t('status.submitted'), 'status-pending'],
    approved: [I18N.t('status.approved'), 'status-approved'],
    rejected: [I18N.t('status.rejected'), 'status-rejected']
  };
  const [label, cls] = map[status] || [status, 'status-pending'];
  return `<span class="status-badge ${cls}">${label}</span>`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}
