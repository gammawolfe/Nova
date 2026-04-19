# Admin UI Agents tab — third bite

**Status:** design approved 2026-04-18
**Scope:** Replace the Agents placeholder with a real cross-galaxy read-only view of every active agent. Add one small admin-auth backend route.
**Prior bites:**
- `2026-04-18-admin-ui-palette-refresh-design.md` — palette + ornament (merged)
- `2026-04-18-admin-ui-shell-layout-design.md` — sidebar + tab shell (merged)

**Next bites (not this work):** filter/search on the Agents tab; per-agent detail page; the Live solar-system tab; the Audit tab.

## Motivation

The shell bite wired up an Agents placeholder promising "flat cross-galaxy view of every registered agent — advertised skills, trust tier, DID, last-seen." This bite fills that in, scoped down to what the existing data makes cheap: name, description, skills, capabilities, galaxy. Trust tier / DID / last-seen each require extra per-agent lookups and are deferred.

The operator ask this answers: **who's live in my Nova right now, what do they say they do, and which galaxy do they belong to?** That's the cross-galaxy picture Galaxies > galaxy detail can't give.

## Scope

**In scope**
- One new backend route: `GET /admin/agents` — admin-auth — returns `{ agents: ParsedAgentMeta[], total: number }` by wrapping the existing `agentService.listAllActiveAgents()`. Critically, keeps `tenantId` on each agent (the existing `/discover` endpoint strips it, which is why we can't reuse it).
- Replace the Agents placeholder template in `packages/admin-api/public/index.html` with the real view: header + grid of agent cards
- New CSS for `.nova-agent-grid`, `.nova-agent-card`, `.nova-skill-chip`, `.nova-capability-indicator`
- New Alpine state: `allAgents`, `allAgentsLoading`, `allAgentsError`
- New method: `loadAllAgents()`
- `routeLoad()` — add handling for `'agents'` route
- `handleSseAgent()` — refresh the Agents list when the Agents tab is active (in addition to existing galaxy refresh)
- Empty state for "no active agents"
- Error state for load failure

**Out of scope**
- Filter/search (by galaxy, by skill, by capability) — next bite
- Sort order beyond natural order from Redis — next bite
- Click-through to a dedicated agent-detail page — cards link to galaxy detail, which is the existing detail surface
- DID, trust tier, operatorUrl, replyUrl, createdAt — each needs additional per-agent fetches; deferred
- Last-seen / online status — no data source for it today
- Pending-agent inclusion — stays in Galaxies > galaxy detail where approve/reject lives
- Automated tests for the new route — admin-api's vitest only runs jsdom client tests; no server-side harness exists and adding one is a separate scope

## Backend — `GET /admin/agents`

**File:** `packages/admin-api/src/routes/all-agents.ts` (new)

```ts
import { Router, Request, Response } from 'express';
import * as agentService from '../services/agent-service';

export const allAgentsRouter = Router();

allAgentsRouter.get('/', async (_req: Request, res: Response, next) => {
  try {
    const agents = await agentService.listAllActiveAgents();
    res.json({ agents, total: agents.length });
  } catch (err) { next(err); }
});
```

**Mount:** in `packages/admin-api/src/index.ts`, alongside other admin routes. Insert after the existing `app.use('/admin/tenants', tenantsRouter);` line:

```ts
app.use('/admin/agents', allAgentsRouter);
```

The route sits at `/admin/agents` (plural, no `tenantId`). It does not conflict with the existing `/admin/tenants/:tenantId/agents` — Express routes via prefix match, and `/admin/agents` starts with `/admin/` but not with `/admin/tenants/`, so the two are unambiguous.

Admin auth happens automatically via the existing `app.use('/admin', adminAuth)` declaration on line 106.

**Response shape** (mirrors `ParsedAgentMeta` from `packages/shared/src/agent-index.ts`):

```json
{
  "agents": [
    {
      "agentId": "claude-code",
      "tenantId": "wolfe-dev",
      "name": "Claude Code",
      "description": "Anthropic's CLI for software engineering",
      "status": "active",
      "skills": [
        { "id": "code_search", "name": "Search codebases", "description": "...", "tags": ["search"] }
      ],
      "capabilities": { "streaming": true, "pushNotifications": false, "stateTransitionHistory": false }
    }
  ],
  "total": 1
}
```

## Frontend — HTML

Replace the existing Agents placeholder block in `packages/admin-api/public/index.html`. The current block (from the shell layout bite):

```html
<template x-if="route.name === 'agents'">
  <div class="nova-placeholder">
    <div class="nova-eyebrow">◉ AGENTS</div>
    <h1 class="nova-display" style="font-size:32px;margin:8px 0 6px">Coming soon.</h1>
    <p class="nova-subtitle">Flat cross-galaxy view of every registered agent — advertised skills, trust tier, DID, last-seen.</p>
  </div>
</template>
```

Becomes:

```html
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

Notes on the HTML:
- The `<a>` card with `:href="#/galaxy/${a.tenantId}"` uses the existing galaxy-detail hash route — clicking a card navigates to that agent's galaxy.
- The galaxy pill uses `a.tenantId` as its text (that's the slug). Planet color uses the existing `planetStyle()` function with `a.tenantId` so colors are stable per galaxy and match the Galaxies tab.
- Skills render as chips showing `s.name` with `s.description` on hover (`title` attribute). Tags are not shown this bite — they're informational but add visual clutter.
- Capability indicators are three labels. Default muted; `.is-on` class lights the label in the active-status green when true.

## Frontend — CSS

Append to `packages/admin-api/public/styles.css`, in the Shell layout section:

```css
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

## Frontend — JavaScript

**File:** `packages/admin-api/public/js/app.js`.

**1. New state** in the returned object (after `allAgents: [],` — insert three lines near the other state):

```js
    allAgents: [],
    allAgentsLoading: false,
    allAgentsError: null,
```

These live alongside the existing `galaxies: []`, `agents: []`, etc. The existing `agents: []` is per-galaxy state (scoped to `currentGalaxy`) — `allAgents` is the cross-galaxy collection. Named distinctly to avoid confusion.

**2. New method** inside the returned object (add near the existing `loadGalaxies()` / `loadGalaxy()`). `loadAllAgents` also ensures `this.galaxies` is populated so the `galaxySlug` helper (below) can resolve tenant IDs to their slugs:

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

**Why `galaxySlug`:** agents are indexed in Redis under their tenant's internal ID (e.g. `tenant_5072f4c969ff`), not its slug. The Galaxies tab routes and `planetStyle()` are keyed on slug, so using `a.tenantId` directly in the Agents tab would produce inconsistent planet colors across the two tabs and display an internal ID in the galaxy pill. `galaxySlug()` is the cheap resolution: look up the agent's `tenantId` in the loaded `galaxies` array, return the matching `slug`. Falls back to the raw id if the galaxies list hasn't loaded (defensive only — `loadAllAgents` eagerly loads galaxies if missing).

**3. Extend `routeLoad()`** to trigger a load when on the agents route:

```js
    async routeLoad() {
      if (!this.token) return;
      if (this.route.name === 'home')   await this.loadGalaxies();
      if (this.route.name === 'galaxy') await this.loadGalaxy(this.route.slug);
      if (this.route.name === 'agents') await this.loadAllAgents();
    },
```

**4. Extend `handleSseAgent()`** so SSE events trigger an Agents refresh when the tab is active:

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

The early `return` after `loadAllAgents()` matters: if we're on the Agents tab we don't also need to refresh `currentGalaxy` (and `currentGalaxy` may even be null).

## Data flow

- User clicks `Agents` in sidebar → hash becomes `#/agents` → `hashchange` → `parseRoute()` → `route.name = 'agents'` → `routeLoad()` → `loadAllAgents()` → GET `/admin/agents` → `allAgents` populated → grid renders
- User clicks an agent card → hash becomes `#/galaxy/:tenantId` → existing galaxy-detail flow
- SSE agent event arrives on any tenant while Agents tab is active → `handleSseAgent` detects `activeTab === 'agents'` → re-fetches `/admin/agents` → grid updates (a newly approved planet appears, an approved agent's skills change, etc.)
- Navigating away from `#/agents` doesn't clear `allAgents` — next visit will re-fetch but meanwhile the stale data is fine since we don't render it

## Error handling

- **Network failure / 500 / 401:** `loadAllAgents` catches, populates `allAgentsError`, fires a toast. Grid hidden; error panel shown instead. 401 also triggers the existing `onUnauthorized` handler which clears the token.
- **Missing fields on an agent (bad Redis data):** the template uses `x-show` guards (`a.description`, `a.skills && a.skills.length > 0`, `a.capabilities?.streaming`) so missing pieces don't render broken DOM.
- **Galaxies fail to load (but agents succeed):** `galaxySlug()` falls back to returning the raw `tenantId`. Cards still render with an internal-ID pill instead of a slug. Functionally correct, visually uglier.
- **Concurrent loads:** no guard needed. If a second load starts while the first is in flight, the later response wins. Stale data isn't dangerous.

## Verification

Manual, same posture as prior bites.

1. Run the admin API and log in.
2. Navigate to the Agents tab. The grid should render with all active agents from all galaxies. Each card shows:
   - Agent name (bold white), agentId (mono grey)
   - Galaxy pill on the right (showing the `tenantId` slug, muted)
   - Planet-colored orb on the left (color derived from tenantId via `planetStyle()`, matching the Galaxies tab)
   - Description below the header row
   - Skill chips in amber (tags intentionally omitted)
   - Three capability indicators along the bottom (streaming / push / history), lit green when true, muted when false
3. Hover a skill chip — `s.description` should appear as a native tooltip.
4. Hover a card — border turns amber, card lifts 1px.
5. Click a card — navigates to `#/galaxy/:tenantId`, galaxy detail renders. Use `← All galaxies` or the Galaxies sidebar item to return.
6. Approve a pending planet in Galaxies → galaxy detail, then click Agents. The newly approved agent should appear in the grid. (If the Agents tab was already active during the approval, it should refresh via SSE without needing manual navigation — verify this by keeping the Agents tab open in one window and approving from another tab/window.)
7. Empty state: if there are no active agents, the "No active agents yet" message renders instead of the grid. Test by deregistering all agents or testing on a fresh Nova.
8. Error state: in DevTools, go to Network → right-click `/admin/agents` → "Block request URL". Refresh the Agents tab. Error panel + toast should render.
9. Reduced motion: with emulation on, hover a card — border still turns amber but the transform doesn't animate.
10. `npm test` still passes 11/11 (no test changes this bite).
11. Grep sweep: `rg "nova-agent-grid|nova-agent-card|nova-skill-chip|nova-capability-indicator" packages/admin-api/public` — four class names, all should appear in both `styles.css` and `index.html`.
12. Planet color consistency check: open the Galaxies tab, note the colors of two galaxies. Click Agents. For agents belonging to those galaxies, the planet orb on each card should be the **same color** as the galaxy's planet on the Galaxies tab. This verifies `galaxySlug()` is resolving correctly.

## Files expected to change

- `packages/admin-api/src/routes/all-agents.ts` — new file, ~10 lines
- `packages/admin-api/src/index.ts` — one import, one `app.use()` call
- `packages/admin-api/public/index.html` — replace the `<template x-if="route.name === 'agents'">` block with the real view
- `packages/admin-api/public/styles.css` — append the `.nova-agent-grid` / `.nova-agent-card` / `.nova-skill-chip` / `.nova-capability-indicator` block
- `packages/admin-api/public/js/app.js` — three new state properties, one new method, two small edits to existing methods (`routeLoad`, `handleSseAgent`)

Approximate size: ~15 backend lines, ~50 HTML lines (replacing ~6), ~30 CSS lines, ~25 JS lines.

## Risks and decisions deferred

- **No DID / trust tier / createdAt / last-seen.** The cards are honest about what we know. Follow-up bite can enrich by adding a `GET /admin/agents/:agentId` call that returns the full `AgentConfig` + trust entry on card expand, without changing the list response.
- **No filter/search.** If an operator has ~20 agents it's fine; at ~200 it'll sag. Filter/search is a natural second bite.
- **Pending agents still in Galaxies > galaxy detail, not here.** Deliberate. Approval is a galaxy-context action; mixing states in the Agents tab muddied purpose. If operators report hunting for pending in the Agents tab, revisit.
- **Card click goes to galaxy, not an agent-detail.** Simplest routing. A dedicated agent-detail page could layer on later without changing the cards.
- **SSE refresh refetches the whole list.** Simpler than diffing. At reasonable scale it's cheap; the list is Redis-backed and fast.
- **No automated tests.** Matches prior bites. The existing vitest harness only covers client-side code via jsdom. Adding server-side route tests would require supertest + Redis mocking — bigger than this bite's scope.
