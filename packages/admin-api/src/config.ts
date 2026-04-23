// Module-load-time validation of admin-api configuration.
// Importing this file throws synchronously if ADMIN_TOKEN is missing or weak,
// so a misconfigured admin-api fails to boot instead of accepting traffic and
// returning 500 on every request.

const MIN_ADMIN_TOKEN_LENGTH = 32;

function validateAdminToken(): string {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    throw new Error(
      'ADMIN_TOKEN env var is required. Generate one with `openssl rand -hex 32`.',
    );
  }
  if (token.length < MIN_ADMIN_TOKEN_LENGTH) {
    throw new Error(
      `ADMIN_TOKEN must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters ` +
      `(got ${token.length}). Generate one with \`openssl rand -hex 32\`.`,
    );
  }
  return token;
}

export const ADMIN_TOKEN = validateAdminToken();
