/**
 * Shared ID validation regex and helper used across admin-api and a2a-server.
 */
export const ID_RE = /^[a-z0-9_-]{1,64}$/;

export function validateId(id: string, label = 'ID'): void {
  if (!ID_RE.test(id)) throw Object.assign(new Error(`Invalid ${label} format`), { status: 400 });
}
