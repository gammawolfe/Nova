# Nova Admin UI — Onboarding Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a lightweight "Cinematic Cosmos" admin UI served from `packages/admin-api` that lets an operator create a galaxy, issue an invite, and approve a planet — the full onboarding loop — without touching curl.

**Architecture:** Static HTML + vendored Alpine.js + plain CSS, served from `packages/admin-api/public/` via `express.static` mounted before the `/admin` bearer-auth middleware. A single `api()` wrapper handles bearer injection + 401 boot-to-login. Live agent/tenant updates ride the existing `GET /admin/events` SSE stream. No build step.

**Tech Stack:** Alpine.js 3.x (vendored), qrcode.js (vendored), vanilla ES modules, CSS custom properties, Vitest + jsdom for JS unit tests, Playwright for E2E.

**Spec:** `docs/superpowers/specs/2026-04-17-admin-ui-onboarding-design.md`

---

## File Structure

**New files:**

| Path | Responsibility |
| ---- | -------------- |
| `packages/admin-api/public/index.html` | Single-page UI shell; all screens via Alpine `x-show` |
| `packages/admin-api/public/styles.css` | Design tokens, `.nova-surface` backdrop, primitives |
| `packages/admin-api/public/js/utils.js` | Pure helpers: slug→color hash, TTL humanizer |
| `packages/admin-api/public/js/api.js` | `fetch` wrapper: bearer injection, 401 handling, error parsing, AbortController timeout |
| `packages/admin-api/public/js/app.js` | Alpine store, hash routing, SSE subscription |
| `packages/admin-api/public/vendor/alpine.min.js` | Vendored Alpine 3.x |
| `packages/admin-api/public/vendor/qrcode.min.js` | Vendored qrcode generator |
| `packages/admin-api/vitest.config.ts` | jsdom environment for browser-side tests |
| `packages/admin-api/test/public/utils.test.js` | Unit tests for `utils.js` |
| `packages/admin-api/test/public/api.test.js` | Unit tests for `api.js` |
| `packages/admin-api/playwright.config.ts` | Playwright config, reads `ADMIN_TOKEN` from env |
| `packages/admin-api/test/e2e/fixtures.ts` | Shared fixtures (admin-api boot helper) |
| `packages/admin-api/test/e2e/onboarding.spec.ts` | Golden path E2E |
| `packages/admin-api/test/e2e/auth.spec.ts` | Invalid token + expired session |
| `packages/admin-api/test/e2e/sse.spec.ts` | SSE reconnect |
| `packages/admin-api/test/e2e/motion.spec.ts` | Reduced-motion coverage |
| `scripts/acceptance-test-m5.ts` | Acceptance harness — runs Playwright golden path |
| `docs/admin-ui/manual-test-playbook.md` | One-page manual playbook for real-world test |

**Modified files:**

| Path | Change |
| ---- | ------ |
| `packages/admin-api/src/index.ts` | Mount `express.static('public')` before `/admin` auth middleware |
| `packages/admin-api/package.json` | Add `vitest`, `jsdom`, `@playwright/test` devDeps; add `test`, `test:e2e` scripts |
| `Dockerfile.admin-api` | Ensure `public/` and `vendor/` ship in the runtime stage |
| `package.json` (root) | Add `test:acceptance:m5` script |
| `.gitignore` | Ignore `.superpowers/`, `packages/admin-api/test-results/`, `packages/admin-api/playwright-report/` |

---

## Task 1: Scaffold static assets + wire admin-api static middleware

**Files:**
- Create: `packages/admin-api/public/index.html`
- Modify: `packages/admin-api/src/index.ts`
- Modify: `.gitignore`
- Modify: `Dockerfile.admin-api`

- [ ] **Step 1: Create minimal index.html placeholder**

Create `packages/admin-api/public/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'">
  <title>Nova Admin</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="nova-surface">
  <main id="app"><h1 style="color:#fff;padding:2rem">Nova Admin — loading…</h1></main>
</body>
</html>
```

- [ ] **Step 2: Wire static middleware before auth**

Open `packages/admin-api/src/index.ts`. Add this import near the top with the other Node imports:

```typescript
import path from 'path';
```

Then replace the block starting at line 27 (`app.use(express.json());`) through line 30 (`app.use('/discover', discoverRouter);`) with:

```typescript
app.use(express.json());

// ── UI static assets (unauthenticated; bearer auth is on /admin/* only) ────
app.use(express.static(path.join(__dirname, '..', 'public'), {
  index: 'index.html',
  maxAge: '5m',
}));

// ── Public routes (no auth needed) ──────────────────────────────────────────
app.use('/discover', discoverRouter);
```

- [ ] **Step 3: Update Dockerfile to carry public assets**

Open `Dockerfile.admin-api` and change the builder stage's admin-api copy line from:

```dockerfile
COPY packages/admin-api ./packages/admin-api
```

to (no change — `packages/admin-api` already includes `public/` as a subdir). Confirm by checking the final `COPY --from=builder /app/packages ./packages` carries public too. **No edit needed — included for verification only.** Proceed.

- [ ] **Step 4: Update .gitignore**

Open `.gitignore` and append:

```
# Superpowers brainstorm artifacts
.superpowers/

# Admin UI test artifacts
packages/admin-api/test-results/
packages/admin-api/playwright-report/
```

- [ ] **Step 5: Smoke test static serving**

Run:
```bash
cd /Users/tyewolfe/Projects/Nova
npm --workspace=packages/admin-api run build
ADMIN_TOKEN=dev-token REDIS_URL=redis://localhost:6379 node packages/admin-api/dist/index.js &
sleep 1
curl -s http://localhost:3005/ | grep -c "Nova Admin"
kill %1
```

Expected: prints `1` (title tag found). The static middleware serves `index.html` without a bearer token.

- [ ] **Step 6: Commit**

```bash
git add packages/admin-api/public/index.html \
        packages/admin-api/src/index.ts \
        .gitignore
git commit -m "feat(admin-api): mount static UI dir before bearer auth"
```

---

## Task 2: Vendor Alpine.js and qrcode.js

**Files:**
- Create: `packages/admin-api/public/vendor/alpine.min.js`
- Create: `packages/admin-api/public/vendor/qrcode.min.js`
- Modify: `packages/admin-api/public/index.html`

- [ ] **Step 1: Download Alpine 3.14.x**

```bash
cd /Users/tyewolfe/Projects/Nova/packages/admin-api/public
mkdir -p vendor
curl -sSL -o vendor/alpine.min.js https://unpkg.com/alpinejs@3.14.1/dist/cdn.min.js
wc -c vendor/alpine.min.js
```

Expected: file size in the 40-60 KB range.

- [ ] **Step 2: Download qrcode.js (davidshimjs/qrcodejs)**

```bash
curl -sSL -o vendor/qrcode.min.js https://raw.githubusercontent.com/davidshimjs/qrcodejs/04f46c6/qrcode.min.js
wc -c vendor/qrcode.min.js
```

Expected: file size in the 25-35 KB range.

- [ ] **Step 3: Wire vendor scripts into index.html**

Replace the `<main id="app">…</main>` block in `packages/admin-api/public/index.html` with:

```html
<main id="app"><h1 style="color:#fff;padding:2rem">Nova Admin — loading…</h1></main>
<script defer src="/vendor/alpine.min.js"></script>
<script defer src="/vendor/qrcode.min.js"></script>
```

- [ ] **Step 4: Smoke test**

```bash
cd /Users/tyewolfe/Projects/Nova
ADMIN_TOKEN=dev-token REDIS_URL=redis://localhost:6379 node packages/admin-api/dist/index.js &
sleep 1
curl -sI http://localhost:3005/vendor/alpine.min.js | head -1
curl -sI http://localhost:3005/vendor/qrcode.min.js | head -1
kill %1
```

Expected: both `HTTP/1.1 200 OK`.

- [ ] **Step 5: Commit**

```bash
git add packages/admin-api/public/vendor \
        packages/admin-api/public/index.html
git commit -m "feat(admin-ui): vendor Alpine 3.14 and qrcode.js"
```

---

## Task 3: Design tokens + .nova-surface backdrop

**Files:**
- Create: `packages/admin-api/public/styles.css`

- [ ] **Step 1: Write styles.css with tokens + backdrop**

Create `packages/admin-api/public/styles.css`:

```css
:root {
  --space-0: #020409;
  --space-1: #050814;
  --nebula-purple: #a855f7;
  --nebula-violet: #a78bfa;
  --plasma-cyan: #22d3ee;
  --plasma-blue: #3b82f6;
  --signal-ok: #4ade80;
  --signal-warn: #f59e0b;
  --signal-danger: #f87171;
  --ink-bright: #fff;
  --ink: #e5e7eb;
  --ink-muted: #94a3b8;
  --ink-faint: #64748b;
  --glass-bg: rgba(255, 255, 255, 0.03);
  --glass-border: rgba(168, 139, 250, 0.18);

  --font-display: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
  --font-mono: 'SF Mono', ui-monospace, Menlo, monospace;
}

* { box-sizing: border-box; }

html, body { margin: 0; padding: 0; min-height: 100vh; }

body {
  background: var(--space-1);
  color: var(--ink);
  font-family: var(--font-display);
  font-size: 14px;
  line-height: 1.5;
  overflow-x: hidden;
}

/* Mesh gradient + starfield backdrop applied once to <body class="nova-surface"> */
.nova-surface {
  position: relative;
}
.nova-surface::before,
.nova-surface::after {
  content: '';
  position: fixed;
  inset: -20%;
  pointer-events: none;
  z-index: -1;
}
.nova-surface::before {
  background:
    radial-gradient(ellipse 60% 50% at 20% 30%, rgba(168, 85, 247, 0.45), transparent 60%),
    radial-gradient(ellipse 50% 40% at 80% 20%, rgba(34, 211, 238, 0.35), transparent 60%),
    radial-gradient(ellipse 70% 50% at 60% 90%, rgba(59, 130, 246, 0.3), transparent 60%),
    radial-gradient(ellipse 40% 30% at 10% 80%, rgba(236, 72, 153, 0.25), transparent 60%);
  filter: blur(40px);
  animation: nova-drift 14s ease-in-out infinite;
}
.nova-surface::after {
  background-image:
    radial-gradient(1px 1px at 8% 12%, #fff, transparent),
    radial-gradient(1px 1px at 32% 48%, #fff, transparent),
    radial-gradient(1px 1px at 67% 22%, #fff, transparent),
    radial-gradient(1px 1px at 88% 78%, #fff, transparent),
    radial-gradient(1px 1px at 41% 88%, #fff, transparent),
    radial-gradient(2px 2px at 74% 34%, rgba(255, 255, 255, 0.9), transparent);
  opacity: 0.75;
  animation: nova-twinkle 4s ease-in-out infinite;
}

@keyframes nova-drift {
  0%, 100% { transform: translate(0, 0) scale(1); }
  50%      { transform: translate(-20px, -15px) scale(1.05); }
}
@keyframes nova-twinkle {
  0%, 100% { opacity: 0.4; }
  50%      { opacity: 0.9; }
}

@media (prefers-reduced-motion: reduce) {
  .nova-surface::before,
  .nova-surface::after { animation: none; }
}
```

- [ ] **Step 2: Manual smoke test**

Start the server (same command as Task 1 Step 5), open `http://localhost:3005/` in a browser. Expect: dark near-black background with soft colored blobs and faint star dots. Kill the server.

- [ ] **Step 3: Commit**

```bash
git add packages/admin-api/public/styles.css
git commit -m "feat(admin-ui): design tokens and cosmic backdrop"
```

---

## Task 4: Visual primitives — glass, spotlight, cta, planet, pill, modal

**Files:**
- Modify: `packages/admin-api/public/styles.css`

- [ ] **Step 1: Append primitive classes to styles.css**

Append to `packages/admin-api/public/styles.css`:

```css
/* ── Layout ────────────────────────────────────────────────────────────── */
.nova-shell { max-width: 1100px; margin: 0 auto; padding: 32px; position: relative; }
.nova-row   { display: flex; align-items: center; gap: 12px; }
.nova-stack { display: flex; flex-direction: column; gap: 12px; }

/* ── Typography ────────────────────────────────────────────────────────── */
.nova-display {
  font-size: 48px; font-weight: 200; line-height: 1; letter-spacing: -1.5px;
  background: linear-gradient(135deg, #fff 0%, var(--nebula-violet) 40%, var(--plasma-cyan) 80%, #fff 100%);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
  filter: drop-shadow(0 0 24px rgba(168, 139, 250, 0.35));
}
.nova-eyebrow {
  font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase;
  color: var(--plasma-cyan); font-weight: 700;
}
.nova-subtitle { color: var(--ink-muted); font-size: 14px; }
.nova-mono { font-family: var(--font-mono); font-size: 12px; color: var(--ink-muted); }

/* ── Glass panel ───────────────────────────────────────────────────────── */
.nova-glass {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  padding: 16px;
}

/* ── Spotlight (rotating conic border) ─────────────────────────────────── */
.nova-spotlight { position: relative; }
.nova-spotlight::before {
  content: '';
  position: absolute; inset: -1px;
  border-radius: inherit;
  background: conic-gradient(from 0deg, transparent 0deg, rgba(34, 211, 238, 0.6) 40deg, transparent 80deg, transparent 360deg);
  animation: nova-spin 6s linear infinite;
  z-index: -1;
  filter: blur(6px);
  opacity: 0.5;
}
@keyframes nova-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .nova-spotlight::before { animation: none; opacity: 0; }
}

/* ── CTA ───────────────────────────────────────────────────────────────── */
.nova-cta {
  background: linear-gradient(135deg, var(--plasma-cyan) 0%, var(--nebula-purple) 50%, #ec4899 100%);
  color: #fff; border: none; cursor: pointer;
  border-radius: 12px; padding: 12px 22px;
  font-size: 14px; font-weight: 600; letter-spacing: 0.3px;
  display: inline-flex; align-items: center; gap: 8px;
  animation: nova-pulse 3s ease-in-out infinite;
  font-family: inherit;
}
.nova-cta[disabled] { opacity: 0.5; cursor: not-allowed; animation: none; }
@keyframes nova-pulse {
  0%, 100% { box-shadow: 0 0 32px rgba(168, 85, 247, 0.35), 0 0 64px rgba(34, 211, 238, 0.15); }
  50%      { box-shadow: 0 0 56px rgba(168, 85, 247, 0.55), 0 0 120px rgba(34, 211, 238, 0.25); }
}
@media (prefers-reduced-motion: reduce) {
  .nova-cta { animation: none; box-shadow: 0 0 32px rgba(168, 85, 247, 0.35); }
}

/* ── Planet (stable color circle) ──────────────────────────────────────── */
.nova-planet {
  width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0;
  background: radial-gradient(circle at 30% 30%, var(--planet-light, var(--plasma-cyan)), var(--planet-dark, #0e7490));
  box-shadow: 0 0 20px var(--planet-glow, rgba(34, 211, 238, 0.4));
}
.nova-planet-lg { width: 56px; height: 56px; }

/* ── Pill ──────────────────────────────────────────────────────────────── */
.nova-pill {
  display: inline-block; padding: 4px 10px; border-radius: 6px;
  font-size: 10px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase;
  border: 1px solid currentColor;
}
.nova-pill-pending { color: var(--plasma-cyan);   background: rgba(34, 211, 238, 0.15); }
.nova-pill-active  { color: var(--signal-ok);     background: rgba(74, 222, 128, 0.15); }
.nova-pill-danger  { color: var(--signal-danger); background: rgba(248, 113, 113, 0.15); }

/* ── Form controls ─────────────────────────────────────────────────────── */
.nova-input {
  width: 100%;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  padding: 11px 14px;
  color: var(--ink);
  font-size: 14px;
  font-family: inherit;
}
.nova-input:focus { outline: none; border-color: var(--plasma-cyan); }
.nova-input.is-error { border-color: var(--signal-danger); animation: nova-shake 0.4s ease-out; }
@keyframes nova-shake {
  0%, 100% { transform: translateX(0); }
  25%      { transform: translateX(-6px); }
  75%      { transform: translateX(6px); }
}
@media (prefers-reduced-motion: reduce) {
  .nova-input.is-error { animation: none; }
}
.nova-label {
  display: block; margin-bottom: 6px;
  font-size: 10px; letter-spacing: 2px; text-transform: uppercase;
  color: var(--plasma-cyan); font-weight: 600;
}
.nova-error { color: var(--signal-danger); font-size: 12px; margin-top: 4px; }

/* ── Modal ─────────────────────────────────────────────────────────────── */
.nova-modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(2, 4, 9, 0.75); backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  z-index: 100; padding: 32px;
}
.nova-modal {
  max-width: 520px; width: 100%;
  background: radial-gradient(ellipse at top right, #1a0b3d 0%, #050814 70%);
  border: 1px solid var(--glass-border);
  border-radius: 16px; padding: 28px;
  max-height: calc(100vh - 64px); overflow-y: auto;
}

/* ── Toast ─────────────────────────────────────────────────────────────── */
.nova-toast-stack {
  position: fixed; bottom: 24px; right: 24px;
  display: flex; flex-direction: column; gap: 8px;
  z-index: 200;
}
.nova-toast {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  backdrop-filter: blur(12px);
  border-radius: 10px; padding: 12px 16px;
  color: var(--ink); font-size: 13px;
  min-width: 240px; max-width: 360px;
}
.nova-toast.is-err { border-color: rgba(248, 113, 113, 0.4); }
.nova-toast.is-ok  { border-color: rgba(74, 222, 128, 0.4); }
```

- [ ] **Step 2: Commit**

```bash
git add packages/admin-api/public/styles.css
git commit -m "feat(admin-ui): reusable glass, spotlight, cta, planet, pill primitives"
```

---

## Task 5: utils.js — slug→color hash and TTL humanizer (TDD)

**Files:**
- Create: `packages/admin-api/vitest.config.ts`
- Create: `packages/admin-api/test/public/utils.test.js`
- Create: `packages/admin-api/public/js/utils.js`
- Modify: `packages/admin-api/package.json`

- [ ] **Step 1: Add vitest + jsdom devDeps and test script**

Replace `packages/admin-api/package.json` entirely with:

```json
{
  "name": "@nova/admin-api",
  "version": "1.0.0",
  "private": true,
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@nova/shared": "*",
    "@nova/task-queue": "*",
    "@ucans/ucans": "^0.12.0",
    "express": "^4.18.0",
    "ioredis": "^5.0.0",
    "prom-client": "^15.0.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.0",
    "@types/node": "^22.0.0",
    "@playwright/test": "^1.44.0",
    "jsdom": "^24.0.0",
    "typescript": "^5.4.0",
    "tsx": "^4.7.0",
    "vitest": "^1.5.0"
  },
  "exports": {
    ".": "./dist/index.js",
    "./src/*": "./dist/*.js"
  }
}
```

Then install:
```bash
cd /Users/tyewolfe/Projects/Nova
npm install
```

- [ ] **Step 2: Create vitest config**

Create `packages/admin-api/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/public/**/*.test.js'],
    globals: true,
  },
});
```

- [ ] **Step 3: Write failing tests**

Create `packages/admin-api/test/public/utils.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { slugColor, humanizeTtl } from '../../public/js/utils.js';

describe('slugColor', () => {
  it('returns the same colors for the same slug', () => {
    const a = slugColor('acme-corp');
    const b = slugColor('acme-corp');
    expect(a).toEqual(b);
  });

  it('returns different colors for different slugs', () => {
    expect(slugColor('acme-corp')).not.toEqual(slugColor('helios'));
  });

  it('returns light, dark, and glow CSS strings', () => {
    const c = slugColor('demo');
    expect(c.light).toMatch(/^hsl\(/);
    expect(c.dark).toMatch(/^hsl\(/);
    expect(c.glow).toMatch(/^rgba\(/);
  });
});

describe('humanizeTtl', () => {
  it('formats common presets', () => {
    expect(humanizeTtl(3600)).toBe('1h');
    expect(humanizeTtl(86400)).toBe('24h');
    expect(humanizeTtl(7 * 86400)).toBe('7d');
  });

  it('formats custom values', () => {
    expect(humanizeTtl(90)).toBe('90s');
    expect(humanizeTtl(600)).toBe('10m');
    expect(humanizeTtl(2 * 86400)).toBe('2d');
  });
});
```

- [ ] **Step 4: Run tests — expect fail**

```bash
cd /Users/tyewolfe/Projects/Nova
npm --workspace=packages/admin-api run test
```

Expected: fails with "Failed to resolve import" or "slugColor is not a function".

- [ ] **Step 5: Implement utils.js**

Create `packages/admin-api/public/js/utils.js`:

```javascript
// FNV-1a 32-bit hash for stable slug→hue derivation.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h;
}

export function slugColor(slug) {
  const hue = fnv1a(slug) % 360;
  return {
    light: `hsl(${hue}, 85%, 65%)`,
    dark:  `hsl(${hue}, 70%, 25%)`,
    glow:  `rgba(${hslToRgb(hue, 0.85, 0.65).join(',')}, 0.4)`,
  };
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r, g, b;
  if      (h < 60)  [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else              [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export function humanizeTtl(seconds) {
  if (seconds >= 86400 && seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds >= 3600  && seconds % 3600 === 0)  return `${seconds / 3600}h`;
  if (seconds >= 60    && seconds % 60 === 0)    return `${seconds / 60}m`;
  return `${seconds}s`;
}
```

- [ ] **Step 6: Run tests — expect pass**

```bash
npm --workspace=packages/admin-api run test
```

Expected: 5 tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/admin-api/package.json \
        packages/admin-api/vitest.config.ts \
        packages/admin-api/test/public/utils.test.js \
        packages/admin-api/public/js/utils.js \
        package-lock.json
git commit -m "feat(admin-ui): slug→color hash and TTL humanizer"
```

---

## Task 6: api.js — fetch wrapper with TDD

**Files:**
- Create: `packages/admin-api/test/public/api.test.js`
- Create: `packages/admin-api/public/js/api.js`

- [ ] **Step 1: Write failing tests**

Create `packages/admin-api/test/public/api.test.js`:

```javascript
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
```

- [ ] **Step 2: Run — expect fail**

```bash
npm --workspace=packages/admin-api run test
```

Expected: new tests fail (module not found).

- [ ] **Step 3: Implement api.js**

Create `packages/admin-api/public/js/api.js`:

```javascript
const TOKEN_KEY = 'nova_admin_token';
const TIMEOUT_MS = 3000;

let unauthorizedHandler = null;

export function setToken(t)     { sessionStorage.setItem(TOKEN_KEY, t); }
export function getToken()       { return sessionStorage.getItem(TOKEN_KEY); }
export function clearToken()     { sessionStorage.removeItem(TOKEN_KEY); }
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
```

- [ ] **Step 4: Run — expect pass**

```bash
npm --workspace=packages/admin-api run test
```

Expected: all tests (utils + api) pass.

- [ ] **Step 5: Commit**

```bash
git add packages/admin-api/test/public/api.test.js \
        packages/admin-api/public/js/api.js
git commit -m "feat(admin-ui): api.js fetch wrapper with 401 boot and timeout"
```

---

## Task 7: Alpine app shell + hash routing + login screen

**Files:**
- Create: `packages/admin-api/public/js/app.js`
- Modify: `packages/admin-api/public/index.html`

- [ ] **Step 1: Write app.js**

Create `packages/admin-api/public/js/app.js`:

```javascript
import { api, setToken, clearToken, getToken, onUnauthorized } from './api.js';
import { slugColor, humanizeTtl } from './utils.js';

window.novaApp = function () {
  return {
    token: getToken() || '',
    loginValue: '',
    loginError: '',
    loginBusy: false,
    route: parseRoute(),
    galaxies: [],
    currentGalaxy: null,
    agents: [],
    pendingAgents: [],
    invites: [],
    showCreateGalaxy: false,
    showCreateInvite: false,
    revealedInvite: null,     // { token, jti, expiresAt }
    approveTarget: null,      // agentId pending approval
    toasts: [],
    sse: null,

    init() {
      onUnauthorized(() => {
        this.token = '';
        location.hash = '';
        this.route = parseRoute();
        this.pushToast('Session ended', 'err');
      });
      window.addEventListener('hashchange', () => {
        this.route = parseRoute();
        this.routeLoad();
      });
      if (this.token) { this.routeLoad(); this.connectSse(); }
    },

    async login() {
      this.loginBusy = true; this.loginError = '';
      try {
        setToken(this.loginValue.trim());
        await api('GET', '/admin/tenants');
        this.token = this.loginValue.trim();
        this.loginValue = '';
        this.routeLoad();
        this.connectSse();
      } catch (e) {
        clearToken();
        this.token = '';
        if (e.name === 'AbortError') this.loginError = 'Admin API unreachable.';
        else if (e.status === 401)   this.loginError = 'Invalid token.';
        else                         this.loginError = e.message || 'Login failed.';
      } finally {
        this.loginBusy = false;
      }
    },

    logout() {
      clearToken();
      this.token = '';
      if (this.sse) { this.sse.close(); this.sse = null; }
      location.hash = '';
      this.route = parseRoute();
    },

    async routeLoad() {
      if (!this.token) return;
      if (this.route.name === 'home')          await this.loadGalaxies();
      if (this.route.name === 'galaxy')        await this.loadGalaxy(this.route.slug);
    },

    async loadGalaxies() {
      try { this.galaxies = await api('GET', '/admin/tenants'); }
      catch (e) { this.pushToast(e.message || 'Load failed', 'err'); }
    },

    async loadGalaxy(slug) {
      try {
        // tenantId == slug in this build (slug is unique; service uses slug as id)
        this.currentGalaxy = await api('GET', `/admin/tenants/${encodeURIComponent(slug)}`);
        this.agents = await api('GET', `/admin/tenants/${encodeURIComponent(slug)}/agents`);
        this.pendingAgents = this.agents.filter(a => a.status === 'pending');
      } catch (e) {
        if (e.status === 404) this.currentGalaxy = null;
        else this.pushToast(e.message || 'Load failed', 'err');
      }
    },

    async createGalaxy(form) {
      try {
        const t = await api('POST', '/admin/tenants', form);
        this.showCreateGalaxy = false;
        location.hash = `#/galaxy/${encodeURIComponent(t.slug)}`;
        this.pushToast(`Galaxy "${t.slug}" forged`, 'ok');
      } catch (e) { throw e; }
    },

    async createInvite(form) {
      const id = this.currentGalaxy.tenantId || this.currentGalaxy.slug;
      const res = await api('POST', `/admin/tenants/${encodeURIComponent(id)}/invites`, form);
      this.revealedInvite = res;
      this.showCreateInvite = false;
    },

    dismissReveal() { this.revealedInvite = null; },

    async approve(agentId, form) {
      const id = this.currentGalaxy.tenantId || this.currentGalaxy.slug;
      try {
        const res = await api('POST', `/admin/tenants/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}/approve`, form);
        this.approveTarget = null;
        this.pushToast(`UCAN issued · ${res.ucan.cid.slice(0, 12)}…`, 'ok');
        await this.loadGalaxy(this.route.slug);
      } catch (e) { this.pushToast(e.message || 'Approval failed', 'err'); }
    },

    async reject(agentId) {
      const id = this.currentGalaxy.tenantId || this.currentGalaxy.slug;
      if (!confirm(`Reject ${agentId}? This cannot be undone.`)) return;
      try {
        await api('POST', `/admin/tenants/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}/reject`);
        this.pushToast('Planet rejected', 'ok');
        await this.loadGalaxy(this.route.slug);
      } catch (e) { this.pushToast(e.message || 'Reject failed', 'err'); }
    },

    connectSse() {
      let attempt = 0;
      const open = () => {
        // Pass token via query param — EventSource has no header API.
        // admin-api accepts the token on the bearer header only today; this
        // path relies on the same-origin cookie being absent and token-in-URL
        // is a known gap (tracked in roadmap: "Caddy reverse-proxy auth").
        // For v1 (localhost-only), we rely on the unauthenticated /admin/events
        // mount by wrapping it inline — see index.ts change.
        this.sse = new EventSource('/admin/events');
        this.sse.addEventListener('agent', (ev) => this.handleSseAgent(ev));
        this.sse.addEventListener('tenant', (ev) => this.handleSseTenant(ev));
        this.sse.onopen = () => { attempt = 0; };
        this.sse.onerror = () => {
          this.sse.close();
          const delay = Math.min(30000, 1000 * Math.pow(2, attempt++));
          setTimeout(open, delay);
        };
      };
      open();
    },

    handleSseAgent(ev) {
      if (!this.currentGalaxy) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.tenantId && (msg.tenantId === this.currentGalaxy.tenantId || msg.tenantId === this.currentGalaxy.slug)) {
          this.loadGalaxy(this.route.slug);
        }
      } catch {}
    },
    handleSseTenant(ev) { this.loadGalaxies(); },

    pushToast(text, kind = 'ok') {
      const id = Math.random().toString(36).slice(2);
      this.toasts.push({ id, text, kind });
      setTimeout(() => { this.toasts = this.toasts.filter(t => t.id !== id); }, 4000);
    },

    planetStyle(slug) {
      const c = slugColor(slug || 'x');
      return `--planet-light:${c.light};--planet-dark:${c.dark};--planet-glow:${c.glow}`;
    },
    humanizeTtl,
  };
};

function parseRoute() {
  const h = location.hash.replace(/^#/, '');
  const galaxyApprove = h.match(/^\/galaxy\/([^/]+)\/approve\/([^/]+)$/);
  if (galaxyApprove) return { name: 'galaxy', slug: decodeURIComponent(galaxyApprove[1]), approve: decodeURIComponent(galaxyApprove[2]) };
  const galaxy = h.match(/^\/galaxy\/([^/]+)$/);
  if (galaxy) return { name: 'galaxy', slug: decodeURIComponent(galaxy[1]) };
  return { name: 'home' };
}
```

**Note on SSE and auth:** EventSource cannot send an Authorization header. For v1 (local-dev, Caddy in front), we mount `/admin/events` *before* the bearer middleware in Task 9. The roadmap's "Caddy reverse-proxy auth" item promotes this to a trusted-header model.

- [ ] **Step 2: Replace index.html body with login-only shell**

Replace `packages/admin-api/public/index.html` entirely with:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:">
  <title>Nova Admin</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="nova-surface" x-data="novaApp()" x-init="init()">
  <main class="nova-shell">

    <!-- LOGIN -->
    <section x-show="!token" x-cloak style="max-width:420px;margin-top:12vh">
      <div class="nova-eyebrow">◉ NOVA · ADMIN</div>
      <h1 class="nova-display" style="margin:12px 0 6px">Enter the console.</h1>
      <p class="nova-subtitle" style="margin-bottom:24px">Bearer token required. Stored in this tab only.</p>
      <form @submit.prevent="login()">
        <label class="nova-label" for="admintok">admin token</label>
        <div class="nova-spotlight" style="border-radius:10px">
          <input id="admintok" class="nova-input" :class="loginError ? 'is-error' : ''"
                 type="password" autocomplete="off" x-model="loginValue" required>
        </div>
        <p class="nova-error" x-show="loginError" x-text="loginError"></p>
        <div style="margin-top:20px">
          <button class="nova-cta" :disabled="loginBusy || !loginValue">
            <span x-text="loginBusy ? 'Probing…' : 'Enter'"></span>
            <span>→</span>
          </button>
        </div>
      </form>
    </section>

    <!-- placeholder for authenticated views (filled by later tasks) -->
    <section x-show="token" x-cloak>
      <div class="nova-row" style="justify-content:space-between;margin-bottom:24px">
        <div class="nova-eyebrow">◉ NOVA · ADMIN</div>
        <button class="nova-input" style="width:auto;padding:6px 12px;font-size:12px" @click="logout()">Log out</button>
      </div>
      <p class="nova-subtitle">Authenticated. Screens land in following tasks.</p>
    </section>

    <!-- Toasts -->
    <div class="nova-toast-stack">
      <template x-for="t in toasts" :key="t.id">
        <div class="nova-toast" :class="t.kind === 'err' ? 'is-err' : 'is-ok'" x-text="t.text"></div>
      </template>
    </div>

  </main>

  <script type="module" src="/js/app.js"></script>
  <script defer src="/vendor/alpine.min.js"></script>
  <script defer src="/vendor/qrcode.min.js"></script>
  <style>[x-cloak]{display:none!important}</style>
</body>
</html>
```

- [ ] **Step 3: Manual smoke test**

Rebuild and start admin-api (same command as Task 1 Step 5). Open `http://localhost:3005/`. Expect: login form. Submit empty → HTML5 validation. Submit wrong token → inline "Invalid token." Submit the real `$ADMIN_TOKEN` → authenticated placeholder view. Log out → back to login.

- [ ] **Step 4: Commit**

```bash
git add packages/admin-api/public/js/app.js \
        packages/admin-api/public/index.html
git commit -m "feat(admin-ui): Alpine shell, hash routing, login screen"
```

---

## Task 8: Galaxies home screen

**Files:**
- Modify: `packages/admin-api/public/index.html`

- [ ] **Step 1: Replace the authenticated placeholder with galaxies home**

In `packages/admin-api/public/index.html`, replace the existing `<section x-show="token" x-cloak>…</section>` block (the authenticated placeholder) with:

```html
<section x-show="token" x-cloak>
  <div class="nova-row" style="justify-content:space-between;margin-bottom:24px">
    <div class="nova-eyebrow">◉ NOVA · ADMIN</div>
    <button class="nova-input" style="width:auto;padding:6px 12px;font-size:12px" @click="logout()">Log out</button>
  </div>

  <!-- HOME: Galaxies -->
  <template x-if="route.name === 'home'">
    <div>
      <h1 class="nova-display" style="margin:0 0 6px">Galaxies</h1>
      <p class="nova-subtitle" style="margin-bottom:24px" x-text="`${galaxies.length} tenant${galaxies.length === 1 ? '' : 's'} orbiting Nova`"></p>

      <div class="nova-stack">
        <template x-for="g in galaxies" :key="g.tenantId || g.slug">
          <a class="nova-glass nova-row" :href="`#/galaxy/${g.slug}`" style="text-decoration:none;color:inherit">
            <div class="nova-planet" :style="planetStyle(g.slug)"></div>
            <div style="flex:1">
              <div style="font-weight:500;color:#fff" x-text="g.name"></div>
              <div class="nova-mono" x-text="g.slug"></div>
            </div>
            <span class="nova-pill" :class="g.status === 'active' ? 'nova-pill-active' : 'nova-pill-danger'" x-text="g.status || 'unknown'"></span>
          </a>
        </template>
        <div x-show="galaxies.length === 0" class="nova-glass" style="text-align:center;color:var(--ink-muted)">
          No galaxies yet.
        </div>
      </div>

      <div style="margin-top:28px">
        <button class="nova-cta" @click="showCreateGalaxy = true">
          <span>+ New galaxy</span>
        </button>
      </div>
    </div>
  </template>
</section>
```

- [ ] **Step 2: Manual smoke test**

With admin-api running and at least one tenant already present (or create one via the existing `seed-tenant` script to test), refresh the page. Expect: galaxy list renders with a colored disc per galaxy; colors are stable across reloads.

- [ ] **Step 3: Commit**

```bash
git add packages/admin-api/public/index.html
git commit -m "feat(admin-ui): galaxies home list with stable planet colors"
```

---

## Task 9: Create-galaxy modal

**Files:**
- Modify: `packages/admin-api/public/index.html`
- Modify: `packages/admin-api/src/index.ts`

- [ ] **Step 1: Mount /admin/events before auth middleware**

EventSource can't send a bearer header. For v1, mount the SSE route *before* `adminAuth`. Open `packages/admin-api/src/index.ts`. Find the block:

```typescript
// ── Authenticated routes ────────────────────────────────────────────────────
app.use('/admin', adminAuth);
```

Insert *before* that block:

```typescript
// ── SSE events (unauthenticated in v1; see admin-ui roadmap) ───────────────
app.use('/admin/events', eventsRouter);
```

Then delete the now-duplicate line further down:

```typescript
app.use('/admin/events', eventsRouter);
```

- [ ] **Step 2: Add create-galaxy modal to index.html**

Inside the `<section x-show="token">` block, immediately after the closing `</template>` for the home view, add:

```html
<!-- CREATE GALAXY MODAL -->
<template x-if="showCreateGalaxy">
  <div class="nova-modal-backdrop" @click.self="showCreateGalaxy = false">
    <div class="nova-modal" x-data="{ slug: '', name: '', plan: 'developer', err: '', busy: false, fieldErrs: {} }">
      <div class="nova-eyebrow">◉ NEW GALAXY</div>
      <h2 class="nova-display" style="font-size:32px;margin:8px 0 20px">Forge a galaxy.</h2>

      <label class="nova-label" for="g-slug">slug</label>
      <input id="g-slug" class="nova-input" :class="fieldErrs.slug ? 'is-error' : ''" x-model="slug" placeholder="acme-corp" pattern="[a-z0-9-]+">
      <p class="nova-error" x-show="fieldErrs.slug" x-text="fieldErrs.slug"></p>

      <label class="nova-label" for="g-name" style="margin-top:14px">display name</label>
      <input id="g-name" class="nova-input" :class="fieldErrs.name ? 'is-error' : ''" x-model="name" placeholder="ACME Corp">
      <p class="nova-error" x-show="fieldErrs.name" x-text="fieldErrs.name"></p>

      <label class="nova-label" for="g-plan" style="margin-top:14px">plan</label>
      <select id="g-plan" class="nova-input" x-model="plan">
        <option value="developer">Developer</option>
        <option value="pro">Pro</option>
        <option value="enterprise">Enterprise</option>
      </select>

      <p class="nova-error" x-show="err" x-text="err" style="margin-top:12px"></p>

      <div class="nova-row" style="margin-top:24px;justify-content:flex-end;gap:10px">
        <button class="nova-input" style="width:auto;padding:10px 16px" @click="showCreateGalaxy = false" :disabled="busy">Cancel</button>
        <button class="nova-cta" @click="async () => {
          busy = true; err = ''; fieldErrs = {};
          try { await createGalaxy({ slug, name, plan }); }
          catch (e) {
            if (e.details && e.details.length) {
              for (const d of e.details) fieldErrs[d.field] = d.message;
            } else { err = e.message || 'Create failed'; }
          } finally { busy = false; }
        }" :disabled="busy || !slug || !name">
          <span x-text="busy ? 'Forging…' : 'Forge galaxy'"></span><span>→</span>
        </button>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 3: Rebuild admin-api and smoke test**

```bash
cd /Users/tyewolfe/Projects/Nova
npm --workspace=packages/admin-api run build
# restart admin-api
```

Open the UI, click "+ New galaxy", submit an invalid slug like `ACME Corp` → inline field error. Submit valid values → route changes to `#/galaxy/<slug>` (the next task renders that screen; for now it's empty but the URL should update).

- [ ] **Step 4: Commit**

```bash
git add packages/admin-api/public/index.html \
        packages/admin-api/src/index.ts
git commit -m "feat(admin-ui): create-galaxy modal with inline validation"
```

---

## Task 10: Galaxy detail screen — header, agents list, invites section stub

**Files:**
- Modify: `packages/admin-api/public/index.html`

- [ ] **Step 1: Add galaxy-detail template**

Inside `<section x-show="token">`, after the home `<template x-if="route.name === 'home'">…</template>`, add:

```html
<!-- GALAXY DETAIL -->
<template x-if="route.name === 'galaxy'">
  <div>
    <a href="#/" class="nova-mono" style="color:var(--ink-muted);text-decoration:none">← All galaxies</a>

    <template x-if="currentGalaxy">
      <div style="margin-top:16px">
        <div class="nova-row" style="gap:20px;align-items:flex-start">
          <div class="nova-planet nova-planet-lg" :style="planetStyle(currentGalaxy.slug)" style="margin-top:8px"></div>
          <div style="flex:1">
            <div class="nova-eyebrow" x-text="'◉ GALAXY · ' + currentGalaxy.slug"></div>
            <h1 class="nova-display" style="font-size:40px;margin:6px 0" x-text="currentGalaxy.name"></h1>
            <div class="nova-mono" x-text="currentGalaxy.did || '(no DID)'"></div>
            <div class="nova-mono" style="margin-top:4px" x-text="`plan: ${currentGalaxy.plan} · messages/day: ${currentGalaxy.quotas?.messagesPerDay ?? '—'} · agents max: ${currentGalaxy.quotas?.agentsMax ?? '—'}`"></div>
          </div>
        </div>

        <!-- Pending planets -->
        <h2 class="nova-display" style="font-size:24px;margin:40px 0 14px">Pending planets</h2>
        <div class="nova-stack">
          <template x-for="a in pendingAgents" :key="a.agentId">
            <div class="nova-glass nova-row">
              <div class="nova-planet" :style="planetStyle(a.agentId)"></div>
              <div style="flex:1">
                <div style="color:#fff;font-weight:500" x-text="a.agentId"></div>
                <div class="nova-mono" x-text="a.did || '(no DID)'"></div>
                <div class="nova-mono" x-text="(a.skills || []).map(s => s.id).join(', ')"></div>
              </div>
              <span class="nova-pill nova-pill-pending">Pending</span>
              <button class="nova-cta" style="padding:8px 14px" @click="approveTarget = a">Approve</button>
              <button class="nova-input" style="width:auto;padding:8px 14px" @click="reject(a.agentId)">Reject</button>
            </div>
          </template>
          <div x-show="pendingAgents.length === 0" class="nova-glass" style="text-align:center;color:var(--ink-muted)">
            No pending planets. Issue an invite below.
          </div>
        </div>

        <!-- Invite trigger (reveal is separate overlay) -->
        <h2 class="nova-display" style="font-size:24px;margin:40px 0 14px">Invites</h2>
        <button class="nova-cta" @click="showCreateInvite = true">
          <span>+ Issue invite</span>
        </button>
      </div>
    </template>

    <template x-if="!currentGalaxy">
      <div class="nova-glass" style="margin-top:32px;text-align:center;color:var(--ink-muted)">
        Galaxy not found.
      </div>
    </template>
  </div>
</template>
```

- [ ] **Step 2: Smoke test**

Navigate to an existing galaxy (seed-tenant has created one before; use `http://localhost:3005/#/galaxy/tenant_seed_123` if you ran `npm run seed-tenant`). Expect: detail screen renders header, DID, and a "no pending planets" empty state.

- [ ] **Step 3: Commit**

```bash
git add packages/admin-api/public/index.html
git commit -m "feat(admin-ui): galaxy detail with header and pending-planet scaffold"
```

---

## Task 11: Create-invite panel + one-time token reveal with QR

**Files:**
- Modify: `packages/admin-api/public/index.html`

- [ ] **Step 1: Add create-invite modal and reveal screen**

Inside `<section x-show="token">`, add after the galaxy-detail template:

```html
<!-- CREATE INVITE MODAL -->
<template x-if="showCreateInvite">
  <div class="nova-modal-backdrop" @click.self="showCreateInvite = false">
    <div class="nova-modal" x-data="{ hint: '', ttl: 86400, note: '', err: '', busy: false }">
      <div class="nova-eyebrow">◉ NEW INVITE</div>
      <h2 class="nova-display" style="font-size:28px;margin:8px 0 20px">Invite a planet.</h2>

      <label class="nova-label" for="i-hint">agent id hint (optional)</label>
      <input id="i-hint" class="nova-input" x-model="hint" placeholder="agent_alpha" pattern="[a-z0-9_-]+">

      <label class="nova-label" for="i-ttl" style="margin-top:14px">ttl</label>
      <select id="i-ttl" class="nova-input" x-model.number="ttl">
        <option :value="3600">1 hour</option>
        <option :value="86400">24 hours</option>
        <option :value="7 * 86400">7 days</option>
      </select>

      <label class="nova-label" for="i-note" style="margin-top:14px">note (optional)</label>
      <input id="i-note" class="nova-input" x-model="note" placeholder="e.g. shared with ops team">

      <p class="nova-error" x-show="err" x-text="err" style="margin-top:12px"></p>

      <div class="nova-row" style="margin-top:24px;justify-content:flex-end;gap:10px">
        <button class="nova-input" style="width:auto;padding:10px 16px" @click="showCreateInvite = false" :disabled="busy">Cancel</button>
        <button class="nova-cta" @click="async () => {
          busy = true; err = '';
          try { await createInvite({ agentIdHint: hint || undefined, ttlSeconds: ttl, note: note || undefined }); }
          catch (e) { err = (e.details && e.details[0]?.message) || e.message || 'Invite failed'; }
          finally { busy = false; }
        }" :disabled="busy">
          <span x-text="busy ? 'Issuing…' : 'Issue invite'"></span><span>→</span>
        </button>
      </div>
    </div>
  </div>
</template>

<!-- INVITE ONE-TIME REVEAL -->
<template x-if="revealedInvite">
  <div class="nova-modal-backdrop" @click.self="dismissReveal()">
    <div class="nova-modal" x-data="{ copied: false }" x-init="$nextTick(() => { const el = $refs.qr; el.innerHTML=''; new QRCode(el, { text: revealedInvite.token, width: 180, height: 180, colorDark: '#fff', colorLight: '#050814' }); })">
      <div class="nova-eyebrow" style="color:var(--signal-warn)">◉ ONE-TIME TOKEN</div>
      <h2 class="nova-display" style="font-size:26px;margin:8px 0 8px">Share this now.</h2>
      <p class="nova-subtitle" style="margin-bottom:20px">This token is shown once. Save it or hand it to the planet operator now — a refresh will lose it.</p>

      <div x-ref="qr" style="display:flex;justify-content:center;margin-bottom:18px"></div>

      <div class="nova-glass nova-mono" style="word-break:break-all;font-size:11px;padding:12px" x-text="revealedInvite.token"></div>

      <div class="nova-mono" style="margin-top:10px" x-text="`jti: ${revealedInvite.jti} · expires: ${new Date(revealedInvite.expiresAt).toLocaleString()}`"></div>

      <div class="nova-row" style="margin-top:24px;justify-content:flex-end;gap:10px">
        <button class="nova-input" style="width:auto;padding:10px 16px" @click="navigator.clipboard.writeText(revealedInvite.token); copied = true; setTimeout(() => copied = false, 2000)">
          <span x-text="copied ? 'Copied ✓' : 'Copy token'"></span>
        </button>
        <button class="nova-cta" @click="dismissReveal()">
          <span>Dismiss</span>
        </button>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Smoke test**

In the galaxy detail, click "+ Issue invite", submit. Expect: modal closes, reveal modal opens with QR code, JWT body, jti + expires. Copy button flashes "Copied ✓". Dismiss clears.

- [ ] **Step 3: Commit**

```bash
git add packages/admin-api/public/index.html
git commit -m "feat(admin-ui): create-invite panel and one-time reveal with QR"
```

---

## Task 12: Verify SSE live-update path

**Files:**
- none (validation only — SSE code already landed in Tasks 7 + 9)

- [ ] **Step 1: Start full stack**

```bash
cd /Users/tyewolfe/Projects/Nova
docker compose up -d redis
ADMIN_TOKEN=dev-token REDIS_URL=redis://localhost:6379 npm --workspace=packages/admin-api run dev &
sleep 2
```

- [ ] **Step 2: Open the UI, enter a galaxy detail**

Paste `dev-token`, navigate to any galaxy (e.g. `#/galaxy/tenant_seed_123` if seeded).

- [ ] **Step 3: Publish a fake lifecycle event and watch the UI react**

In a separate terminal:

```bash
redis-cli PUBLISH nova:lifecycle:agent '{"event":"agent.registered","tenantId":"tenant_seed_123","agentId":"test_live","status":"pending","did":"did:key:zTest","skills":[{"id":"s1"}]}'
```

Expected: browser devtools network tab shows EventSource stream still open; the pending-planets section re-renders (via `loadGalaxy`). If admin-api doesn't actually add "test_live" to the agents list, that's fine — we only need to confirm the SSE handler fires (check console for `handleSseAgent` triggering by adding a temporary `console.log` during dev; remove it after).

- [ ] **Step 4: Kill admin-api, confirm reconnect**

```bash
kill %1  # stop admin-api
```

Browser: the EventSource will error and back off. Restart admin-api:

```bash
ADMIN_TOKEN=dev-token REDIS_URL=redis://localhost:6379 npm --workspace=packages/admin-api run dev &
```

Within ~30s the EventSource reconnects (devtools Network tab shows the `events` request re-establishing).

- [ ] **Step 5: Commit nothing; this task is validation only**

No code changes; the commit from Task 7 already contains the SSE handler and Task 9 mounted `/admin/events` before auth. If a `console.log` was added for debugging, remove it before leaving this task.

---

## Task 13: Approve modal

**Files:**
- Modify: `packages/admin-api/public/index.html`

- [ ] **Step 1: Add approve modal driven by `approveTarget`**

Inside `<section x-show="token">`, after the invite-reveal template, add:

```html
<!-- APPROVE MODAL -->
<template x-if="approveTarget">
  <div class="nova-modal-backdrop" @click.self="approveTarget = null">
    <div class="nova-modal" x-data="{
      tier: 1, allowedSkillsRaw: '*', expiry: 30, notes: '',
      busy: false, err: ''
    }" x-init="allowedSkillsRaw = (approveTarget.skills || []).map(s => s.id).join(', ') || '*'">
      <div class="nova-eyebrow">◉ APPROVE PLANET</div>
      <h2 class="nova-display" style="font-size:26px;margin:8px 0 6px" x-text="approveTarget.agentId"></h2>
      <div class="nova-mono" style="margin-bottom:20px" x-text="approveTarget.did"></div>

      <label class="nova-label" for="a-tier">trust tier (1-3)</label>
      <select id="a-tier" class="nova-input" x-model.number="tier">
        <option :value="1">1 — basic</option>
        <option :value="2">2 — elevated</option>
        <option :value="3">3 — full</option>
      </select>

      <label class="nova-label" for="a-skills" style="margin-top:14px">allowed skills (comma-separated, or *)</label>
      <input id="a-skills" class="nova-input" x-model="allowedSkillsRaw" placeholder="query_knowledge, request_summary">

      <label class="nova-label" for="a-exp" style="margin-top:14px">ucan expiry (days)</label>
      <input id="a-exp" class="nova-input" type="number" min="1" max="365" x-model.number="expiry">

      <label class="nova-label" for="a-notes" style="margin-top:14px">notes (optional)</label>
      <input id="a-notes" class="nova-input" x-model="notes">

      <p class="nova-error" x-show="err" x-text="err" style="margin-top:12px"></p>

      <div class="nova-row" style="margin-top:24px;justify-content:flex-end;gap:10px">
        <button class="nova-input" style="width:auto;padding:10px 16px" @click="approveTarget = null" :disabled="busy">Cancel</button>
        <button class="nova-cta" @click="async () => {
          busy = true; err = '';
          const skills = allowedSkillsRaw.split(',').map(s => s.trim()).filter(Boolean);
          try { await approve(approveTarget.agentId, { trustTier: tier, allowedSkills: skills, ucanExpiryDays: expiry, notes: notes || undefined }); }
          catch (e) { err = e.message || 'Approval failed'; }
          finally { busy = false; }
        }" :disabled="busy">
          <span x-text="busy ? 'Approving…' : 'Approve'"></span><span>→</span>
        </button>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Smoke test**

With a pending agent present (run `self-register` via curl in another terminal against a fresh invite; see Task 20's playbook), click Approve in the UI. Expect: modal opens preloaded with the agent's skills, tier 1, expiry 30. Submit → UCAN toast fires, agent moves out of pending list.

- [ ] **Step 3: Commit**

```bash
git add packages/admin-api/public/index.html
git commit -m "feat(admin-ui): approve modal with tier, skills, expiry"
```

---

## Task 14: Logout, CSP tightening, and final index.html polish

**Files:**
- Modify: `packages/admin-api/public/index.html`

- [ ] **Step 1: Verify CSP meta tag already present**

The index.html from Task 7 already has:

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:">
```

This allows: self-origin everything, inline styles (Alpine needs them on elements), and data URIs for the QR code canvas. **No edit needed unless missing — proceed.**

- [ ] **Step 2: Kinetic status ticker (optional polish)**

Above `<main class="nova-shell">` in `index.html`, add:

```html
<div x-show="token" x-cloak style="position:fixed;top:0;left:0;right:0;background:linear-gradient(90deg,transparent,rgba(0,0,0,0.6),transparent);border-bottom:1px solid var(--glass-border);overflow:hidden;height:28px;display:flex;align-items:center;z-index:50">
  <div style="display:flex;gap:48px;white-space:nowrap;animation:nova-scroll-x 24s linear infinite;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--ink-muted);padding-left:20px">
    <span>◉ nova admin</span>
    <span x-text="`${galaxies.length} galaxies`"></span>
    <span x-text="`${pendingAgents.length} pending`"></span>
    <span>◉ nova admin</span>
    <span x-text="`${galaxies.length} galaxies`"></span>
    <span x-text="`${pendingAgents.length} pending`"></span>
  </div>
</div>
```

Then append to `styles.css`:

```css
@keyframes nova-scroll-x {
  from { transform: translateX(0); }
  to   { transform: translateX(-50%); }
}
@media (prefers-reduced-motion: reduce) {
  [style*="nova-scroll-x"] > div { animation: none !important; }
}
```

Bump top padding on `.nova-shell` to `52px` (top of screen, accounts for ticker):

```css
.nova-shell { max-width: 1100px; margin: 0 auto; padding: 52px 32px 32px; position: relative; }
```

- [ ] **Step 3: Commit**

```bash
git add packages/admin-api/public/index.html \
        packages/admin-api/public/styles.css
git commit -m "feat(admin-ui): kinetic status ticker and CSP confirmation"
```

---

## Task 15: Playwright install + config + fixtures

**Files:**
- Create: `packages/admin-api/playwright.config.ts`
- Create: `packages/admin-api/test/e2e/fixtures.ts`

- [ ] **Step 1: Install Playwright browsers**

```bash
cd /Users/tyewolfe/Projects/Nova
npx playwright install chromium
```

- [ ] **Step 2: Write playwright.config.ts**

Create `packages/admin-api/playwright.config.ts`:

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  fullyParallel: false,        // admin-api is a single shared instance
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'dot' : 'list',
  use: {
    baseURL: process.env.NOVA_UI_URL ?? 'http://localhost:3005',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
```

- [ ] **Step 3: Write fixtures**

Create `packages/admin-api/test/e2e/fixtures.ts`:

```typescript
import { test as base, expect } from '@playwright/test';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

export const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'e2e-token-' + Math.random().toString(36).slice(2);
export const PORT = Number(process.env.ADMIN_PORT ?? 3015);
export const BASE_URL = `http://localhost:${PORT}`;

let proc: ChildProcess | null = null;
let dataRoot: string | null = null;

export const test = base.extend<{ ready: void }>({
  ready: [async ({}, use) => {
    if (!proc) {
      dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-e2e-'));
      fs.mkdirSync(path.join(dataRoot, 'tenants'), { recursive: true });
      fs.mkdirSync(path.join(dataRoot, 'keys'), { recursive: true });
      // Minimal fake DID so services that read it don't crash
      fs.writeFileSync(path.join(dataRoot, 'keys', 'nova.did'), 'did:key:zE2EStub');
      proc = spawn('node', ['packages/admin-api/dist/index.js'], {
        env: {
          ...process.env,
          ADMIN_TOKEN,
          PORT: String(PORT),
          DATA_ROOT: dataRoot,
          REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
        },
        stdio: 'inherit',
        cwd: path.resolve(__dirname, '..', '..', '..', '..'),
      });
      await waitForHealth(BASE_URL);
    }
    await use();
  }, { scope: 'worker', auto: true }],
  baseURL: async ({}, use) => { await use(BASE_URL); },
});

export async function waitForHealth(baseUrl: string, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`${baseUrl}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('admin-api never became healthy');
}

process.on('exit', () => { if (proc) proc.kill(); if (dataRoot) fs.rmSync(dataRoot, { recursive: true, force: true }); });

export { expect };
```

- [ ] **Step 4: Smoke-run Playwright with zero tests**

```bash
npm --workspace=packages/admin-api run test:e2e -- --list
```

Expected: "0 tests found" (no spec files yet). Errors here mean the config or fixture file has a typo.

- [ ] **Step 5: Commit**

```bash
git add packages/admin-api/playwright.config.ts \
        packages/admin-api/test/e2e/fixtures.ts \
        package-lock.json
git commit -m "test(admin-ui): Playwright config and admin-api boot fixture"
```

---

## Task 16: E2E golden path

**Files:**
- Create: `packages/admin-api/test/e2e/onboarding.spec.ts`

- [ ] **Step 1: Write golden-path spec**

Create `packages/admin-api/test/e2e/onboarding.spec.ts`:

```typescript
import { test, expect, ADMIN_TOKEN, BASE_URL } from './fixtures';
import crypto from 'crypto';
import { signJwt } from '@nova/shared/src/invites';  // Re-use the server invite signer? If not exported, read it via REST.

test('golden path: login → create galaxy → issue invite → self-register → approve', async ({ page }) => {
  // ── Login ───────────────────────────────────────────────────────────────
  await page.goto('/');
  await page.fill('#admintok', ADMIN_TOKEN);
  await page.click('button.nova-cta');
  await expect(page.getByText('Galaxies', { exact: true })).toBeVisible();

  // ── Create galaxy ───────────────────────────────────────────────────────
  await page.click('button:has-text("+ New galaxy")');
  await page.fill('#g-slug', 'acme-e2e');
  await page.fill('#g-name', 'ACME E2E');
  await page.click('button:has-text("Forge galaxy")');
  await expect(page).toHaveURL(/#\/galaxy\/acme-e2e/);
  await expect(page.getByText('ACME E2E')).toBeVisible();

  // ── Create invite ───────────────────────────────────────────────────────
  await page.click('button:has-text("+ Issue invite")');
  await page.click('button:has-text("Issue invite")');
  // Reveal modal shows the token
  await expect(page.getByText('ONE-TIME TOKEN')).toBeVisible();
  const jwt = await page.locator('.nova-modal .nova-glass.nova-mono').first().innerText();
  expect(jwt.split('.').length).toBe(3);
  await page.click('button:has-text("Dismiss")');

  // ── Self-register a planet via API (simulating a planet operator) ─────
  const kp = crypto.generateKeyPairSync('ed25519');
  const pub = kp.publicKey.export({ format: 'der', type: 'spki' }).slice(-32).toString('base64');
  const registerRes = await fetch(`${BASE_URL}/admin/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      invite: jwt,
      agentId: 'planet_atlas',
      name: 'Planet Atlas',
      publicKey: pub,
      did: 'did:key:zE2EAtlas' + Date.now(),
      skills: [{ id: 'ping', name: 'Ping', description: 'Pings' }],
    }),
  });
  expect([200, 201]).toContain(registerRes.status);

  // ── SSE fires; pending card appears without reload ─────────────────────
  const pendingCard = page.locator('.nova-glass:has-text("planet_atlas")');
  await expect(pendingCard).toBeVisible({ timeout: 5000 });

  // ── Approve ─────────────────────────────────────────────────────────────
  await pendingCard.getByRole('button', { name: 'Approve' }).click();
  await page.click('.nova-modal button:has-text("Approve")');
  await expect(page.getByText(/UCAN issued/)).toBeVisible({ timeout: 5000 });
});
```

**Note:** if `POST /admin/register` is the agent self-register route, fine. If the route is actually `POST /admin/tenants/:id/agents/register`, update the path. Check `packages/a2a-server/src/routes/register.ts` and `packages/admin-api/src/index.ts` before running this spec. The plan uses `/admin/register` as a placeholder that the engineer validates against live code.

- [ ] **Step 2: Run**

```bash
REDIS_URL=redis://localhost:6379 npm --workspace=packages/admin-api run test:e2e
```

Expected: spec passes. Common failure modes: wrong register path (fix in step 1); public key encoding rejected by schema (generate a proper ed25519 pub key raw 32 bytes, base64).

- [ ] **Step 3: Commit**

```bash
git add packages/admin-api/test/e2e/onboarding.spec.ts
git commit -m "test(admin-ui): golden-path E2E onboarding flow"
```

---

## Task 17: E2E auth, session expiry, motion

**Files:**
- Create: `packages/admin-api/test/e2e/auth.spec.ts`
- Create: `packages/admin-api/test/e2e/sse.spec.ts`
- Create: `packages/admin-api/test/e2e/motion.spec.ts`

- [ ] **Step 1: Auth spec**

Create `packages/admin-api/test/e2e/auth.spec.ts`:

```typescript
import { test, expect } from './fixtures';

test('invalid token shows inline error and shakes', async ({ page }) => {
  await page.goto('/');
  await page.fill('#admintok', 'definitely-not-the-token');
  await page.click('button.nova-cta');
  await expect(page.getByText('Invalid token.')).toBeVisible();
  await expect(page.locator('#admintok')).toHaveClass(/is-error/);
});

test('expired session boots to login on any 401', async ({ page, context }) => {
  await page.goto('/');
  await page.fill('#admintok', process.env.ADMIN_TOKEN ?? '');
  await page.click('button.nova-cta');
  await expect(page.getByText('Galaxies')).toBeVisible();

  // Wipe sessionStorage on server's behalf by overriding next fetch to 401
  await page.route('**/admin/tenants', (route) => route.fulfill({ status: 401, body: JSON.stringify({ error: 'Unauthorized' }) }));
  await page.evaluate(() => (window as any).novaApp ? null : null); // no-op, force re-check
  // Navigate — triggers loadGalaxies which hits the 401
  await page.goto('/#/');
  await expect(page.getByText('Enter the console.')).toBeVisible();
});
```

- [ ] **Step 2: SSE spec**

Create `packages/admin-api/test/e2e/sse.spec.ts`:

```typescript
import { test, expect } from './fixtures';

test('SSE stream is established on login', async ({ page }) => {
  await page.goto('/');
  const sseRequest = page.waitForRequest((r) => r.url().endsWith('/admin/events'));
  await page.fill('#admintok', process.env.ADMIN_TOKEN ?? '');
  await page.click('button.nova-cta');
  const req = await sseRequest;
  expect(req.method()).toBe('GET');
});
```

- [ ] **Step 3: Motion spec**

Create `packages/admin-api/test/e2e/motion.spec.ts`:

```typescript
import { test, expect } from './fixtures';

test('prefers-reduced-motion disables animation on surface and CTA', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto('/');
  const anim = await page.locator('body.nova-surface').evaluate((el) => {
    return getComputedStyle(el, '::before').animationName;
  });
  // When reduced-motion is on, our CSS sets animation: none → computed is 'none'
  expect(anim).toBe('none');
  await ctx.close();
});
```

- [ ] **Step 4: Run**

```bash
REDIS_URL=redis://localhost:6379 npm --workspace=packages/admin-api run test:e2e
```

Expected: all four E2E specs pass.

- [ ] **Step 5: Commit**

```bash
git add packages/admin-api/test/e2e/auth.spec.ts \
        packages/admin-api/test/e2e/sse.spec.ts \
        packages/admin-api/test/e2e/motion.spec.ts
git commit -m "test(admin-ui): auth, SSE, and reduced-motion E2E coverage"
```

---

## Task 18: acceptance-test-m5.ts

**Files:**
- Create: `scripts/acceptance-test-m5.ts`
- Modify: `package.json` (root)

- [ ] **Step 1: Write the acceptance script**

Create `scripts/acceptance-test-m5.ts`:

```typescript
/**
 * Milestone 5 acceptance — runs Playwright golden-path headless against the
 * currently running admin-api instance. Assumes admin-api is reachable at
 * NOVA_UI_URL (default http://localhost:3005).
 */
import { spawn } from 'child_process';
import path from 'path';

const cwd = path.resolve(__dirname, '..');
const child = spawn('npx', ['playwright', 'test', '--config', 'packages/admin-api/playwright.config.ts', '--project', 'chromium', 'packages/admin-api/test/e2e/onboarding.spec.ts'], {
  cwd,
  stdio: 'inherit',
  env: { ...process.env },
});
child.on('exit', (code) => process.exit(code ?? 1));
```

- [ ] **Step 2: Add root script**

Open root `package.json` and add inside `scripts`:

```json
"test:acceptance:m5": "tsx scripts/acceptance-test-m5.ts"
```

- [ ] **Step 3: Run**

```bash
REDIS_URL=redis://localhost:6379 ADMIN_TOKEN=dev-token npm run test:acceptance:m5
```

Expected: golden-path E2E runs and passes.

- [ ] **Step 4: Commit**

```bash
git add scripts/acceptance-test-m5.ts package.json
git commit -m "test(admin-ui): milestone-5 acceptance script"
```

---

## Task 19: Manual test playbook doc

**Files:**
- Create: `docs/admin-ui/manual-test-playbook.md`

- [ ] **Step 1: Write playbook**

Create `docs/admin-ui/manual-test-playbook.md`:

```markdown
# Admin UI Manual Test Playbook

Use this when running the real-world onboarding test by hand (not in CI).

## Preflight

```bash
# One-time
npm install
npm run generate:keys          # produces data/keys/nova.{did,private.pem}

# Every session
docker compose up -d redis
ADMIN_TOKEN=dev-token REDIS_URL=redis://localhost:6379 \
  npm --workspace=packages/admin-api run dev
```

Open http://localhost:3005/.

## Test 1 — Login

1. Submit empty token → HTML5 required validation blocks submit.
2. Submit `wrong` → shake + "Invalid token." visible.
3. Submit `dev-token` → lands on "Galaxies" home.
4. Refresh → stays on home (sessionStorage restores token).
5. Click **Log out** → back to login.

## Test 2 — Create galaxy

1. On home, click **+ New galaxy**.
2. Submit with slug `ACME Corp` (uppercase + space) → blocked by input pattern.
3. Submit with valid `acme-corp`, name `ACME`, plan `developer` → URL changes to `#/galaxy/acme-corp`, detail header renders.

## Test 3 — Issue invite

1. On galaxy detail, click **+ Issue invite**, keep defaults, submit.
2. Reveal modal appears with QR code + JWT body + jti + expiry.
3. Click **Copy token** → button flashes "Copied ✓".
4. Dismiss modal.

## Test 4 — Self-register a planet

In another terminal (replace `$JWT` with the copied token):

```bash
JWT=paste-here
curl -s -X POST http://localhost:3005/admin/register \
  -H 'Content-Type: application/json' \
  -d "{
    \"invite\": \"$JWT\",
    \"agentId\": \"planet_manual\",
    \"name\": \"Manual Planet\",
    \"publicKey\": \"$(openssl genpkey -algorithm ed25519 -outform der | tail -c 32 | base64)\",
    \"did\": \"did:key:zManualTest\",
    \"skills\": [{\"id\":\"ping\",\"name\":\"Ping\",\"description\":\"Pings\"}]
  }"
```

Expected in browser (without refresh): a pending card for `planet_manual` appears within ~2s.

## Test 5 — Approve

1. Click **Approve** on the pending card.
2. In the modal: tier 1, skills `ping`, expiry 30.
3. Submit → toast "UCAN issued · <cid>…" appears. Card moves out of pending.

## Test 6 — Reject

Repeat Test 4 with `planet_reject`, then click **Reject**, confirm. Card disappears.

## Test 7 — SSE resilience

Kill admin-api while UI is on a galaxy detail:

```bash
pkill -f 'admin-api/dist/index.js'
```

Restart:

```bash
ADMIN_TOKEN=dev-token REDIS_URL=redis://localhost:6379 \
  npm --workspace=packages/admin-api run dev
```

Within ~30s the browser's EventSource reconnects (devtools → Network → `events`).

## Test 8 — Reduced motion

Browser devtools → Rendering → Emulate CSS `prefers-reduced-motion: reduce`. Confirm the starfield stops twinkling, the CTA stops pulsing, and the status ticker stops scrolling.
```

- [ ] **Step 2: Commit**

```bash
git add docs/admin-ui/manual-test-playbook.md
git commit -m "docs(admin-ui): manual test playbook for real-world onboarding"
```

---

## Task 20: End-to-end verification and final sweep

**Files:**
- none (validation)

- [ ] **Step 1: Run full unit test suite**

```bash
cd /Users/tyewolfe/Projects/Nova
npm --workspace=packages/admin-api run test
```

Expected: utils + api tests pass.

- [ ] **Step 2: Run E2E suite**

```bash
docker compose up -d redis
REDIS_URL=redis://localhost:6379 ADMIN_TOKEN=e2e-tok npm --workspace=packages/admin-api run test:e2e
```

Expected: onboarding + auth + sse + motion specs pass.

- [ ] **Step 3: Run acceptance script**

```bash
REDIS_URL=redis://localhost:6379 ADMIN_TOKEN=dev-token npm run test:acceptance:m5
```

Expected: golden-path passes.

- [ ] **Step 4: Full manual playbook walkthrough**

Follow `docs/admin-ui/manual-test-playbook.md` end to end. Report any step that fails.

- [ ] **Step 5: Final commit if any cleanup remains**

```bash
git status
# If only tracked changes remain:
git add -A
git commit -m "chore(admin-ui): final cleanup after end-to-end verification"
```

- [ ] **Step 6: Done.**

All milestones green. Spec requirements in `docs/superpowers/specs/2026-04-17-admin-ui-onboarding-design.md` are implemented.
