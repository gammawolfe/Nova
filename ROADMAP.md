# Nova Roadmap

Living tracking document. Items grouped by theme, checkboxed so status is
visible at a glance. Dates in `YYYY-MM-DD`. When an item ships, leave it
checked with a commit/PR link instead of deleting — keeps the trail.

---

## MCP Onboarding Hardening

Context: review on 2026-04-21 identified friction for LLM-driven agents
(Claude Code specifically) and a handful of robustness/security gaps in the
self-registration → UCAN-claim flow. See conversation notes for the full
review. Each item below is scoped to ship as its own PR.

### P0 — LLM sharp edges (biggest UX wins, small code)

- [x] **Stop burning invites on agent-side errors.** Split
  `verifyAndConsumeInvite()` in `packages/shared/src/invites.ts` into
  `verifyInvite()` + `consumeInvite()`. In
  `packages/a2a-server/src/routes/register.ts`, run all validation
  (signature, exp, hint match, schema, agent uniqueness) before the Redis
  NX consume. Keep the consume atomic. Backwards-compatible on success.
  — Shipped 2026-04-21 (#15, landed on main via #17).
- [x] **Server-side invite inspection tool.** Add `nova_inspect_invite`
  MCP tool returning `{tenantId, agentIdHint, expiresAt, jti}` from pure
  client-side decode — no network, no consumption. Update `nova_onboard`
  prompt in `packages/mcp-server/src/prompts.ts` to call it instead of
  asking the LLM to base64url-decode the JWT middle segment.
  — Shipped 2026-04-21 (#14).
- [x] **Make `agentIdHint` mandatory on invite mint.** Require the field
  in `POST /admin/tenants/:tenantId/invites` schema
  (`packages/shared/src/admin-schemas.ts`). Admin UI invite-mint form
  pre-fills it. Gate behind tenant flag `strict_invites: true` if BC
  matters.
  — Shipped 2026-04-21 (#16, landed on main via #17). Skipped the
  `strict_invites` tenant flag — Tenant interface has no flags field and
  BC wasn't needed (legacy hintless invites are TTL-bounded ≤7d).

### P1 — Robustness gaps

- [x] **UCAN claim window: extend + recovery path.** Bump default Redis
  TTL on the one-time UCAN claim from 1h to 24h in
  `packages/a2a-server/src/services/ucan-service.ts`. Add
  `nova_reissue_ucan` admin tool + endpoint for operators to regenerate a
  missed claim (idempotent, no invite needed). Emit distinct
  `UCAN_CLAIM_EXPIRED` error code with remediation text.
  — Shipped 2026-04-21 (#18). TTL bump + reissue lives in
  `packages/admin-api/src/routes/agents.ts` + `.../services/ucan-service.ts`
  (not `a2a-server` — roadmap path was wrong). `UCAN_CLAIM_EXPIRED` is
  client-emitted in `nova_check_registration` when status=active but both
  the server claim and local cache are empty; the server can't
  disambiguate "never claimed" from "claimed-and-re-polling" without extra
  state, and the client already knows.
- [x] **Polling backoff + recovery guidance in `nova_onboard` prompt.**
  Replace "every 10 seconds" forever with: 10s for first 2min, then 30s,
  cap at 60s, abort after 30min with operator-contact message. Add
  explicit handling for `UCAN_CLAIM_EXPIRED`. File:
  `packages/mcp-server/src/prompts.ts`.
  — Shipped 2026-04-21 (#19, landed on main via #21). Cadence caps total
  polls at ≤48 vs. prior unbounded 10s loop. UCAN_CLAIM_EXPIRED stops
  polling immediately with a verbatim operator-handoff message.
- [x] **Concurrent-instance file locking on UCAN cache.** Add
  `proper-lockfile` (or `fs.flock`) around reads/writes of
  `~/.nova/agents/{agentId}.ucan.json` in
  `packages/mcp-server/src/tools.ts`. On contention, re-read and reuse the
  fresh UCAN instead of re-renewing.
  — Shipped 2026-04-21 (#20, landed on main via #21). Uses
  `proper-lockfile` (atomic mkdir, 10s stale, 5s heartbeat). Fast-path
  check happens without the lock; slow path locks + re-reads + renews so
  the race loser picks up the winner's fresh UCAN for free. Helper lives
  in `ucan-store.ts` as `withCacheLock`, reusable by future cache-mutating
  tools.

### P2 — Security hardening (longer horizon)

- [x] **Key rotation flow.** New `nova_rotate_key(agentId)` tool +
  `POST /agents/:agentId/rotate-key` endpoint. Generates new keypair
  locally, PoP-signs the rotation request with the *old* key. Server
  updates stored public key, issues fresh UCAN. ~200 LOC + migration note
  for existing agents.
  — Shipped 2026-04-21 (PR). PoP signature covers
  `${nonce}|${newDid}|${newPublicKey}` so a captured request can't be
  replayed with a different public key. Endpoint is
  `POST /admin/tenants/:tenantId/agents/:agentId/rotate-key` — mounted
  before the `/admin` auth gate; auth boundary is the PoP sig, not a
  bearer token. Server revokes every UCAN issued to the old DID in the
  tenant, swaps `{did, publicKey}` atomically, rebuilds the trust-registry
  actor with tier + allowedSkills preserved, and mints a fresh self-UCAN.
  Client tool snapshots the previous identity to
  `{agentId}.json.rotated-{ISO}.bak` and wipes perDestination UCAN cache
  (all entries were bound to the old DID). Cross-tenant trust entries
  that reference the old DID are left for the operator to re-seed — the
  tool response surfaces the new DID so the user can notify counterparties.
  Drive-by fix: `issueUcan` now adds `jti` to the payload so two UCANs
  issued in the same second with identical capabilities get distinct CIDs
  (without it, rotation's fresh UCAN collided with the old about-to-be-
  revoked UCAN).
- [x] **OS keychain integration (opt-in).** `NOVA_KEY_BACKEND=keychain|file`
  env var. Keychain backend via `node-keytar` (macOS) / libsecret (Linux).
  File backend remains default for CI/containers. Abstraction in new
  `packages/mcp-server/src/key-backend.ts`. Ship after rotation.
  — Shipped 2026-04-21 (PR). Substituted `@napi-rs/keyring` for `node-keytar`
  — keytar is archived, napi-rs variant ships prebuilds and covers macOS
  Keychain / libsecret / Windows Credential Manager through the same
  `Entry(service, account)` API. File backend is unchanged from pre-P2.8
  (inline PEM in `~/.nova/agents/{agentId}.json`), so existing deployments
  and CI/containers keep working without any config. Keychain backend
  stores the PEM in the OS credential store and keeps only metadata + a
  `keyBackend:"keychain"` marker on disk. Transparent one-way migration
  on load (file→keychain): legacy records picked up under the new env
  move into the keychain and the on-disk JSON is rewritten. Orphaned-
  metadata case (marker says keychain but no entry) surfaces an explicit
  error pointing at remediation. Invalid `NOVA_KEY_BACKEND` values fail
  fast rather than silently defaulting.
- [x] **Opportunistic revocation-check on send.** Add lightweight
  `nova_check_status()`; have `nova_send_task` call it with a 5-min cache
  to surface operator revocations before the task submit fails silently.
  File: `packages/mcp-server/src/tools.ts`.
  — Shipped 2026-04-21 (PR). Server-side: new public
  `GET /agents/:agentId/health?ucanCid=XYZ` on a2a-server returns
  `{ agentStatus, ucan?: { revoked, found, expiresAt } }`. Agent status via
  Redis agent-meta (O(1)); UCAN state via filesystem probe of
  `ucans/issued/{cid}.json` + `ucans/revoked/{cid}.json`. cid format
  validated against `[0-9a-f]{32}` to close the path-traversal surface on
  the filesystem probe. Client-side: `nova_check_status()` MCP tool +
  process-local 5-min in-memory cache keyed by `(agentId, cid)` — rotation
  invalidates for free since cid changes. `nova_send_task` now does two
  pre-flight checks: self-agent status + UCAN revocation (abort with
  AGENT_INACTIVE / UCAN_REVOKED and operator remediation text), and
  destination agent status (abort with DEST_AGENT_INACTIVE). Probe
  failures are swallowed — advisory only, gate remains authoritative.

### Out of scope for this block (named so we don't re-debate)

- Runtime attestation (TPM/TEE / signed-binary). Revisit only if tier-3
  ever gets automatic privileges.
- Self-serve approval replacing the human-operator step. Different threat
  model; deserves its own spec.

### Suggested sequencing

1. Week 1 — P0.1 + P0.2 + P0.3 (all small, all independently shippable)
2. Week 2 — P1.4 + P1.5 (UCAN window + prompt hardening, naturally paired)
3. Week 3 — P1.6 (file locking)
4. Later — P2.7 (rotation) → P2.8 (keychain) → P2.9 (revocation check)

---

## Broker-mode push + daemon

Context: the 2026-04-21 Hermes onboarding session exposed two coverage gaps
in broker-mode (MCP-native, webhook-less) agents: reception was coupled to
interactive session lifetime, and reply collection required long-polling.
The block below closed both and shipped the supervision story that had been
documented-as-manual since the original broker-receiver spec.

### Shipped

- [x] **Invite-JWT whitespace tolerance.** `verifyInvite` and
  `decodeInvitePayload` both strip whitespace before parsing. JWTs pasted
  through terminals with line-wrapping now verify instead of producing a
  misleading `INVITE_INVALID` that looked like a consumed token.
  — Shipped 2026-04-22 (#28).
- [x] **MCP push subscriptions for the task inbox.** New
  `nova:inbox-notify:{t}:{a}` pub/sub channel. `GET /agents/:id/inbox/stream`
  SSE route with subscribe-first-then-snapshot-then-dedup resume via a
  per-inbox `seq`. `resources.subscribe = true` on the MCP server.
  `nova://inbox` + `nova://tasks/{taskId}` subscribable resources. Fallback
  `nova_watch_inbox` / `nova_watch_task` tools for clients without spec-
  compliant subscribe. Latency drops from ~one poll window to ~100ms for
  interactive sessions.
  — Shipped 2026-04-22 (#27). Spec:
  `docs/superpowers/specs/2026-04-22-mcp-push-subscriptions.md`.
- [x] **Broker-receiver daemon** (`@nova/broker-receiver`). Supervised,
  persistent process with own Nova identity and grant. Pluggable handlers
  (`echo`, `claude-api`). launchd + systemd templates. Loopback-only
  `/health`. Graceful SIGTERM drain. CLI subcommands: `init`, `run`,
  `install`, `uninstall`. Closes the "session closed = dead air" gap.
  — Shipped 2026-04-22 (#29). Spec:
  `docs/superpowers/specs/2026-04-21-broker-receiver-daemon.md`.
- [x] **Daemon SSE migration.** Daemon now subscribes to `/inbox/stream`
  instead of long-polling. Both triggers (SSE event + fallback tick) set a
  shared `claimPending` flag; one worker drains via `client.pull(1s)` until
  204. Coalesces bursts. Shared SSE client extracted to
  `@nova/shared/src/sse-client.ts`; `mcp-server/subscriptions.ts` refactored
  to consume it. Config renamed `pollWaitMs → pollFallbackMs` with an alias
  shim. Headless reception latency drops from ~30s to ~100ms.
  — Shipped 2026-04-22 (#30).
- [x] **Push subscriptions for the reply inbox.** Symmetric to #27 but for
  broker-mode *senders* collecting replies. `nova:reply-inbox-notify:{t}:{a}`,
  `GET /agents/:id/replies/stream`, `GET /agents/:id/replies/peek`, and
  `nova://replies` subscribable resource with `nova_watch_replies` /
  `nova_unwatch_replies` fallbacks. Senders now see replies in ~100ms too.
  — Shipped 2026-04-22 (#31).
- [x] **Operator playbook doc.** `docs/operator-notes.md` captures the
  rolling-container matrix (which services to rebuild when shared packages
  change), the brew-vs-docker Redis port-collision trap, and the standard
  acceptance-test run order. Motivated by two incidents where partial
  rebuilds produced silent behavioural skew.
  — Shipped 2026-04-22 (#32).

### Remaining — scoped, prioritised

- [ ] **R1. Notification bridge (daemon → interactive Claude Code session).**
  Hybrid flow: daemon handles everything autonomously with `claude-api`,
  escalates exceptions (handler failures, unknown intents, long-running
  tasks, confirm-required skills) into an open MCP session for human
  override. Requires a local IPC channel between the daemon and Claude
  Code — candidate shapes: (a) daemon writes to a well-known file that an
  MCP hook watches, (b) daemon runs a loopback HTTP endpoint Claude Code
  subscribes to, (c) reuse the existing Redis pub/sub and have Claude
  Code's MCP server subscribe to a dedicated `nova:escalation:{agentId}`
  channel. Option (c) is cheapest — no new transport, leverages the same
  SSE infra we already have. Needs a design spec before code: escalation
  policy (what counts as an exception), operator UX, replay semantics when
  the interactive session starts later. ~300-600 LOC across broker-receiver
  + mcp-server. Out of scope here: multi-session fan-out (which of two
  open Claude Code sessions gets the escalation).

- [ ] **R2. Auto-reissue grant on near-expiry.** Today grants last ~30
  days from approval; near-expiry just logs a warning and the operator
  runs `nova_reissue_ucan` by hand. Options considered: (a) daemon calls
  `nova_reissue_ucan` itself with a stored admin token — rejected, elevates
  blast radius; (b) new operator-scoped self-service endpoint that accepts
  the agent's self-UCAN and extends the grant one tier at a time —
  preferred. Lives in `packages/admin-api/src/routes/agents.ts` as a
  self-service companion to the existing operator reissue. Daemon's
  `/health` already exposes grant expiry; the auto-reissue client logic
  goes in `broker-receiver/src/claim-loop.ts` (or a sibling grant-manager
  module). Tight threshold: reissue at ≤15% lifetime remaining to give
  operators a window to revoke if something's off. ~150 LOC + endpoint
  + tests. Do this before the earliest-onboarded agents expire (first
  known grant expires ~2026-05-21 — see auto-memory note).

- [ ] **R3. Additional handlers (`shell-exec`, `webhook-forward`).** Each
  is a new file under `packages/broker-receiver/src/handlers/` plus
  registration in `handlers/index.ts`. Individually small (~50-100 LOC
  each); the work is the threat-model writeup per handler:
  - `shell-exec` — runs an allow-listed command per intent. Needs explicit
    allow-list + argument templating rules + sandboxing strategy (macOS
    sandbox-exec? Linux seccomp? no sandbox + trust-tier?).
  - `webhook-forward` — POSTs the task to a configured URL and returns
    the response as the TaskResult. Needs outbound allow-list + retry
    policy + timeout + response-size cap.
  Each ships as its own PR so reviewers can focus on the threat model.
  Dependency: neither blocks on R1/R2.

### Out of scope for this block (named so we don't re-debate)

- **Daemon on Windows.** macOS + Linux only for v1. Windows Service
  template is a separate bite when there's a user.
- **Multi-agent receivers in one process.** One daemon per identity is
  simpler; multiplexing is a perf optimisation we don't need at our scale.
- **SSE fan-out above Redis pub/sub.** If we ever have many subscribers
  per inbox, migrate to Redis Streams with consumer groups. For now, the
  pub/sub channel handles everyone cheaply.
- **Claim-on-push.** Preserving "notification ≠ claim" is load-bearing for
  multi-watcher correctness. Don't collapse them for latency; the current
  design already delivers ~100ms.

### Suggested sequencing

1. **R2 first.** Hard deadline (grants expiring), smallest scope, clearest
   scope. Ship well before 2026-05-21.
2. **R1 second.** Largest user-visible change remaining. Design spec → PR.
3. **R3 as needed.** When a specific handler request lands (someone wants
   webhook-forward for their existing monitoring stack, or shell-exec for
   a local automation), take it then.

---

## Operator UX & packaging (Multica comparison)

Context: 2026-04-22 comparison against Multica (github.com/multica-ai/multica)
surfaced packaging and operator-UX ideas worth borrowing. None touch Nova's
security model — they're strictly about making Nova easier to install, run,
and operate. Candidates only; discuss before committing. Each item below is
scoped to ship as its own PR.

### Candidates — not committed

- [ ] **C1. First-class operator CLI (`nova`).** Replace the curl-to-admin-api
  examples in the README with a real CLI. Commands: `nova setup`, `nova tenant
  create|list`, `nova invite mint`, `nova agent list|approve|reject`, `nova
  audit tail`, `nova events` (SSE stream from `/admin/events`). Thin wrapper
  over the admin-api HTTP surface the mcp-server already uses. Lives in a new
  `packages/cli/` workspace. ~400-600 LOC.

- [ ] **C2. Homebrew tap + install script.** `brew install nova/tap/nova`
  plus a `curl | bash` fallback and a PowerShell variant for Windows. Ships
  the CLI from C1 and any host-daemon from C3. Requires prebuilt binaries via
  a release workflow (goreleaser-equivalent for a Node CLI — `pkg` or `bun
  build --compile`). Blocked on C1.

- [ ] **C3. Multi-planet host daemon.** A host running N agents today runs N
  mcp-server processes, each with its own on-disk key, UCAN cache, and SSE
  subscription. A single local daemon supervising all planets on the host
  would share: key backend, UCAN cache + lock, subscriptions, a loopback
  `/health`. Distinct from the broker-receiver daemon (which runs *one*
  identity persistently); this groups *many* identities under one supervisor.
  Needs a design spec first: identity scoping, per-planet revocation, how it
  coexists with broker-receiver on the same host. ~300 LOC + spec.

- [ ] **C4. "Host" as a first-class audit object.** Even with C3 in place,
  operators benefit from a view of *"these 4 planets all live on my laptop"*
  for audit and batch revocation. Add a `hostId` field to registered agents
  (client-generated, stable across restarts), surfaced in the admin UI and
  audit stream. Trust stays per-agent; this is an ergonomics layer on top.
  ~150 LOC. Depends on C3.

- [ ] **C5. Dedicated self-host story.** Split today's `docker-compose.yml`
  into `docker-compose.dev.yml` (source-mounted, hot-reload) and
  `docker-compose.selfhost.yml` (prebuilt GHCR images, no source mounts).
  Publish images on tagged releases via a GHA workflow. Write `SELF_HOSTING.md`
  alongside `docs/operator-notes.md` — operator-notes is for people running
  Nova day-to-day, SELF_HOSTING is for first-time installs.

- [ ] **C6. `make dev` bootstrap.** Single command that: creates `.env` from
  `.env.example`, runs `npm install`, runs `npm run generate:keys`, starts
  Redis via `docker compose up -d`, and runs admin-api + a2a-server +
  agent-connector under `concurrently`. Replaces the 4-step Quick Start. If
  C1 ships first, reuse `nova setup` inside the Makefile target. ~50 LOC
  Makefile + a small `scripts/dev-up.sh`.

### Deliberately not copied from Multica (named so we don't re-debate)

- **Issues / boards / chat UI.** Orchestration is a layer above Nova, not
  inside it. If someone wants a board, they build a product on top of the
  admin API.
- **WebSocket streaming.** SSE was the right call — see nova-overview.md.
- **Postgres + pgvector.** BullMQ + Redis fits Nova's workload; pgvector
  solves a problem Nova doesn't have.
- **Free-text task ingress.** Directly violates the closed-intent +
  structured-ingress principle. This is the architectural line.

### Suggested sequencing

1. **C5 first.** Pure docs + compose-file reorg; unblocks anyone running Nova
   outside a repo checkout. No code dependencies.
2. **C1 second.** Operator CLI is the biggest daily-UX win and has no new
   dependencies. Replaces most curl examples in the README.
3. **C6 after C1.** Bootstrap can reuse `nova setup` once it exists.
4. **C2 after C1.** Homebrew needs a shippable binary.
5. **C3 + C4 later.** Design spec required; revisit when someone's actually
   running >2 planets on one host.

---

## a2a-server production hardening

Context: 2026-04-23 review of `packages/a2a-server/` surfaced a set of
production-readiness gaps — no graceful shutdown, missing Express hardening
(body limits, helmet, trust proxy, global error middleware), in-memory rate
limiter in the self-register path, SSE subscriber-connection amplification
under load, disk reads on every agent-card fetch, unauthenticated grant
pickup, and several smaller quality issues. Each item below is scoped to
ship as its own PR. Cross-package coordination is called out per item.

### P0 — Resilience under real load

- [ ] **H1. Graceful shutdown.** Mirror the admin-api pattern at
  `packages/admin-api/src/index.ts:135-145`: keep the `server.listen`
  handle, install SIGTERM/SIGINT → `server.close` → `closeSharedRedis` →
  exit. Subtlety vs. admin-api: a2a-server opens one Redis subscriber per
  SSE stream via `redis.duplicate()` in `stream.ts:90`, `inbox.ts:330`,
  `replies.ts:144`. Maintain a live-sub registry so drain closes each one
  cleanly. No cross-package changes. Unblocks zero-downtime rolling
  deploys.

- [ ] **H2. Express hardening pass.** One PR, four changes in
  `a2a-server/src/index.ts`: (a) `app.use(express.json({ limit: '64kb' }))`
  on the default mount and a larger dedicated limit on
  `/agents/:agentId/inbox/:taskId/respond` sized to
  `BROKER_RESULT_MAX_BYTES`; (b) `app.set('trust proxy', …)` so `req.ip`
  is the real client address when Caddy fronts the service (today every
  rate-limit bucket collapses to the proxy's IP); (c) `helmet()` on the
  public well-known endpoint; (d) global error middleware that maps
  `ZodError` + `NovaError` the same way admin-api does at
  `admin-api/src/index.ts:129`. No cross-package changes; extract the
  error-middleware body into `@nova/shared` only if admin-api wants to
  adopt the same helper.

- [ ] **H3. Grant-pickup atomicity (`GETDEL`).** Swap the non-atomic
  `redis.get` + `redis.del` at `a2a-server/src/routes/register.ts:282-286`
  for `GETDEL` (Redis 6.2+). One-line internal change; same contract with
  admin-api's approve flow at `admin-api/src/routes/agents.ts:100-108`.
  Closes the read-then-delete race where two concurrent pollers both see
  the grant.

- [ ] **H4. Redis-backed rate limit on `/register`.** Replace the
  in-memory `rateStore` + `setInterval` sweep in `register.ts:16-35`
  with a Redis `INCR` + `EXPIRE NX` pattern matching the ingress limiter
  at `index.ts:170-178`. Fixes horizontal-scale bypass and unbounded-
  map growth between sweeps. No cross-package changes.

### P1 — Performance / hot-path fixes

- [ ] **H5. Agent-card cache with lifecycle-channel bust.** Today
  `.well-known/agent.json` does `fsp.readFile` + `AgentCardSchema.safeParse`
  on every hit (`index.ts:97-142`). Add a process-local map keyed by
  `tenantId/agentId` with lazy population, and subscribe to
  `AGENT_LIFECYCLE_CHANNEL` (already published by
  `admin-api/src/services/agent-service.ts:39` and
  `a2a-server/src/routes/register.ts:181`, already consumed by
  agent-connector + admin-api/events) to invalidate entries. No producer-
  side changes — a2a-server becomes a third subscriber.

- [ ] **H6. `tenantRouter` Redis-lookup cache.** Every agent-scoped
  request currently does `GET nova:agent-index:<agentId>` (`tenant-
  router.ts:31`). Add a short-TTL LRU (2-5s) with the same `AGENT_
  LIFECYCLE_CHANNEL` invalidation hook from H5. Share the cache
  infrastructure between H5 and H6 — one subscriber, two cache maps.

- [ ] **H7. SSE subscriber fanout.** `stream.ts`, `inbox.ts`, `replies.ts`
  each call `redis.duplicate()` per open stream — at 10k streams that's
  10k extra Redis connections per replica. Ship in two parts: (a) extract
  a shared SSE helper into `@nova/shared/src/sse-stream.ts` covering
  `writeSSE`, heartbeat, cleanup, and the subscribe-first-then-snapshot-
  then-dedup pattern that inbox.ts + replies.ts already share; migrate
  a2a-server's three SSE routes to it. (b) Replace per-stream
  `duplicate()` with a single shared subscriber that demuxes to in-
  process listeners. Admin-api's `routes/events.ts:36-72` is a separate
  SSE implementation — opt-in migration when convenient, not a blocker.
  Cap concurrent streams per agent and globally as part of the helper.

- [ ] **H8. Webhook-reply DLQ branch.** `inbox.ts:134-148` delivers to
  `replyTo` fire-and-forget — failures are logged and lost. The broker-
  mode branch at `inbox.ts:158` already uses `writeDeadLetter` from
  `@nova/task-queue/src/dead-letter`. Call it in the webhook-failure
  path too with a distinct `failureReason: 'webhook_delivery_failed'`
  so the two modes have symmetric durability. Downstream DLQ consumers
  see one more source of entries, which is desirable.

- [ ] **H9. `/discover` pagination (additive).** `index.ts:51-76`
  loads all active agents and filters in memory. Add optional
  `cursor`/`limit` query params and push the status/skill filter into
  Redis set indexes where possible. Keep the unparameterized call
  returning the full set so existing callers
  (`mcp-server/src/nova-client.ts:60+`, admin-api discover router) don't
  break; mcp-server migrates lazily.

### P2 — Smaller correctness / cleanup

- [ ] **H10. SSE `NaN` id guard.** `stream.ts:45` does
  `parseInt(… ?? '0', 10)` without a `|| 0` fallback, so a malformed
  `Last-Event-ID` produces `NaN` in subsequent `id:` fields. `inbox.ts:294`
  and `replies.ts:112` already use `|| 0`; normalize `stream.ts` the
  same way. Pull into H7's shared helper.

- [ ] **H11. UCAN error-reason typing.** `auth/self-ucan.ts:54-61` does
  substring matching on `err.message` (`'expir'`, `'signature'`). If
  `@ucans/ucans` changes phrasing, every failure silently becomes
  `'malformed'`, losing the "expired" / "revoked" distinction that
  `authSelfUcan` returns to clients. Use typed errors or structured
  codes from the library if exposed; otherwise pin behaviour with a
  test and add a version floor.

- [ ] **H12. Agent capabilities default alignment.** Three write sites
  disagree: `a2a-server/src/index.ts:112-116` defaults
  `pushNotifications: true`, `a2a-server/src/routes/register.ts:168`
  writes `false`, and `admin-api/src/services/agent-service.ts:79`
  also writes the agent-config. Pick one source of truth (admin-api
  service is the right home), have register.ts call it, delete the
  `index.ts` fallback. Cross-package: shared, admin-api, a2a-server.

- [ ] **H13. `INVITE_ALREADY_CONSUMED` distinct error code.** When two
  registrations race the same invite, the loser's `consumeInvite` NX
  fails and the caller sees `INVITE_INVALID` with no hint. Add a
  distinct `INVITE_ALREADY_CONSUMED` variant surfaced from
  `@nova/shared/src/invites.ts:110-167` and mapped by
  `a2a-server/src/routes/register.ts`. Additive — admin-api callers
  that don't pattern-match on the old message stay working.

- [ ] **H14. `createApp()` refactor.** `index.ts` calls `start()` at
  import time, making in-process testing and embedding awkward.
  Split into `createApp()` + `main()`; only the CLI entry calls
  `main()`. Internal-only; unblocks integration tests that want to
  spin up a2a-server in-process.

- [ ] **H15. Standardize Redis singleton usage.** `index.ts` imports
  both `redis` from `@nova/task-queue` (line 8) and `getSharedRedis()`
  from `@nova/shared` (line 23). They're the same connection today,
  but the duality invites future dual-pool bugs. Pick `getSharedRedis()`
  everywhere and sweep a2a-server, admin-api, broker-receiver, agent-
  connector, gate-service in one commit.

- [ ] **H16. Metrics coverage.** `metrics.ts` only exports
  `activeSseStreams`. Add: ingress request counter + latency histogram,
  rate-limit rejection counter labeled `sender|global`, gate-rejection
  counter labeled by `errorCode`, SSE reconnect counter, Redis latency
  histogram. Register on the existing `a2aRegistry`. No cross-package
  changes; dashboards + alerts can follow.

### P3 — Coordinated cross-package changes (plan before coding)

- [ ] **H17. Grant-pickup auth hardening.** Today
  `GET /register/status/:tenantId/:agentId` is unauthenticated and
  returns the grant JWT on first fetch after approval. Anyone who
  guesses `tenantId+agentId` while the claim is live can race the
  legitimate caller. Fix: bind the grant to a claim-secret returned
  from `POST /register` and required on the status fetch. Touches
  three packages — `admin-api` (grant-write format), `a2a-server`
  (register.ts response + status verification), `mcp-server` (onboard
  client stores and presents the secret). Needs a design note before
  code covering: migration for in-flight grants at deploy time,
  whether the secret is rotated on reissue, and whether
  `nova_reissue_ucan` is included. Ship behind a flag, burn down the
  flag once all planets are on the new client.

### Out of scope for this block (named so we don't re-debate)

- **Runtime-attestation for the a2a-server process itself.** Out of
  scope for hardening; see the P2 block in the MCP Onboarding section
  for the equivalent debate on client-side attestation.
- **Per-skill rate limiting.** The current global + per-sender shape
  is sufficient. Skill-level quotas are a policy layer above the
  transport.
- **HTTP/2 or HTTP/3 transport.** Node's HTTP/1.1 + keep-alive handles
  Nova's throughput. Revisit when latency or concurrency actually
  becomes the bottleneck.

### Suggested sequencing

1. **H1 → H2 → H3 → H4.** All pure-internal or one-line; ship in order
   in the first week. After H1 lands, rolling deploys stop dropping
   live SSE streams; after H2, the service has the same hardening
   surface as admin-api; after H3 + H4, the self-register path is
   safe to scale horizontally.
2. **H5 + H6 together.** One lifecycle-channel subscriber, two caches.
   Paired naturally.
3. **H7.** Larger refactor — do after H5/H6 so the shared infra can
   absorb the SSE helper cleanly.
4. **H8, H9, H10-H16** as fillers; none block each other.
5. **H17 last.** Coordinated multi-package change; needs a design
   note first. Not urgent — the current gap requires an attacker to
   guess `tenantId+agentId` within the grant-claim TTL window.

### Deliberately not copied from Multica (named so we don't re-debate)

- **Issues / boards / chat UI.** Orchestration is a layer above Nova, not
  inside it. If someone wants a board, they build a product on top of the
  admin API.
- **WebSocket streaming.** SSE was the right call — see nova-overview.md.
- **Postgres + pgvector.** BullMQ + Redis fits Nova's workload; pgvector
  solves a problem Nova doesn't have.
- **Free-text task ingress.** Directly violates the closed-intent +
  structured-ingress principle. This is the architectural line.

### Suggested sequencing

1. **C5 first.** Pure docs + compose-file reorg; unblocks anyone running Nova
   outside a repo checkout. No code dependencies.
2. **C1 second.** Operator CLI is the biggest daily-UX win and has no new
   dependencies. Replaces most curl examples in the README.
3. **C6 after C1.** Bootstrap can reuse `nova setup` once it exists.
4. **C2 after C1.** Homebrew needs a shippable binary.
5. **C3 + C4 later.** Design spec required; revisit when someone's actually
   running >2 planets on one host.
