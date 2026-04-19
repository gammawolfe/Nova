# Admin UI Audit Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Audit placeholder with a cross-galaxy event table backed by a new `GET /admin/audit` aggregator route.

**Architecture:** New backend service helper `queryAllAuditLogs` fans out `queryAuditLogs` across tenants and merges results. New `GET /admin/audit` route wraps the helper behind admin auth. Frontend replaces the placeholder with a div-grid table + filter row + click-to-expand metadata JSON. Two Playwright smoke tests replace the existing placeholder test.

**Tech Stack:** Express + TypeScript (backend), Alpine.js + vanilla CSS (frontend), Playwright (e2e). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-04-19-admin-ui-audit-tab-design.md`

---

## Dev loop

```bash
# Type-check after backend edits
cd packages/admin-api && npx tsc --noEmit

# Run client-side tests
cd packages/admin-api && npm test

# Run full e2e suite
cd packages/admin-api && npm run test:e2e

# Rebuild container (end of plan)
cd /Users/tyewolfe/Projects/Nova && docker-compose up -d --build admin-api
```

Admin token: `my-secure-admin-token-12345`. UI at `http://localhost:3005`.

---

## Task 1: Add `queryAllAuditLogs` service helper

**Why:** Lifts per-tenant `queryAuditLogs` into a cross-galaxy aggregator. Called by the new route in Task 2.

**Files:**
- Modify: `packages/admin-api/src/services/audit-service.ts` (append helper + one import)

- [ ] **Step 1: Add the `fs/promises` import at the top**

Open `packages/admin-api/src/services/audit-service.ts`. The current imports are:

```ts
import { createReadStream } from 'fs';
import path from 'path';
import readline from 'readline';
import { DATA_ROOT } from '@nova/shared/src/tenant';
import { AuditEvent } from '@nova/shared/src/types';
```

Add two imports immediately after:

```ts
import { createReadStream } from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { DATA_ROOT } from '@nova/shared/src/tenant';
import { AuditEvent } from '@nova/shared/src/types';
import { ID_RE } from '@nova/shared/src/validation';
```

- [ ] **Step 2: Append the `queryAllAuditLogs` function at end of file**

After the existing `getTaskAudit` function (currently the last in the file), append:

```ts

/**
 * Cross-galaxy audit aggregator: fans out queryAuditLogs across all tenants
 * in DATA_ROOT/audit, merges the per-tenant results, sorts newest-first, and
 * truncates to the caller's limit.
 *
 * `total` is the sum of per-tenant totals matching the filter — an upper
 * bound on "how many matches across all galaxies" before merge truncation.
 * Pagination (offset) is deliberately not exposed at the cross-galaxy level
 * because offset-within-sort-order is ambiguous across independent sources.
 */
export async function queryAllAuditLogs(
  filters: {
    event?: string | undefined; from?: string | undefined; to?: string | undefined;
    taskId?: string | undefined; limit?: number | undefined;
  }
): Promise<{ events: AuditEvent[]; total: number }> {
  const rootAuditDir = path.join(DATA_ROOT, 'audit');
  let tenantDirs: string[];
  try { tenantDirs = await fsp.readdir(rootAuditDir); }
  catch { return { events: [], total: 0 }; }

  const validTenants = tenantDirs.filter(d => ID_RE.test(d));
  const limit = filters.limit ?? 50;

  const perTenant = await Promise.all(
    validTenants.map(tenantId =>
      queryAuditLogs(tenantId, { ...filters, limit, offset: 0 })
        .catch(() => ({ events: [] as AuditEvent[], total: 0 })),
    ),
  );

  const merged = perTenant.flatMap(r => r.events);
  merged.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const totalCounted = perTenant.reduce((sum, r) => sum + r.total, 0);
  return { events: merged.slice(0, limit), total: totalCounted };
}
```

- [ ] **Step 3: Type-check**

```bash
cd packages/admin-api && npx tsc --noEmit
```

Expected: silent success.

- [ ] **Step 4: Run tests**

```bash
cd packages/admin-api && npm test
```

Expected: `Tests  11 passed (11)`. The existing jsdom tests don't touch this file; we're verifying nothing compiles-broken elsewhere.

- [ ] **Step 5: Commit**

```bash
git add packages/admin-api/src/services/audit-service.ts
git commit -m "feat(admin-api): add queryAllAuditLogs cross-galaxy aggregator

Thin fan-out around queryAuditLogs: iterates tenant directories in
DATA_ROOT/audit, applies the same filters to each, merges + sorts
newest-first, truncates to limit. 'total' is the sum of per-tenant
matches (upper bound). Pagination intentionally not exposed — offset
across independent sorted streams is ambiguous without a single
underlying index."
```

---

## Task 2: Add `GET /admin/audit` route

**Why:** Exposes the aggregator via an admin-auth endpoint the frontend can call.

**Files:**
- Create: `packages/admin-api/src/routes/all-audit.ts`
- Modify: `packages/admin-api/src/index.ts` (one import, one mount line)

- [ ] **Step 1: Create the new route file**

Create `packages/admin-api/src/routes/all-audit.ts` with this exact content:

```ts
import { Router, Request, Response, NextFunction } from 'express';
import { AuditQuerySchema } from '@nova/shared/src/admin-schemas';
import * as auditService from '../services/audit-service';

export const allAuditRouter = Router();

allAuditRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filters = AuditQuerySchema.parse(req.query);
    const { events, total } = await auditService.queryAllAuditLogs({
      event: filters.event,
      from: filters.from,
      to: filters.to,
      taskId: filters.taskId,
      limit: filters.limit,
    });
    res.json({ events, total });
  } catch (err) { next(err); }
});
```

- [ ] **Step 2: Import the router in `index.ts`**

Open `packages/admin-api/src/index.ts`. Find the existing `allAgentsRouter` import (added in the Agents-tab bite). Add one more import immediately after:

```ts
import { allAgentsRouter } from './routes/all-agents';
import { allAuditRouter } from './routes/all-audit';
```

- [ ] **Step 3: Mount the router**

Find the existing mount line:

```ts
app.use('/admin/tenants', tenantsRouter);
app.use('/admin/agents', allAgentsRouter);
app.use('/admin/tenants/:tenantId/invites', invitesRouter);
```

Insert the new mount between `allAgentsRouter` and `invitesRouter`:

```ts
app.use('/admin/tenants', tenantsRouter);
app.use('/admin/agents', allAgentsRouter);
app.use('/admin/audit', allAuditRouter);
app.use('/admin/tenants/:tenantId/invites', invitesRouter);
```

Order note: `/admin/audit` sits before the `/admin/tenants/:tenantId/*` routes so the Express router matches it as a literal segment rather than trying to interpret "audit" as a tenantId.

- [ ] **Step 4: Type-check**

```bash
cd packages/admin-api && npx tsc --noEmit
```

Expected: silent success.

- [ ] **Step 5: Run tests**

```bash
cd packages/admin-api && npm test
```

Expected: 11/11 passing.

- [ ] **Step 6: Commit**

```bash
git add packages/admin-api/src/routes/all-audit.ts packages/admin-api/src/index.ts
git commit -m "feat(admin-api): add GET /admin/audit cross-galaxy route

Thin admin-auth wrapper around queryAllAuditLogs. Reuses the existing
AuditQuerySchema for filter validation. Mounted at /admin/audit so
Express matches it as a literal path segment, not as a tenantId under
/admin/tenants/:tenantId. Consumed by the upcoming Audit tab view."
```

---

## Task 3: Append Audit tab CSS

**Why:** Additive. After this task the new classes exist but have no HTML consumers — UI unchanged.

**Files:**
- Modify: `packages/admin-api/public/styles.css` (append)

- [ ] **Step 1: Append the Audit block to the end of the file**

Open `packages/admin-api/public/styles.css`. Scroll to the end (last block is `.nova-live-empty-sun`). Append:

```css

/* ── Audit tab ─────────────────────────────────────────────────────────── */
.nova-audit-list {
  font-family: var(--font-mono);
  font-size: 12px;
}
.nova-audit-head,
.nova-audit-row {
  display: grid;
  grid-template-columns: 180px 220px 150px 140px 1fr;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  align-items: center;
}
.nova-audit-head {
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
  font-size: 10px;
  font-weight: 600;
}
.nova-audit-row {
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.1s ease;
}
.nova-audit-row:hover { background: rgba(255, 255, 255, 0.02); }
.nova-audit-row.is-expanded { background: rgba(245, 166, 35, 0.04); }
.nova-audit-row span:nth-child(2) { color: var(--text); }

.nova-audit-row span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nova-audit-expanded {
  padding: 0 12px 12px;
  border-bottom: 1px solid var(--border);
}
.nova-audit-metadata {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11px;
  overflow-x: auto;
  margin: 0;
  white-space: pre;
}
```

- [ ] **Step 2: Verify UI unchanged**

No container rebuild yet. If the dev loop is running via `npm run dev`, refresh the browser — walk every tab, confirm nothing looks different. The new classes have no consumers until Task 5.

- [ ] **Step 3: Commit**

```bash
git add packages/admin-api/public/styles.css
git commit -m "feat(admin-ui): add CSS for Audit tab table

Additive block — no HTML consumes these classes yet. Uses a CSS
grid layout (180 / 220 / 150 / 140 / 1fr) for the header + rows
instead of an HTML <table> to sidestep table-parser edge cases
inside Alpine's x-for. Row hover + expanded accent + metadata pre
block all match the existing token palette."
```

---

## Task 4: Add Audit tab state + methods + routeLoad branch

**Why:** The data layer. After this task, navigating to `#/audit` fires a fetch to `/admin/audit` and populates `auditEvents`, but the placeholder HTML still renders, so no visible change.

**Files:**
- Modify: `packages/admin-api/public/js/app.js` (state, new methods, routeLoad extension)

- [ ] **Step 1: Add the new state properties**

Find the existing Live-tab state block (added in Live-1 bite):

```js
    rotationDeg: 0,
    activeLines: [],
    hoverGalaxy: null,
    sidebarCollapsed: readSidebarState(),
```

Add five audit-tab state properties immediately after `hoverGalaxy`:

```js
    rotationDeg: 0,
    activeLines: [],
    hoverGalaxy: null,
    auditEvents: [],
    auditLoading: false,
    auditError: null,
    auditFilters: { event: '', taskId: '', tenantId: '' },
    auditExpanded: null,
    sidebarCollapsed: readSidebarState(),
```

- [ ] **Step 2: Add the `visibleAuditEvents` getter and the two methods**

Find the `galaxySlug(tenantId)` method (added in the Agents-tab bite):

```js
    galaxySlug(tenantId) {
      const match = this.galaxies.find(g => g.id === tenantId || g.slug === tenantId);
      return match?.slug || tenantId;
    },
```

Add three members immediately after (before `get livePlanets`):

```js
    galaxySlug(tenantId) {
      const match = this.galaxies.find(g => g.id === tenantId || g.slug === tenantId);
      return match?.slug || tenantId;
    },

    get visibleAuditEvents() {
      if (!this.auditFilters.tenantId) return this.auditEvents;
      return this.auditEvents.filter(e => e.tenantId === this.auditFilters.tenantId);
    },

    async loadAuditEvents() {
      this.auditLoading = true;
      this.auditError = null;
      try {
        const params = new URLSearchParams();
        if (this.auditFilters.event) params.set('event', this.auditFilters.event);
        if (this.auditFilters.taskId) params.set('taskId', this.auditFilters.taskId);
        params.set('limit', '50');

        const galaxiesPromise = this.galaxies.length === 0
          ? this.loadGalaxies()
          : Promise.resolve();
        const [res] = await Promise.all([
          api('GET', '/admin/audit?' + params.toString()),
          galaxiesPromise,
        ]);
        this.auditEvents = res?.events || [];
      } catch (e) {
        this.auditError = e.message || 'Load failed';
        this.pushToast(this.auditError, 'err');
      } finally {
        this.auditLoading = false;
      }
    },

    toggleAuditRow(eventId) {
      this.auditExpanded = this.auditExpanded === eventId ? null : eventId;
    },
```

- [ ] **Step 3: Extend `routeLoad` to trigger `loadAuditEvents` on `#/audit`**

Find the current `routeLoad`:

```js
    async routeLoad() {
      if (!this.token) return;
      if (this.route.name === 'home')   await this.loadGalaxies();
      if (this.route.name === 'galaxy') await this.loadGalaxy(this.route.slug);
      if (this.route.name === 'agents') await this.loadAllAgents();
      if (this.route.name === 'live')   await this.loadAllAgents();
    },
```

Add the audit branch:

```js
    async routeLoad() {
      if (!this.token) return;
      if (this.route.name === 'home')   await this.loadGalaxies();
      if (this.route.name === 'galaxy') await this.loadGalaxy(this.route.slug);
      if (this.route.name === 'agents') await this.loadAllAgents();
      if (this.route.name === 'live')   await this.loadAllAgents();
      if (this.route.name === 'audit')  await this.loadAuditEvents();
    },
```

- [ ] **Step 4: Verify data loads on `#/audit`**

Refresh the UI, log in, click Audit. Open DevTools → Network → confirm a GET to `/admin/audit?limit=50` returns 200 with `{ events: [...], total: N }`.

Open Console:

```js
Alpine.$data(document.querySelector('[x-data]')).auditEvents.length
```

Expected: an integer reflecting how many audit events are in the last 7 days (may be 0 on a quiet dev instance).

The Audit tab itself still shows the placeholder ("Coming soon.") — that's expected until Task 5.

- [ ] **Step 5: Run tests**

```bash
cd packages/admin-api && npm test
```

Expected: 11/11 passing.

- [ ] **Step 6: Commit**

```bash
git add packages/admin-api/public/js/app.js
git commit -m "feat(admin-ui): add Audit tab data layer

New state: auditEvents, auditLoading, auditError, auditFilters
(event/taskId/tenantId), auditExpanded. New getter
visibleAuditEvents applies the galaxy filter client-side (the other
two filters go to the backend via query string). New methods
loadAuditEvents (fetches /admin/audit with filters, eagerly loads
galaxies for slug resolution) and toggleAuditRow. routeLoad fires
loadAuditEvents on #/audit. No template consumes this state yet —
the HTML wiring lands in the next task."
```

---

## Task 5: Replace the Audit placeholder with the real view

**Why:** The visible change. Swaps the "Coming soon" placeholder for the table + filters + expandable rows.

**Files:**
- Modify: `packages/admin-api/public/index.html` (replace one `<template>` block)

- [ ] **Step 1: Replace the Audit placeholder**

Find the Audit placeholder in `index.html` (from the shell bite):

```html
      <!-- PLACEHOLDER: Audit -->
      <template x-if="route.name === 'audit'">
        <div class="nova-placeholder">
          <div class="nova-eyebrow">◉ AUDIT</div>
          <h1 class="nova-display" style="font-size:32px;margin:8px 0 6px">Coming soon.</h1>
          <p class="nova-subtitle">Task audit log — which agent sent what to whom, when, and with what result. Feeds from <code>/admin/audit</code>.</p>
        </div>
      </template>
```

Replace with the real view:

```html
      <!-- AUDIT -->
      <template x-if="route.name === 'audit'">
        <div>
          <div class="nova-eyebrow">◉ AUDIT</div>
          <h1 class="nova-display" style="font-size:40px;margin:6px 0">Audit</h1>
          <p class="nova-subtitle" style="margin-bottom:20px" x-text="auditEvents.length + ' ' + (auditEvents.length === 1 ? 'event' : 'events') + ' in the last 7 days'"></p>

          <div class="nova-row" style="gap:12px;margin-bottom:20px;flex-wrap:wrap">
            <select class="nova-input" style="width:auto;min-width:200px" x-model="auditFilters.event" @change="loadAuditEvents()">
              <option value="">All event types</option>
              <option value="task_started">task_started</option>
              <option value="task_completed">task_completed</option>
              <option value="task_expired">task_expired</option>
              <option value="message_received">message_received</option>
              <option value="message_parse_failed">message_parse_failed</option>
              <option value="gate_503">gate_503</option>
              <option value="ucan_verified">ucan_verified</option>
              <option value="ucan_failed">ucan_failed</option>
              <option value="actor_resolved">actor_resolved</option>
              <option value="actor_unknown">actor_unknown</option>
              <option value="schema_valid">schema_valid</option>
              <option value="schema_invalid">schema_invalid</option>
              <option value="injection_clear">injection_clear</option>
              <option value="injection_pattern_match">injection_pattern_match</option>
              <option value="injection_detected">injection_detected</option>
              <option value="injection_suspected">injection_suspected</option>
              <option value="injection_pattern_clear">injection_pattern_clear</option>
              <option value="classifier_unavailable">classifier_unavailable</option>
              <option value="confirm_requested">confirm_requested</option>
              <option value="confirm_approved">confirm_approved</option>
              <option value="confirm_denied">confirm_denied</option>
              <option value="confirm_timeout">confirm_timeout</option>
              <option value="delivery_success">delivery_success</option>
              <option value="delivery_transient_failure">delivery_transient_failure</option>
              <option value="delivery_permanent_failure">delivery_permanent_failure</option>
              <option value="dead_letter_written">dead_letter_written</option>
            </select>

            <select class="nova-input" style="width:auto;min-width:180px" x-model="auditFilters.tenantId">
              <option value="">All galaxies</option>
              <template x-for="g in galaxies" :key="g.id">
                <option :value="g.id" x-text="g.slug"></option>
              </template>
            </select>

            <input class="nova-input" style="width:auto;min-width:280px;font-family:var(--font-mono);font-size:12px"
                   placeholder="task id (uuid)" x-model.debounce.300ms="auditFilters.taskId" @input="loadAuditEvents()">

            <button class="nova-input" style="width:auto;padding:10px 16px" @click="loadAuditEvents()">
              Refresh
            </button>
          </div>

          <div x-show="auditLoading" class="nova-glass" style="text-align:center;color:var(--text-secondary)">
            Loading events…
          </div>

          <div x-show="auditError" class="nova-glass" style="text-align:center;color:var(--status-error)" x-text="auditError"></div>

          <div x-show="!auditLoading && !auditError && visibleAuditEvents.length === 0" class="nova-glass" style="text-align:center;color:var(--text-secondary)">
            No events match these filters.
          </div>

          <div x-show="!auditLoading && !auditError && visibleAuditEvents.length > 0" class="nova-audit-list">
            <div class="nova-audit-head">
              <span>Timestamp</span>
              <span>Event</span>
              <span>Galaxy</span>
              <span>Agent</span>
              <span>Task ID</span>
            </div>
            <template x-for="e in visibleAuditEvents" :key="e.eventId">
              <div>
                <div class="nova-audit-row" :class="auditExpanded === e.eventId && 'is-expanded'" @click="toggleAuditRow(e.eventId)">
                  <span class="nova-mono" x-text="e.timestamp.slice(0, 19).replace('T', ' ')"></span>
                  <span x-text="e.event"></span>
                  <span x-text="galaxySlug(e.tenantId)"></span>
                  <span class="nova-mono" x-text="e.agentId"></span>
                  <span class="nova-mono" x-text="e.taskId ? e.taskId.slice(0, 8) + '…' : ''"></span>
                </div>
                <div x-show="auditExpanded === e.eventId" class="nova-audit-expanded">
                  <pre class="nova-audit-metadata" x-text="JSON.stringify({ eventId: e.eventId, taskId: e.taskId, metadata: e.metadata }, null, 2)"></pre>
                </div>
              </div>
            </template>
          </div>

          <p x-show="!auditLoading && !auditError && visibleAuditEvents.length >= 50" class="nova-subtitle" style="margin-top:12px;text-align:center">
            Showing 50 most recent · refine filters for older events
          </p>
        </div>
      </template>
```

Comment label changes from `PLACEHOLDER: Audit` to `AUDIT`.

- [ ] **Step 2: Visually verify in the browser**

Refresh and click Audit. Expect:

- Header: amber `◉ AUDIT` eyebrow, gradient "Audit" title, subtitle with event count
- Filter row: event-type dropdown, galaxy dropdown, task-id input, Refresh button
- Event list below (or "No events match" if nothing in the last 7 days)
- Each row shows timestamp · event · galaxy slug · agent · truncated task id
- Click a row — it highlights amber-tinted and metadata JSON expands below
- Click again — collapses
- Change event-type dropdown — table re-fetches and re-renders with the filter applied
- Change galaxy dropdown — table filters client-side immediately
- Type a task id — after ~300ms debounce, re-fetches

- [ ] **Step 3: Run tests**

```bash
cd packages/admin-api && npm test
```

Expected: 11/11 passing.

- [ ] **Step 4: Commit**

```bash
git add packages/admin-api/public/index.html
git commit -m "feat(admin-ui): replace Audit placeholder with real event table

Filter row (event-type dropdown, galaxy dropdown, debounced task-id
input, Refresh button) sits above a div-grid list of events.
Event-type and task-id changes hit the backend; galaxy filter is
client-side via visibleAuditEvents getter. Click a row to expand
its metadata as formatted JSON. Empty state renders a quiet card
with copy. 50-row cap with hint when reached."
```

---

## Task 6: Replace the placeholder Playwright test with real Audit coverage

**Why:** The existing `Audit tab renders placeholder` test in `admin-ui-tabs.spec.ts` checks for "Coming soon" text that no longer exists. Replace it with tests that assert the real view renders and filters work.

**Files:**
- Modify: `packages/admin-api/test/e2e/admin-ui-tabs.spec.ts`

- [ ] **Step 1: Add synthetic audit events and the `/admin/audit` route mock**

Open `packages/admin-api/test/e2e/admin-ui-tabs.spec.ts`. At the top of the file, below the `AGENT_BETA` constant, add the synthetic audit events:

```ts
const SAMPLE_AUDIT_EVENTS = [
  {
    eventId: '11111111-1111-1111-1111-111111111111',
    timestamp: '2026-04-19T10:00:00.000Z',
    tenantId: 'tenant_test',
    agentId: 'alpha',
    event: 'task_completed',
    taskId: '22222222-2222-2222-2222-222222222222',
    metadata: { status: 'success', durationMs: 1234 },
  },
  {
    eventId: '33333333-3333-3333-3333-333333333333',
    timestamp: '2026-04-19T09:00:00.000Z',
    tenantId: 'tenant_test',
    agentId: 'beta',
    event: 'injection_detected',
    metadata: { pattern: 'PROMPT_OVERRIDE', confidence: 0.92 },
  },
];
```

Extend `mockAdminEndpoints` to handle `/admin/audit`. Find the existing function:

```ts
async function mockAdminEndpoints(page: any) {
  await page.route('**/admin/tenants', async (route: any) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([TENANT]) });
    } else {
      await route.continue();
    }
  });
  await page.route('**/admin/agents', async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ agents: [AGENT_ALPHA, AGENT_BETA], total: 2 }),
    });
  });
}
```

Replace with:

```ts
async function mockAdminEndpoints(page: any) {
  await page.route('**/admin/tenants', async (route: any) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([TENANT]) });
    } else {
      await route.continue();
    }
  });
  await page.route('**/admin/agents', async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ agents: [AGENT_ALPHA, AGENT_BETA], total: 2 }),
    });
  });
  await page.route('**/admin/audit**', async (route: any) => {
    const url = new URL(route.request().url());
    const eventFilter = url.searchParams.get('event');
    const events = eventFilter
      ? SAMPLE_AUDIT_EVENTS.filter(e => e.event === eventFilter)
      : SAMPLE_AUDIT_EVENTS;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ events, total: events.length }),
    });
  });
}
```

- [ ] **Step 2: Replace the old Audit placeholder test with two real tests**

Find the existing Audit test:

```ts
test('Audit tab renders placeholder', async ({ page }) => {
  await login(page);
  await page.click('.nova-nav-item:has-text("Audit")');
  await expect(page.locator('.nova-placeholder')).toContainText('AUDIT');
  await expect(page.locator('.nova-placeholder')).toContainText('Coming soon');
});
```

Replace with:

```ts
test('Audit tab renders event list and expands row on click', async ({ page }) => {
  await login(page);
  await page.click('.nova-nav-item:has-text("Audit")');

  await expect(page.locator('.nova-audit-list')).toBeVisible();
  await expect(page.locator('.nova-audit-row')).toHaveCount(2);
  await expect(page.locator('.nova-audit-row').first()).toContainText('task_completed');
  await expect(page.locator('.nova-audit-row').nth(1)).toContainText('injection_detected');

  await page.locator('.nova-audit-row').first().click();
  await expect(page.locator('.nova-audit-metadata')).toBeVisible();
  await expect(page.locator('.nova-audit-metadata')).toContainText('durationMs');
});

test('Audit tab event-type filter triggers re-fetch', async ({ page }) => {
  await login(page);
  await page.click('.nova-nav-item:has-text("Audit")');
  await expect(page.locator('.nova-audit-row')).toHaveCount(2);

  await page.selectOption('select.nova-input >> nth=0', 'injection_detected');
  await expect(page.locator('.nova-audit-row')).toHaveCount(1);
  await expect(page.locator('.nova-audit-row').first()).toContainText('injection_detected');
});
```

- [ ] **Step 3: Run the e2e suite**

```bash
cd packages/admin-api && npm run test:e2e
```

Expected: **14 passed** (4 onboarding + 8 previous admin-UI + 2 new audit tests). The full tab tour no-console-errors test automatically covers the new real Audit view.

- [ ] **Step 4: Commit**

```bash
git add packages/admin-api/test/e2e/admin-ui-tabs.spec.ts
git commit -m "test(admin-ui): replace Audit placeholder test with real coverage

Adds SAMPLE_AUDIT_EVENTS + a /admin/audit route mock that respects
the event query param so the filter test can assert a narrowed
result. Two new tests: 'renders event list and expands row on
click' and 'event-type filter triggers re-fetch'. Removes the old
'renders placeholder' test whose assertion no longer holds."
```

---

## Task 7: Final sweep and container rebuild

**Why:** Confirm nothing is stale and ship the backend + frontend changes into the running container.

**Files:** No code changes expected unless Step 1 surfaces an issue.

- [ ] **Step 1: Grep for leftover placeholder text**

From the repo root:

```bash
rg "Coming soon" packages/admin-api/public/index.html
```

Expected: **zero matches**. All three placeholders (Agents in bite 3, Live in bite 4, Audit in this bite) have been replaced.

- [ ] **Step 2: Grep for the new Audit class names**

```bash
rg "nova-audit-" packages/admin-api/public
```

Expected: matches in both `styles.css` and `index.html` — at least `nova-audit-list`, `nova-audit-head`, `nova-audit-row`, `nova-audit-expanded`, `nova-audit-metadata`.

- [ ] **Step 3: Grep for the new backend symbols**

```bash
rg "queryAllAuditLogs|allAuditRouter" packages --type ts
```

Expected:
- `services/audit-service.ts` — export `queryAllAuditLogs`
- `routes/all-audit.ts` — import + use
- `index.ts` — import + mount

- [ ] **Step 4: Type-check and tests**

```bash
cd packages/admin-api && npx tsc --noEmit
cd packages/admin-api && npm test
cd packages/admin-api && npm run test:e2e
```

All three should succeed:
- tsc: silent
- unit tests: 11/11
- e2e: 14/14

- [ ] **Step 5: Rebuild the container**

```bash
cd /Users/tyewolfe/Projects/Nova
docker-compose up -d --build admin-api
```

Wait for `Container nova-admin-api-1 Started` and give ~5 seconds for boot.

- [ ] **Step 6: Verify the new route is live**

```bash
# Route responds 200 with the expected shape
curl -s http://localhost:3005/admin/audit \
  -H "Authorization: Bearer my-secure-admin-token-12345" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('events:', len(d['events']), 'total:', d['total'])"
# Expected: events: N total: N (possibly 0/0 on a quiet dev instance — that's fine)

# 401 without auth
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3005/admin/audit
# Expected: 401

# Static bundle has the new CSS
curl -s http://localhost:3005/styles.css | grep -c 'nova-audit-'
# Expected: 5 or more

# Static bundle has the new HTML
curl -s http://localhost:3005/ | grep -c 'nova-audit-list\|auditEvents'
# Expected: 3 or more
```

- [ ] **Step 7: Final browser check**

Visit `http://localhost:3005/#/audit`. The real view renders with filters, empty state (if no events) or the event list. Click a row to confirm metadata expansion works against the container. If a real event has fired recently (e.g. from previous task-send attempts), you'll see it here.

- [ ] **Step 8: If Steps 1–7 surfaced any fixes, commit them**

```bash
git add packages/admin-api/
git commit -m "fix(admin-ui): cleanup after Audit tab sweep"
```

If no fixes needed, skip.

---

## Self-review

**Spec coverage** — every spec requirement traces to a task:
- `queryAllAuditLogs` service helper → Task 1
- `GET /admin/audit` route + mount → Task 2
- CSS for `.nova-audit-list` / `-head` / `-row` / `-expanded` / `-metadata` → Task 3
- Alpine state (`auditEvents`, `auditLoading`, `auditError`, `auditFilters`, `auditExpanded`) → Task 4 Step 1
- `visibleAuditEvents` getter → Task 4 Step 2
- `loadAuditEvents` + `toggleAuditRow` → Task 4 Step 2
- `routeLoad` extension → Task 4 Step 3
- HTML replacement → Task 5
- Playwright tests (event list renders, row expands, event-type filter re-fetches) → Task 6
- Empty / loading / error states → Task 5's template
- 50-row cap with hint → Task 5's template
- Container rebuild → Task 7

**Placeholder scan** — no TBD/TODO. Every code block is concrete.

**Type consistency** — `queryAllAuditLogs`, `queryAuditLogs`, `allAuditRouter`, `AuditQuerySchema`, `auditEvents`, `auditFilters`, `visibleAuditEvents`, `toggleAuditRow`, `loadAuditEvents`, `SAMPLE_AUDIT_EVENTS`, `.nova-audit-list` — all spelled identically across tasks. The route is `/admin/audit` (singular) everywhere. Event-type enum values in the dropdown match the `AuditEventSchema` enum in `packages/shared/src/schemas.ts`.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-19-admin-ui-audit-tab.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
