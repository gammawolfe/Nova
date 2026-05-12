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
      // Server now emits the `detailed` error shape uniformly:
      //   { error: <CODE>, message: <human-readable>, issues?: [...] }
      //
      // For Error.message we prefer the human-readable `message` so toasts
      // show "Tenant not found" rather than "HTTP_404". Fall through to
      // `error` for legacy payloads or hand-rolled responses that only
      // set the code field. Preserve the code as `err.code` so any
      // future UI alerting can switch on it without parsing strings.
      const humanMessage =
        (parsed && (parsed.message || parsed.error)) || `HTTP ${res.status}`;
      const err = new Error(humanMessage);
      err.status = res.status;
      err.code = parsed && parsed.error;
      err.details = (parsed && (parsed.issues || parsed.details)) || [];
      throw err;
    }

    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }
