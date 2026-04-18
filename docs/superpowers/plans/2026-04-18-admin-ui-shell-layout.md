# Admin UI Shell Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap Nova's admin UI authenticated view in a collapsible sidebar + main-content shell, add placeholder tabs for Agents/Live/Audit, and extend hash routing — without changing any existing view's behavior.

**Architecture:** Additive CSS + JS + HTML restructure in `packages/admin-api/public/`. No backend changes, no new dependencies. Shell wraps existing content; the current Galaxies list and galaxy detail render unchanged inside the new `.nova-main` area. Hash routes gain `#/agents`, `#/live`, `#/audit` which resolve to placeholder views. Sidebar collapse state persists via `localStorage`.

**Tech Stack:** Vanilla CSS, Alpine.js, hash-based routing. Same bundle, same Express static server.

**Spec:** `docs/superpowers/specs/2026-04-18-admin-ui-shell-layout-design.md`

---

## Dev loop — running the admin UI locally

Same as the first bite:

```bash
docker-compose up admin-api
# or for faster iteration:
cd packages/admin-api && npm run dev
```

UI at `http://localhost:3005`. Paste the admin token to log in.

After each task, refresh and verify. No build step — save and reload.

---

## Task 1: Append shell CSS to styles.css

**Why:** Add the new layout rules as an additive block. No existing rules change. After this task the UI looks identical — the new classes have no consumers yet. This is the safe foundation.

**Files:**
- Modify: `packages/admin-api/public/styles.css` (append only)

- [ ] **Step 1: Append the shell layout block to the end of the file**

Open `packages/admin-api/public/styles.css`. After the last rule (the ticker `@media (prefers-reduced-motion: reduce)` block at the bottom), append:

```css

/* ── Shell layout (authenticated) ──────────────────────────────────────── */
.nova-shell--full { max-width: none; padding: 0; }

.nova-app {
  display: flex;
  min-height: calc(100vh - 28px);
  position: relative;
}

.nova-sidebar {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 20px 16px;
  border-right: 1px solid var(--border);
  background: var(--bg);
  transition: width 0.2s ease, padding 0.2s ease, opacity 0.2s ease;
  overflow: hidden;
}
.nova-app.is-sidebar-collapsed .nova-sidebar {
  width: 0;
  padding-left: 0;
  padding-right: 0;
  opacity: 0;
  border-right: none;
}
@media (prefers-reduced-motion: reduce) {
  .nova-sidebar { transition: none; }
}

.nova-sidebar-brand {
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
  white-space: nowrap;
}

.nova-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nova-nav-item {
  display: block;
  padding: 10px 14px;
  border-radius: 8px;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
  transition: background 0.15s ease, color 0.15s ease;
  white-space: nowrap;
}
.nova-nav-item:hover {
  background: rgba(255, 255, 255, 0.04);
  color: var(--text);
}
.nova-nav-item.is-active {
  background: rgba(245, 166, 35, 0.08);
  color: var(--accent);
}

.nova-sidebar-spacer { flex: 1; }

.nova-sidebar-logout {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 14px;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.nova-sidebar-logout:hover {
  border-color: var(--border-hover);
  color: var(--text);
}

.nova-sidebar-toggle {
  position: absolute;
  top: 20px;
  left: 208px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text-muted);
  cursor: pointer;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: left 0.2s ease, border-color 0.15s ease, color 0.15s ease;
  z-index: 10;
}
.nova-sidebar-toggle:hover {
  border-color: var(--border-hover);
  color: var(--text-secondary);
}
.nova-app.is-sidebar-collapsed .nova-sidebar-toggle { left: 8px; }
@media (prefers-reduced-motion: reduce) {
  .nova-sidebar-toggle { transition: none; }
}

.nova-main {
  flex: 1;
  min-width: 0;
  padding: 40px 32px;
  overflow-y: auto;
  max-height: calc(100vh - 28px);
}

.nova-placeholder {
  max-width: 560px;
  margin: 80px auto 0;
  text-align: center;
}
```

- [ ] **Step 2: Verify the UI is unchanged**

Refresh `http://localhost:3005`. Walk the same views as before: login, galaxies list, galaxy detail, each modal. Everything should look identical to the palette-bite state — the new CSS classes have no consumers yet.

Open DevTools → Elements. Search the document for `nova-app` (Cmd/Ctrl+F in the Elements panel). **Expected:** no matches. If there are matches, the HTML was accidentally changed.

- [ ] **Step 3: Commit**

```bash
git add packages/admin-api/public/styles.css
git commit -m "feat(admin-ui): add shell layout CSS (sidebar, nav, main, placeholder)

Additive block only — no existing rules changed. The new classes
(.nova-app, .nova-sidebar, .nova-nav*, .nova-main, .nova-placeholder,
.nova-sidebar-toggle, .nova-sidebar-logout, .nova-shell--full) are
unused until Task 3 wires them into index.html."
```

---

## Task 2: Add Alpine state and route parsing to app.js

**Why:** Another additive change. We introduce the new reactive state, toggle, activeTab getter, and extended `parseRoute` — but nothing consumes them yet. After this task the UI still behaves identically. This isolates the logic layer change from the HTML restructure.

**Files:**
- Modify: `packages/admin-api/public/js/app.js` (two edits: helpers at the top of the file, new properties inside `novaApp()`, extended `parseRoute()`)

- [ ] **Step 1: Add the localStorage helpers at the top of the file**

Open `packages/admin-api/public/js/app.js`. At the top, right after the two `import` statements on lines 1–2, insert these two helper functions:

```js
import { api, setToken, clearToken, getToken, onUnauthorized } from './api.js';
import { slugColor, humanizeTtl } from './utils.js';

function readSidebarState() {
  try { return localStorage.getItem('nova-admin-sidebar-collapsed') === '1'; }
  catch { return false; }
}
function writeSidebarState(collapsed) {
  try { localStorage.setItem('nova-admin-sidebar-collapsed', collapsed ? '1' : '0'); }
  catch {}
}

window.novaApp = function () {
```

The `window.novaApp = function () {` line stays where it was (line 4 becomes line 11).

- [ ] **Step 2: Add `sidebarCollapsed`, `activeTab` getter, and `toggleSidebar` inside the returned object**

Find the returned object (starts at `return {` around line 13 of the new file, line 5 of the original). The existing properties are `token`, `loginValue`, `loginError`, etc. Just after the `sse: null,` line (the last "state" line before `init()`), add three new members. The existing ordering + new additions should look like:

```js
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
    activeAgents: [],
    showCreateGalaxy: false,
    showCreateInvite: false,
    revealedInvite: null,
    approveTarget: null,
    toasts: [],
    sse: null,
    sidebarCollapsed: readSidebarState(),

    get activeTab() {
      switch (this.route.name) {
        case 'home':
        case 'galaxy':  return 'galaxies';
        case 'agents':  return 'agents';
        case 'live':    return 'live';
        case 'audit':   return 'audit';
        default:        return 'galaxies';
      }
    },

    toggleSidebar() {
      this.sidebarCollapsed = !this.sidebarCollapsed;
      writeSidebarState(this.sidebarCollapsed);
    },

    init() {
```

Everything below `init()` stays unchanged.

- [ ] **Step 3: Extend `parseRoute()` to recognize the three new routes**

Scroll to the bottom of the file. Find the current `parseRoute()` function:

```js
function parseRoute() {
  const h = location.hash.replace(/^#/, '');
  const galaxy = h.match(/^\/galaxy\/([^/]+)$/);
  if (galaxy) return { name: 'galaxy', slug: decodeURIComponent(galaxy[1]) };
  return { name: 'home' };
}
```

Replace with:

```js
function parseRoute() {
  const h = location.hash.replace(/^#/, '');
  const galaxy = h.match(/^\/galaxy\/([^/]+)$/);
  if (galaxy) return { name: 'galaxy', slug: decodeURIComponent(galaxy[1]) };
  if (h === '/agents') return { name: 'agents' };
  if (h === '/live')   return { name: 'live' };
  if (h === '/audit')  return { name: 'audit' };
  return { name: 'home' };
}
```

- [ ] **Step 4: Verify the UI is still unchanged**

Refresh `http://localhost:3005`. Walk the same views. Everything should behave identically — the new state exists but nothing renders it yet. Open DevTools → Console:

```js
Alpine.$data(document.querySelector('[x-data]'))
```

The returned object should include `sidebarCollapsed` (boolean) and `activeTab` (string, either `'galaxies'` or whatever route you're on). If you paste `#/agents` into the URL and refresh, `Alpine.$data(...).activeTab` should return `'agents'` — even though the Agents view doesn't exist yet, the getter resolves correctly.

Paste `#/not-a-real-route` into the URL. `activeTab` should fall through to `'galaxies'`.

- [ ] **Step 5: Run the existing test suite**

```bash
cd packages/admin-api
npm test
```

Expected: `Test Files  2 passed (2) · Tests  11 passed (11)`. The existing tests don't cover `parseRoute` or the new state, so they should continue passing unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/admin-api/public/js/app.js
git commit -m "feat(admin-ui): add sidebar state and new tab routes to Alpine app

New Alpine state: sidebarCollapsed (persisted in localStorage under
nova-admin-sidebar-collapsed), activeTab (computed getter mapping
route.name to sidebar nav identity), toggleSidebar() action.
parseRoute() recognizes #/agents, #/live, and #/audit in addition to
the existing #/ and #/galaxy/:slug routes. No view consumes these
yet — the HTML wiring lands in the next task."
```

---

## Task 3: Restructure the authenticated HTML to use the shell

**Why:** This is the big visual change. The authenticated `<section>` gains the `.nova-app` shell structure: sidebar with brand + nav + logout, toggle button, and `.nova-main` wrapping the existing galaxy content plus new placeholder templates.

**Files:**
- Modify: `packages/admin-api/public/index.html` (three distinct regions)

- [ ] **Step 1: Update the `<main>` element to get `.nova-shell--full` when logged in**

Find the `<main class="nova-shell">` line (line ~25 of the current file):

```html
  <main class="nova-shell">
```

Replace with:

```html
  <main class="nova-shell" :class="token && 'nova-shell--full'">
```

This drops the 1100px max-width and 52px top padding whenever the user is authenticated, so the sidebar can span the viewport. The login view (no token) keeps its centered column layout.

- [ ] **Step 2: Replace the authenticated section opener and brand+logout row with the shell structure**

Find the authenticated section at line ~49. The current block, from the `<!-- AUTHENTICATED -->` comment through the opening of the first `<template x-if="route.name === 'home'">`, looks like:

```html
    <!-- AUTHENTICATED -->
    <section x-show="token" x-cloak>
      <div class="nova-row" style="justify-content:space-between;margin-bottom:24px">
        <div class="nova-eyebrow">◉ NOVA · ADMIN</div>
        <button class="nova-input" style="width:auto;padding:6px 12px;font-size:12px" @click="logout()">Log out</button>
      </div>

      <!-- HOME: Galaxies -->
      <template x-if="route.name === 'home'">
```

Replace with:

```html
    <!-- AUTHENTICATED -->
    <section x-show="token" x-cloak class="nova-app" :class="sidebarCollapsed && 'is-sidebar-collapsed'">

      <aside class="nova-sidebar">
        <div class="nova-sidebar-brand">
          <div class="nova-eyebrow">◉ NOVA · ADMIN</div>
        </div>
        <nav class="nova-nav">
          <a href="#/"        class="nova-nav-item" :class="activeTab === 'galaxies' && 'is-active'">Galaxies</a>
          <a href="#/agents"  class="nova-nav-item" :class="activeTab === 'agents'   && 'is-active'">Agents</a>
          <a href="#/live"    class="nova-nav-item" :class="activeTab === 'live'     && 'is-active'">Live</a>
          <a href="#/audit"   class="nova-nav-item" :class="activeTab === 'audit'    && 'is-active'">Audit</a>
        </nav>
        <div class="nova-sidebar-spacer"></div>
        <button class="nova-sidebar-logout" @click="logout()">Log out</button>
      </aside>

      <button class="nova-sidebar-toggle" @click="toggleSidebar()" :aria-label="sidebarCollapsed ? 'Open sidebar' : 'Collapse sidebar'">
        <span x-text="sidebarCollapsed ? '▶' : '◀'"></span>
      </button>

      <section class="nova-main">

      <!-- HOME: Galaxies -->
      <template x-if="route.name === 'home'">
```

Changes:
- `<section x-show="token" x-cloak>` gains `class="nova-app" :class="sidebarCollapsed && 'is-sidebar-collapsed'"`
- The inline brand + logout `.nova-row` is replaced by the full sidebar (`<aside class="nova-sidebar">...`)
- The toggle button is added as a sibling of the sidebar
- A new `<section class="nova-main">` opens to contain the view templates

The existing `<!-- HOME: Galaxies -->` comment and the `<template>` below it stay unchanged.

- [ ] **Step 3: Insert placeholder templates and close `.nova-main` before the modals**

Find the line that closes the galaxy detail template (around line 154 in the current file, immediately before the `<!-- CREATE GALAXY MODAL -->` comment). The existing structure looks like:

```html
          <template x-if="!currentGalaxy">
            <div class="nova-glass" style="margin-top:32px;text-align:center;color:var(--text-secondary)">
              Galaxy not found.
            </div>
          </template>
        </div>
      </template>

      <!-- CREATE GALAXY MODAL -->
      <template x-if="showCreateGalaxy">
```

Insert the three placeholder templates and a closing `</section>` between the last `</template>` of the galaxy detail block and the `<!-- CREATE GALAXY MODAL -->` comment:

```html
          <template x-if="!currentGalaxy">
            <div class="nova-glass" style="margin-top:32px;text-align:center;color:var(--text-secondary)">
              Galaxy not found.
            </div>
          </template>
        </div>
      </template>

      <!-- PLACEHOLDER: Agents -->
      <template x-if="route.name === 'agents'">
        <div class="nova-placeholder">
          <div class="nova-eyebrow">◉ AGENTS</div>
          <h1 class="nova-display" style="font-size:32px;margin:8px 0 6px">Coming soon.</h1>
          <p class="nova-subtitle">Flat cross-galaxy view of every registered agent — advertised skills, trust tier, DID, last-seen.</p>
        </div>
      </template>

      <!-- PLACEHOLDER: Live -->
      <template x-if="route.name === 'live'">
        <div class="nova-placeholder">
          <div class="nova-eyebrow">◉ LIVE</div>
          <h1 class="nova-display" style="font-size:32px;margin:8px 0 6px">Coming soon.</h1>
          <p class="nova-subtitle">Solar-system visualization. Planets orbit a star; dotted lines light up as A2A conversations flow, streamed from <code>/admin/events</code>.</p>
        </div>
      </template>

      <!-- PLACEHOLDER: Audit -->
      <template x-if="route.name === 'audit'">
        <div class="nova-placeholder">
          <div class="nova-eyebrow">◉ AUDIT</div>
          <h1 class="nova-display" style="font-size:32px;margin:8px 0 6px">Coming soon.</h1>
          <p class="nova-subtitle">Task audit log — which agent sent what to whom, when, and with what result. Feeds from <code>/admin/audit</code>.</p>
        </div>
      </template>

      </section><!-- /.nova-main -->

      <!-- CREATE GALAXY MODAL -->
      <template x-if="showCreateGalaxy">
```

The four modal `<template>` blocks (`showCreateGalaxy`, `showCreateInvite`, `revealedInvite`, `approveTarget`) and the toast stack all stay exactly as they are — they're now siblings of `.nova-main` inside the `.nova-app` section. They already use `position: fixed`, so DOM depth is irrelevant to their rendering.

- [ ] **Step 4: Verify in the browser — shell renders**

Refresh `http://localhost:3005` and log in. You should see:

- **Sidebar on the left, 220px wide**, with:
  - `◉ NOVA · ADMIN` eyebrow at top, amber
  - Four nav items: Galaxies (highlighted amber with subtle amber-tinted background because you're on `#/`), Agents, Live, Audit (each in muted grey, amber on hover)
  - A bordered `Log out` button at the bottom
- **Toggle button**: a small circular button on the sidebar's right edge, showing `◀`
- **Main content area** fills the rest, showing the Galaxies list exactly as before

Click each nav item. The URL hash updates to `#/agents`, `#/live`, `#/audit`. The active-tab highlight (amber) moves. The main area swaps to the corresponding "Coming soon" placeholder — each with its amber eyebrow label, gradient "Coming soon." title in Outfit, and the description below.

Click back to Galaxies (`#/`). List renders. Click any galaxy. Hash becomes `#/galaxy/:slug`. Detail view renders in the main area. Sidebar: Galaxies item stays highlighted. Click "← All galaxies" — returns to list.

- [ ] **Step 5: Verify sidebar collapse**

Click the `◀` toggle button. The sidebar animates closed (~200ms), the main area expands, and the toggle button slides flush-left showing `▶`. Click again — sidebar opens back to 220px.

Reload the page. The sidebar should stay in the state you left it. (If you closed it before reload, it stays closed after.)

- [ ] **Step 6: Verify modals still work**

Click `+ New galaxy`. The create modal appears over the whole viewport, backdrop covers both sidebar and main area. Cancel. Open `+ Issue invite` from a galaxy detail — same. Approve a pending planet — same. The one-time-token reveal modal (if you're testing the invite flow end-to-end) should still show with a red `◉ ONE-TIME TOKEN` eyebrow.

- [ ] **Step 7: Verify login flow is unchanged**

Click `Log out` (from the sidebar). Sidebar disappears, main `<main>` reverts to the 1100px centered column, login view renders. Log back in. Sidebar returns.

- [ ] **Step 8: Run existing tests**

```bash
cd packages/admin-api
npm test
```

Expected: 11/11 passing. No regression in the server-side tests.

- [ ] **Step 9: Commit**

```bash
git add packages/admin-api/public/index.html
git commit -m "feat(admin-ui): wrap authenticated view in sidebar + main shell

The authenticated <section> becomes .nova-app with a 220px collapsible
left sidebar (brand, Galaxies/Agents/Live/Audit nav, logout at bottom)
and a .nova-main area that hosts existing galaxy views plus three new
Coming-soon placeholder templates. The <main> element gains
.nova-shell--full when authenticated so the shell goes full-bleed.
Hash routes #/agents, #/live, #/audit now render their placeholder.
Modals remain siblings of .nova-main and continue to render over the
full viewport via their fixed-position backdrops."
```

---

## Task 4: Final sweep — verify edge cases, grep, and reduced-motion

**Why:** Confirm the shell handles the documented edge cases (localStorage blocked, unknown routes, reduced motion, direct URL entry). Grep for any stale references to the removed inline brand+logout row.

**Files:** No file changes expected. Verification only — unless Step 1 or 2 surfaces a bug.

- [ ] **Step 1: Grep for references to the removed inline elements**

From the repo root:

```bash
rg 'nova-row.*margin-bottom:24px' packages/admin-api/public
```

**Expected:** no matches. The only `.nova-row` with that inline style was the old brand+logout row we removed. If this finds anything, it wasn't cleanly replaced.

```bash
rg 'nova-input.*@click="logout' packages/admin-api/public
```

**Expected:** no matches. The old logout button used `.nova-input` styling; the new one is `.nova-sidebar-logout`. If this finds a stray reference, it's an orphaned copy of the old button.

- [ ] **Step 2: Test localStorage blocked**

In DevTools → Application → Storage → Local Storage, right-click the origin and select "Clear". Refresh. Sidebar should default to expanded. Click the toggle — sidebar collapses. Reload — sidebar should be *expanded again* (state was written to localStorage, cleared, re-read as default).

Now simulate localStorage blocked: in DevTools → Application → Storage, click "Clear site data" and then in Chrome DevTools → Preferences, check "Disable JavaScript" off, but that doesn't block localStorage. A more reliable test: open the page in a private/incognito window with third-party storage restricted, or use this console snippet before the Alpine app initializes (refresh required after):

```js
Object.defineProperty(window, 'localStorage', {
  get() { throw new Error('localStorage blocked'); }
});
```

Refresh. App should load normally; sidebar defaults expanded; toggle works during the session but doesn't persist. **No errors should appear in the console** — the `try/catch` in `readSidebarState`/`writeSidebarState` handles it.

- [ ] **Step 3: Test unknown hash routes**

Paste these into the URL bar one at a time and hit Enter:
- `http://localhost:3005/#/nonsense` — should fall back to Galaxies view (route.name === 'home')
- `http://localhost:3005/#/galaxy/nonexistent-slug` — should show galaxy detail with "Galaxy not found." empty state
- `http://localhost:3005/#/agents` — Agents placeholder, Agents highlighted in sidebar
- `http://localhost:3005/#/live` — Live placeholder, Live highlighted
- `http://localhost:3005/#/audit` — Audit placeholder, Audit highlighted

- [ ] **Step 4: Test prefers-reduced-motion**

DevTools → Rendering → "Emulate CSS prefers-reduced-motion: reduce". Toggle the sidebar. The collapse should be instant (no transition). Toggle button slides left instantly. Disable the emulation.

The ticker should also remain respectful — already tested in the previous bite, but confirm once more that it stops scrolling under reduced-motion emulation.

- [ ] **Step 5: Test browser navigation**

With the sidebar expanded, click through Galaxies → Agents → Live → Audit (four clicks). Press the browser back button four times. Each press should reverse one step in the hash history and update the active tab and content. Press forward four times — should re-advance.

Click a galaxy to enter detail. Press back — returns to Galaxies list. Press forward — re-enters galaxy detail.

- [ ] **Step 6: Visual smoke test — one last walk**

Walk every authenticated view, confirming:
- Galaxies list: amber `◉ NOVA · ADMIN` at the sidebar top, amber active-state on Galaxies nav item, galaxy cards render unchanged from the palette bite (planet orb, name, slug, status pill)
- Galaxy detail: back-link works, pending and active sections render, invite controls render, approve and reject flows work end-to-end (approve a pending planet if you have one to test with)
- Three placeholder tabs: each has the right eyebrow label, gradient title, and description
- Sidebar collapse: works, persists
- Modals: all four work (create-galaxy, create-invite, invite-reveal with QR, approve-planet)
- Toasts: trigger success (approve) and error (reject twice or create galaxy with bad slug) — both render bottom-right with correct border color

- [ ] **Step 7: If Steps 1–6 surfaced any fixes, commit them**

```bash
git add packages/admin-api/public/
git commit -m "fix(admin-ui): cleanup after shell layout sweep"
```

If Steps 1–6 produced no fixes, skip this commit — the plan is done.

---

## Self-review

**Spec coverage** — every spec section maps to a task:
- Layout (sidebar structure, toggle position, main area, ticker unchanged) → Task 1 (CSS) + Task 3 (HTML)
- HTML restructure → Task 3 (explicit before/after diffs)
- CSS additions (every class listed in spec) → Task 1 (all classes present in the append block)
- JavaScript changes (sidebarCollapsed, activeTab getter, toggleSidebar, extended parseRoute, localStorage helpers) → Task 2
- Data flow → Task 2 + Task 3 (no separate task; the flow works once state + HTML are wired)
- Error handling (localStorage blocked, unknown routes) → Task 4 Steps 2–3
- Verification procedure → Task 4 (expanded with precise DevTools steps)
- Files expected to change → Tasks 1 / 2 / 3 cover styles.css / app.js / index.html respectively

**Placeholder scan** — no TBD/TODO. Every code block has the actual code. Verification steps include exact console commands, URL patterns, and expected behavior. File line numbers are approximate ("around line 49") because the file grows — this is normal; the replacement is anchored by surrounding context, not line numbers.

**Type consistency** — `sidebarCollapsed`, `activeTab`, `toggleSidebar()`, `readSidebarState()`, `writeSidebarState()`, `'nova-admin-sidebar-collapsed'` localStorage key — all spelled consistently across Task 2 code and Task 3 HTML (`:class="sidebarCollapsed && ..."`, `@click="toggleSidebar()"`, `activeTab === 'galaxies'` etc).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-18-admin-ui-shell-layout.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
