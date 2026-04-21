# Broker reply inbox — closing the Broker→Broker loop

**Status:** implemented 2026-04-21
**Scope:** Add a reply path so broker-mode senders (no public webhook) can collect `TaskResult`s for tasks they issued. Symmetric to the task-inbox bite dated 2026-04-19.
**Prior context:** The earlier bite added a broker receive path for MCP-native agents. It still assumed the sender had a real `replyTo` webhook. A broker-mode sender paired with *any* recipient would silently lose the result because there was no endpoint to deliver replies to.

## Motivation

Before this bite, the topology matrix had one unreachable cell:

| Sender → Recipient | Status |
|---|---|
| Webhook → Webhook | OK |
| Webhook → Broker  | OK — recipient pulls, responds to sender's webhook |
| Broker  → Webhook | OK |
| **Broker  → Broker**  | **Silently dropped** |

The broker-mode sender registered with no `replyTo`, and `nova_send_task` defaulted the per-task `replyTo` to `${novaUrl}/agents/${rt.agentId}/replies` — an endpoint that was not mounted. The respond handler fetched that URL, caught the 404, and logged a warning. The sender never saw the result.

This bite adds the missing endpoint and the storage behind it so two broker-mode MCP agents can round-trip a task.

## Design

Three Redis structures, symmetric with the task inbox:

- `nova:reply-inbox:{tenantId}:{agentId}` — **list**. LPUSH on respond; BLPOP on sender's pull. One entry per pending reply, JSON-serialized.
- `nova:reply-inflight:{tenantId}:{agentId}` — **sorted set**. Score = visibility-expiry ms. Claimed on pull; cleared on ack; redelivered by the reclaim worker on expiry; dead-lettered after `BROKER_RECLAIM_CEILING` reclaims.
- `nova:task-result:{tenantId}:{agentId}:{taskId}` — **string with 24h TTL**. Written alongside the inbox LPUSH; served by `GET /agents/:agentId/replies/:taskId` for direct lookup independent of inbox consumption state.

Three HTTP routes, all authenticated with the agent's self-UCAN:

- `GET  /agents/:agentId/replies?wait=<ms>` — long-poll pull. Returns `{ taskId, result, visibleUntil }` or 204.
- `GET  /agents/:agentId/replies/:taskId` — direct lookup by taskId. Returns `{ result }` or 404.
- `POST /agents/:agentId/replies/:taskId/ack` — clears in-flight state. Idempotent.

Three new MCP tools wrap those endpoints:

- `nova_next_reply({ waitMs })` — long-poll wrapper.
- `nova_ack_reply({ taskId })` — ack wrapper.
- `nova_get_task_result` — reused. Now prefers `GET /replies/:taskId` and falls through to the existing task-status endpoint when no stored reply exists (covers in-flight tasks and webhook-mode replyTo senders).

## Ingress change — sender resolution

Task ingress (`packages/a2a-server/src/index.ts`) now resolves the verified sender DID to a Nova-registered agent via `getAgentByDid()`. When resolved, `senderTenantId` and `senderAgentId` are stamped on the `QueuedTask`. The respond path uses these fields to target the sender's reply inbox.

If a task arrives with neither `replyTo` nor a resolvable sender, ingress rejects with `400 REPLY_TARGET_UNRESOLVED` — the result would be undeliverable. External (non-Nova) callers still work as long as they provide `replyTo`.

## Respond path — branching

Both the broker respond endpoint (`packages/a2a-server/src/routes/inbox.ts`) and the webhook delivery path (`packages/agent-connector/src/index.ts`) now branch on the same rules:

1. `replyTo` URL set → POST to URL (existing behavior).
2. `senderTenantId` + `senderAgentId` present + sender active → `enqueueReply`.
3. Sender was present but is now inactive → `writeDeadLetter` with `failureReason: 'reply_sender_inactive'`.
4. Neither branch applies → warn (ingress should have rejected).

## Key production decisions

### Visibility timeout on replies: yes

Mirrors the task inbox. A broker sender that pulls a reply and crashes before consuming it would silently lose the result without a visibility timeout. With it, the reply is redelivered on the next pull. The cost is a small duplicate-processing window; MCP-native agents are already expected to handle at-least-once for tasks, so the reply side is no extra burden.

Trade-off considered: skip the in-flight set and rely solely on the 24h direct-lookup key. Rejected because the sender may not persist the taskIds of in-flight requests and couldn't know what to look up after a crash.

### Stored-result TTL: 24 hours

Matches the maximum `ttlMinutes` accepted by `nova_send_task` (1440). A reply can't meaningfully outlive the window in which its task could still have been running. Env override: `BROKER_REPLY_RESULT_TTL_SECONDS`.

### Size cap: 1 MB

Enforced at the respond endpoint before in-flight state is cleared so an oversized result can be retried with a trimmed payload without losing the claim. Oversized → 413 `RESULT_TOO_LARGE`. Env override: `BROKER_RESULT_MAX_BYTES`.

### No feature flag

Every change is additive or gated on `replyTo` being absent. Existing webhook senders — whose traffic makes up 100% of the current deployment — hit unchanged code paths. Schema-level `replyTo` went from required to optional; all existing serialized data still validates.

### Sender-deregistered handling

When the respond handler finds the sender inactive, the result is written to the dead-letter store addressed to the sender (not the recipient). Operators reviewing DLQ entries with `failureReason: 'reply_sender_inactive'` see exactly which sent tasks lost their replies.

## Redis key summary

```
nova:reply-inbox:{tenantId}:{agentId}        # list  — LPUSH on respond, BLPOP on pull
nova:reply-inflight:{tenantId}:{agentId}     # zset  — score = visibility-expiry ms
nova:task-result:{tenantId}:{agentId}:{tid}  # str   — 24h TTL, direct lookup
nova:broker-reply-agents                     # set   — participants for reclaim sweep
```

## Audit events

New events emitted by the respond path and reply routes:

- `reply_broker_queued` — respond enqueued a reply to a broker sender's inbox
- `reply_delivered` — webhook replyTo delivery succeeded
- `reply_acked` — sender acknowledged a pulled reply
- `reply_reclaimed` (via reclaim worker metrics — no per-entry audit)
- `reply_dead_lettered` (same)
- `reply_sender_inactive` — respond found sender deregistered

## Reclaim worker

`packages/agent-connector`'s existing reclaim tick now also calls `replyInbox.reclaimAllReplies()` in parallel with `reclaimAll()` for task inboxes. Both use the same 10-second interval (`BROKER_RECLAIM_INTERVAL_MS`) and ceiling (`BROKER_RECLAIM_CEILING`).

## Verification

Automated (run with Nova + Redis running):

```
npm run test:acceptance:broker-reply
```

Covers: enqueue/pull/ack round-trip, stored-result lookup, ack idempotency, stored-result surviving ack, reclaim redelivery, reclaim-ceiling DLQ, and the three new routes' auth negative paths.

Manual MCP happy-path (two Claude Code sessions, both broker-mode):

1. Register both agents without `operatorUrl`.
2. Sender: `nova_send_task` to recipient, omit `replyTo`.
3. Recipient: `nova_next_task` → `nova_respond({ status: 'ok', result })`.
4. Sender: `nova_next_reply` — expect the `TaskResult`.
5. Sender: `nova_ack_reply` — expect `{ status: 'accepted' }`.
6. Sender: `nova_get_task_result` — expect `{ source: 'broker_reply', result: {...} }`.

## Out of scope (follow-ups)

- Admin-UI surface for broker-reply inbox depth + DLQ filtered by `reply_*` reasons.
- SSE push for replies (mirrors the same follow-up on the task side).
- Progress-update events delivered through the reply channel (`nova_respond_progress`).
- Per-reply size metrics (`nova_result_payload_bytes` histogram).
