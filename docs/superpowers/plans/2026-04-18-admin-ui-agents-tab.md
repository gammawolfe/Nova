# Admin UI Agents Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Agents placeholder with a real cross-galaxy grid of every active agent (name, agentId, galaxy, description, skill chips, capability indicators) backed by a new `GET /admin/agents` route.

**Architecture:** Additive across backend + frontend. One new Express route `src/routes/all-agents.ts` wraps the existing `agentService.listAllActiveAgents()`. Frontend gains three state properties, two new methods (`loadAllAgents`, `galaxySlug`), and a small extension to `routeLoad` and `handleSseAgent`. The existing Agents placeholder template is replaced with the real view. No schema changes, no new dependencies.

**Tech Stack:** Express + TypeScript (backend), Alpine.js + vanilla CSS (frontend). Admin API's existing middleware handles auth.

**Spec:** `docs/superpowers/specs/2026-04-18-admin-ui-agents-tab-design.md`

---

## Dev loop — running the admin UI locally

Two wrinkles this bite vs previous bites:

1. **Backend code change.** After editing TypeScript in `packages/admin-api/src/`, the running container won't pick it up automatically. Use the hot-reload dev script instead, or rebuild the container at the end:

   ```bash
   # Hot reload for iteration (runs outside docker, needs local Redis)
   cd packages/admin-api && npm run dev

   # Or rebuild the container (slower but mirrors production):
   docker-compose up -d --build admin-api
   ```

2. **Admin token.** The running container uses `ADMIN_TOKEN` from `.env` (currently `my-secure-admin-token-12345`). All `curl -H "Authorization: Bearer …"` in this plan need that token.

UI at `http://localhost:3005`. Paste the token to log in.

Verify tests still pass after every task:

```bash
cd packages/admin-api && npm test
```

Expected: `Tests  11 passed (11)`. The existing suite doesn't cover the new route (see spec — no server-side test harness this bite), but the client-side tests must continue to pass unchanged.

---

## Task 1: Add the `GET /admin/agents` backend route

**Why:** The frontend needs a single cross-galaxy agent fetch that preserves `tenantId` (unlike `/discover` which strips it). This route is a thin admin-auth wrapper around the existing `agentService.listAllActiveAgents()`.

**Files:**
- Create: `packages/admin-api/src/routes/all-agents.ts`
- Modify: `packages/admin-api/src/index.ts` (two inserts: import + mount)

- [ ] **Step 1: Create the new route file**

Create `packages/admin-api/src/routes/all-agents.ts` with this exact content:

```ts
import { Router, Request, Response, NextFunction } from 'express';
import * as agentService from '../services/agent-service';

export const allAgentsRouter = Router();

allAgentsRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const agents = await agentService.listAllActiveAgents();
    res.json({ agents, total: agents.length });
  } catch (err) { next(err); }
});
```

- [ ] **Step 2: Import the router in `index.ts`**

Open `packages/admin-api/src/index.ts`. Find the block of route imports (lines 7–18 in current file). Add one import after the existing `agentsRouter` import:

Existing:

```ts
import { tenantsRouter } from './routes/tenants';
import { agentsRouter } from './routes/agents';
```

Change to:

```ts
import { tenantsRouter } from './routes/tenants';
import { agentsRouter } from './routes/agents';
import { allAgentsRouter } from './routes/all-agents';
```

- [ ] **Step 3: Mount the router in `index.ts`**

In the same file, find the authenticated routes block (around line 118). The existing mount looks like:

```ts
app.use('/admin/tenants', tenantsRouter);
app.use('/admin/tenants/:tenantId/invites', invitesRouter);
```

Insert the new mount between them (before the tenant-scoped routes so it's adjacent to `/admin/tenants`):

```ts
app.use('/admin/tenants', tenantsRouter);
app.use('/admin/agents', allAgentsRouter);
app.use('/admin/tenants/:tenantId/invites', invitesRouter);
```

The admin auth middleware at line 106 (`app.use('/admin', adminAuth)`) applies to everything under `/admin`, so no explicit auth wiring is needed.

- [ ] **Step 4: Verify with `curl`**

Start the admin-api locally. If using the dev script:

```bash
cd packages/admin-api && npm run dev
```

Wait for the log line `Admin API running on http://127.0.0.1:3005`, then in another terminal:

```bash
# Without auth — expect 401
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3005/admin/agents
# Expected: 401

# With auth — expect 200 with the { agents, total } shape
curl -s http://localhost:3005/admin/agents \
  -H "Authorization: Bearer my-secure-admin-token-12345" \
  | python3 -m json.tool | head -20
# Expected: {"agents":[...], "total": N} where each agent has
# agentId, tenantId, name, description, status, skills, capabilities
```

The `tenantId` field must be present on each agent (that's the whole reason we're adding this route instead of using `/discover`). Confirm by inspecting the JSON output.

- [ ] **Step 5: Run the tests**

```bash
cd packages/admin-api && npm test
```

Expected: 11/11 passing. No test changes this bite; we're confirming the new route didn't break client-side tests.

- [ ] **Step 6: Commit**

```bash
git add packages/admin-api/src/routes/all-agents.ts packages/admin-api/src/index.ts
git commit -m "feat(admin-api): add GET /admin/agents cross-galaxy list route

Thin admin-auth wrapper around agentService.listAllActiveAgents().
Returns { agents, total } where each agent includes tenantId —
critically unlike /discover which strips tenantId. Consumed by the
upcoming Agents tab in the admin UI."
```

---

## Task 2: Append CSS for agent grid and cards

**Why:** Additive CSS only. The new classes (`.nova-agent-grid`, `.nova-agent-card`, `.nova-skill-chip`, `.nova-capability-indicator`) have no HTML consumers yet — UI looks unchanged after this task.

**Files:**
- Modify: `packages/admin-api/public/styles.css` (append)

- [ ] **Step 1: Append the agent-view block**

Open `packages/admin-api/public/styles.css`. Scroll to the end of the file (just after the `.nova-placeholder` rule from the shell-layout bite). Append:

```css

/* ── Agents tab ────────────────────────────────────────────────────────── */
.nova-agent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 16px;
}

.nova-agent-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  text-decoration: none;
  color: inherit;
  transition: border-color 0.15s ease, transform 0.15s ease;
  display: block;
}
.nova-agent-card:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
}
@media (prefers-reduced-motion: reduce) {
  .nova-agent-card { transition: none; }
  .nova-agent-card:hover { transform: none; }
}

.nova-skill-chip {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 14px;
  background: rgba(245, 166, 35, 0.08);
  border: 1px solid rgba(245, 166, 35, 0.2);
  color: var(--accent);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}

.nova-capability-indicator {
  color: var(--text-muted);
  font-family: var(--font-mono);
}
.nova-capability-indicator.is-on {
  color: var(--status-active);
}
```

- [ ] **Step 2: Verify the UI is unchanged**

Refresh `http://localhost:3005`. Walk Galaxies, galaxy detail, each placeholder tab (Agents, Live, Audit), and every modal. Everything should look identical to the post-shell-bite state. The new classes have no consumers yet.

Open DevTools → Elements → search for `nova-agent-grid`. Expected: no matches in the DOM.

- [ ] **Step 3: Commit**

```bash
git add packages/admin-api/public/styles.css
git commit -m "feat(admin-ui): add CSS for Agents tab grid and cards

Additive block only — no HTML consumes these classes yet.
.nova-agent-grid is a responsive auto-fill grid. .nova-agent-card
uses the flat-surface pattern established in prior bites, with an
amber border on hover and a 1px lift (respects reduced-motion).
.nova-skill-chip is a pill in amber. .nova-capability-indicator is
muted by default, green when .is-on."
```

---

## Task 3: Add Alpine state, `loadAllAgents`, `galaxySlug`, extend `routeLoad` and `handleSseAgent`

**Why:** Adds the data layer so the Agents tab has something to render in Task 4. After this task, navigating to `#/agents` fires a network call and populates `allAgents`, but the placeholder HTML is still what renders — so you see loading noise in DevTools but the UI looks unchanged.

**Files:**
- Modify: `packages/admin-api/public/js/app.js` (four edits: state, new method(s), `routeLoad`, `handleSseAgent`)

- [ ] **Step 1: Add `allAgents`, `allAgentsLoading`, `allAgentsError` state**

Open `packages/admin-api/public/js/app.js`. Find the existing state block inside `novaApp()` (around line 22). The last state line before the new `sidebarCollapsed` property (added in the shell bite) is `sse: null,`. Add three new state properties right after `sse: null,`:

Existing:

```js
    toasts: [],
    sse: null,
    sidebarCollapsed: readSidebarState(),
```

Change to:

```js
    toasts: [],
    sse: null,
    allAgents: [],
    allAgentsLoading: false,
    allAgentsError: null,
    sidebarCollapsed: readSidebarState(),
```

- [ ] **Step 2: Add `loadAllAgents` and `galaxySlug` methods**

In the same file, find the existing `loadGalaxy(slug)` method (around line 82). Its closing brace ends with:

```js
    async loadGalaxy(slug) {
      try {
        const all = await api('GET', '/admin/tenants') || [];
        const match = all.find(t => t.slug === slug || t.id === slug);
        if (!match) { this.currentGalaxy = null; return; }
        this.currentGalaxy = match;
        this.agents = await api('GET', `/admin/tenants/${encodeURIComponent(match.id)}/agents`) || [];
        this.pendingAgents = this.agents.filter(a => a.status === 'pending');
        this.activeAgents  = this.agents.filter(a => a.status !== 'pending');
      } catch (e) {
        if (e.status === 404) this.currentGalaxy = null;
        else this.pushToast(e.message || 'Load failed', 'err');
      }
    },
```

Add two new methods right after this, before `createGalaxy(form)`:

```js
    async loadAllAgents() {
      this.allAgentsLoading = true;
      this.allAgentsError = null;
      try {
        const galaxiesPromise = this.galaxies.length === 0
          ? this.loadGalaxies()
          : Promise.resolve();
        const [res] = await Promise.all([api('GET', '/admin/agents'), galaxiesPromise]);
        this.allAgents = res?.agents || [];
      } catch (e) {
        this.allAgentsError = e.message || 'Load failed';
        this.pushToast(this.allAgentsError, 'err');
      } finally {
        this.allAgentsLoading = false;
      }
    },

    galaxySlug(tenantId) {
      const match = this.galaxies.find(g => g.id === tenantId || g.slug === tenantId);
      return match?.slug || tenantId;
    },

```

Note the empty line at the end — keep the separation from `createGalaxy`.

- [ ] **Step 3: Extend `routeLoad` to fire `loadAllAgents` on `#/agents`**

Find the existing `routeLoad()` method (around line 65 of the current file):

```js
    async routeLoad() {
      if (!this.token) return;
      if (this.route.name === 'home')   await this.loadGalaxies();
      if (this.route.name === 'galaxy') await this.loadGalaxy(this.route.slug);
    },
```

Add one line for the agents route:

```js
    async routeLoad() {
      if (!this.token) return;
      if (this.route.name === 'home')   await this.loadGalaxies();
      if (this.route.name === 'galaxy') await this.loadGalaxy(this.route.slug);
      if (this.route.name === 'agents') await this.loadAllAgents();
    },
```

- [ ] **Step 4: Extend `handleSseAgent` to refresh the Agents tab when active**

Find the existing `handleSseAgent(ev)` method (around line 143):

```js
    handleSseAgent(ev) {
      if (!this.currentGalaxy) return;
      try {
        const msg = JSON.parse(ev.data);
        const galaxyId = this.currentGalaxy.id;
        if (msg.tenantId && (msg.tenantId === galaxyId || msg.tenantId === this.currentGalaxy.slug)) {
          this.loadGalaxy(this.route.slug);
        }
      } catch {}
    },
```

Replace with this expanded version:

```js
    handleSseAgent(ev) {
      try {
        const msg = JSON.parse(ev.data);
        if (this.activeTab === 'agents') {
          this.loadAllAgents();
          return;
        }
        if (!this.currentGalaxy) return;
        const galaxyId = this.currentGalaxy.id;
        if (msg.tenantId && (msg.tenantId === galaxyId || msg.tenantId === this.currentGalaxy.slug)) {
          this.loadGalaxy(this.route.slug);
        }
      } catch {}
    },
```

The early-return pattern means: if we're on the Agents tab, refresh the global agents list and stop. Otherwise fall through to the existing galaxy-refresh logic. Moving the `JSON.parse(ev.data)` call inside the outer `try` (which was already the case) keeps error swallowing identical to before.

- [ ] **Step 5: Verify the data loads on `#/agents`**

Refresh `http://localhost:3005`, log in, then click Agents in the sidebar. Open DevTools → Network. You should see:

1. `GET /admin/agents` → 200 OK with the JSON body
2. `GET /admin/tenants` → 200 OK (only if you hadn't visited Galaxies yet this session)

Open Console and run:

```js
Alpine.$data(document.querySelector('[x-data]')).allAgents
```

Expected: array of agent objects, each with `agentId`, `tenantId`, `name`, `skills`, `capabilities`, etc.

```js
Alpine.$data(document.querySelector('[x-data]')).galaxySlug(
  Alpine.$data(document.querySelector('[x-data]')).allAgents[0]?.tenantId
)
```

Expected: the slug of the first agent's galaxy (e.g. `wolfe-dev-sadi`), **not** the internal ID (`tenant_xxxxx`). If this returns the raw id, the galaxies list didn't load or the agent's `tenantId` doesn't match any known galaxy — check the Network tab for `/admin/tenants`.

The Agents tab itself still renders the placeholder ("Coming soon.") — that's expected until Task 4.

- [ ] **Step 6: Run tests**

```bash
cd packages/admin-api && npm test
```

Expected: 11/11 passing.

- [ ] **Step 7: Commit**

```bash
git add packages/admin-api/public/js/app.js
git commit -m "feat(admin-ui): add Agents tab data layer to Alpine app

New state: allAgents, allAgentsLoading, allAgentsError. New methods:
loadAllAgents (fetches /admin/agents and ensures galaxies list is
loaded for slug resolution) and galaxySlug (maps tenant ID to slug
for consistent routing and planet colors across tabs). routeLoad
fires loadAllAgents on #/agents. handleSseAgent refreshes the
Agents list when the Agents tab is active; otherwise falls through
to the existing galaxy-refresh behavior. No template consumes this
data yet — the HTML wiring lands in the next task."
```

---

## Task 4: Replace the Agents placeholder with the real grid view

**Why:** This is where the visible change lands. The placeholder template is swapped for the real grid of agent cards, using the state wired up in Task 3.

**Files:**
- Modify: `packages/admin-api/public/index.html` (replace one block)

- [ ] **Step 1: Replace the Agents placeholder template**

Open `packages/admin-api/public/index.html`. Find the Agents placeholder that was added in the shell bite (around line ~165 after Task 3 of that bite):

```html
      <!-- PLACEHOLDER: Agents -->
      <template x-if="route.name === 'agents'">
        <div class="nova-placeholder">
          <div class="nova-eyebrow">◉ AGENTS</div>
          <h1 class="nova-display" style="font-size:32px;margin:8px 0 6px">Coming soon.</h1>
          <p class="nova-subtitle">Flat cross-galaxy view of every registered agent — advertised skills, trust tier, DID, last-seen.</p>
        </div>
      </template>
```

Replace with the real view:

```html
      <!-- AGENTS -->
      <template x-if="route.name === 'agents'">
        <div>
          <div class="nova-eyebrow">◉ AGENTS</div>
          <h1 class="nova-display" style="font-size:40px;margin:6px 0">Agents</h1>
          <p class="nova-subtitle" style="margin-bottom:24px" x-text="`${allAgents.length} active ${allAgents.length === 1 ? 'agent' : 'agents'} across your galaxies`"></p>

          <div x-show="allAgentsLoading" class="nova-glass" style="text-align:center;color:var(--text-secondary)">
            Loading agents…
          </div>

          <div x-show="allAgentsError" class="nova-glass" style="text-align:center;color:var(--status-error)" x-text="allAgentsError"></div>

          <div x-show="!allAgentsLoading && !allAgentsError && allAgents.length === 0" class="nova-glass" style="text-align:center;color:var(--text-secondary)">
            No active agents yet. Approve a pending planet in a galaxy to see it here.
          </div>

          <div x-show="!allAgentsLoading && !allAgentsError && allAgents.length > 0" class="nova-agent-grid">
            <template x-for="a in allAgents" :key="a.agentId">
              <a class="nova-agent-card" :href="`#/galaxy/${encodeURIComponent(galaxySlug(a.tenantId))}`">
                <div class="nova-row" style="margin-bottom:12px;align-items:flex-start">
                  <div class="nova-planet" :style="planetStyle(galaxySlug(a.tenantId))" style="margin-top:2px"></div>
                  <div style="flex:1;min-width:0">
                    <div style="color:#fff;font-weight:500" x-text="a.name"></div>
                    <div class="nova-mono" x-text="a.agentId"></div>
                  </div>
                  <span class="nova-pill" style="color:var(--text-secondary);border-color:var(--border)" x-text="galaxySlug(a.tenantId)"></span>
                </div>

                <p x-show="a.description" class="nova-subtitle" style="margin-bottom:12px" x-text="a.description"></p>

                <div x-show="a.skills && a.skills.length > 0" style="margin-bottom:12px">
                  <div style="display:flex;flex-wrap:wrap;gap:6px">
                    <template x-for="s in a.skills" :key="s.id">
                      <span class="nova-skill-chip" :title="s.description" x-text="s.name"></span>
                    </template>
                  </div>
                </div>

                <div class="nova-row" style="gap:14px;color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:1px">
                  <span class="nova-capability-indicator" :class="a.capabilities?.streaming && 'is-on'">streaming</span>
                  <span class="nova-capability-indicator" :class="a.capabilities?.pushNotifications && 'is-on'">push</span>
                  <span class="nova-capability-indicator" :class="a.capabilities?.stateTransitionHistory && 'is-on'">history</span>
                </div>
              </a>
            </template>
          </div>
        </div>
      </template>
```

Comment label changes from `PLACEHOLDER: Agents` to just `AGENTS` to reflect the template's new status.

- [ ] **Step 2: Verify in the browser**

Refresh and navigate to Agents. You should see:

- **Header:** amber `◉ AGENTS` eyebrow, "Agents" title in the white→amber→white gradient, subtitle showing the count (e.g. "2 active agents across your galaxies")
- **Grid of cards** below: each card has a small planet orb (color matching the galaxy's planet on the Galaxies tab), the agent's name (bold white), its `agentId` in mono grey, and a galaxy pill on the right showing the slug
- **Description** below the header row (if the agent has one)
- **Skill chips** in amber (hover any chip to see the skill description as a native tooltip)
- **Capability indicators** at the bottom — each of `streaming` / `push` / `history` is either muted grey (off) or green (on)

Hover a card — border turns amber, card lifts 1px.

Click a card — the URL becomes `#/galaxy/<slug>` and the galaxy detail view opens. Verify the Galaxies nav item stays highlighted (not Agents), since the activeTab getter maps the `galaxy` route to `galaxies`.

- [ ] **Step 3: Verify planet color consistency**

Open Galaxies. Note the color of each galaxy's planet orb. Click Agents. For any agent whose `galaxySlug(a.tenantId)` matches a galaxy slug you just saw, the card's orb should be the **same color** as that galaxy's orb on Galaxies. If colors differ, `galaxySlug` isn't resolving — likely because the galaxies list didn't load (check Network).

- [ ] **Step 4: Verify SSE refresh on the Agents tab**

Open the Agents tab in your browser. In a separate browser tab (or incognito window with a separate login), navigate into a galaxy and approve a pending planet — or reject an active agent — via the existing Galaxies > galaxy detail flow. The Agents tab grid in the first window should update within a second or two (the new agent appears, or a deregistered one disappears). No page refresh required.

If you don't have a pending planet to approve, you can simulate by triggering any admin action that publishes an agent lifecycle event (approve, reject). If none are available, this verification step is optional — the SSE path is well-exercised by the existing galaxy refresh code; we've just added a condition to also call `loadAllAgents` on it.

- [ ] **Step 5: Verify empty and error states**

Empty state is hard to trigger on a populated Nova — skip unless you have a freshly-initialized instance. The rendering path is guarded by an `x-show` and has no conditional logic, so visual verification isn't critical.

Error state: in DevTools → Network → right-click `/admin/agents` → "Block request URL". Refresh the Agents tab. Expected:
- Error panel renders (`.nova-glass` with red text)
- Toast appears bottom-right with the error message
- Grid is hidden

Unblock the URL and refresh to recover.

- [ ] **Step 6: Run tests**

```bash
cd packages/admin-api && npm test
```

Expected: 11/11 passing.

- [ ] **Step 7: Commit**

```bash
git add packages/admin-api/public/index.html
git commit -m "feat(admin-ui): replace Agents placeholder with real grid view

Cards show: planet orb, agent name + agentId, galaxy pill, description,
skill chips, and three capability indicators (streaming, push,
history). Clicking a card navigates to that agent's galaxy via the
existing detail route. Uses galaxySlug() to resolve tenant IDs so
planet colors match the Galaxies tab. Loading, empty, and error
states are guarded with x-show."
```

---

## Task 5: Final sweep — grep, visual walk, browser navigation, deploy

**Why:** Confirm everything hangs together and nothing stale was left behind. Rebuild the container so the backend change ships with the UI change.

**Files:** No file changes expected unless Steps 1–2 surface a bug.

- [ ] **Step 1: Grep for the four new CSS class names**

From the repo root:

```bash
rg "nova-agent-grid|nova-agent-card|nova-skill-chip|nova-capability-indicator" packages/admin-api/public
```

Expected: every class appears in both `styles.css` (definition) and `index.html` (usage). No class should appear in only one file.

- [ ] **Step 2: Grep for leftover "Coming soon" on Agents**

```bash
rg -n "Coming soon" packages/admin-api/public/index.html
```

Expected: two matches — Live and Audit placeholders. The Agents placeholder should be gone. If you see three matches, the Task 4 replacement didn't apply cleanly.

- [ ] **Step 3: Walk every view one final time**

With the admin-api running, log in and walk:

- Login screen (no sidebar, centered)
- Galaxies list (gradient title, galaxy cards with planet orbs, `+ New galaxy` amber CTA)
- Galaxy detail (pending/active planets, invite controls, approve modal)
- **Agents (the new view)** — header, grid, cards, capabilities, hover, click-through
- Live placeholder (unchanged "Coming soon")
- Audit placeholder (unchanged "Coming soon")
- Sidebar collapse still works, state persists
- Every modal still works (create-galaxy, create-invite, invite-reveal with QR + red eyebrow, approve-planet)
- Toasts still work (success green, error red)

- [ ] **Step 4: Test reduced-motion on agent cards**

DevTools → Rendering → emulate `prefers-reduced-motion: reduce`. Hover an agent card — the border should still turn amber, but the card should not lift (transform: none).

- [ ] **Step 5: Run tests**

```bash
cd packages/admin-api && npm test
```

Expected: 11/11 passing.

- [ ] **Step 6: If Steps 1–5 surfaced any fixes, commit them**

```bash
git add packages/admin-api/
git commit -m "fix(admin-ui): cleanup after Agents tab sweep"
```

If no fixes needed, skip this commit.

- [ ] **Step 7: Rebuild and restart the container**

The backend change (new TS route) won't show up in the container until it's rebuilt. After all prior tasks are on the branch (or merged), run:

```bash
docker-compose up -d --build admin-api
```

Wait for `Container nova-admin-api-1  Started`. Give the container ~5 seconds to boot, then verify:

```bash
# Confirm the new route is live in the container
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3005/admin/agents \
  -H "Authorization: Bearer my-secure-admin-token-12345"
# Expected: 200

# Confirm the new UI is being served
curl -s http://localhost:3005/styles.css | grep -c "nova-agent-grid"
# Expected: 1

curl -s http://localhost:3005/ | grep -c "Agents.*across your galaxies\|nova-agent-grid\|nova-agent-card"
# Expected: 2 or more
```

If the curl against `/admin/agents` returns 404, the route mount didn't make it into the image — check Task 1 Step 3 was applied and re-run `docker-compose up -d --build admin-api`.

- [ ] **Step 8: Final browser check against the container**

Visit `http://localhost:3005` (the container, not `npm run dev`), log in, navigate to Agents, confirm the grid renders the same as in the dev loop.

---

## Self-review

**Spec coverage** — every requirement traces to a task:

- Backend `GET /admin/agents` route → Task 1
- Mount in `index.ts` → Task 1 Step 3
- Returns `{ agents, total }` with `tenantId` preserved → Task 1 verified via curl in Step 4
- New CSS (`.nova-agent-grid`, `.nova-agent-card`, `.nova-skill-chip`, `.nova-capability-indicator`) → Task 2
- Alpine state (`allAgents`, `allAgentsLoading`, `allAgentsError`) → Task 3 Step 1
- `loadAllAgents()` with eager galaxies load → Task 3 Step 2
- `galaxySlug()` helper → Task 3 Step 2
- `routeLoad` extension → Task 3 Step 3
- `handleSseAgent` extension for SSE-driven refresh → Task 3 Step 4
- HTML template replacement → Task 4
- Loading / empty / error guards → Task 4 template + Step 5 verification
- Card click navigates to galaxy detail via existing route → Task 4 Step 2 verification
- Planet color consistency → Task 4 Step 3
- SSE refresh on active Agents tab → Task 4 Step 4
- Reduced motion → Task 5 Step 4
- Container rebuild (since backend changed) → Task 5 Step 7

**Placeholder scan** — no TBD/TODO. Every code block has concrete content. Verification steps have exact curl commands with expected status codes / outputs.

**Type consistency** — variable names (`allAgents`, `allAgentsLoading`, `allAgentsError`, `loadAllAgents`, `galaxySlug`) are spelled identically across JS (Task 3) and HTML (Task 4). Backend response shape `{ agents, total }` matches what the frontend reads (`res?.agents`).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-18-admin-ui-agents-tab.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
