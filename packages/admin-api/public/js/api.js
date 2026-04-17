const TOKEN_KEY = 'nova_admin_token';
const TIMEOUT_MS = 3000;

let unauthorizedHandler = null;

export function setToken(t)       { sessionStorage.setItem(TOKEN_KEY, t); }
export function getToken()         { return sessionStorage.getItem(TOKEN_KEY); }
export function clearToken()       { sessionStorage.removeItem(TOKEN_KEY); }
export function onUnauthorized(fn) { unauthorizedHandler = fn; }

export async function api(method, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    if (res.status === 401) {
      clearToken();
      if (unauthorizedHandler) unauthorizedHandler();
      const err = new Error('Unauthorized');
      err.status = 401;
      throw err;
    }

    const text = await res.text();
    const parsed = text ? safeJson(text) : null;

    if (!res.ok) {
      const err = new Error((parsed && parsed.error) || `HTTP ${res.status}`);
      err.status = res.status;
      err.details = (parsed && parsed.details) || [];
      throw err;
    }

    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }
