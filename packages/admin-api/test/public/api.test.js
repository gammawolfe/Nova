import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { api, setToken, clearToken, onUnauthorized } from '../../public/js/api.js';

beforeEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});
afterEach(() => { vi.useRealTimers(); });

describe('api()', () => {
  it('injects bearer token from sessionStorage', async () => {
    setToken('tok-123');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await api('GET', '/admin/tenants');
    const req = fetchMock.mock.calls[0][1];
    expect(req.headers.Authorization).toBe('Bearer tok-123');
  });

  it('parses JSON body on 2xx', async () => {
    setToken('t');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ name: 'acme' }), { status: 200 }),
    );
    const body = await api('GET', '/admin/tenants/acme');
    expect(body).toEqual({ name: 'acme' });
  });

  it('throws with parsed .details on 400', async () => {
    setToken('t');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'VALIDATION', details: [{ field: 'slug', message: 'required' }] }), { status: 400 }),
    );
    await expect(api('POST', '/admin/tenants', { foo: 1 }))
      .rejects.toMatchObject({ status: 400, details: [{ field: 'slug', message: 'required' }] });
  });

  it('on 401 clears sessionStorage and calls onUnauthorized handler', async () => {
    setToken('bad');
    const handler = vi.fn();
    onUnauthorized(handler);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    );
    await expect(api('GET', '/admin/tenants')).rejects.toMatchObject({ status: 401 });
    expect(sessionStorage.getItem('nova_admin_token')).toBeNull();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('aborts after 3s and throws a timeout error', async () => {
    vi.useFakeTimers();
    setToken('t');
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const p = api('GET', '/admin/tenants');
    vi.advanceTimersByTime(3100);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('setToken/clearToken', () => {
  it('round-trips through sessionStorage', () => {
    setToken('abc');
    expect(sessionStorage.getItem('nova_admin_token')).toBe('abc');
    clearToken();
    expect(sessionStorage.getItem('nova_admin_token')).toBeNull();
  });
});
