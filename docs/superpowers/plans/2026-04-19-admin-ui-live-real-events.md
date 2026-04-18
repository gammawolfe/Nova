# Admin UI Live Real Events (Live-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire real A2A task lifecycle events into the Live solar-system view — amber lines when tasks start, green when they complete, red when they fail — and add a DID reverse index to resolve senders cheaply.

**Architecture:** Extend `@nova/shared`'s agent discovery with `did` on `AgentMeta` + a new `nova:did-index` reverse key + `getAgentByDid` helper. `agent-connector` publishes to the already-subscribed `TASK_LIFECYCLE_CHANNEL` at three moments in `processTask`. Frontend registers a `task` SSE listener and renders each event as a color-coded SVG path with a 2.5s fade. Agents tab gains DID display as a side-effect of the index enrichment.

**Tech Stack:** TypeScript + Express + ioredis (backend), Alpine.js + vanilla SVG (frontend). `ioredis.pipeline()` for atomic index writes. `EventSource` for SSE. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-04-19-admin-ui-live-real-events-design.md`

---

## Dev loop

Two backend services change this bite, so container rebuild is the only honest end-to-end verification:

```bash
# After each backend task: type-check quickly without running
cd packages/admin-api && npx tsc --noEmit
cd packages/agent-connector && npx tsc --noEmit

# Full stack rebuild (runs at end of plan)
docker-compose up -d --build admin-api agent-connector
```

Admin token: from `.env` (`my-secure-admin-token-12345`). UI at `http://localhost:3005`.

Run `cd packages/admin-api && npm test` after every task — expected `Tests  11 passed (11)`.

---

## Task 1: Shared type extensions + DID reverse index

**Why:** All downstream code (agent-connector publisher, frontend DID display, sender resolution) depends on these shared types and helpers. Lands first so later tasks have something to import.

**Files:**
- Modify: `packages/shared/src/agent-index.ts` (six edits)

- [ ] **Step 1: Add `didIndexKey` helper**

Open `packages/shared/src/agent-index.ts`. Find the existing `agentMetaKey` helper (around line 26):

```ts
export function agentMetaKey(agentId: string): string {
  return `nova:agent-meta:${agentId}`;
}
```

Add a new helper immediately after:

```ts
export function agentMetaKey(agentId: string): string {
  return `nova:agent-meta:${agentId}`;
}

export function didIndexKey(did: string): string {
  return `nova:did-index:${did}`;
}
```

- [ ] **Step 2: Add `did` to `AgentMeta` interface**

Find the `AgentMeta` interface:

```ts
export interface AgentMeta {
  agentId: string;
  tenantId: string;
  name: string;
  description: string;
  status: string;
  skills: string;        // JSON-serialized
  capabilities: string;  // JSON-serialized
}
```

Add `did`:

```ts
export interface AgentMeta {
  agentId: string;
  tenantId: string;
  name: string;
  description: string;
  status: string;
  skills: string;        // JSON-serialized
  capabilities: string;  // JSON-serialized
  did: string;           // Empty string if legacy data pre-DID-index
}
```

- [ ] **Step 3: Extend `TaskLifecycleEvent` with directional fields**

Find the existing `TaskLifecycleEvent`:

```ts
export interface TaskLifecycleEvent {
  action: 'queued' | 'completed' | 'failed' | 'quarantined';
  tenantId: string;
  agentId: string;
  taskId: string;
}
```

Replace with:

```ts
export interface TaskLifecycleEvent {
  action: 'queued' | 'completed' | 'failed' | 'quarantined';
  taskId: string;
  toTenantId: string;
  toAgentId: string;
  fromTenantId?: string;
  fromAgentId?: string;
}
```

The rename is safe: nothing currently publishes to `TASK_LIFECYCLE_CHANNEL`, and the admin-api SSE router only forwards the JSON payload opaquely. No consumers break.

- [ ] **Step 4: Update `indexAgentMeta` to accept and write `did`**

Find the `indexAgentMeta` function:

```ts
export async function indexAgentMeta(
  redis: IORedis,
  config: {
    agentId: string;
    tenantId: string;
    name: string;
    description?: string | undefined;
    status: string;
    skills: Array<{ id: string; name: string; description: string; tags?: string[] | undefined; [key: string]: unknown }>;
    capabilities: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean };
  }
): Promise<void> {
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
    })
    .sadd(AGENT_REGISTRY_SET, config.agentId)
    .exec();
}
```

Replace with:

```ts
export async function indexAgentMeta(
  redis: IORedis,
  config: {
    agentId: string;
    tenantId: string;
    name: string;
    description?: string | undefined;
    status: string;
    skills: Array<{ id: string; name: string; description: string; tags?: string[] | undefined; [key: string]: unknown }>;
    capabilities: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean };
    did?: string | undefined;
  }
): Promise<void> {
  const did = config.did ?? '';
  const pipe = redis.pipeline()
    .set(agentIndexKey(config.agentId), config.tenantId)
    .hset(agentMetaKey(config.agentId), {
      agentId: config.agentId,
      tenantId: config.tenantId,
      name: config.name,
      description: config.description ?? '',
      status: config.status,
      skills: JSON.stringify(config.skills),
      capabilities: JSON.stringify(config.capabilities),
      did,
    })
    .sadd(AGENT_REGISTRY_SET, config.agentId);
  if (did) pipe.set(didIndexKey(did), config.agentId);
  await pipe.exec();
}
```

Empty-string guard prevents writing `nova:did-index:` (an empty key) for legacy configs that don't yet have a DID.

- [ ] **Step 5: Update `deindexAgent` to clean up the DID reverse index**

Find `deindexAgent`:

```ts
export async function deindexAgent(redis: IORedis, agentId: string): Promise<void> {
  await redis.pipeline()
    .hset(agentMetaKey(agentId), 'status', 'deregistered')
    .srem(AGENT_REGISTRY_SET, agentId)
    .del(agentIndexKey(agentId))
    .exec();
}
```

Replace with:

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

- [ ] **Step 6: Update `ParsedAgentMeta` and `parseAgentMeta` to include `did`**

Find `ParsedAgentMeta`:

```ts
export interface ParsedAgentMeta {
  agentId: string;
  tenantId: string;
  name: string;
  description: string;
  status: string;
  skills: Array<{ id: string; name: string; description: string; tags?: string[] | undefined }>;
  capabilities: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean };
}
```

Add `did?: string | undefined`:

```ts
export interface ParsedAgentMeta {
  agentId: string;
  tenantId: string;
  name: string;
  description: string;
  status: string;
  skills: Array<{ id: string; name: string; description: string; tags?: string[] | undefined }>;
  capabilities: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean };
  did?: string | undefined;
}
```

Find `parseAgentMeta`:

```ts
function parseAgentMeta(data: Record<string, string>): ParsedAgentMeta | null {
  if (!data['agentId']) return null;
  try {
    return {
      agentId: data['agentId']!,
      tenantId: data['tenantId']!,
      name: data['name']!,
      description: data['description'] ?? '',
      status: data['status']!,
      skills: JSON.parse(data['skills'] || '[]'),
      capabilities: JSON.parse(data['capabilities'] || '{}'),
    };
  } catch {
    return null;
  }
}
```

Add `did`:

```ts
function parseAgentMeta(data: Record<string, string>): ParsedAgentMeta | null {
  if (!data['agentId']) return null;
  try {
    return {
      agentId: data['agentId']!,
      tenantId: data['tenantId']!,
      name: data['name']!,
      description: data['description'] ?? '',
      status: data['status']!,
      skills: JSON.parse(data['skills'] || '[]'),
      capabilities: JSON.parse(data['capabilities'] || '{}'),
      did: data['did'] || undefined,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 7: Add `getAgentByDid` export**

Find the existing `getAgentMeta` function (around line 122):

```ts
export async function getAgentMeta(redis: IORedis, agentId: string): Promise<ParsedAgentMeta | null> {
  const data = await redis.hgetall(agentMetaKey(agentId));
  return parseAgentMeta(data);
}
```

Add `getAgentByDid` immediately after:

```ts
export async function getAgentMeta(redis: IORedis, agentId: string): Promise<ParsedAgentMeta | null> {
  const data = await redis.hgetall(agentMetaKey(agentId));
  return parseAgentMeta(data);
}

export async function getAgentByDid(redis: IORedis, did: string): Promise<ParsedAgentMeta | null> {
  if (!did) return null;
  const agentId = await redis.get(didIndexKey(did));
  if (!agentId) return null;
  return getAgentMeta(redis, agentId);
}
```

- [ ] **Step 8: Type-check**

```bash
cd packages/shared && npx tsc --noEmit
cd ../admin-api && npx tsc --noEmit
cd ../agent-connector && npx tsc --noEmit
```

Each command should complete with no output (silent success).

If admin-api or agent-connector fails to type-check, it's because a downstream caller references `TaskLifecycleEvent`'s old shape (`tenantId`/`agentId`). There should be no such callers — nothing publishes to `TASK_LIFECYCLE_CHANNEL` today. If anything surfaces, the message will tell you exactly which file and line.

- [ ] **Step 9: Run admin-api tests**

```bash
cd packages/admin-api && npm test
```

Expected: `Tests  11 passed (11)`. None of these tests touch `agent-index.ts` so they're unaffected.

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/agent-index.ts
git commit -m "feat(shared): extend AgentMeta with did and add did reverse index

AgentMeta gains a 'did' hash field (empty string for legacy data).
ParsedAgentMeta gains optional 'did'. New nova:did-index:<did>
maps to agentId, maintained in indexAgentMeta + deindexAgent. New
getAgentByDid helper does one GET plus one HGETALL. TaskLifecycleEvent
replaces ambiguous tenantId/agentId with directional toTenantId +
toAgentId + optional fromTenantId + fromAgentId — safe rename since
nothing currently publishes to TASK_LIFECYCLE_CHANNEL."
```

---

## Task 2: Agent-connector publishes task lifecycle events

**Why:** The SSE stream already carries `task` events from `TASK_LIFECYCLE_CHANNEL`; they'll reach browsers the moment anything publishes. This task is the only writer side of that pipe.

**Files:**
- Modify: `packages/agent-connector/src/index.ts` (one import, one resolution block at top of `processTask`, four publish calls at terminal paths)

- [ ] **Step 1: Add imports**

Open `packages/agent-connector/src/index.ts`. Find the existing imports (lines 1–17):

```ts
import express from 'express';
import { Job } from 'bullmq';
import { logger } from '@nova/shared/src/logger';
import { auditLog } from '@nova/shared/src/audit';
import { TenantContext } from '@nova/shared/src/tenant';
import { QueuedTask } from '@nova/shared/src/types';
import { updateTaskStatus, publishTaskEvent } from '@nova/task-queue/src/index';
```

Add one import for `TASK_LIFECYCLE_CHANNEL` and `getAgentByDid`:

```ts
import { TenantContext } from '@nova/shared/src/tenant';
import { QueuedTask } from '@nova/shared/src/types';
import { TASK_LIFECYCLE_CHANNEL, getAgentByDid, TaskLifecycleEvent } from '@nova/shared/src/agent-index';
import { updateTaskStatus, publishTaskEvent } from '@nova/task-queue/src/index';
```

- [ ] **Step 2: Add lifecycle base resolution at the top of `processTask`**

Find the start of `processTask` (around line 23):

```ts
async function processTask(job: Job, ctx: TenantContext): Promise<void> {
  const task = job.data as QueuedTask;
  const taskCtx: TenantContext = { tenantId: task.tenantId, agentId: task.agentId };

  logger.info({ jobId: job.id, taskId: task.taskId, intent: task.intent }, 'Processing task');
```

Insert the resolution block and the `queued` publish right after the log line:

```ts
async function processTask(job: Job, ctx: TenantContext): Promise<void> {
  const task = job.data as QueuedTask;
  const taskCtx: TenantContext = { tenantId: task.tenantId, agentId: task.agentId };

  logger.info({ jobId: job.id, taskId: task.taskId, intent: task.intent }, 'Processing task');

  // Resolve source agent for lifecycle events — may be null for unknown senders
  const sourceAgent = await getAgentByDid(getSharedRedis(), task.senderDid);
  const lifecycleBase: Omit<TaskLifecycleEvent, 'action'> = {
    taskId: task.taskId,
    toTenantId: task.tenantId,
    toAgentId: task.agentId,
    ...(sourceAgent ? { fromTenantId: sourceAgent.tenantId, fromAgentId: sourceAgent.agentId } : {}),
  };

  // Publish "queued" to the global lifecycle channel — best-effort, not on critical path
  try {
    await getSharedRedis().publish(TASK_LIFECYCLE_CHANNEL, JSON.stringify({
      action: 'queued',
      ...lifecycleBase,
    } satisfies TaskLifecycleEvent));
  } catch (err: any) {
    logger.warn({ err: err.message, taskId: task.taskId }, 'Failed to publish queued lifecycle event');
  }
```

`getSharedRedis` is already imported at line 11 (`import { getSharedRedis } from '@nova/shared/src/redis';`).

- [ ] **Step 3: Add `completed` publish at the end of the happy path**

Find the successful-delivery block (around line 160–188). The happy path ends after `deliverToReplyTo`:

```ts
  const replyResult = await deliverToReplyTo(task.replyTo, delivery.taskResult);
  if (!replyResult.success) {
    deliveryOutcomes.inc({ target: 'replyTo', outcome: 'transient_failure' });
    logger.warn({ taskId: task.taskId, error: replyResult.error }, 'replyTo delivery failed');
    await auditLog(taskCtx, {
      event: 'delivery_transient_failure',
      taskId: task.taskId,
      metadata: { url: task.replyTo, error: replyResult.error },
    });
  } else {
    deliveryOutcomes.inc({ target: 'replyTo', outcome: 'success' });
    await auditLog(taskCtx, { event: 'delivery_success', taskId: task.taskId });
  }
```

Add a lifecycle publish immediately after this block's closing brace:

```ts
  const replyResult = await deliverToReplyTo(task.replyTo, delivery.taskResult);
  if (!replyResult.success) {
    deliveryOutcomes.inc({ target: 'replyTo', outcome: 'transient_failure' });
    logger.warn({ taskId: task.taskId, error: replyResult.error }, 'replyTo delivery failed');
    await auditLog(taskCtx, {
      event: 'delivery_transient_failure',
      taskId: task.taskId,
      metadata: { url: task.replyTo, error: replyResult.error },
    });
  } else {
    deliveryOutcomes.inc({ target: 'replyTo', outcome: 'success' });
    await auditLog(taskCtx, { event: 'delivery_success', taskId: task.taskId });
  }

  try {
    await getSharedRedis().publish(TASK_LIFECYCLE_CHANNEL, JSON.stringify({
      action: 'completed',
      ...lifecycleBase,
    } satisfies TaskLifecycleEvent));
  } catch (err: any) {
    logger.warn({ err: err.message, taskId: task.taskId }, 'Failed to publish completed lifecycle event');
  }
```

- [ ] **Step 4: Add `failed` publish helper and call it at each terminal-failure `return`**

To avoid code duplication, define a small local helper inside `processTask` just below the `lifecycleBase` declaration:

```ts
  const lifecycleBase: Omit<TaskLifecycleEvent, 'action'> = {
    taskId: task.taskId,
    toTenantId: task.tenantId,
    toAgentId: task.agentId,
    ...(sourceAgent ? { fromTenantId: sourceAgent.tenantId, fromAgentId: sourceAgent.agentId } : {}),
  };

  const publishLifecycle = async (action: TaskLifecycleEvent['action']) => {
    try {
      await getSharedRedis().publish(TASK_LIFECYCLE_CHANNEL, JSON.stringify({
        action, ...lifecycleBase,
      } satisfies TaskLifecycleEvent));
    } catch (err: any) {
      logger.warn({ err: err.message, taskId: task.taskId, action }, 'Failed to publish lifecycle event');
    }
  };

  // Publish "queued" to the global lifecycle channel
  await publishLifecycle('queued');
```

Then replace the Step 3 raw-publish-for-completed with:

```ts
  await publishLifecycle('completed');
```

And add `await publishLifecycle('failed');` immediately before each `return` at every terminal failure path:

1. **TTL expired** (around line 32–34):
```ts
  if (new Date(task.expiresAt) <= new Date()) {
    await updateTaskStatus(taskCtx, task.taskId, 'failed', { statusMessage: 'Task TTL expired before processing' });
    await publishTaskEvent(taskCtx, task.taskId, { type: 'status_update', data: { status: 'failed', reason: 'TTL_EXPIRED' } });
    await auditLog(taskCtx, { event: 'task_expired', taskId: task.taskId });
    await publishLifecycle('failed');
    return;
  }
```

2. **Confirmation denied** (around line 75–79):
```ts
    if (status === 'denied') {
      await updateTaskStatus(taskCtx, task.taskId, 'failed', { statusMessage: 'Confirmation denied by operator' });
      await publishTaskEvent(taskCtx, task.taskId, { type: 'status_update', data: { status: 'failed', reason: 'HUMAN_DENIED' } });
      await auditLog(taskCtx, { event: 'confirm_denied', taskId: task.taskId });
      await publishLifecycle('failed');
      return;
    }
```

3. **Confirmation timeout** (around line 82–86):
```ts
    if (status === 'timeout') {
      await updateTaskStatus(taskCtx, task.taskId, 'failed', { statusMessage: 'Confirmation timed out' });
      await publishTaskEvent(taskCtx, task.taskId, { type: 'status_update', data: { status: 'failed', reason: 'CONFIRMATION_TIMEOUT' } });
      await auditLog(taskCtx, { event: 'confirm_timeout', taskId: task.taskId });
      await publishLifecycle('failed');
      return;
    }
```

4. **No operator URL** (around line 117–122):
```ts
  const operatorUrl = await getOperatorUrl(taskCtx);
  if (!operatorUrl) {
    logger.error({ taskCtx }, 'No operator URL configured for agent');
    await updateTaskStatus(taskCtx, task.taskId, 'failed', { statusMessage: 'No operator URL configured' });
    await publishTaskEvent(taskCtx, task.taskId, { type: 'status_update', data: { status: 'failed' } });
    await publishLifecycle('failed');
    return;
  }
```

5. **Delivery failure** (around line 127–157):
```ts
  if (!delivery.success || !delivery.taskResult) {
    // ... existing dead-letter + audit logic ...
    await updateTaskStatus(taskCtx, task.taskId, 'failed', { statusMessage: delivery.error || 'Delivery failed' });
    await publishTaskEvent(taskCtx, task.taskId, { type: 'status_update', data: { status: 'failed' } });
    await publishLifecycle('failed');
    return;
  }
```

- [ ] **Step 5: Type-check**

```bash
cd packages/agent-connector && npx tsc --noEmit
```

Expected: silent success. If the compiler complains about `satisfies TaskLifecycleEvent`, verify the import on Step 1 landed.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-connector/src/index.ts
git commit -m "feat(agent-connector): publish task lifecycle events to TASK_LIFECYCLE_CHANNEL

Resolves senderDid to (fromTenantId, fromAgentId) at processTask entry
via getAgentByDid (may be null for unknown senders). Publishes
'queued' at worker entry, 'completed' at end of happy path, 'failed'
at each terminal error path (TTL expired, confirm denied, confirm
timeout, no operator URL, delivery failure). Events fire after their
respective audit log + status update so state is consistent first.
Publish errors are caught and logged at warn — task processing
continues. Feeds the Live tab solar-system view."
```

---

## Task 3: Frontend — CSS + JS + HTML in one commit

**Why:** The three frontend files are tightly coupled (state shape + rendering + styling must change together). Splitting them breaks the Demo button between steps. One atomic commit keeps the UI working throughout.

**Files:**
- Modify: `packages/admin-api/public/styles.css` (replace demo-line rules with multi-action line rules)
- Modify: `packages/admin-api/public/js/app.js` (swap singleton demo state for `activeLines`, add SSE listener, new methods)
- Modify: `packages/admin-api/public/index.html` (rename button, replace singleton `<path>` with `x-for`, add DID display on Agents card)

- [ ] **Step 1: Replace the demo-line CSS block with multi-action line rules**

Open `packages/admin-api/public/styles.css`. Find the demo-line block (from Live-1 bite):

```css
.nova-live-demo-line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5;
  stroke-dasharray: 5 5;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.3s ease;
}
.nova-live-demo-line.is-active {
  opacity: 1;
  animation: nova-live-demo-fade 1.5s ease-out forwards;
}
@keyframes nova-live-demo-fade {
  0%   { opacity: 1; stroke-dashoffset: 0; }
  100% { opacity: 0; stroke-dashoffset: -40; }
}
@media (prefers-reduced-motion: reduce) {
  .nova-live-demo-line.is-active {
    animation: none;
    opacity: 1;
  }
}
```

Replace with:

```css
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
.nova-live-line.is-quarantined { stroke: var(--status-error); }

@keyframes nova-live-line-fade {
  0%   { opacity: 1; stroke-dashoffset: 0; }
  100% { opacity: 0; stroke-dashoffset: -40; }
}
@media (prefers-reduced-motion: reduce) {
  .nova-live-line { animation: none; opacity: 1; }
}
```

- [ ] **Step 2: Swap singleton demo state for `activeLines` in `app.js`**

Open `packages/admin-api/public/js/app.js`. Find the Live-1 state block:

```js
    rotationDeg: 0,
    demoLineActive: false,
    demoLinePath: '',
    hoverGalaxy: null,
```

Replace with:

```js
    rotationDeg: 0,
    activeLines: [],
    hoverGalaxy: null,
```

- [ ] **Step 3: Add `handleSseTask`, `addConversationLine`, and `pruneExpiredLines`**

Find the existing `handleSseAgent` method. Add three new methods immediately after it:

```js
    handleSseAgent(ev) {
      try {
        const msg = JSON.parse(ev.data);
        if (this.activeTab === 'agents' || this.activeTab === 'live') {
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

    handleSseTask(ev) {
      if (this.activeTab !== 'live') return;
      try {
        const msg = JSON.parse(ev.data);
        if (!msg.fromAgentId || !msg.toAgentId) return;
        this.addConversationLine(msg.fromAgentId, msg.toAgentId, msg.action);
      } catch {}
    },

    addConversationLine(fromAgentId, toAgentId, action) {
      const planets = this.livePlanets;
      const from = planets.find(p => p.agentId === fromAgentId);
      const to = planets.find(p => p.agentId === toAgentId);
      if (!from || !to) return;
      this.activeLines.push({
        id: Math.random().toString(36).slice(2),
        x1: from.x,
        y1: from.y,
        x2: to.x,
        y2: to.y,
        action,
        expiresAt: performance.now() + 2500,
      });
    },

    pruneExpiredLines() {
      if (this.activeLines.length === 0) return;
      const now = performance.now();
      this.activeLines = this.activeLines.filter(l => l.expiresAt > now);
    },
```

- [ ] **Step 4: Wire `pruneExpiredLines` into `startLiveTicker` and add a reduced-motion fallback**

Find the existing `startLiveTicker`:

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
        this._liveRaf = requestAnimationFrame(tick);
      };
      this._liveRaf = requestAnimationFrame(tick);
    },
```

Replace with:

```js
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

Find `stopLiveTicker`:

```js
    stopLiveTicker() {
      if (this._liveRaf) {
        cancelAnimationFrame(this._liveRaf);
        this._liveRaf = null;
      }
    },
```

Replace with:

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

- [ ] **Step 5: Rewrite `triggerDemoLine` to delegate to `addConversationLine`**

Find `triggerDemoLine`:

```js
    triggerDemoLine() {
      const planets = this.livePlanets;
      if (planets.length < 2) return;
      if (this._demoTimeout) clearTimeout(this._demoTimeout);
      const a = planets[Math.floor(Math.random() * planets.length)];
      let b;
      do { b = planets[Math.floor(Math.random() * planets.length)]; } while (b.agentId === a.agentId);
      this.demoLinePath = `M ${a.x} ${a.y} Q 400 300 ${b.x} ${b.y}`;
      this.demoLineActive = false;
      requestAnimationFrame(() => { this.demoLineActive = true; });
      this._demoTimeout = setTimeout(() => {
        this.demoLineActive = false;
        this.demoLinePath = '';
        this._demoTimeout = null;
      }, 1600);
    },
```

Replace with:

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

- [ ] **Step 6: Register the `task` SSE listener in `connectSse`**

Find `connectSse`:

```js
    connectSse() {
      let attempt = 0;
      const open = () => {
        this.sse = new EventSource('/admin/events');
        this.sse.addEventListener('agent', (ev) => this.handleSseAgent(ev));
        this.sse.addEventListener('tenant', () => this.loadGalaxies());
        this.sse.onopen = () => { attempt = 0; };
        this.sse.onerror = () => {
          this.sse && this.sse.close();
          const delay = Math.min(30000, 1000 * Math.pow(2, attempt++));
          setTimeout(open, delay);
        };
      };
      open();
    },
```

Add one `addEventListener`:

```js
    connectSse() {
      let attempt = 0;
      const open = () => {
        this.sse = new EventSource('/admin/events');
        this.sse.addEventListener('agent',  (ev) => this.handleSseAgent(ev));
        this.sse.addEventListener('tenant', () => this.loadGalaxies());
        this.sse.addEventListener('task',   (ev) => this.handleSseTask(ev));
        this.sse.onopen = () => { attempt = 0; };
        this.sse.onerror = () => {
          this.sse && this.sse.close();
          const delay = Math.min(30000, 1000 * Math.pow(2, attempt++));
          setTimeout(open, delay);
        };
      };
      open();
    },
```

- [ ] **Step 7: Replace the singleton demo-line `<path>` with `x-for` over `activeLines`**

Open `packages/admin-api/public/index.html`. Find (inside the Live `<svg>`):

```html
<path class="nova-live-demo-line" :class="demoLineActive && 'is-active'" :d="demoLinePath" />
```

Replace with:

```html
<template x-for="line in activeLines" :key="line.id">
  <path class="nova-live-line"
        :class="`is-${line.action}`"
        :d="`M ${line.x1} ${line.y1} Q 400 300 ${line.x2} ${line.y2}`" />
</template>
```

- [ ] **Step 8: Rename the "Demo conversation" button**

In the same file, find:

```html
<button class="nova-input" style="width:auto;padding:8px 14px;font-size:12px"
        @click="triggerDemoLine()" :disabled="allAgents.length < 2">
  Demo conversation
</button>
```

Change the label:

```html
<button class="nova-input" style="width:auto;padding:8px 14px;font-size:12px"
        @click="triggerDemoLine()" :disabled="allAgents.length < 2">
  Simulate conversation
</button>
```

- [ ] **Step 9: Add DID display to Agents card**

Still in `index.html`, find the agent card's header block from the Agents bite:

```html
<div style="flex:1;min-width:0">
  <div style="color:#fff;font-weight:500" x-text="a.name"></div>
  <div class="nova-mono" x-text="a.agentId"></div>
</div>
```

Replace with:

```html
<div style="flex:1;min-width:0">
  <div style="color:#fff;font-weight:500" x-text="a.name"></div>
  <div class="nova-mono" x-text="a.agentId"></div>
  <div class="nova-mono" x-show="a.did" style="overflow-wrap:anywhere;margin-top:2px;font-size:10px" x-text="a.did"></div>
</div>
```

- [ ] **Step 10: Run admin-api tests**

```bash
cd packages/admin-api && npm test
```

Expected: 11/11 passing. (The jsdom client tests don't cover the SVG/Alpine logic but they verify the shared `api.js` + `utils.js` helpers still compile/import fine.)

- [ ] **Step 11: Commit**

```bash
git add packages/admin-api/public/styles.css packages/admin-api/public/js/app.js packages/admin-api/public/index.html
git commit -m "feat(admin-ui): wire real task lifecycle events into Live view

Frontend swaps singleton demo-line state for an activeLines array.
New methods: handleSseTask, addConversationLine (validates endpoints,
pushes with 2.5s expiresAt), pruneExpiredLines (called on rAF tick
and on a 1Hz interval fallback under reduced-motion). Live
EventSource now registers the task event listener. triggerDemoLine
reuses the same addConversationLine code path as real events —
button relabelled Simulate conversation. Line CSS split by action:
amber for queued, green for completed, red for failed/quarantined.
Agents tab gains a DID display under agentId as a side-effect of
Live-2's discovery-index enrichment."
```

---

## Task 4: Final sweep, deploy, and Redis migration

**Why:** Two backend services changed; the only end-to-end verification is a container rebuild. Existing agents need their Redis `AgentMeta` re-indexed to gain the `did` field and populate the reverse index.

**Files:** No code changes expected unless Step 1 surfaces an issue.

- [ ] **Step 1: Grep sweep**

From the repo root:

```bash
rg "demoLine|demoLinePath|demoLineActive|nova-live-demo-line" packages/admin-api/public
```

Expected: **no matches**. Any hit means old singleton state wasn't fully replaced in Task 3.

```bash
rg "TASK_LIFECYCLE_CHANNEL" packages --type ts
```

Expected: three matches — `packages/shared/src/agent-index.ts` (export), `packages/admin-api/src/routes/events.ts` (SSE subscribe), `packages/agent-connector/src/index.ts` (publish).

```bash
rg "getAgentByDid" packages --type ts
```

Expected: two matches — `packages/shared/src/agent-index.ts` (export), `packages/agent-connector/src/index.ts` (import + call).

- [ ] **Step 2: Type-check all packages**

```bash
cd packages/shared && npx tsc --noEmit
cd ../admin-api && npx tsc --noEmit
cd ../agent-connector && npx tsc --noEmit
```

Each should be silent.

- [ ] **Step 3: Run tests**

```bash
cd packages/admin-api && npm test
```

Expected: 11/11 passing.

- [ ] **Step 4: Rebuild both backend containers**

```bash
cd /Users/tyewolfe/Projects/Nova
docker-compose up -d --build admin-api agent-connector
```

Wait for both `Container nova-admin-api-1  Started` and `Container nova-agent-connector-1  Started` (or equivalent names). Give ~5 seconds for both to boot.

- [ ] **Step 5: Run the Redis migration**

Existing `nova:agent-meta:*` hashes lack the `did` field and there's no `nova:did-index:*` set of keys yet. Flushing the registry set triggers the existing fallback migration in `listAllActiveAgents` which re-indexes from disk with all the new fields.

```bash
docker exec nova-redis-1 redis-cli del nova:agent-registry
# Expected: (integer) 1  — registry set was present and deleted
```

Then visit `http://localhost:3005/admin/agents` (or click the Agents tab in the UI) — the registry-empty fallback fires, re-indexes every active agent, and writes their DIDs.

Verify the migration:

```bash
docker exec nova-redis-1 redis-cli keys 'nova:did-index:*'
# Expected: one key per active agent (e.g. 2 lines with did:key:z6Mk... prefixes)

docker exec nova-redis-1 redis-cli hget nova:agent-meta:claude-code did
# Expected: the DID string "did:key:z6Mk..."
```

If the did-index keys are missing after visiting `/admin/agents`, check the admin-api container logs with `docker-compose logs admin-api | tail`.

- [ ] **Step 6: Verify the deployed frontend shows DID on Agents cards**

Visit `http://localhost:3005`, log in, go to Agents. Each card should now have a third line under `agentId` — small mono `did:key:z6Mk...` text (or whatever the agent's DID is).

- [ ] **Step 7: Verify the Simulate button still works on Live**

Go to Live. Click `Simulate conversation`. An amber dashed line draws between two random planets, fades over 2.5s. Clicking repeatedly triggers multiple concurrent lines — each fades on its own timer (the singleton-ness is gone).

- [ ] **Step 8: End-to-end real-event test**

Trigger a real A2A task from one agent to another. There are a few ways, depending on setup:

- If using the MCP server: `nova_send_task` from one agent's MCP session targeting another agent. The exact tool call depends on the agent's UCAN.
- If using curl: POST a signed task to `/a2a` on the receiving tenant (requires a UCAN from the sender). Complex to set up manually; recommended to test via MCP.

Watch the Live tab. Within ~1s of the task being accepted, an amber line should draw from the source planet to the destination planet through the sun. When the task completes, a green line fires. If it fails, a red line.

If no line appears:
- Check `docker-compose logs agent-connector | grep -i lifecycle` — should show logs when `processTask` runs, no "Failed to publish" warnings.
- Check the browser's DevTools → Network → `/admin/events` → Response — raw SSE frames should include `event: task` lines with JSON data.
- If the SSE shows events but no lines render, either `fromAgentId` is missing (sender migration didn't complete — verify Step 5) or the agentId doesn't match any planet in `livePlanets`.

- [ ] **Step 9: Verify reduced-motion behavior**

DevTools → Rendering → emulate `prefers-reduced-motion: reduce`. Refresh. Click Simulate a few times. Lines should appear at full opacity and stay for the full 2.5s before snapping away (no fade). Planets don't orbit.

- [ ] **Step 10: If Steps 1–9 surfaced any fixes, commit**

```bash
git add packages/
git commit -m "fix(admin-ui): cleanup after Live-2 sweep"
```

If no fixes, skip this commit.

---

## Self-review

**Spec coverage** — every requirement traces to a task:

- `AgentMeta.did` field → Task 1 Step 2
- `ParsedAgentMeta.did` field → Task 1 Step 6
- `TaskLifecycleEvent` directional fields → Task 1 Step 3
- `didIndexKey` helper → Task 1 Step 1
- `indexAgentMeta` writes `did` + reverse index → Task 1 Step 4
- `deindexAgent` cleans up reverse index → Task 1 Step 5
- `getAgentByDid` export → Task 1 Step 7
- agent-connector publisher for `queued` → Task 2 Steps 1–2, 4
- agent-connector publisher for `completed` → Task 2 Step 4 (`publishLifecycle('completed')`)
- agent-connector publisher for `failed` at all terminal paths (TTL, confirm denied, confirm timeout, no operator, delivery failed) → Task 2 Step 4
- Frontend SSE `task` listener → Task 3 Step 6
- `activeLines` state + `handleSseTask` + `addConversationLine` + `pruneExpiredLines` → Task 3 Steps 2–3
- Reduced-motion pruning fallback → Task 3 Step 4
- Singleton demo-line state removed → Task 3 Steps 2, 5
- Button renamed → Task 3 Step 8
- Demo delegates to addConversationLine → Task 3 Step 5
- HTML `x-for` over activeLines → Task 3 Step 7
- Action-keyed CSS (`.is-queued` / `.is-completed` / `.is-failed`) → Task 3 Step 1
- DID on Agents card → Task 3 Step 9
- Migration procedure → Task 4 Step 5

**Placeholder scan** — no TBD/TODO/"implement later". Every code block has the actual diff. Verification steps have specific commands.

**Type consistency** — `activeLines`, `addConversationLine`, `handleSseTask`, `pruneExpiredLines`, `_reducedPruneInterval`, `TaskLifecycleEvent`, `lifecycleBase`, `publishLifecycle`, `getAgentByDid`, `didIndexKey` — spelled identically across tasks. CSS class names `.nova-live-line`, `.is-queued`, `.is-completed`, `.is-failed`, `.is-quarantined` match between Task 3 Steps 1 and 7.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-19-admin-ui-live-real-events.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
