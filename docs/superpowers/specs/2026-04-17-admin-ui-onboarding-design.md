# Nova Admin UI — Onboarding Console (v1)

**Date:** 2026-04-17
**Status:** Design approved, awaiting user review before plan
**Scope:** Onboarding-only admin UI served from `packages/admin-api`

## Purpose

Provide a lightweight web UI to perform the Nova onboarding loop — create a
galaxy (tenant), issue an invite, and approve a planet (agent) when it
self-registers — so operators can run real-world onboarding tests without
crafting `curl` incantations. Broader admin functions stay out of scope and
move to the roadmap.

## Context

- `packages/admin-api` (Express, port 3005, container `admin-api`) already
  exposes all the REST routes needed: `POST /admin/tenants`, `GET /admin/tenants`,
  `POST /admin/tenants/:id/invites`, `GET /admin/tenants/:id/agents`,
  `POST /admin/tenants/:id/agents/:agentId/approve`, and
  `POST /admin/tenants/:id/agents/:agentId/reject`.
- `GET /admin/events` is a Server-Sent Events stream for `agent`, `tenant`,
  and `task` lifecycle events — used for live redemption updates instead of
  polling.
- `middleware/auth.ts` is a single `Bearer ${ADMIN_TOKEN}` check (timing-safe).
  No sessions, no multi-user.
- `docker-compose.yml` binds admin-api to `127.0.0.1:3005` and fronts it with
  Caddy; admin-api currently has no UI layer.
- Aesthetic direction (locked during brainstorm): *Cinematic Cosmos* — merges
  Tesseract's gradient-glass motion style with Nova's galaxy/planet metaphor
  (starfield, orbital rings, glow, kinetic ticker).

## Architecture

**Delivery.** New `packages/admin-api/public/` folder holding:

- `index.html` — single page, all screens toggled via Alpine `x-show`
- `app.js` — top-level Alpine store + routing
- `api.js` — `fetch` wrapper with token injection and 401 handling
- `styles.css` — design tokens + primitives
- `alpine.min.js` — vendored (no CDN, works offline inside compose)
- `qrcode.min.js` — vendored, used only on the invite-reveal screen

Wire `app.use(express.static('public'))` into `admin-api/src/index.ts`
**before** `app.use('/admin', adminAuth)` so static assets load without
auth; XHR requests carry the bearer token. Add
`COPY packages/admin-api/public ./public` to `Dockerfile.admin-api`.

**Routing.** Hash-based client-side routing, no server rewrites:

- `#/` — galaxies home
- `#/galaxy/:slug` — galaxy detail (invites + pending planets)
- `#/galaxy/:slug/approve/:agentId` — approve modal

Create-galaxy and create-invite are in-place panels, not separate routes.

**Data flow.**

- Single `api(method, path, body)` wrapper reads token from
  `sessionStorage.nova_admin_token`, sets `Authorization: Bearer`, parses
  admin-api's error shape, on 401 wipes token and routes to login, on other
  errors pushes a toast.
- One `EventSource('/admin/events')` subscription updates the Alpine store
  when `agent` or `tenant` lifecycle events arrive. Handles reconnect with
  exponential backoff (1s, 2s, 5s, max 30s).

**Build.** None. Plain files. No new npm scripts. Alpine loaded via
`<script defer src="/alpine.min.js">`.

## Onboarding Flow & Screens

1. **Login** — single password field labeled "admin token", probe
   `GET /admin/tenants` on submit. 200 → `sessionStorage` save + route home.
   401 → shake + inline error. Timeout >3s → "Admin API unreachable".
2. **Galaxies (home)** — list from `GET /admin/tenants`. Each entry: glowing
   disc (color derived from slug hash), slug, display name, agent count,
   status pill. "+ New galaxy" button.
3. **Create galaxy** — modal over home. Fields: `slug` (validates
   `/^[a-z0-9-]+$/` inline), `name`, `plan` enum. Submit →
   `POST /admin/tenants` → 201 → close modal + route to detail.
4. **Galaxy detail** — header shows tenant id, DID, quotas, plan.
   Two sections: *Invites* and *Pending planets*.
5. **Create invite** — inline panel in galaxy detail. Fields:
   `agentIdHint` (optional), `ttlSeconds` with humanized presets
   (24h / 7d / custom), `note`. Submit →
   `POST /admin/tenants/:id/invites` → response contains the JWT `token`,
   which is rendered in a **one-time reveal** block with copy button and
   QR code, plus the warning "This token is shown once."
6. **Pending planets (live via SSE)** — when an agent self-registers
   against an invite, a new card appears in real time with pulse
   animation. Card shows `agentId`, DID, skills, operator URL. Buttons:
   **Approve** and **Reject**.
7. **Approve modal** — trust tier (1-3), allowed skills, UCAN expiry days,
   optional notes. Submit →
   `POST /admin/tenants/:id/agents/:agentId/approve` → 200 → confirmation
   toast with the issued UCAN CID. Card shifts to the active list.

Screens total: **4** (login, galaxies, galaxy detail, approve modal).

## Visual System

**Color tokens** on `:root`:

```css
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
```

**Typography.** System stack (`-apple-system, 'Inter', sans-serif`). Display
weight 200, body 400, UI labels 600 uppercase with 2.5px tracking. Display
headings use `background-clip: text` with gradient
`#fff → #a78bfa → #22d3ee`. `SF Mono` for DIDs, JWTs, and other identifiers.

**Reusable primitives:**

- `.nova-surface` — layered mesh-gradient + starfield backdrop applied once
  to `<body>`
- `.nova-glass` — blurred panel with purple border (cards, form fields,
  modals)
- `.nova-spotlight` — glass + rotating conic-gradient border; used
  sparingly on the primary input row and CTA container
- `.nova-cta` — gradient pill button with pulse animation; one per screen
- `.nova-planet` — radial-gradient glowing circle, 36px default; color
  derives from slug hash so each planet has a stable identity color
- `.nova-pill` — status chip (pending / active / danger)

**Motion budget.** Mesh-gradient drift (14s), two-layer star twinkle
(4s + 6s), status ticker scroll (24s), spotlight rotation on focused
element only, CTA pulse on primary action only. All animations gated
behind `@media (prefers-reduced-motion: reduce)` → become no-ops.

**Density.** 32px screen padding, 12-16px between stacked elements. List
rows taller than typical admin UIs to reinforce "each galaxy is a
sovereign thing".

**Asset footprint.** ~8 kB CSS, no raster images (gradients/SVG/CSS only),
Alpine ~15 kB, qrcode ~4 kB, app.js estimated ~6 kB. Total page weight
well under 50 kB.

## Auth & Error Handling

**Auth lifecycle.**

- On load, read `sessionStorage.nova_admin_token`. Present → home. Absent → login.
- Login form posts a probe `GET /admin/tenants` with an `AbortController`
  that fires at 3s. 200 → stash + route home. 401 → shake + inline error.
  Abort fired or fetch rejected (network) → "Admin API unreachable".
- Every API call goes through `api()` which injects the bearer header.
- **Any 401** anywhere → clear sessionStorage, route to login, toast
  "Session ended".
- Logout button (top-right): clears storage, reloads.

**Error taxonomy.**

| Source                      | UX                                                                   |
| --------------------------- | -------------------------------------------------------------------- |
| 400 validation (zod)        | Inline under field; parse `err.details[].field` / `.message`         |
| 401                         | Global — boot to login                                               |
| 403                         | Toast + stay put (defensive only)                                    |
| 404 on detail route         | Screen-level empty state: "Galaxy not found" with back button        |
| 409 / 422 (e.g., slug taken)| Inline form error at submit button                                   |
| 5xx                         | Toast "Nova is having a moment — try again" + preserve form state    |
| Network (fetch throws)      | Same 5xx toast, plus offline banner if `!navigator.onLine`           |
| SSE disconnect              | Silent reconnect (exp backoff, max 30s); disconnected dot if >10s    |

**Form-state preservation.** All forms hold values in Alpine `x-data`, not
DOM. A failed submit never clears what the user typed.

**Token-reveal screen.** The invite JWT is shown exactly once after
creation. Copy button, QR code, "I've copied it — dismiss" button. Not
persisted client-side. Refresh → token gone → issue a new invite. Mirrors
admin-api's `createInvite` contract, which only returns the JWT at POST
time.

**CSRF.** N/A — bearer auth with non-cookie credential.

**CSP.** Tight meta tag: `default-src 'self'; style-src 'self' 'unsafe-inline'`.
No external origins (Alpine + qrcode vendored).

## Testing

**Unit** (`packages/admin-api/test/public/`, Vitest + jsdom):

- `api.js` — 401 clears sessionStorage, 4xx preserves form state, error
  shape parsing, bearer header injection
- Slug hash → planet color (deterministic)
- Invite TTL humanizer ("24h", "7d", "custom 3600s")

**End-to-end** (Playwright, `packages/admin-api/test/e2e/`):

- Golden path — admin-api + redis started in setup, open UI, login, create
  galaxy, create invite, self-register as a planet via direct API call,
  watch SSE surface the pending agent live, approve, assert UCAN returned
- Invalid token — login shakes and errors
- Expired session — stub 401 mid-session, assert boot-to-login
- SSE reconnect — kill admin-api mid-session, assert reconnection on restart
- Reduced motion — emulate `prefers-reduced-motion: reduce`, assert
  animations are off

**Acceptance integration.** New `scripts/acceptance-test-m5.ts` that
launches headless Playwright and runs the golden path as the final
acceptance step. Keeps UI coverage in the existing acceptance cadence.

**Manual test playbook** (committed alongside the spec, used for the
real-world onboarding test):

1. Fresh `docker compose up` → open UI → paste `$ADMIN_TOKEN` → home renders
2. Create galaxy with real slug → detail page opens
3. Create invite → JWT shown once → copy → dismiss
4. In another terminal, `curl` self-register as a planet using the token
5. Watch pending agent appear without refreshing
6. Click Approve → assert UCAN issued, card moves to active

**Not tested in v1.** Visual pixel regression (too brittle for an
iterating design). Accessibility automation (manual keyboard / contrast /
focus checks for now; add axe-core in a later iteration).

## Roadmap

Explicitly deferred. Each item is a future iteration, not a hidden v1
requirement.

**Near-term:**

- Caddy reverse-proxy auth injection — trusted header set by Caddy; UI
  never sees the token. Needs Caddyfile edit + admin-api middleware path.
- Galaxy edit & delete (PATCH/DELETE). Needs destructive-action confirm
  pattern.
- Reject-with-reason — extend `/reject` to accept a note, show it in audit.

**Mid-term (UI grows past onboarding):**

- Trust registry management (add/remove trusted DIDs, change tier)
- UCAN issue & revoke — full lifecycle beyond the auto-issue at approval
- Audit view — filters on event type, time range, taskId
- Agent detail screen — skills, operator URL, health, recent tasks; tab
  pattern (overview / trust / dead-letter / quarantine)

**Long-term (full admin console):**

- Quarantine & dead-letter actions (requeue, drop, inspect)
- Cross-destination UCAN requests — admin visibility and revocation
- Multi-operator — per-user accounts with roles, beyond single
  `ADMIN_TOKEN`
- Discovery browser — lightweight read-only surface over `/discover`
- Global dashboard — activity, health, counts; replaces galaxies-only home

**Motion & polish backlog:**

- Cursor-reactive starfield parallax (borrow from Tesseract
  `cursor-reactive.html`)
- View Transitions API between screens
- Galaxy detail header: animated orbit of approved planets

**Explicit non-goals:**

- No React/Vue SPA in v1. If the UI outgrows Alpine, migrate to a new
  `packages/admin-ui/` package, not retrofit.
- No embedded DB or state beyond `sessionStorage`.
- No separate `admin-ui` container — ships with `admin-api`.

## Success Criteria

- Operator can complete the full onboarding loop (create galaxy, issue
  invite, approve planet) in the UI without touching `curl`.
- Pending-agent card appears live via SSE within 2 seconds of a planet
  self-registering.
- Invite JWT is shown exactly once and never persisted client-side.
- `docker compose up` + open browser to Caddy host → UI loads over HTTPS.
- `npm run test:acceptance:m5` passes headless in CI.
- Works in Chrome, Safari, Firefox at current versions. No IE / legacy.
