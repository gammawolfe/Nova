# @nova/task-queue

Redis-backed durability and delivery layer. The a2a-server, admin-api, and agent-connector all go through this package — nothing else in the monorepo talks to Redis directly for task state. Consolidating the key layout, TTLs, and BullMQ wiring here keeps naming consistent and makes dead-code-review possible.

## What's inside

Five concerns, five files:

| File | Role |
|---|---|
| `index.ts` | BullMQ tier queues, task-state hash, SSE event fan-out |
| `inbox.ts` | Broker-mode receiver inbox (at-least-once, visibility timeout) |
| `reply-inbox.ts` | Broker-mode sender-side reply inbox + direct-lookup `TaskResult` store |
| `dead-letter.ts` | File-backed DLQ for delivery-exhaustion and 4xx |
| `metrics.ts` | Prometheus registry for `nova_queue_depth` + `nova_task_duration_ms` |

## Primary task pipeline (`index.ts`)

### Idempotent enqueue

```ts
enqueueWithIdempotency(ctx, task, ttlSeconds) → boolean
```

`SET NX` on `redisKey(ctx, 'idempotency', taskId)` acquires the slot atomically. On acquire, the task is pushed onto the per-tier BullMQ queue (`queueName(ctx, tier)`) with `jobId = taskId` and `attempts: 1` — retries are the HTTP sender's responsibility via resubmission with the same `taskId`, not BullMQ's. Returns `false` on duplicate (drop), `true` on fresh enqueue.

Queue instances are memoized in a module-level `Map` to avoid per-request connection churn.

### Task state

```ts
setTaskState(ctx, state)      // initial write, full TaskState as Redis hash
updateTaskStatus(ctx, id, status, extra?)  // partial update
getTaskState(ctx, id)         // returns TaskState | null
```

Persisted under `redisKey(ctx, 'task', taskId)` with 24h TTL. Only well-formed writes flow through `setTaskState` / `updateTaskStatus`, so `getTaskState` casts the hash without schema revalidation.

### SSE event fan-out

```ts
publishTaskEvent(ctx, taskId, { type, data })
```

Dual-writes per event in a single pipeline:

1. `INCR` a per-task sequence counter → monotonic `eventId`.
2. `ZADD` the payload to a sorted log (for Last-Event-ID replay).
3. `PUBLISH` to the pub/sub channel (for live SSE subscribers).

This is what backs the `nova://tasks/{taskId}` push stream exposed by the MCP server and admin UI.

## Broker inboxes

When a recipient (or the sender waiting for a reply) isn't reachable via webhook, tasks and results land here instead and wait to be pulled.

### Receiver side — `inbox.ts`

Per-agent list-backed queue with a companion in-flight set.

| Key | Purpose |
|---|---|
| `nova:inbox:{tenantId}:{agentId}` | LPUSH'd list of `InflightEntry` payloads |
| `nova:inflight:{tenantId}:{agentId}` | ZSET scored by `visibleUntil` (ms) |
| `nova:inbox-notify:{tenantId}:{agentId}` | Pub/sub channel for push hints |
| `nova:inbox-seq:{tenantId}:{agentId}` | Monotonic `seq` counter (SSE `id:` values) |
| `nova:broker-agents` | Registry of `(tenantId, agentId)` pairs with broker agents |

Primitives:

```ts
enqueue(ctx, task)          // LPUSH + INCR seq + SADD registry + PUBLISH notify
pull(ctx, waitMs)           // BLPOP → ZADD inflight with visibility timeout
list(ctx)                   // non-destructive peek (used by HTTP /peek and SSE replay)
respond(ctx, taskId, ...)   // remove from inflight, returns accepted|already_completed|task_not_found
```

Visibility-timeout semantics: `pull` claims a task under `BROKER_VISIBILITY_TIMEOUT_MS` (5 min in `@nova/shared/src/broker-config`); if `respond` doesn't land in time, a reclaim worker returns it to the inbox with `reclaimCount++`. Past `BROKER_RECLAIM_CEILING` attempts, the entry is written to dead-letter.

Known caveat (documented at the `pull` call site): BLPOP + ZADD can't be made atomic with Redis Lua because BLPOP blocks. A process crash between the two commands loses the task from the inbox without in-flight tracking. Surface orphans via follow-up sweeps if this ever matters in practice.

### Sender side — `reply-inbox.ts`

Symmetric to the receiver inbox but in the opposite direction. When a broker-mode sender omits `replyTo`, the recipient's respond handler enqueues the `TaskResult` here instead of POSTing to a webhook. Pulled by `nova_next_reply`, acked by `nova_ack_reply`.

| Key | Purpose |
|---|---|
| `nova:reply-inbox:{tenantId}:{agentId}` | Pending `TaskResult` payloads |
| `nova:reply-inflight:{tenantId}:{agentId}` | In-flight ZSET |
| `nova:reply-inbox-notify:{tenantId}:{agentId}` | Pub/sub channel for push hints |
| `nova:reply-inbox-seq:{tenantId}:{agentId}` | Monotonic `seq` counter |
| `nova:task-result:{tenantId}:{agentId}:{taskId}` | Direct-lookup store (TTL = `BROKER_REPLY_RESULT_TTL_SECONDS`) |

The direct-lookup key is what lets `nova_get_task_result` return a stored reply independent of the pull/ack state — once a result lands, it stays retrievable for the configured TTL even after the sender acks it off the pull queue.

## Dead-letter (`dead-letter.ts`)

On delivery-exhaustion (retry ceiling hit) or HTTP 4xx from the target, `writeDeadLetter` emits a JSON file under `tenantDataPath(ctx, 'dead-letter')/<uuid>.json` with a 7-day default expiry (`DEAD_LETTER_TTL_DAYS` env override).

File-backed, not Redis — dead letters outlive Redis flushes and are intended for operator inspection via the admin-api DLQ endpoints (`GET /admin/tenants/:id/agents/:agentId/dead-letter`).

## Metrics (`metrics.ts`)

Registered under the `task-queue` namespace in the shared metrics registry.

| Metric | Type | Labels |
|---|---|---|
| `nova_queue_depth` | Gauge | `tier` |
| `nova_task_duration_ms` | Histogram | `intent`, `status` |

Buckets: `100, 500, 1000, 5000, 15000, 30000, 60000` ms.

## Key-naming conventions

All keys route through `redisKey(ctx, kind, ...)` and `queueName(ctx, tier)` from `@nova/shared/src/tenant`. Never hand-roll a key outside those helpers — tenant isolation depends on the helpers prefixing every key with the tenant id.
