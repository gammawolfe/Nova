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

- [ ] **UCAN claim window: extend + recovery path.** Bump default Redis
  TTL on the one-time UCAN claim from 1h to 24h in
  `packages/a2a-server/src/services/ucan-service.ts`. Add
  `nova_reissue_ucan` admin tool + endpoint for operators to regenerate a
  missed claim (idempotent, no invite needed). Emit distinct
  `UCAN_CLAIM_EXPIRED` error code with remediation text.
- [ ] **Polling backoff + recovery guidance in `nova_onboard` prompt.**
  Replace "every 10 seconds" forever with: 10s for first 2min, then 30s,
  cap at 60s, abort after 30min with operator-contact message. Add
  explicit handling for `UCAN_CLAIM_EXPIRED`. File:
  `packages/mcp-server/src/prompts.ts`.
- [ ] **Concurrent-instance file locking on UCAN cache.** Add
  `proper-lockfile` (or `fs.flock`) around reads/writes of
  `~/.nova/agents/{agentId}.ucan.json` in
  `packages/mcp-server/src/tools.ts`. On contention, re-read and reuse the
  fresh UCAN instead of re-renewing.

### P2 — Security hardening (longer horizon)

- [ ] **Key rotation flow.** New `nova_rotate_key(agentId)` tool +
  `POST /agents/:agentId/rotate-key` endpoint. Generates new keypair
  locally, PoP-signs the rotation request with the *old* key. Server
  updates stored public key, issues fresh UCAN. ~200 LOC + migration note
  for existing agents.
- [ ] **OS keychain integration (opt-in).** `NOVA_KEY_BACKEND=keychain|file`
  env var. Keychain backend via `node-keytar` (macOS) / libsecret (Linux).
  File backend remains default for CI/containers. Abstraction in new
  `packages/mcp-server/src/key-backend.ts`. Ship after rotation.
- [ ] **Opportunistic revocation-check on send.** Add lightweight
  `nova_check_status()`; have `nova_send_task` call it with a 5-min cache
  to surface operator revocations before the task submit fails silently.
  File: `packages/mcp-server/src/tools.ts`.

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
