# Admin UI Audit tab — final placeholder

**Status:** design approved 2026-04-19
**Scope:** Replace the Audit placeholder with a cross-galaxy event log. Adds one new admin-auth backend route `GET /admin/audit` that aggregates per-tenant audit files.
**Prior bites:**
- palette / shell / Agents / Live-1 / Live-2 / SVG fix / Playwright smoke tests (all merged)

**Next bites (not this work):** date-range picker, pagination (`Load more` button calling `offset`), export to JSON, `audit` SSE channel for live events.

## Motivation

The shell bite wired an Audit placeholder promising "task audit log — which agent sent what to whom, when, and with what result." The backend already has `queryAuditLogs()` service and a per-tenant route. This bite exposes the data in the admin UI via a cross-galaxy aggregator — the single surface operators want when triaging "what just happened in my Nova."

The per-tenant route `GET /admin/tenants/:tenantId/audit` stays. The new `GET /admin/audit` is the aggregator. Follows the same pattern we used for `/admin/agents` in the Agents-tab bite.

## Scope

**In scope**
- New backend route `GET /admin/audit` — admin-auth — iterates tenants in `DATA_ROOT/audit`, calls the existing `queryAuditLogs()` per tenant with the same filters, merges + sorts by `timestamp` desc, truncates to `limit`. Response shape: `{ events: AuditEvent[], total: number }`.
- Replace the Audit placeholder in `index.html` with:
  - Header and dynamic count
  - Filter row: event-type dropdown (all 22 enum values + "All events"), galaxy dropdown (populated from `galaxies`), task-id text input, refresh button
  - Compact table: Timestamp · Event · Galaxy · Agent · Task ID
  - Click a row to expand inline and render `metadata` as formatted JSON
- New Alpine state: `auditEvents`, `auditLoading`, `auditError`, `auditFilters`, `auditExpanded`
- New methods: `loadAuditEvents`, `toggleAuditRow`
- `routeLoad` trigger on `#/audit`
- New CSS for `.nova-audit-table`, `.nova-audit-row`, `.nova-audit-expanded`, `.nova-audit-metadata`
- Playwright smoke test covering: table renders with mocked events, event-type filter triggers re-fetch, row expands with metadata

**Out of scope**
- Date range picker — stick with the server's 7-day default. Operators can override via URL query if they really need older events this bite.
- Pagination — top 50 only with copy hint: "50 most recent; refine filters to see older events." Add `Load more` later.
- Export to CSV / JSON — separate bite.
- Live refresh via SSE — `audit` is not a current SSE event type; would require publishing from `auditLog()` in shared. Deferred.
- Per-event-type color coding. Stick with a monospace flat table for now; colors tempt over-design.
- Filtering across galaxies + task id + event type at once (all three are supported server-side already via query params; just not yet all-wired on the UI).

## Backend — `GET /admin/audit`

**File:** `packages/admin-api/src/services/audit-service.ts` (append one helper) and `packages/admin-api/src/routes/all-audit.ts` (new).

### New service helper: `queryAllAuditLogs`

Append to `audit-service.ts`:

```ts
import fsp from 'fs/promises';
import { ID_RE } from '@nova/shared/src/validation';

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

  // Fetch per-tenant in parallel with the same filters + limit (so each tenant
  // caps its contribution at `limit`). Merge after.
  const perTenant = await Promise.all(
    validTenants.map(tenantId =>
      queryAuditLogs(tenantId, { ...filters, limit, offset: 0 }).catch(() => ({ events: [], total: 0 })),
    ),
  );

  const merged = perTenant.flatMap(r => r.events);
  merged.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const totalCounted = perTenant.reduce((sum, r) => sum + r.total, 0);
  return { events: merged.slice(0, limit), total: totalCounted };
}
```

**Note on semantics:** `total` is the sum of per-tenant totals that matched the filter (before the merge truncation). Gives the operator a rough "there are N matches in this window; showing top M."

**Note on pagination:** cross-galaxy offset is ambiguous (offset within which ordering?). We pass `offset: 0` to each tenant and rely on truncating the merged list. Since there's no UI for pagination this bite, the `offset` query parameter is intentionally not exposed on the `/admin/audit` route.

### New route: `packages/admin-api/src/routes/all-audit.ts`

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

Mount in `packages/admin-api/src/index.ts`, alongside `/admin/agents`:

```ts
import { allAuditRouter } from './routes/all-audit';
// ...
app.use('/admin/tenants', tenantsRouter);
app.use('/admin/agents', allAgentsRouter);
app.use('/admin/audit', allAuditRouter);
app.use('/admin/tenants/:tenantId/invites', invitesRouter);
```

## Frontend — HTML

Replace the current Audit placeholder:

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

With:

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

Notes:
- Uses a `<div>`-based grid layout instead of an HTML `<table>`. Alpine's `x-for` expects a single-root template child; the plain `<div>` wrapper around `row` + `expanded` sibling divs satisfies that cleanly without the HTML table parser quirks.
- Timestamp formatting strips the `T` and trailing ms for readability. Full ISO is still visible in the expanded metadata JSON.
- Task ID is truncated to the first 8 chars; click-to-expand shows the full UUID.
- Event-type `<option>` list is static — 26 values match the `AuditEventSchema` enum. New event types need updating here.
- Galaxy filter uses `tenantId` (internal id) as its value so it matches `AuditEvent.tenantId` directly without resolution.

## Frontend — JavaScript

**File:** `packages/admin-api/public/js/app.js`.

New state (add alongside `allAgents` etc.):

```js
    auditEvents: [],
    auditLoading: false,
    auditError: null,
    auditFilters: { event: '', taskId: '', tenantId: '' },
    auditExpanded: null,
```

New computed getter — filters `auditEvents` client-side by `tenantId` (the other two filters go to the backend):

```js
    get visibleAuditEvents() {
      if (!this.auditFilters.tenantId) return this.auditEvents;
      return this.auditEvents.filter(e => e.tenantId === this.auditFilters.tenantId);
    },
```

New method:

```js
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

Extend `routeLoad` with the audit branch:

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

The event-type filter in the UI calls `loadAuditEvents()` on `@change`, triggering a server-side re-fetch. The `taskId` input uses `.debounce.300ms` so typing doesn't spam the backend. The galaxy dropdown is client-side filter only (no re-fetch).

## Frontend — CSS

Append to `styles.css`:

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
.nova-audit-row span:nth-child(2) { color: var(--text); } /* event name pops */

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

## Data flow

- User clicks `Audit` → hash `#/audit` → `routeLoad` → `loadAuditEvents` → GET `/admin/audit?limit=50` → backend aggregates across tenants → response JSON → `auditEvents` populated → table renders `visibleAuditEvents`
- User picks event type in dropdown → `@change` fires `loadAuditEvents` with the new filter in the query string
- User types task id → `.debounce.300ms` → `loadAuditEvents`
- User picks galaxy → `auditFilters.tenantId` updates → `visibleAuditEvents` getter re-derives → table filters without network round-trip
- User clicks a row → `toggleAuditRow(e.eventId)` → row expands, metadata JSON renders
- User clicks `Refresh` → `loadAuditEvents` fires again with current filters

## Error handling

- Backend 500 / network failure → `auditError` populated, toast fires, error panel shown, table hidden
- Backend returns empty events array → "No events match these filters" panel
- Malformed JSON from backend → caught in the `try` block, surfaces as "Load failed"
- Click a row with no metadata → metadata JSON still renders (empty object). No special handling needed.

## Playwright smoke test

Add to `test/e2e/admin-ui-tabs.spec.ts` (replace the existing Audit placeholder test). Mocks `/admin/audit` to return synthetic events, asserts table renders, clicking an event row expands.

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

async function mockAdminEndpoints(page: any) {
  // ... existing mocks ...
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

Replace the existing `'Audit tab renders placeholder'` test with:

```ts
test('Audit tab renders event table and expands on click', async ({ page }) => {
  await login(page);
  await page.click('.nova-nav-item:has-text("Audit")');

  await expect(page.locator('.nova-audit-list')).toBeVisible();
  await expect(page.locator('.nova-audit-row')).toHaveCount(2);
  await expect(page.locator('.nova-audit-row').first()).toContainText('task_completed');

  // Click the first row — expand it
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

The `no console errors during full tab tour` test continues to walk Audit and now covers the richer view as well.

## Verification

1. `docker-compose up -d --build admin-api` — deploy the new route
2. `curl http://localhost:3005/admin/audit -H "Authorization: Bearer my-secure-admin-token-12345" | python3 -m json.tool | head -20` — confirm the endpoint returns `{ events: [...], total: N }`. If Nova has had no traffic yet, `events: []` and `total: 0` — expected.
3. Open `http://localhost:3005/#/audit` in the browser. Table renders (or empty state if no events).
4. Trigger some traffic to generate events (fire a task via `nova_send_task` after the UCAN routing fix takes effect). Refresh Audit — events appear.
5. Select an event type from the dropdown — table re-fetches, filters to that event type.
6. Pick a galaxy — table filters client-side to that tenant.
7. Click a row — metadata JSON expands below the row. Click again — collapses.
8. `cd packages/admin-api && npm test` — existing 11 jsdom tests pass.
9. `cd packages/admin-api && npm run test:e2e` — full Playwright suite (4 onboarding + 8 previous admin-UI + 2 new audit = 14 tests) all pass.
10. Grep sweep: `rg "Coming soon" packages/admin-api/public/index.html` → **no matches**. All placeholders replaced.

## Files expected to change

- `packages/admin-api/src/services/audit-service.ts` — append `queryAllAuditLogs` (~25 lines)
- `packages/admin-api/src/routes/all-audit.ts` — new route file (~15 lines)
- `packages/admin-api/src/index.ts` — one import, one `app.use('/admin/audit', allAuditRouter)` line
- `packages/admin-api/public/index.html` — replace Audit placeholder with table + filters (~60 lines net)
- `packages/admin-api/public/js/app.js` — state + getter + two methods + routeLoad branch (~45 lines)
- `packages/admin-api/public/styles.css` — append Audit table block (~35 lines)
- `packages/admin-api/test/e2e/admin-ui-tabs.spec.ts` — replace placeholder test with two real tests + add `/admin/audit` route mock

## Risks and decisions deferred

- **Reading all per-tenant files in parallel** — `queryAllAuditLogs` fans out concurrent file reads. At ~5 tenants × 7 days = 35 JSONL reads, this is fine. At hundreds of tenants, we'd want Redis-based indexing. YAGNI for now.
- **Total-count semantics** — `total` sums per-tenant totals that matched the filter before merge-truncation. It's an upper bound on "events matching these filters across all galaxies," not a precise count after merge. Acceptable for a UI hint.
- **No date range UI** — 7-day default is baked in. If someone needs older events today, they can hit the per-tenant endpoint directly with `from`/`to` query params. Adding a UI picker is a small follow-up.
- **Static event-type dropdown** — 26 hardcoded values. If the backend adds a new event type in `AuditEventSchema`, the dropdown needs updating. Could auto-populate from a backend `/admin/audit/event-types` endpoint later — YAGNI.
- **Galaxy dropdown uses `tenantId` (internal id), not `slug`** — because `AuditEvent.tenantId` is the internal id. The dropdown shows `slug` as its label but sends `tenantId` as its value. Consistent with internal filtering logic.
- **Click-to-expand is per-row, not global** — only one row at a time can be expanded. Keeps the table compact. If debugging a task flow requires multiple open rows, users can search by task id instead.
