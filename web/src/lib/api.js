/**
 * Thin fetch wrapper. Every call sends the auth cookie and throws an ApiError
 * carrying the server's `message` plus the parsed body, so callers can react to
 * a 409 by reading `err.body.visit` rather than re-fetching.
 */

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body || {};
  }
}

async function request(path, { method = 'GET', body, headers = {}, signal } = {}) {
  const init = { method, credentials: 'same-origin', headers: { ...headers }, signal };

  if (body instanceof FormData) {
    // Let the browser set the multipart boundary.
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('NETWORK', 0, {});
  }

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const payload = isJson ? await res.json().catch(() => ({})) : {};

  if (!res.ok) {
    throw new ApiError(payload.message || `Request failed (${res.status})`, res.status, payload);
  }
  return payload;
}

export const api = {
  get: (path, opts) => request(path, opts),
  post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
  patch: (path, body, opts) => request(path, { ...opts, method: 'PATCH', body }),
  del: (path, opts) => request(path, { ...opts, method: 'DELETE' }),
};

export const auth = {
  me: () => api.get('/api/auth/me'),
  login: (username, password) => api.post('/api/auth/login', { username, password }),
  loginPin: (userId, pin) => api.post('/api/auth/login-pin', { userId, pin }),
  gateUsers: () => api.get('/api/auth/gate-users'),
  logout: () => api.post('/api/auth/logout'),
  setPin: (newPin, currentPin) => api.post('/api/auth/pin', { newPin, currentPin }),
  changePassword: (currentPassword, newPassword) =>
    api.post('/api/auth/change-password', { currentPassword, newPassword }),
  webauthnLoginOptions: () => api.post('/api/auth/webauthn/login/options'),
  webauthnLoginVerify: (credential) => api.post('/api/auth/webauthn/login/verify', { credential }),
};

export const gate = {
  today: () => api.get('/api/visits/today'),
  hosts: () => api.get('/api/visitors/hosts'),
  lookup: (phone) => api.get(`/api/visitors/lookup?phone=${encodeURIComponent(phone)}`),
  create: (formData) => api.post('/api/visits', formData),
  checkIn: (id) => api.post(`/api/visits/${id}/check-in`),
  checkOut: (id) => api.post(`/api/visits/${id}/check-out`),
};

export const approvals = {
  pending: () => api.get('/api/approvals/pending'),
  history: () => api.get('/api/approvals/history'),
  approve: (id) => api.post(`/api/approvals/${id}/approve`),
  reject: (id, reason) => api.post(`/api/approvals/${id}/reject`, { reason }),
};

export const admin = {
  dashboard: () => api.get('/api/admin/dashboard'),
  users: (role) => api.get(`/api/admin/users${role ? `?role=${role}` : ''}`),
  createUser: (payload) => api.post('/api/admin/users', payload),
  updateUser: (id, payload) => api.patch(`/api/admin/users/${id}`, payload),
  resetPin: (id) => api.post(`/api/admin/users/${id}/reset-pin`),
  authEvents: (id) => api.get(`/api/admin/users/${id}/auth-events`),
  visits: (params) => api.get(`/api/admin/visits?${new URLSearchParams(params)}`),
  events: (id) => api.get(`/api/admin/visits/${id}/events`),
  csvUrl: (date) => `/api/admin/report/daily?format=csv${date ? `&date=${date}` : ''}`,
};

export const photoUrl = (filename) => `/api/photos/${filename}`;
