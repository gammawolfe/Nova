# Autonomous Agent Runtime Plan

Nova's production boundary is:

- **Nova:** transport, identity, trust, UCAN authorization, schema/policy gates,
  queues, task lifecycle, audit, and observability.
- **Agent runtime:** an online process for one agent identity that claims work,
  evaluates receiver-side policy, runs capability handlers, and responds.
- **Handler:** the implementation of one capability. Handlers are wrapped by
  middleware traits such as budget, approval, sandbox, dedup, lease extension,
  and audit.

## Current State Verified

- `packages/broker-receiver` is the right receiver daemon foundation. It already
  has SSE inbox wakeups, fallback polling, capacity-aware claiming, graceful
  shutdown, and a health endpoint.
- `packages/task-queue/src/visibility-queue.ts` already uses per-process Redis
  heartbeats for crash-safe holding-list recovery. Do not add a second generic
  broker heartbeat unless it solves a distinct push/webhook case.
- Broker liveness for pull-mode agents should be derived from active SSE/poll
  activity plus receiver health, not from duplicated capability heartbeats.
- Agent capabilities are canonical in the agent card. Runtime health should not
  re-send skills; it should report online/degraded/offline, load, and transport.
- Broker delivery is at-least-once. The visibility timeout can redeliver a task
  while a slow handler is still running, so receiver-side idempotency is required
  before write-capable skills are allowed.
- `codex-cli` can invoke live Codex through `codex exec`, but that must be
  opt-in. The handler now refuses live execution unless configured with
  `handlerConfig.mode: "receiver-policy"` or the dev-only `trusted-local` mode.
- The receiver now has a first execution-policy slice: deny/allow rules by
  sender and intent plus an in-memory per-hour task cap. Denials are returned as
  structured task errors instead of allowing tasks to expire silently.

## Runtime Contract

An online broker-mode runtime should:

1. Subscribe to `/agents/:agentId/inbox/stream` or use long-poll fallback.
2. Claim only when below local concurrency.
3. Evaluate hierarchical receiver policy before running a handler.
4. Check receiver-side dedup before executing non-idempotent work.
5. Run the handler under least privilege.
6. Let handlers explicitly extend leases; never auto-extend because a process
   is still alive.
7. Respond through Nova with either a schema-shaped result or a structured error.
8. Watch the reply inbox for tasks this agent sent and acknowledge replies.
9. Emit trace/audit/metrics for every policy and handler decision.

## Policy Model

Precedence should be explicit:

```text
tenant default < agent default < skill policy < sender override
```

Policy traits are orthogonal and composable:

```text
budgeted
requiresApproval
senderAllowlist
sandbox
networkEgress
secretAccess
idempotency
leaseExtension
audit
```

Example shape:

```json
{
  "defaults": {
    "llm": {
      "requiresApproval": true,
      "maxRuntimeMs": 240000
    }
  },
  "agents": {
    "codex": {
      "skills": {
        "answer_code_question": {
          "senders": {
            "claude-code": {
              "requiresApproval": false,
              "tasksPerHour": 20,
              "usdPerDay": 5,
              "sandbox": "read-only"
            }
          }
        }
      }
    }
  }
}
```

## Lease Semantics

Visibility timeouts should protect the queue from dead receivers.

- Runtime starts with the lease returned by `pull`.
- Handler may explicitly call `extendLease(taskId, durationMs)`.
- Runtime must not extend leases automatically.
- If the handler dies or hangs, the lease lapses and Nova redelivers or
  dead-letters according to reclaim policy.
- Handler timeout must be less than the lease unless the handler is written to
  extend leases deliberately.

## Dedup Retention

Dedup storage must be bounded:

```text
dedup_ttl = visibility_timeout + max_retry_window + safety_margin
```

Recommended storage:

- Dev: in-memory LRU is acceptable for read-only smoke tests.
- Single-host runtime: SQLite.
- Distributed receiver pool: Redis.

## Queue Limits

Receiver backpressure is not enough. Nova should enforce per-agent queue limits
before enqueue:

```text
maxQueueDepth
maxQueuedBytes
maxTaskTtl
overflowPolicy: reject_new | shed_oldest | priority_shed
```

Default production policy should be `reject_new` with failure reason
`queue_full`.

## Lifecycle Model

Keep lifecycle status and failure reason separate:

```text
status:
  queued | claimed | running | completed | failed | expired | canceled

failureReason:
  receiver_offline | unsupported_intent | policy_denied | schema_invalid |
  handler_timeout | handler_error | ucan_scope_violation | budget_exceeded |
  queue_full
```

## Observability

Every task needs end-to-end identifiers:

```text
traceId
taskId
senderTenantId
senderAgentId
targetAgentId
intent
policyDecisionId
handlerRunId
```

Metrics should include queue depth, latency by skill, handler runtime, policy
denials by reason, retry/redelivery count, lease extensions, timeouts, and
LLM cost by sender/skill.

Audit should record accepted, denied, queued, claimed, lease extended, handler
started, handler completed, handler failed, budget exceeded, approval requested,
approval granted, approval denied, and response sent.

## Implementation Slices

1. **Safe live Codex handler:** keep `codex-cli` opt-in with receiver-policy
   mode, read-only sandbox, timeout, and bounded output.
2. **Receiver policy schema:** extend the current sender/intent rule support
   into hierarchical policy loading and a middleware pipeline around handlers.
3. **Dedup store:** add bounded receiver-side dedup before allowing write-capable
   handlers.
4. **Lease extension:** add explicit server endpoint and receiver client method;
   handlers opt into calling it.
5. **Queue limits:** enforce per-agent queue depth/bytes at ingress before
   enqueue.
6. **Lifecycle split:** migrate task state to separate `status` and
   `failureReason`.
7. **Trace/audit metrics:** propagate trace IDs and log every policy/handler
   decision.
8. **Reply watcher:** make the runtime watch `/replies/stream` and ack replies
   for tasks it sent.

## Tests To Add

- live LLM handler denied by default
- sender not in allowlist denied before subprocess spawn
- receiver offline leaves task queued and reports unavailable/expired cleanly
- UCAN scope violation rejected before enqueue
- schema mismatch rejected before enqueue
- queue full rejects before enqueue
- handler timeout causes redelivery or structured failure
- dedup prevents duplicate non-idempotent execution
- explicit lease extension keeps a long task claimed
- missing lease extension allows redelivery
