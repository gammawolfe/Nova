# MCP push subscriptions — inbox and task notifications without polling

**Status:** proposed 2026-04-22
**Scope:** Add a push path so MCP clients (Claude Code, Hermes, OpenClaw, a future broker-receiver daemon) learn of new inbox items and task-state changes as they happen, instead of long-polling. Surgical changes across three packages, reusing existing SSE and pub/sub plumbing.
**Prior context:** Broker mode ships today with `nova_next_task` (BLPOP long-poll, 30s windows). Task streaming ships today via `GET /agents/:agentId/tasks/:taskId/stream` (SSE). The two live side-by-side but MCP clients only see the pull half. This bite joins them up.

## Motivation

Every current MCP consumer of the inbox pays the long-poll cost: a 30-second wait before the next check, a duplicate round-trip whenever an item lands, and no way to react to task progress without calling `nova_get_task_result` on a timer. The server already emits the events needed to do better — they just aren't routed to MCP clients.

Concrete consequences today:

- **Interactive sessions miss traffic.** A user reopening Claude Code after a lunch break waits up to 30s before the session sees there's anything queued.
- **Programmatic consumers reinvent the wheel.** The forthcoming broker-receiver daemon (`2026-04-21-broker-receiver-daemon.md`) is specced against long-poll because push wasn't available; it will want to migrate the moment push ships.
- **No way to tail a remote task.** A sender has no primitive for "tell me when task X changes state" beyond re-polling `nova_get_task_result`.

Closing these is a small set of additions; the expensive machinery (pub/sub, sorted-set replay logs, SSE framing, UCAN auth on streams) already exists.

## What already exists

Verified against current code before writing this spec:

- **Per-task events are already published.** `publishTaskEvent` (`packages/task-queue/src/index.ts:135-156`) writes every event to a per-task sorted-set log *and* a per-task pub/sub channel. Replay-on-reconnect via `Last-Event-ID` is already supported.
- **Task-level SSE endpoint is live.** `GET /agents/:agentId/tasks/:taskId/stream` (`packages/a2a-server/src/stream.ts:30-146`) exposes the per-task channel as SSE with heartbeats, replay, and terminal-state close. UCAN-authed.
- **Inbox enqueue is silent.** `enqueue` (`packages/task-queue/src/inbox.ts:42-48`) only does `LPUSH` + broker-set membership. No pub/sub emission. The list is the sole notification mechanism, and the only consumer is `BLPOP` inside `pull`.
- **MCP capabilities omit subscribe.** `packages/mcp-server/src/index.ts:12-18` advertises `tools`, `resources`, and `prompts` but not `resources.subscribe`. Clients that would honor `notifications/resources/updated` never get the chance.
- **`nova_next_task` is pure pull.** `packages/mcp-server/src/tools.ts:588-619` calls `client.inboxPull` → HTTP → BLPOP. No subscription-aware fast path.

The point: plumbing is 60% done. This bite wires the remaining 40% and exposes it to MCP clients.

## Scope

**In scope**
- Publish on `enqueue` — new pub/sub channel for inbox arrivals, symmetric with the existing per-task channel.
- New SSE route `GET /agents/:agentId/inbox/stream` on `a2a-server`, UCAN-authed, with replay semantics so a freshly-subscribed client catches up on everything currently in the inbox.
- `resources.subscribe = true` in the MCP server capabilities.
- Two subscribable MCP resources:
  - `nova://inbox` — backed by `/inbox/stream`.
  - `nova://tasks/{taskId}` — backed by the existing `/tasks/:taskId/stream`.
- New MCP subscription module (`packages/mcp-server/src/subscriptions.ts`) holding one `EventSource` per active subscription, emitting `notifications/resources/updated` when events arrive, tearing everything down on transport close.
- Two optional convenience tools for clients that prefer explicit control:
  - `nova_watch_inbox` / `nova_unwatch_inbox`.
  - `nova_watch_task({ taskId })` / `nova_unwatch_task({ taskId })`.
- `nova_next_task` stays — it's the correct bootstrap and fallback primitive.
- Tests: pub/sub emission on enqueue, SSE route replay+live correctness, subscribe-then-catchup ordering (see §"The resume gap"), MCP subscription lifecycle on transport close.

**Out of scope (separate bites)**
- **Claim-on-push.** Notification-only; claims still happen via `nova_next_task` → BLPOP. See §"Notification ≠ claim".
- **Redis Streams instead of pub/sub.** The durable store is the inbox list. Streams would be over-engineered for v1 at our fan-out.
- **Batching or coalescing.** Every notification is one SSE event is one `notifications/resources/updated`. If an inbox receives 50 items in 10 ms, clients see 50 notifications.
- **SSE for broker reply inbox.** Symmetric problem; separate bite once the inbox pattern is validated.
- **Cross-tenant stream authorization.** Everything stays tenant-scoped via the self-UCAN that already authenticates the inbox HTTP routes.
- **Migration of broker-receiver daemon to SSE.** The daemon ships against long-poll first; moving it to `/inbox/stream` is a follow-up bite so the two designs don't block each other.

## Architecture

```
 Sender agent
      │  POST /agents/<recipient>/tasks  (existing)
      ▼
 a2a-server ingress
      │
      ▼
 task-queue.enqueue ─────────┬──► LPUSH nova:inbox:<t>:<a>             (unchanged, durable)
                             │
                             └──► PUBLISH nova:inbox-notify:<t>:<a>    (NEW — best-effort tap)
                                       │
                                       ▼
                          GET /agents/<a>/inbox/stream                 (NEW SSE route)
                          • auth: self-UCAN (same as inbox pull)
                          • on connect: SUBSCRIBE first, then LRANGE,
                            then flush, then live
                                       │
                                       ▼
                       MCP subscription module
                          • one EventSource per subscribed resource
                          • server.sendResourceUpdated(...)
                                       │
                                       ▼
                                 MCP client
                          resources/read on nova://inbox
                          (or directly nova_next_task)
```

Everything on the client side of `a2a-server` is a plain MCP interaction. The HTTP + SSE hop is only inside the MCP server, preserving the trust boundary: **the MCP server never talks to Redis directly. All cross-tenant / cross-agent enforcement remains in a2a-server.**

## Wire format

### New Redis channel

```
channel: nova:inbox-notify:<tenantId>:<agentId>
payload: {
  "seq":       <number>,   // monotonic per (tenant,agent) inbox
  "taskId":    "...",
  "intent":    "...",
  "enqueuedAt": "2026-04-22T10:00:00.000Z"
}
```

The `seq` comes from a new `INCR nova:inbox-seq:<tenantId>:<agentId>` counter, with the same TTL discipline as `task-events-seq`. It exists to solve the resume gap (see below).

The channel publishes a **notification**, not the task itself. Consumers that want the task either (a) call `nova_next_task` to claim it, or (b) read the MCP resource `nova://inbox`, which under the hood invokes the inbox list endpoint non-destructively.

### New SSE route

```
GET /agents/:agentId/inbox/stream
Headers:
  Authorization: Bearer <self-UCAN>
  Last-Event-ID: <seq>            (optional, resume point)
Response:
  Content-Type: text/event-stream
  Events:
    id: <seq>
    event: enqueued
    data: { taskId, intent, enqueuedAt }

    event: heartbeat
    data: { at }
```

Mirrors `/tasks/:taskId/stream` byte-for-byte in framing. The only semantic differences:

- No terminal state — inbox streams don't auto-close. Client disconnects when it's done.
- Replay draws from `LRANGE nova:inbox:<t>:<a>` (current pending items) rather than a sorted-set log of historical events. Items already pulled are invisible to a fresh subscriber.

### MCP resources

```
URI: nova://inbox
Description: Pending tasks for this agent. Subscribing emits
             notifications/resources/updated whenever a task arrives.
Read: returns the current inbox contents (non-destructive — equivalent to LRANGE).

URI: nova://tasks/{taskId}
Description: Live task state. Subscribing emits
             notifications/resources/updated on every state change.
Read: returns the current TaskState.
```

Subscribing activates an `EventSource` inside the MCP server; unsubscribing tears it down. Reading is a separate HTTP call to a2a-server — we do not cache resource state inside the MCP server.

## The resume gap

The single non-trivial correctness concern. A naive subscribe flow has a race:

```
t0:  client: resources/subscribe nova://inbox
t1:  server: HTTP GET /inbox/stream
t2:  server: LRANGE (snapshot = [item A])
t3:  someone enqueues item B → LPUSH + PUBLISH
t4:  server: SUBSCRIBE (too late — PUBLISH already fired)
t5:  client sees A, never sees B
```

The `/tasks/:taskId/stream` endpoint avoids this via monotonic `Last-Event-ID` replay over a sorted-set log that records every event. The inbox channel has no log — the list *is* the state, and items leave the list when pulled. So we need a different resume strategy.

**Chosen approach: subscribe-first, then snapshot, then dedup by `seq`.**

```
1. SUBSCRIBE nova:inbox-notify:<t>:<a>        (start buffering PUBLISHes)
2. LRANGE nova:inbox:<t>:<a>                  (take snapshot of current items)
3. For each snapshot item: emit `id: <enqueueSeq>` SSE event
4. Flush the buffered PUBLISHes, emitting any with seq > max(snapshot seq)
5. Continue forwarding live PUBLISHes.
```

For this to work, `enqueue` must write the seq into the stored entry:

```ts
// packages/task-queue/src/inbox.ts
const seq = await redis.incr(seqKey(ctx));
const entry: InflightEntry & { seq: number } = { taskId, task, reclaimCount: 0, seq };
await redis.pipeline()
  .lpush(inboxKey(ctx), JSON.stringify(entry))
  .sadd(BROKER_AGENTS_SET, memberKey(ctx))
  .publish(notifyChannel(ctx), JSON.stringify({ seq, taskId, intent, enqueuedAt }))
  .exec();
```

The seq travels with the entry on the list and in the notification, so the SSE endpoint can emit consistent `id:` values in both the replay and the live paths, and clients can use `Last-Event-ID` meaningfully. This matches the existing task-events pattern.

Trade-off considered — **skip the seq, dedup by taskId instead.** Works for correctness but loses the resume primitive; a client reconnecting after a brief drop would re-receive every currently-pending item every time. The INCR cost is trivial.

## Trust boundary

Non-negotiable: **the MCP server does not get Redis credentials.** Every route that reads or watches inbox/task state is on `a2a-server`, UCAN-authenticated, and already enforces tenant isolation.

Specifically:
- `/agents/:agentId/inbox/stream` reuses the same auth middleware and UCAN-verification code path as `/agents/:agentId/inbox` (the existing long-poll pull endpoint). Same audience check, same invocation-token validation.
- The MCP subscription module supplies the self-UCAN as the `Authorization` header on its EventSource request. `EventSource` only supports the default `Authorization` header via a polyfill or custom fetch — we'll use `eventsource` (Node) with its `headers` option, already present as a transitive dep.
- No Redis clients live in `packages/mcp-server/`. Grep should return zero matches for `ioredis` / `redis` in that package after this bite.

## MCP subscription lifecycle

`packages/mcp-server/src/subscriptions.ts` owns a Map of `resourceUri → { eventSource, lastEventId }`. Contract:

- `subscribe(uri)`:
  - Parse URI → resolve to backing SSE route.
  - Open `EventSource` with current self-UCAN.
  - On `message`: call `server.sendResourceUpdated({ uri })` and update `lastEventId`.
  - On `error`: exponential backoff (1s → 60s cap), auto-reconnect with `Last-Event-ID`.
- `unsubscribe(uri)`: close EventSource, delete from map.
- `shutdown()`: close all EventSources. Called on `StdioServerTransport` close and on SIGTERM.

The MCP server process is short-lived (one per MCP client session). Leaks-on-shutdown would tie up `a2a-server` connection slots — we handle it explicitly rather than relying on process exit.

## Client UX

Two supported patterns:

**Pattern A — MCP-native, `resources/subscribe`.** Clients that implement the spec-compliant pattern. Claude Code's MCP client does; some others (Hermes via Gemini, some IDE integrations) may not yet.

**Pattern B — explicit tools, `nova_watch_inbox` / `nova_unwatch_inbox`.** Fallback for clients that lack `resources/subscribe` but can still receive side-channel MCP notifications. These tools wrap the same subscription module; they just surface it as an explicit tool call pair.

Both land as MCP `notifications/resources/updated` under the hood. The tool pair is a thin wrapper, not a separate subsystem.

`nova_next_task` is untouched. It remains the bootstrap and the fallback. After a notification, the canonical read sequence is `nova_next_task` (to claim) → handle → `nova_respond`.

**Notification ≠ claim.** Emphasized here and in the tool descriptions. An MCP client that treats a notification as "this task is now mine" will break under concurrent pullers. The claim is BLPOP-side; the notification is a hint.

## Interaction with other bites

- **Broker-receiver daemon (`2026-04-21-broker-receiver-daemon.md`).** The daemon ships against HTTP long-poll first — it doesn't need push to be correct, and writing it against an unshipped SSE route would couple the two timelines. After this spec lands, migrating the daemon is a one-file change in its pull-loop module. v1 daemon uses long-poll; v2 daemon uses `/inbox/stream`. The daemon spec doesn't change; only its implementation under the hood.

- **Broker reply inbox (`2026-04-21-broker-reply-inbox.md`).** Symmetric problem for `nova:reply-inbox:<t>:<a>`. Not in scope here — replicate once inbox push proves out. One new channel, one new SSE route, one new resource `nova://replies` following the same template.

- **Sender-signed UCANs (`2026-04-21-sender-signed-ucans.md`).** No interaction. The self-UCAN that authenticates inbox HTTP routes today authenticates `/inbox/stream` unchanged.

- **Admin UI Live tab.** Already subscribes to `TASK_LIFECYCLE_CHANNEL` server-side. Gains nothing from this bite and loses nothing. If operators want a "live inbox depth per agent" visualization later, they can subscribe to the new notify channel from the admin-api, independently.

## Open decisions

1. **Backpressure.** If a client holds a subscription but never drains (bug or stalled handler), the MCP server's EventSource buffer grows. Default: bound it with `MAX_BUFFERED_EVENTS = 1024`; on overflow, close the EventSource and emit a final `notifications/resources/updated` the client will interpret as "go check". Defensible for v1.

2. **Subscription survives UCAN rotation.** When the agent rotates its key (see §"Key rotation" in agent lifecycle), the cached self-UCAN becomes stale. Open question: does the subscription module auto-reopen with the new UCAN on 401, or does it surface the error to the client? Lean toward auto-reopen with a log line; it matches the existing pattern in `mcp-server` nova client code.

3. **`nova://inbox` read semantics.** Does `resources/read nova://inbox` pull (destructive) or peek (non-destructive)? Must be peek — readers and pullers are distinct roles, and combining them would be a footgun for any client that auto-reads resources on subscribe. Implement as `GET /agents/:agentId/inbox/peek` (new route) or as a query param on the existing `/inbox` endpoint; decision deferred to implementation.

4. **Heartbeat cadence on `/inbox/stream`.** Existing `/tasks/:taskId/stream` uses 15s; match that unless load testing shows otherwise.

## Verification

Unit tests (Vitest):
- `enqueue` publishes the notification with correct `seq`, `taskId`, `intent`.
- SSE route emits replay events in order with correct `id:` values.
- SSE route forwards live events post-subscribe.
- Subscribe-before-snapshot ordering (fuzz: interleave LPUSH + PUBLISH with SUBSCRIBE + LRANGE; assert no missed events).
- MCP subscription module: subscribe / unsubscribe round-trip; auto-reconnect on transport error; shutdown closes all open EventSources.

Integration tests (`scripts/acceptance-test-mcp-push.ts`):
1. Register two agents: `sender`, `watcher`.
2. MCP session as `watcher` subscribes to `nova://inbox`.
3. Send 10 tasks from `sender` in quick succession, asserting 10 `notifications/resources/updated` arrive in order and with strictly increasing `seq`s.
4. Disconnect the MCP session mid-burst; send 5 more tasks; reconnect with `Last-Event-ID` set to the last seen seq; assert the 5 missed tasks are re-notified in order.
5. Pull and respond to all tasks; assert no further notifications after the inbox drains.

Manual smoke (in package README):
1. Run `packages/mcp-server` in dev; subscribe to `nova://inbox` via an MCP inspector.
2. Send tasks from another session; observe notifications arriving in <100ms.

## What a reader needs to know to understand this spec

If you're picking this up cold, these are the pieces to load first:

- **How the existing task SSE works.** `packages/a2a-server/src/stream.ts:30-146` is the template this spec replicates. The pattern: SUBSCRIBE to a Redis pub/sub channel, replay missed events from a sorted-set log using `Last-Event-ID`, forward live events, heartbeat on a timer.
- **How publishTaskEvent bridges pub/sub and durable replay.** `packages/task-queue/src/index.ts:135-156`. The log-plus-channel pattern is the shape we're copying for the inbox notify, with the simplification that the inbox list itself plays the role of the log (because old inbox items are claimed, not stored forever).
- **How broker inbox enqueue works today.** `packages/task-queue/src/inbox.ts:42-48`. This is the one function we mutate — adding a PUBLISH and writing a seq.
- **How MCP resources are registered.** `packages/mcp-server/src/resources.ts`. We add two URI patterns and flip the capabilities bit.
- **How BLPOP claim works.** `packages/task-queue/src/inbox.ts:61-93`. Unchanged. Notifications do not touch this path; pull still owns the claim.
- **Why the MCP server doesn't touch Redis.** Trust-boundary invariant. Every tenant-scoped check runs in `a2a-server`. Violating this gives an MCP compromise direct read access to every agent's queue. Don't.
- **Why `nova_next_task` is keeping its job.** Bootstrap primitive (first pull on subscribe returns what's already there), fallback for clients without `resources/subscribe`, and the canonical claim. Push is an optimization layered on top; the pull API is the floor.

## Deliverables summary

- `packages/task-queue/src/inbox.ts` — `enqueue` writes seq and publishes notification.
- `packages/a2a-server/src/routes/inbox.ts` (or a sibling `inbox-stream.ts`) — `GET /agents/:agentId/inbox/stream` and `GET /agents/:agentId/inbox/peek`.
- `packages/mcp-server/src/index.ts` — `capabilities.resources.subscribe = true`.
- `packages/mcp-server/src/resources.ts` — register `nova://inbox` and `nova://tasks/{taskId}` as subscribable.
- `packages/mcp-server/src/subscriptions.ts` — new module managing EventSource lifecycle.
- `packages/mcp-server/src/tools.ts` — optional `nova_watch_inbox` / `nova_unwatch_inbox` / `nova_watch_task` / `nova_unwatch_task`.
- `scripts/acceptance-test-mcp-push.ts` + `npm run test:acceptance:mcp-push`.
- README updates in `packages/mcp-server/` covering subscription patterns and the notification-vs-claim invariant.
