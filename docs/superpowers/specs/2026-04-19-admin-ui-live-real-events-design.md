# Admin UI Live tab real events (Live-2)

**Status:** design approved 2026-04-19
**Scope:** Wire real task-lifecycle events into the Live solar-system view. Extend the agent discovery index with DID so source-agent resolution is cheap. Agents tab gains DID display as a side-effect.
**Prior bites:**
- `2026-04-18-admin-ui-palette-refresh-design.md` — palette (merged)
- `2026-04-18-admin-ui-shell-layout-design.md` — shell (merged)
- `2026-04-18-admin-ui-agents-tab-design.md` — Agents tab (merged)
- `2026-04-18-admin-ui-live-tab-design.md` — Live-1 solar-system visualization (merged)

**Next bites (not this work):** `quarantined` event publishing from gate-service; per-line concurrency cap if pileups become a problem; conversation replay from audit log.

## Motivation

Live-1 shipped the solar-system visualization with a stubbed "Demo conversation" button. This bite replaces the stub with real A2A task flow: when agent A sends a task to agent B, an amber line draws between their planets and fades; when the task completes, a green flash; when it fails, a red flash.

That requires three things we don't have today:
1. **A publisher** to `TASK_LIFECYCLE_CHANNEL` (the channel exists, the SSE `/admin/events` subscribes to it, but nothing writes to it)
2. **Source agent resolution** — `QueuedTask` only has `senderDid` (a DID string), not `fromAgentId`/`fromTenantId`. Drawing a line needs both endpoints
3. **SSE consumption** of the `task` event type on the frontend (the server fans it out, the client currently ignores it)

Option B from brainstorming solves source resolution cleanly by extending `AgentMeta` to include `did` and adding a DID → agentId reverse index. The Agents tab gets DID display for free — a previously-deferred item.

## Scope

**In scope**
- `@nova/shared`: extend `AgentMeta` hash fields to include `did`. Extend `ParsedAgentMeta` with `did?: string | undefined`. Add `nova:did-index:<did>` → `<agentId>` reverse index maintained by `indexAgentMeta` + `deindexAgent`. New exported `getAgentByDid(redis, did): Promise<ParsedAgentMeta | null>`.
- `@nova/admin-api`: every call to `indexAgentMeta` now passes the agent's `did` (all callsites already have full `AgentConfig` which carries it)
- `@nova/agent-connector`: publish `TaskLifecycleEvent` to `TASK_LIFECYCLE_CHANNEL` at three moments in `processTask`: entry (`action: 'queued'`), successful completion (`action: 'completed'`), terminal failure (`action: 'failed'`). Event shape extended with optional `fromTenantId`/`fromAgentId` resolved via `getAgentByDid(task.senderDid)`.
- `@nova/shared`: extend `TaskLifecycleEvent` interface with `toTenantId`, `toAgentId`, optional `fromTenantId`, `fromAgentId` (remove old `tenantId`/`agentId` since they were ambiguous about direction)
- Frontend `js/app.js`: new state `activeLines`, new SSE handler `handleSseTask`, new methods `addConversationLine` + `pruneExpiredLines`, line pruning tied into the existing rAF tick, register `task` event on the existing `EventSource`
- Frontend `index.html`: replace the single `.nova-live-demo-line` path with an `x-for` over `activeLines`, each rendered as a `.nova-live-line` with action-specific CSS class
- Frontend `styles.css`: new `.nova-live-line.is-queued` / `.is-completed` / `.is-failed` rules, each with a 2.5s fade animation and color-specific stroke
- Frontend Agents tab: render DID in mono below `agentId` on each card
- "Demo conversation" button renamed to "Simulate conversation" and now adds a `queued` line to `activeLines` (exercises the same code path as real events)
- Manual verification via `nova_send_task` end-to-end

**Out of scope**
- `quarantined` lifecycle publishing (lives in gate-service, separate scope)
- Rate limiting / concurrency cap on `activeLines`
- Replaying recent conversations on tab entry (would need a persisted log; audit_log has the data but consuming it here is a separate bite)
- Per-agent click-to-filter (show only conversations for one agent)
- Task payload preview on line hover
- Migration UX — existing agents without DID in their Redis Hash won't resolve as senders until their Hash is rewritten (on next approve / re-index / container restart with an empty registry). Documented as a known limitation with a manual-flush workaround.
- Automated tests — matches prior bites' posture (no server-side route harness)

## Shared type changes

**`packages/shared/src/agent-index.ts`:**

```ts
// Existing interface — add did
export interface AgentMeta {
  agentId: string;
  tenantId: string;
  name: string;
  description: string;
  status: string;
  skills: string;        // JSON-serialized
  capabilities: string;  // JSON-serialized
  did: string;           // NEW — empty string for legacy agents
}

// Existing interface — replace old fields with directional ones
export interface TaskLifecycleEvent {
  action: 'queued' | 'completed' | 'failed' | 'quarantined';
  taskId: string;
  toTenantId: string;
  toAgentId: string;
  fromTenantId?: string;
  fromAgentId?: string;
}

// Existing interface — add did
export interface ParsedAgentMeta {
  agentId: string;
  tenantId: string;
  name: string;
  description: string;
  status: string;
  skills: Array<{ id: string; name: string; description: string; tags?: string[] | undefined }>;
  capabilities: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean };
  did?: string;  // NEW — undefined if missing from hash (legacy data)
}

// NEW key helper
export function didIndexKey(did: string): string {
  return `nova:did-index:${did}`;
}

// NEW exported helper
export async function getAgentByDid(redis: IORedis, did: string): Promise<ParsedAgentMeta | null> {
  const agentId = await redis.get(didIndexKey(did));
  if (!agentId) return null;
  return getAgentMeta(redis, agentId);
}
```

`indexAgentMeta` signature gains `did` in its input shape (callers already have it) and the pipeline writes the did-index entry:

```ts
await redis.pipeline()
  .set(agentIndexKey(config.agentId), config.tenantId)
  .hset(agentMetaKey(config.agentId), {
    agentId: config.agentId,
    tenantId: config.tenantId,
    name: config.name,
    description: config.description ?? '',
    status: config.status,
    skills: JSON.stringify(config.skills),
    capabilities: JSON.stringify(config.capabilities),
    did: config.did ?? '',
  })
  .set(didIndexKey(config.did), config.agentId)  // NEW (skip if did is empty)
  .sadd(AGENT_REGISTRY_SET, config.agentId)
  .exec();
```

Actually — `.set(didIndexKey(''), ...)` would write a meaningless key. Guard in code:

```ts
const pipe = redis.pipeline()
  .set(agentIndexKey(config.agentId), config.tenantId)
  .hset(agentMetaKey(config.agentId), { ...existing_fields, did: config.did ?? '' })
  .sadd(AGENT_REGISTRY_SET, config.agentId);
if (config.did) pipe.set(didIndexKey(config.did), config.agentId);
await pipe.exec();
```

`deindexAgent` gains did-index cleanup. Since the caller has agentId, not DID, we need to fetch the meta first:

```ts
export async function deindexAgent(redis: IORedis, agentId: string): Promise<void> {
  const did = await redis.hget(agentMetaKey(agentId), 'did');
  const pipe = redis.pipeline()
    .hset(agentMetaKey(agentId), 'status', 'deregistered')
    .srem(AGENT_REGISTRY_SET, agentId)
    .del(agentIndexKey(agentId));
  if (did) pipe.del(didIndexKey(did));
  await pipe.exec();
}
```

`parseAgentMeta` gains `did`:

```ts
return {
  agentId: data['agentId']!,
  tenantId: data['tenantId']!,
  name: data['name']!,
  description: data['description'] ?? '',
  status: data['status']!,
  skills: JSON.parse(data['skills'] || '[]'),
  capabilities: JSON.parse(data['capabilities'] || '{}'),
  did: data['did'] || undefined,  // NEW — undefined if missing
};
```

## Backend publisher — `agent-connector`

**File:** `packages/agent-connector/src/index.ts`.

At the top of `processTask`, before the TTL check:

```ts
async function processTask(job: Job, ctx: TenantContext): Promise<void> {
  const task = job.data as QueuedTask;
  const taskCtx: TenantContext = { tenantId: task.tenantId, agentId: task.agentId };

  logger.info({ jobId: job.id, taskId: task.taskId, intent: task.intent }, 'Processing task');

  // Resolve source agent once for lifecycle events (may be null for unknown senders)
  const sourceAgent = await getAgentByDid(getSharedRedis(), task.senderDid);
  const lifecycleBase = {
    taskId: task.taskId,
    toTenantId: task.tenantId,
    toAgentId: task.agentId,
    ...(sourceAgent ? { fromTenantId: sourceAgent.tenantId, fromAgentId: sourceAgent.agentId } : {}),
  };

  // Publish "queued" at start
  await getSharedRedis().publish(TASK_LIFECYCLE_CHANNEL, JSON.stringify({
    action: 'queued',
    ...lifecycleBase,
  }));

  // ... existing TTL check, confirmation, delivery ...
}
```

And at each terminal exit point in `processTask`, add a publish before the `return`:

- Successful completion (after replyTo delivery):
  ```ts
  await getSharedRedis().publish(TASK_LIFECYCLE_CHANNEL, JSON.stringify({
    action: 'completed',
    ...lifecycleBase,
  }));
  ```
- TTL expired:
  ```ts
  await getSharedRedis().publish(TASK_LIFECYCLE_CHANNEL, JSON.stringify({
    action: 'failed',
    ...lifecycleBase,
  }));
  ```
- Confirmation denied / timed out / delivery failed (4xx or transient) / no operator URL:
  ```ts
  await getSharedRedis().publish(TASK_LIFECYCLE_CHANNEL, JSON.stringify({
    action: 'failed',
    ...lifecycleBase,
  }));
  ```

**Semantic note:** `action: 'queued'` fires when the BullMQ worker first picks up the task — slightly after the task was actually queued by `a2a-server`. For the Live view this is fine; it marks the start of work. True queue-time would need a publisher in `a2a-server`, doubling the surface; defer.

**Note on `working`:** the existing `publishTaskEvent(..., { type: 'status_update', data: { status: 'working' } })` is per-task, not lifecycle. We do NOT add a `working` lifecycle action — the `queued` event is the single "line appears" signal.

## Frontend — SSE consumer + line rendering

**File:** `packages/admin-api/public/js/app.js`.

New state (add next to `activeLines: []` — actually `activeLines` is new; add alongside other Live-tab state):

```js
    rotationDeg: 0,
    demoLineActive: false,   // remove in favor of activeLines (see below)
    demoLinePath: '',        // remove
    hoverGalaxy: null,
    activeLines: [],         // NEW — [{ id, x1, y1, x2, y2, action, expiresAt }]
```

Wait — the old `demoLineActive`/`demoLinePath` state was singleton. Now that we support multiple concurrent lines, we replace them with `activeLines`. The Demo button writes into `activeLines` like real events do.

**Revised state (replace old singleton demo fields):**

```js
    rotationDeg: 0,
    hoverGalaxy: null,
    activeLines: [],
```

**New SSE listener.** Extend `connectSse` to register a `task` handler:

Current `connectSse`:

```js
    connectSse() {
      let attempt = 0;
      const open = () => {
        this.sse = new EventSource('/admin/events');
        this.sse.addEventListener('agent', (ev) => this.handleSseAgent(ev));
        this.sse.addEventListener('tenant', () => this.loadGalaxies());
        this.sse.onopen = () => { attempt = 0; };
        this.sse.onerror = () => { ... };
      };
      open();
    },
```

Add one line:

```js
        this.sse.addEventListener('agent', (ev) => this.handleSseAgent(ev));
        this.sse.addEventListener('tenant', () => this.loadGalaxies());
        this.sse.addEventListener('task',   (ev) => this.handleSseTask(ev));
```

**`handleSseTask`** — looks up both endpoints in `livePlanets` and pushes a line:

```js
    handleSseTask(ev) {
      if (this.activeTab !== 'live') return;
      try {
        const msg = JSON.parse(ev.data);
        if (!msg.fromAgentId || !msg.toAgentId) return; // sourceless — skip
        this.addConversationLine(msg.fromAgentId, msg.toAgentId, msg.action);
      } catch {}
    },
```

**`addConversationLine`** — resolves agentId → planet position, pushes line:

```js
    addConversationLine(fromAgentId, toAgentId, action) {
      const planets = this.livePlanets;
      const from = planets.find(p => p.agentId === fromAgentId);
      const to = planets.find(p => p.agentId === toAgentId);
      if (!from || !to) return;
      const id = Math.random().toString(36).slice(2);
      this.activeLines.push({
        id,
        x1: from.x,
        y1: from.y,
        x2: to.x,
        y2: to.y,
        action,
        expiresAt: performance.now() + 2500,
      });
    },
```

**`pruneExpiredLines`** — called from the rAF tick (inside `startLiveTicker`'s `tick` function). Remove any line whose `expiresAt` is past:

```js
    pruneExpiredLines() {
      if (this.activeLines.length === 0) return;
      const now = performance.now();
      this.activeLines = this.activeLines.filter(l => l.expiresAt > now);
    },
```

**`startLiveTicker` modified** — add `pruneExpiredLines()` inside `tick`:

```js
    startLiveTicker() {
      if (this._liveRaf) return;
      const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (prefersReduced) return;
      let lastTime = performance.now();
      const degPerSec = 360 / 90;
      const tick = (now) => {
        if (this.activeTab !== 'live') {
          this._liveRaf = null;
          return;
        }
        const dt = (now - lastTime) / 1000;
        lastTime = now;
        this.rotationDeg = (this.rotationDeg + degPerSec * dt) % 360;
        this.pruneExpiredLines();
        this._liveRaf = requestAnimationFrame(tick);
      };
      this._liveRaf = requestAnimationFrame(tick);
    },
```

Note: when reduced-motion is on, the rAF loop doesn't start → `activeLines` never prunes. Solution: call `pruneExpiredLines` on a `setInterval(1000)` as a fallback when the ticker is inactive. Or — simpler — just let lines stay on-screen longer under reduced-motion (they'll render steadily for 2.5s and then a follow-up call clears them). **Cleanest:** fall back to a setInterval when startLiveTicker bails:

```ts
    startLiveTicker() {
      if (this._liveRaf) return;
      const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (prefersReduced) {
        // Still prune expired lines at 1Hz so they eventually disappear
        if (!this._reducedPruneInterval) {
          this._reducedPruneInterval = setInterval(() => {
            if (this.activeTab !== 'live') {
              clearInterval(this._reducedPruneInterval);
              this._reducedPruneInterval = null;
              return;
            }
            this.pruneExpiredLines();
          }, 1000);
        }
        return;
      }
      // ... existing tick ...
    },
```

**`stopLiveTicker` modified** to clear the interval too:

```js
    stopLiveTicker() {
      if (this._liveRaf) {
        cancelAnimationFrame(this._liveRaf);
        this._liveRaf = null;
      }
      if (this._reducedPruneInterval) {
        clearInterval(this._reducedPruneInterval);
        this._reducedPruneInterval = null;
      }
    },
```

**`triggerDemoLine` replaced** — now just uses `addConversationLine`:

```js
    triggerDemoLine() {
      const planets = this.livePlanets;
      if (planets.length < 2) return;
      const a = planets[Math.floor(Math.random() * planets.length)];
      let b;
      do { b = planets[Math.floor(Math.random() * planets.length)]; } while (b.agentId === a.agentId);
      this.addConversationLine(a.agentId, b.agentId, 'queued');
    },
```

## Frontend — HTML

**File:** `packages/admin-api/public/index.html`.

**1.** Rename the Demo button: `Demo conversation` → `Simulate conversation`.

**2.** Replace the single `.nova-live-demo-line` `<path>` with an `x-for` over `activeLines`. Current:

```html
<path class="nova-live-demo-line" :class="demoLineActive && 'is-active'" :d="demoLinePath" />
```

Becomes:

```html
<template x-for="line in activeLines" :key="line.id">
  <path class="nova-live-line"
        :class="`is-${line.action}`"
        :d="`M ${line.x1} ${line.y1} Q 400 300 ${line.x2} ${line.y2}`" />
</template>
```

**3.** Agents tab card gets DID display. Find the existing agent card's header section:

```html
<div style="flex:1;min-width:0">
  <div style="color:#fff;font-weight:500" x-text="a.name"></div>
  <div class="nova-mono" x-text="a.agentId"></div>
</div>
```

Extend:

```html
<div style="flex:1;min-width:0">
  <div style="color:#fff;font-weight:500" x-text="a.name"></div>
  <div class="nova-mono" x-text="a.agentId"></div>
  <div class="nova-mono" x-show="a.did" style="overflow-wrap:anywhere;margin-top:2px;font-size:10px" x-text="a.did"></div>
</div>
```

## Frontend — CSS

**File:** `packages/admin-api/public/styles.css`. Replace the single `.nova-live-demo-line` rule block with multi-action line styling:

```css
/* Remove this block */
.nova-live-demo-line { ... }
.nova-live-demo-line.is-active { ... }
@keyframes nova-live-demo-fade { ... }
@media (prefers-reduced-motion: reduce) {
  .nova-live-demo-line.is-active { ... }
}

/* Add this */
.nova-live-line {
  fill: none;
  stroke-width: 1.5;
  stroke-dasharray: 5 5;
  pointer-events: none;
  animation: nova-live-line-fade 2.5s ease-out forwards;
}
.nova-live-line.is-queued    { stroke: var(--accent); }
.nova-live-line.is-completed { stroke: var(--status-active); }
.nova-live-line.is-failed    { stroke: var(--status-error); }

@keyframes nova-live-line-fade {
  0%   { opacity: 1; stroke-dashoffset: 0; }
  100% { opacity: 0; stroke-dashoffset: -40; }
}
@media (prefers-reduced-motion: reduce) {
  .nova-live-line { animation: none; opacity: 1; }
}
```

## Data flow

### Happy path — real task

1. External agent sends a task to Nova via `/register` + task POST (outside this spec's scope)
2. `a2a-server` enqueues the task in BullMQ (today's behavior, unchanged)
3. `agent-connector`'s worker picks up the job, enters `processTask`
4. `processTask` calls `getAgentByDid(task.senderDid)` → `{tenantId: 'wolfe-dev', agentId: 'claude-code'}` (or null if unknown)
5. Publishes `{action:'queued', taskId, toTenantId, toAgentId, fromTenantId, fromAgentId}` to `TASK_LIFECYCLE_CHANNEL`
6. `admin-api`'s SSE subscriber fans it out to every connected browser as `event: task`
7. Browser's `EventSource` on `/admin/events` fires the `task` listener → `handleSseTask`
8. `handleSseTask` sees `activeTab === 'live'` and both endpoints → `addConversationLine`
9. `addConversationLine` resolves both agentIds to planet positions via `livePlanets`, appends a line to `activeLines`
10. Alpine reactively renders a new `<path>` in the SVG → CSS animation plays
11. 2.5s later, `pruneExpiredLines` (called by the rAF tick) removes the line

Task completes/fails → steps 3–11 repeat with `action: 'completed'` or `'failed'`, rendering green or red line.

### Sourceless path (legacy sender)

Task arrives from an agent whose DID isn't in the DID reverse index (e.g. agent indexed before DID enrichment landed). `getAgentByDid` returns `null`. The `queued` event is still published but without `fromTenantId`/`fromAgentId`. Frontend's `handleSseTask` returns early. No line renders. Users see completeness-check noise in dev console if they've turned on debug logging, but no broken UI.

## Migration

Existing agents in Redis have no `did` field in their `nova:agent-meta:*` hash. Three ways to migrate:

1. **Automatic on next index event.** Any agent that gets re-indexed (via `approveAgent`, `createAgent`, a manual admin action, or the `listAllActiveAgents` fallback when `AGENT_REGISTRY_SET` is empty) will be written with `did`. Over time, the index self-heals.
2. **Manual flush.** Operator runs `docker exec nova-redis-1 redis-cli del nova:agent-registry` followed by reloading `/admin/agents`. The registry-empty path in `listAllActiveAgents` triggers a full rebuild from disk, re-writing each Hash with `did`.
3. **Startup re-index.** Not this bite. Would add ~200ms to admin-api cold start; defer unless needed.

This bite documents (2) as the recommended one-shot migration after deploy. Until the migration runs, the two current dev-instance agents won't resolve as sources in the Live view — lines drawn from them won't render.

## Error handling

- **Redis publish fails:** caught, logged at `warn`; task continues (publishing is best-effort, not on the critical path)
- **`getAgentByDid` throws:** caught, treated as null (sourceless event)
- **SSE event with malformed JSON:** existing `try/catch` in `handleSseTask` swallows
- **Planet lookup fails (agent in event not in current `livePlanets`):** `addConversationLine` returns early without erroring — could happen if an agent was deregistered between event publish and event receipt
- **Concurrent lines pile up past screen-readability:** no throttling this bite (explicitly deferred)

## Verification

Manual, in a deployed container.

1. **Deploy.** `docker-compose up -d --build admin-api agent-connector` (agent-connector also changed).
2. **Flush Redis index** (migration). `docker exec nova-redis-1 redis-cli del nova:agent-registry`. Reload `/admin/agents` in the browser to trigger re-index.
3. **Confirm DID index.** `docker exec nova-redis-1 redis-cli keys 'nova:did-index:*'` should return one key per active agent.
4. **Confirm AgentMeta has DID.** `docker exec nova-redis-1 redis-cli hget nova:agent-meta:claude-code did` should return the DID string.
5. **Navigate to Agents tab.** Each card should now show the DID in small mono below `agentId`.
6. **Navigate to Live tab.** Planets render as before.
7. **Simulate conversation.** Click `Simulate conversation`. An amber dashed line draws between two random planets through the sun, fades over 2.5s. Clicking quickly triggers multiple concurrent lines — each fades on its own timer.
8. **Real task.** From another shell, invoke an A2A task send (the exact command depends on the tenant/agent setup — `nova_send_task` via MCP, or a curl against `/a2a` with a UCAN-signed payload). Within ~1s an amber line draws from the sender's planet to the recipient's planet on the Live view. When the task completes, a green line fires a moment later. If it fails, a red line.
9. **Unknown sender.** Send a task from an agent whose Hash lacks `did` (e.g. pre-migration). No line renders for that task. The Live view remains silent for this conversation — documented behavior, not a bug.
10. **Reduced motion.** Emulate `prefers-reduced-motion: reduce`. Click Simulate — line appears at full opacity and disappears after 2.5s without the dash-march animation.
11. **Tests still pass.** `cd packages/admin-api && npm test` → 11/11.
12. **Grep sweep.** `rg "demoLine" packages/admin-api/public` → no matches (old singleton state fully replaced). `rg "activeLines" packages/admin-api/public` → matches in `app.js` and `index.html`.

## Files expected to change

- `packages/shared/src/agent-index.ts` — `AgentMeta`, `ParsedAgentMeta`, `TaskLifecycleEvent`, `indexAgentMeta`, `deindexAgent`, `parseAgentMeta`; add `didIndexKey` helper and `getAgentByDid` export
- `packages/admin-api/src/services/agent-service.ts` — no signature change needed (already passes full `AgentConfig` which has `did`); ensure the re-export of `ParsedAgentMeta` picks up the new optional field automatically
- `packages/agent-connector/src/index.ts` — import `TASK_LIFECYCLE_CHANNEL` and `getAgentByDid`; add the lifecycle base resolution and three `publish` calls (`queued` at entry, `completed` on success, `failed` on each terminal-failure path)
- `packages/admin-api/public/js/app.js` — replace `demoLineActive` / `demoLinePath` with `activeLines`; new methods `handleSseTask`, `addConversationLine`, `pruneExpiredLines`; extend `startLiveTicker` / `stopLiveTicker` with reduced-motion prune interval; rewrite `triggerDemoLine` to delegate; register `task` SSE listener in `connectSse`
- `packages/admin-api/public/index.html` — rename Demo button, replace singleton demo-line `<path>` with `x-for` over `activeLines`, add DID under `agentId` in Agents card
- `packages/admin-api/public/styles.css` — replace `.nova-live-demo-line` block with `.nova-live-line` + three action variants + updated keyframe and reduced-motion rule

Approximate size: ~80 shared lines (mostly interface additions), ~40 agent-connector lines (publisher calls + resolution), ~90 js/app.js lines (state swap, new methods, ticker extensions), ~15 index.html lines (rename + line template + DID display), ~25 CSS lines (replace + three action variants).

## Risks and decisions deferred

- **`a2a-server` not publishing `queued`.** We publish from `agent-connector` at worker-pickup, which is strictly after enqueue. For a low-traffic Nova the difference is <100ms; if BullMQ queues get deep, lines might appear noticeably after the real enqueue. Revisit by moving the `queued` publisher to `a2a-server` if latency feedback warrants.
- **No `quarantined` publisher.** Gate-service handles quarantine; adding a publisher there is a clean follow-up bite. The frontend already has CSS keyed for `.is-failed`; a `quarantined` event would map to that visually, but the publisher is out of scope here.
- **DID migration is operator-triggered.** A startup-time re-index would make the migration fully automatic but lengthens admin-api boot. Defer unless a user reports confusion.
- **Concurrent line management.** At high task rates the screen fills up. If that becomes a problem, cap `activeLines.length` to (say) 32 with FIFO eviction. YAGNI for now.
- **Line replay on tab entry.** If a user opens Live mid-conversation, they won't see lines that were already in flight. Audit log has the data; a replay pass could hydrate. Separate bite.
- **`working` not surfaced.** A task can spend a long time in `working` state (confirmation pending, for example). The Live view shows nothing during that window after `queued` fades. If users want "this is still happening" feedback, add a pulsing ring around the destination planet tied to pending tasks. Separate concern.
- **Payload privacy.** The lifecycle event contains only taskId + tenant/agent identifiers — no payload. Safe to broadcast via SSE. If future payload-preview features land, audit what goes out over SSE.
