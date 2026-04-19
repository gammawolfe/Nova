# MCP broker receiver — first-class receive path for MCP-native agents

**Status:** design approved 2026-04-19
**Scope:** Add a broker receive path so MCP-native agents (Claude Code, Hermes, OpenClaw, Cursor) can receive A2A tasks without running an HTTP server. Implements it as a per-agent inbox queue with long-poll pull via two new MCP tools.
**Prior context:** All seven admin-UI bites merged; PR #9 open. Existing receive path requires an `operatorUrl` pointing at an HTTP webhook. That bar is too high for individual users; this bite adds the alternative.

## Motivation

Nova's current receive architecture assumes agents can run HTTP servers. `agent-connector` delivers tasks by POSTing to the agent's declared `operatorUrl`. That works for enterprise deployments (Docker, serverless, VPS) but makes the everyday user journey — *"my 18-year-old nephew installs OpenClaw and can now receive messages from his dad's agent"* — effectively impossible without onboarding him to container orchestration or hosted webhooks.

MCP-native runtimes (Claude Code, OpenClaw, Hermes, Cursor) are stdio clients. They cannot listen on inbound ports, have no public URL, and live only for the duration of a chat session. The existing design documented this gap explicitly: *"MCP is sender-only. Receivers still run operator webhooks directly."*

This bite closes the gap by introducing a **broker** path. Nova stores pending tasks in a per-agent inbox. The agent's MCP client pulls tasks via a long-polling tool call when its AI runtime is ready to work. When the AI produces a response, the MCP client ships the result back via a second tool call, and Nova forwards it to the original sender's `replyUrl`.

For the nephew, receiving becomes another MCP tool — no different from sending.

## Verified behaviour — routing is agent-addressed, not skill-auctioned

Two facts anchor the design. Both verified against the code before writing the spec:

- **`nova_send_task` routes to a specific `targetAgentId`** — `packages/mcp-server/src/tools.ts:304`. Senders name the destination explicitly from the results of `nova_list_agents`. Skills are advertised so senders can pick correctly, not so agents compete.

- **The gate-service rejects intents the target doesn't declare** — `packages/gate-service/src/schema-validator.ts:62-65`. The target agent's `agent-config.json` is loaded; if the intent isn't in its `skills` array the task is rejected as `intent_unknown` before it reaches any queue.

- **Queues are namespaced per-agent** — `packages/shared/src/tenant.ts:57-59` defines `queueName(ctx, tier) = nova:t:<tenantId>:a:<agentId>:tasks:tier<tier>`. Tasks for `nephew-hermes` land in Hermes's queue; Claude Code's queue as `nephew-claude` never sees them.

The broker path inherits this model unchanged. Inboxes follow the same per-agent namespacing. A task addressed to `nephew-hermes` is pushed onto `nova:inbox:<tenantId>:nephew-hermes`. An MCP client authenticated as `nephew-claude` pulling `nova_next_task` sees its own inbox only; it can't see Hermes's.

## Scope

**In scope**
- Inbox data structure in Redis (`nova:inbox:<tenantId>:<agentId>`) backed by a list; LPUSH on arrival, BLPOP on pull
- In-flight store (`nova:inflight:<tenantId>:<agentId>`) as a sorted set keyed by visibility expiry
- At-least-once delivery with 5-minute visibility timeout and 3-reclaim ceiling before dead-letter
- Background reclaim worker: every 10 seconds, returns expired in-flight entries to the head of their inbox (or to DLQ after the retry ceiling)
- New branch in `agent-connector`'s `processTask`: if target agent has no `operatorUrl`, LPUSH to its inbox instead of the existing "No operator URL configured" failure
- Two new HTTP endpoints on `a2a-server`:
  - `GET /agents/:agentId/inbox?wait=30` — long-polls up to `wait` seconds; returns the next task and claims it into in-flight; authenticated with the agent's self-UCAN
  - `POST /agents/:agentId/inbox/:taskId/respond` — completes an in-flight task; ships `TaskResult` to sender's `replyUrl`; clears in-flight state
- Two new MCP tools:
  - `nova_next_task({ waitMs })` → returns `{ task: QueuedTask, visibleUntil: ISOstring } | null`
  - `nova_respond({ taskId, status, result?, error? })` → returns `{ status: 'accepted' | 'already_completed' | 'task_not_found' }`
- Registration flow unchanged — broker mode is signaled implicitly by omitting `operatorUrl` at `nova_register_agent`. Existing webhook agents keep working.
- Lifecycle events (`TASK_LIFECYCLE_CHANNEL`) fired on broker-path `queued` / `completed` / `failed` so the Live admin UI surfaces broker traffic identically to webhook traffic
- DLQ integration: reuses `packages/task-queue/src/dead-letter.ts`. Tasks reclaimed three times without response are written to the existing dead-letter path, matching webhook failure handling.
- Tests (Vitest + Playwright coverage for the new endpoints and tools)

**Out of scope**
- SSE live push — long-poll via BLPOP is sufficient for this bite. SSE can layer on as pure optimization later without changing tool shapes or inbox semantics.
- Platform-level human-in-the-loop approval UI — existing `confirm_requested` flow stays as-is; the broker is transparent. An AI that wants to prompt its operator before executing a task does so at the AI level.
- Progress / partial status updates (`nova_respond_progress`) — YAGNI for the first cut; add when needed.
- Batch pull or batch respond — single task per call.
- Automatic broker-mode on registration if the client cannot offer an `operatorUrl` — caller is explicit; omit `operatorUrl` to request broker mode.
- Inbox listing / inspection API for operators — observable via logs + metrics + Live view; a dedicated admin-UI "inbox viewer" is its own bite.
- Priority / tiered pulling — all tiers land in one inbox per agent. BullMQ's tier mechanic was tuned for webhook delivery ordering. The broker doesn't need it.

## Architecture

Three changes land together. Each is independently deployable and inert on its own.

1. **`agent-connector` gains a broker branch.** Current code fails with `No operator URL configured`. New behaviour: if the target agent's `operatorUrl` is absent at the point of delivery, LPUSH the `QueuedTask` onto `nova:inbox:<tenantId>:<agentId>` and publish `queued` to `TASK_LIFECYCLE_CHANNEL`. The existing webhook path is entered only when `operatorUrl` is set. `agent-connector` also runs a reclaim worker that sweeps in-flight tasks on a 10-second interval.
2. **`a2a-server` gains two endpoints.** `GET .../inbox` is the long-poll pull; `POST .../inbox/:taskId/respond` is the completion path. Both authenticate via the agent's self-UCAN (same UCAN issued at approval that appears in `nova_whoami`'s `ucan.self`).
3. **`mcp-server` gains two tools** that wrap those endpoints. The tools carry the agent's self-UCAN automatically — the MCP client already has it stored at `~/.nova/agents/<agentId>/ucan`.

No schema changes. No data migration. Existing webhook receivers (all zero of them in the current deployment, but the code path remains) are unaffected.

## Data model

### Redis keys

- `nova:inbox:<tenantId>:<agentId>` — **list**. New task → LPUSH. Pull → BLPOP (atomic with the in-flight ZADD via a Lua script). Each entry is the full JSON-serialized `QueuedTask`.
- `nova:inflight:<tenantId>:<agentId>` — **sorted set**. Score = visibility-expiry Unix ms. Member = JSON-serialized `{ taskId, task, reclaimCount }`. On successful pull, ZADD with score `Date.now() + 5*60*1000`. On `respond`, ZREM the entry whose `taskId` matches.
- `nova:inbox:tenants` — **set** of tenantIds that have at least one broker-mode agent. Maintained on registration/deregistration. Used by the reclaim worker to know which tenant prefixes to scan.

Key format deliberately mirrors `queueName` (`nova:t:<tenantId>:a:<agentId>:tasks:tier<tier>`) so existing operators recognize the shape.

### In-flight state machine

```
               ┌────────────┐
  task arrives │            │ nova_next_task
  ──LPUSH────▶ │   INBOX    │──BLPOP+ZADD─────▶┐
               │            │                  │
               └────────────┘                  │
                     ▲                         ▼
                     │                   ┌──────────┐
                     │                   │          │ nova_respond(ok)
                     │  visibility       │ IN-FLIGHT│──ZREM──▶ COMPLETED
                     │  timeout          │          │           (ship to replyUrl)
                     │  reclaim_count<3  │          │
                     └──ZREM + LPUSH─────│          │ nova_respond(error)
                                         │          │──ZREM──▶ FAILED
                                         └──────────┘           (ship error to replyUrl)
                                              │
                                              │ visibility timeout
                                              │ reclaim_count>=3
                                              ▼
                                            DLQ
                                     (writeDeadLetter)
```

Visibility timeout default: 300 seconds. Reclaim ceiling: 3. Both live in `@nova/shared/src/config.ts` as named constants, overridable via env.

## Registration — implicit broker mode

The existing `nova_register_agent` tool accepts optional `operatorUrl` and `replyUrl`. No schema change; the signal to request broker mode is simply **registering with real skills and omitting `operatorUrl`**.

```ts
// Webhook receiver (unchanged)
await nova_register_agent({
  agentId: 'mycompany-bot',
  name: 'MyCompany Bot',
  skills: [{ id: 'query_knowledge', ... }],
  operatorUrl: 'https://api.mycompany.com/nova/process',  // webhook target
  replyUrl: 'https://api.mycompany.com/nova/replies',
});

// Broker receiver (new — nephew scenario)
await nova_register_agent({
  agentId: 'nephew-hermes',
  name: 'Anime Buddy',
  skills: [{ id: 'anime_suggestion', name: 'Suggest anime', ... }],
  // NO operatorUrl — signals broker mode
  // NO replyUrl — broker doesn't need one; responses flow back through sender's replyUrl
});

// Sender-only (unchanged)
await nova_register_agent({
  agentId: 'nephew-claude',
  name: 'Claude for homework',
  skills: [{ id: '__sender_only', name: 'Sender only', description: '...' }],
});
```

`agent-connector` uses `operatorUrl` presence at delivery time to pick the path:

```ts
// New branch in processTask (agent-connector/src/index.ts, around line 117)
const operatorUrl = await getOperatorUrl(taskCtx);
if (!operatorUrl) {
  // Check broker mode via agent-service.
  const agent = await agentService.getAgent(taskCtx.tenantId, taskCtx.agentId);
  if (agent && agent.status === 'active' && agent.skills.some(s => s.id !== '__sender_only')) {
    // Broker mode — enqueue to inbox
    await inboxService.enqueue(taskCtx, task);
    await publishLifecycle('queued');
    return;
  }
  // Legacy failure path — sender-only agent that somehow had a task addressed to it
  await updateTaskStatus(...);
  return;
}
// Existing webhook path — unchanged
```

No flag on `AgentConfig` distinguishes broker vs webhook. The presence or absence of `operatorUrl` is the signal. This keeps the schema untouched and the migration cost zero.

## Authentication — self-UCAN proof

The agent already holds a **self-UCAN** issued by Nova at approval time, stored at `~/.nova/agents/<agentId>/ucan` and tracked in `whoami`'s `ucan.self`. This UCAN proves the holder is authorized to act as `<agentId>` in `<tenantId>`. The broker endpoints verify it exactly as existing admin routes do.

**Pull request:**
```
GET /agents/<agentId>/inbox?wait=30
Authorization: Bearer <agent-self-UCAN-JWT>
```

`a2a-server` extracts the UCAN, verifies signature + expiry + audience, confirms the UCAN's subject DID matches the agent's stored DID in the Redis agent-index, and only then proceeds. No other capability claim needed — the agent is pulling from its own inbox.

**Respond request:**
```
POST /agents/<agentId>/inbox/<taskId>/respond
Authorization: Bearer <agent-self-UCAN-JWT>
Content-Type: application/json

{ "status": "ok", "result": { ... } }
```

Same UCAN verification. Additionally, the endpoint reads `nova:inflight:<tenantId>:<agentId>` and confirms `<taskId>` is in-flight for this agent. If not (either the task never existed, was already responded to, or timed out and was reclaimed), return `404` with `{ status: 'task_not_found' }` or `409` with `{ status: 'already_completed' }`.

If the MCP client's self-UCAN has expired, `nova_renew_ucan` already handles rotation; the tool surfaces a reasonable error and the renewal path is unchanged.

## Backend — `agent-connector` broker branch

**File:** `packages/agent-connector/src/index.ts`

Current state (around line 117):
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

New state:
```ts
const operatorUrl = await getOperatorUrl(taskCtx);
if (!operatorUrl) {
  // Broker mode — agent receives via MCP pull instead of HTTP webhook
  const isBrokerMode = await inboxService.isBrokerAgent(taskCtx);
  if (isBrokerMode) {
    await inboxService.enqueue(taskCtx, task);
    await updateTaskStatus(taskCtx, task.taskId, 'queued', { statusMessage: 'Queued in agent inbox' });
    await publishTaskEvent(taskCtx, task.taskId, { type: 'status_update', data: { status: 'queued' } });
    await publishLifecycle('queued');
    logger.info({ taskCtx, taskId: task.taskId }, 'Task enqueued to broker inbox');
    return;
  }

  logger.error({ taskCtx }, 'No operator URL configured and agent is not in broker mode');
  await updateTaskStatus(taskCtx, task.taskId, 'failed', { statusMessage: 'No operator URL configured' });
  await publishTaskEvent(taskCtx, task.taskId, { type: 'status_update', data: { status: 'failed' } });
  await publishLifecycle('failed');
  return;
}
// Existing webhook delivery continues here, unchanged.
```

`inboxService.isBrokerAgent(ctx)` returns true when the agent is active, has no `operatorUrl`, and advertises at least one skill that isn't `__sender_only`.

## Backend — new `inbox-service` module

**File:** `packages/task-queue/src/inbox.ts` (new)

```ts
export interface InboxEnqueueResult { enqueued: true; position: number; }

export async function enqueue(ctx: TenantContext, task: QueuedTask): Promise<InboxEnqueueResult>;
export async function pull(ctx: TenantContext, waitMs: number): Promise<{ task: QueuedTask; visibleUntil: Date } | null>;
export async function respond(ctx: TenantContext, taskId: string): Promise<'accepted' | 'already_completed' | 'task_not_found'>;
export async function reclaim(ctx: TenantContext): Promise<{ reclaimed: number; deadLettered: number }>;
export async function isBrokerAgent(ctx: TenantContext): Promise<boolean>;
```

Key Redis ops (pseudocode):

```ts
// enqueue
await redis.lpush(inboxKey(ctx), JSON.stringify(task));

// pull (atomic via Lua script to avoid race between BLPOP and ZADD)
const script = `
  local payload = redis.call('RPOP', KEYS[1])
  if not payload then return nil end
  local taskId = cjson.decode(payload).taskId
  local visibleUntil = tonumber(ARGV[1])
  redis.call('ZADD', KEYS[2], visibleUntil, cjson.encode({taskId=taskId, task=payload, reclaimCount=0}))
  return payload
`;
// If RPOP returns nil, fall back to BLPOP with remaining waitMs budget — single blocking call

// respond
const entries = await redis.zrange(inflightKey(ctx), 0, -1);
for (const raw of entries) {
  const entry = JSON.parse(raw);
  if (entry.taskId === taskId) {
    await redis.zrem(inflightKey(ctx), raw);
    return 'accepted';
  }
}
return 'task_not_found'; // or 'already_completed' if we track completions separately

// reclaim — runs from the background worker every 10s
const now = Date.now();
const expired = await redis.zrangebyscore(inflightKey(ctx), '-inf', now);
for (const raw of expired) {
  const entry = JSON.parse(raw);
  entry.reclaimCount += 1;
  await redis.zrem(inflightKey(ctx), raw);
  if (entry.reclaimCount >= 3) {
    await writeDeadLetter(ctx, { ... existing shape ... });
  } else {
    const updated = { ...entry };
    await redis.lpush(inboxKey(ctx), entry.task); // head of list so it comes back first
  }
}
```

Keys:
```ts
export function inboxKey(ctx: TenantContext): string {
  return `nova:inbox:${ctx.tenantId}:${ctx.agentId}`;
}
export function inflightKey(ctx: TenantContext): string {
  return `nova:inflight:${ctx.tenantId}:${ctx.agentId}`;
}
```

## Backend — new HTTP endpoints on `a2a-server`

**File:** `packages/a2a-server/src/routes/inbox.ts` (new) plus mount in `packages/a2a-server/src/index.ts`

```
GET /agents/:agentId/inbox?wait=<ms>
  Auth: Bearer <agent-self-UCAN>
  Response 200: { task: QueuedTask, visibleUntil: "2026-04-19T12:34:56.789Z" }
  Response 204: (no task in window)
  Response 401: UCAN invalid / expired / DID mismatch
  Response 404: agent not found / not broker mode

POST /agents/:agentId/inbox/:taskId/respond
  Auth: Bearer <agent-self-UCAN>
  Body: { status: "ok"|"error", result?: any, error?: { code, message, retryable } }
  Response 202: { status: "accepted" }
  Response 404: { status: "task_not_found" }
  Response 409: { status: "already_completed" }
  Response 401: UCAN invalid
```

Pull handler internally calls `inboxService.pull(ctx, waitMs)`. Respond handler validates the task is in-flight, then:
- On `ok`: ships the `TaskResult` to the sender's `replyUrl` via existing `deliverToReplyTo` helper, publishes `completed` to `TASK_LIFECYCLE_CHANNEL`, ZREMs the in-flight entry, updates task status to `completed`, writes audit log.
- On `error`: ships an error-shaped `TaskResult`, publishes `failed`, ZREMs, updates task status to `failed`.

The respond path goes through the same `deliverToReplyTo` code the webhook path uses, so the sender's `replyUrl` sees identical behaviour regardless of which receive mode the target used. Delivery retries, dead-lettering of the replyUrl delivery, and metrics all inherit from the existing plumbing.

## Backend — reclaim worker

Runs inside `agent-connector` (which already hosts worker processes). Interval: 10 seconds. Scans `nova:inbox:tenants`, then for each tenant scans `nova:inflight:<tenantId>:*`. For each inflight set, calls `inboxService.reclaim(ctx)`.

Scale note: with N tenants and M broker agents per tenant, this is `O(N*M)` Redis calls per tick. At the scale Nova is designed for (thousands of agents, not millions) this is trivial. If it ever isn't, index-driven discovery (`SCAN` with pattern) or per-agent BullMQ delayed-job scheduling replaces the scan.

## Backend — DLQ integration

Reclaim count 3+ triggers `writeDeadLetter` from `@nova/task-queue`. Entry shape:

```ts
{
  id: uuid,
  tenantId, agentId,
  taskId, targetUrl: 'broker',
  taskResult: { type: 'TaskResult', requestId: taskId, status: 'error',
                error: { code: 'BROKER_TIMEOUT', message: 'Receiver did not respond within 3 reclaim windows', retryable: false },
                auditToken: 'none', completedAt: now, schemaVersion: '1.0' },
  failureReason: 'broker_no_response',
  attemptCount: reclaimCount,
}
```

The existing admin UI dead-letter surface (not yet implemented, but the backend exists) automatically includes broker failures once we add the UI.

## MCP tools — `nova_next_task`

**File:** `packages/mcp-server/src/tools.ts`

```ts
server.registerTool(
  'nova_next_task',
  {
    title: 'Pull the next pending task from this agent\'s inbox',
    description: 'Long-polls up to waitMs for a task addressed to the active agent. Returns null on timeout. The returned task is claimed into an in-flight state with a 5-minute visibility timeout; call nova_respond before the timeout expires or the task will be redelivered.',
    inputSchema: {
      waitMs: z.number().int().min(0).max(60_000).default(30_000).describe('Max ms to wait for a task. Server caps at 60s.'),
    },
  },
  async ({ waitMs }) => {
    const rt = await loadAgentRuntime();
    if (!rt) return err('No active agent runtime. Set NOVA_AGENT_ID.');
    const selfUcan = await loadSelfUcan(rt.agentId);
    if (!selfUcan) return err(`Self-UCAN missing for ${rt.agentId}`);

    const result = await rt.client.inboxPull(rt.agentId, selfUcan, waitMs);
    if (!result) return ok({ task: null, message: 'No task available within wait window.' });
    return ok(result);
  },
);
```

Return shape on success:
```json
{
  "task": {
    "taskId": "uuid",
    "tenantId": "tenant_xxx",
    "agentId": "nephew-hermes",
    "intent": "anime_suggestion",
    "params": { "mood": "cozy" },
    "replyTo": "https://nova.example.com/agents/dad-bot/replies",
    "senderDid": "did:key:z6Mk...",
    "tier": 2,
    "queuedAt": "...",
    "expiresAt": "..."
  },
  "visibleUntil": "2026-04-19T12:34:56.789Z"
}
```

On no task: `{ task: null, message: "No task available within wait window." }`.

Usage pattern (AI-side, in the nephew's MCP session):
```
Nephew: "Any messages for me?"
AI: [calls nova_next_task, waitMs=30000]
    [receives task: "dad-bot wants an anime suggestion for a cozy evening"]
    "Dad wants an anime suggestion for a cozy evening. Let me think..."
    [calls nova_respond with the suggestion]
    "Sent! 'Flying Witch' — it's exactly the cozy vibe."
```

## MCP tools — `nova_respond`

```ts
server.registerTool(
  'nova_respond',
  {
    title: 'Complete a task this agent pulled from its inbox',
    description: 'Ships a TaskResult back to the original sender. Must be called within the visibility timeout (5 minutes from nova_next_task) or the task will be redelivered.',
    inputSchema: {
      taskId: z.string().uuid(),
      status: z.enum(['ok', 'error']),
      result: z.record(z.unknown()).optional().describe('On ok: the result payload shaped to the skill\'s outputSchema'),
      error: z.object({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean().optional(),
      }).optional().describe('On error: structured error detail'),
    },
  },
  async ({ taskId, status, result, error }) => {
    const rt = await loadAgentRuntime();
    if (!rt) return err('No active agent runtime. Set NOVA_AGENT_ID.');
    const selfUcan = await loadSelfUcan(rt.agentId);
    if (!selfUcan) return err(`Self-UCAN missing for ${rt.agentId}`);

    const response = await rt.client.inboxRespond(rt.agentId, selfUcan, taskId, { status, result, error });
    return ok(response);
  },
);
```

Return shape: `{ status: 'accepted' }` | `{ status: 'already_completed' }` | `{ status: 'task_not_found' }`.

Idempotency: calling `nova_respond` twice with the same `taskId` yields `already_completed` on the second call, never double-fires the replyUrl.

## Lifecycle events — Live view integration

The existing `TASK_LIFECYCLE_CHANNEL` publishers in `agent-connector` already cover the webhook path (`queued` at processTask entry, `completed` at delivery, `failed` at terminal errors). For broker mode, we add:

- `queued` fires on `inboxService.enqueue` (in the `agent-connector` broker branch, replacing the webhook's pre-delivery `queued`)
- `completed` fires inside the respond endpoint when the replyUrl delivery succeeds
- `failed` fires inside the respond endpoint on `status: 'error'` responses, and from the reclaim worker when a task hits the DLQ

So the Live tab's solar-system view lights up amber → green (or red) for broker traffic identically to webhook traffic. No admin-UI changes needed.

## Observability

**Logs** (pino structured, matching existing conventions):
```
{ level: 'info', taskCtx, taskId, mode: 'broker', msg: 'Task enqueued to broker inbox' }
{ level: 'info', agentId, taskId, visibleUntil, msg: 'Task pulled from inbox' }
{ level: 'info', agentId, taskId, outcome: 'ok'|'error', msg: 'Task responded' }
{ level: 'warn', agentId, taskId, reclaimCount, msg: 'Task reclaimed — visibility timeout exceeded' }
{ level: 'error', agentId, taskId, msg: 'Task dead-lettered after broker reclaim ceiling' }
```

**Metrics** (Prometheus via `prom-client`, consistent with `connectorRegistry`):
```
nova_broker_inbox_depth{tenantId, agentId}          gauge
nova_broker_inflight_depth{tenantId, agentId}       gauge
nova_broker_pull_duration_ms                        histogram
nova_broker_pull_outcome{outcome="task"|"timeout"}  counter
nova_broker_respond_outcome{outcome="ok"|"error"|"already_completed"|"task_not_found"}  counter
nova_broker_reclaims_total{outcome="redeliver"|"dead_letter"}  counter
```

## Error handling

| Situation | Handling |
|---|---|
| Task's `expiresAt` passes while in inbox | On pull, check `expiresAt`. If expired, skip (LPOP without claiming), update status to `failed(TTL_EXPIRED)`, publishLifecycle `failed`, log. The next pull on the same inbox gets the next task. |
| MCP client calls `nova_respond` with a taskId it never pulled | 404 `task_not_found`. |
| MCP client calls `nova_respond` after visibility timeout expired (task was reclaimed) | Depends on whether it was redelivered: if the same client pulled it again, the ZADD on the second pull created a new entry — the `respond` ZREMs the current entry cleanly. If a different client pulled it, `respond` finds its expected entry gone → 409 `already_completed`. |
| Reclaim reaches count 3 | DLQ + `failed` lifecycle. |
| `deliverToReplyTo` fails during respond | Existing dead-letter flow on the replyUrl side (unchanged). Broker's respond still returns `accepted` to the AI because the receive-side contract was fulfilled; the delivery-side failure is a separate concern the sender sees on their replyUrl. |
| Self-UCAN expired | 401. MCP client surfaces a structured error prompting `nova_renew_ucan`. |
| Agent deregistered between pull and respond | 404 `task_not_found` (inflight set was cleared by `deindexAgent`). |
| Two MCP sessions claiming the same agentId, both long-polling | Redis BLPOP is FIFO; whoever's call arrived first gets the task. The other sees null and re-polls. |
| Redis unavailable | Pull returns 503; respond returns 503; MCP tool surfaces `inbox_unavailable`. Standard circuit-breaker applies. |

## Testing strategy

**Unit tests (Vitest):**
- `inbox-service.test.ts` with a real Redis in a Docker-compose test harness (or ioredis-mock): enqueue → pull → respond → verify empty; enqueue → pull → no respond → reclaim returns it; reclaim 3× → DLQ; concurrent pulls race-free via Lua.
- Schema tests: self-UCAN verification paths return correct status codes.

**Integration tests (Playwright + supertest):**
- Start `a2a-server` + Redis.
- Register a broker-mode agent fixture.
- POST a task via the standard A2A ingress (simulates what gate-service hands to agent-connector after validation).
- Call the new inbox endpoints directly with a synthetic self-UCAN.
- Verify: task reaches inbox, pull claims it, respond ships to replyUrl, lifecycle events fire in expected order.

**E2E smoke test (admin-ui Playwright, extending existing suite):**
- Mock `/admin/agents` to include a broker-mode agent.
- Navigate to Live tab.
- Via the already-existing ability to inject SSE events from page.evaluate(), simulate a broker queued/completed pair — assert the Live lines draw.

No changes to the existing 11 unit + 16 e2e tests are required; they keep passing.

## Verification procedure

1. `cd packages/task-queue && npm test` — inbox-service Vitest passes.
2. `docker-compose up -d --build a2a-server agent-connector` — both rebuild cleanly.
3. Register a broker-mode agent via the existing `nova_register_agent` MCP tool, omitting `operatorUrl`. Advertise one real skill (e.g., `echo`).
4. Operator approves via admin UI.
5. From a different agent, send a task to the broker agent: `nova_send_task({ targetAgentId: 'echo-bot', intent: 'echo', params: { text: 'hello' } })`.
6. As `echo-bot` (in a separate MCP session), call `nova_next_task({ waitMs: 5000 })`. Expect the task.
7. Call `nova_respond({ taskId, status: 'ok', result: { text: 'hello' } })`. Expect `{ status: 'accepted' }`.
8. Sender calls `nova_get_task_result({ targetAgentId: 'echo-bot', taskId })`. Expect the result.
9. Admin UI Live tab shows the conversation — amber queued line, green completed line.
10. Repeat the send but don't respond. After 5 minutes of inactivity, verify the task returned to the inbox (observe with `docker exec nova-redis-1 redis-cli llen nova:inbox:<tenantId>:echo-bot`). After 3 reclaim cycles, verify a DLQ entry appears in `data/tenants/<tenantId>/agents/echo-bot/dead-letter/`.
11. Grep: `rg "operatorUrl" packages/agent-connector packages/a2a-server` — confirms the webhook path still exists and is untouched.

## Files expected to change

- `packages/shared/src/config.ts` — new const `BROKER_VISIBILITY_TIMEOUT_MS = 300_000` and `BROKER_RECLAIM_CEILING = 3` (new file if config doesn't exist yet)
- `packages/task-queue/src/inbox.ts` — new module, ~150 lines
- `packages/task-queue/src/index.ts` — re-export inbox module
- `packages/agent-connector/src/index.ts` — new broker branch in `processTask`, new reclaim worker registered at startup, ~50 lines
- `packages/a2a-server/src/routes/inbox.ts` — new route file, ~120 lines
- `packages/a2a-server/src/index.ts` — mount the router, ~5 lines
- `packages/mcp-server/src/nova-client.ts` — two new client methods `inboxPull` + `inboxRespond`, ~40 lines
- `packages/mcp-server/src/tools.ts` — two new tools `nova_next_task` + `nova_respond`, ~70 lines
- `packages/mcp-server/src/ucan-store.ts` (or similar) — if a `loadSelfUcan(agentId)` helper doesn't already exist, add one reading from `~/.nova/agents/<agentId>/ucan`
- Tests: `packages/task-queue/test/inbox.test.ts`, `packages/a2a-server/test/inbox.integration.test.ts`

Approximate total: ~500 lines across 5 packages, plus ~300 lines of tests.

## Risks and decisions deferred

- **Reclaim worker running in `agent-connector` means it's tied to that process's lifecycle.** If `agent-connector` is down, no reclaims happen and in-flight tasks sit stuck until it recovers. Since `agent-connector` already owns the equivalent responsibility for webhook delivery retries, this is the right home; dedicated reclaim service is premature.
- **BLPOP holds a Redis connection per long-poll.** At 1000 simultaneous pulls that's 1000 Redis connections. Mitigated by (a) 60-second max wait, so connections churn; (b) per-tenant connection pools if scale demands. Flag for load-testing before production.
- **Lua-scripted pull-and-claim vs two-call version.** Two-call (BLPOP then ZADD) has a race: if the server crashes between them, task is lost. Lua is atomic. Spec mandates Lua; implementation may initially use two-call for simplicity and switch to Lua after integration tests prove the race is real and not theoretical.
- **No rate limit on `nova_next_task`.** A misbehaving client could hammer `waitMs=0` and spin. Standard admin rate-limit middleware (if/when added) covers it; not a first-cut concern.
- **TTL cleanup of abandoned inboxes.** If a broker agent is deregistered but had pending tasks, `deindexAgent` should also `DEL` the inbox + inflight keys. Add that in implementation; not a large change.
- **Self-UCAN expiry in the middle of a long-poll.** Edge case. The long-poll holds for up to 60 seconds. If the UCAN expires during the wait, the subsequent responses work but the CURRENT call has already been authorized. Acceptable — tiny window.
- **MCP tool surface bloat.** Two more tools adds to the agent's toolset. At some point we'll want a "receive mode" vs "send mode" split or a toolset-grouping convention. Defer.
- **No auto-discovery of broker vs webhook on registration.** The client explicitly decides by omitting `operatorUrl`. A future smarter client could detect "I can't host a URL" and choose broker automatically, but that's client-side and orthogonal.
- **Replay / audit for in-flight tasks.** Operators can't currently see what's in the inbox. A future admin-UI "Inbox" drawer (per agent) would be cheap given the existing Redis keys and admin-auth. Spec doesn't include it; separate bite.
- **No `nova_respond_progress` for long-running tasks.** AIs that need more than 5 minutes must extend the visibility timeout or accept redelivery. A progress tool that ACKs without completing is the clean fix; defer until a real use case demands it.
- **Confirmation/HITL integration.** The platform's existing `confirmation` service (`confirm_requested` events) is orthogonal. A receiving AI that wants a human to approve can still use that mechanism via existing skill config (`highPrivilegeSkills`, `confirmTimeouts`). No new UX baked into the broker.
- **Cross-tenant conversations.** Both sender and receiver can be in different tenants today (the trust-registry story already supports it). Broker mode doesn't change that — the inbox is still keyed by the *recipient's* tenantId+agentId, which is what the task was addressed to.
