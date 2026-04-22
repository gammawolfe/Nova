# Hermes onboarding onto Nova (send + receive)

Hermes joins the Wolfe Dev galaxy as a **broker-mode agent** — meaning it both sends tasks *and* receives them, but without running an HTTP webhook. Inbound tasks are pulled over the MCP channel instead. This is the model meant for any AI runtime that can't host an inbound server (Hermes, Claude Code, Cursor, etc.).

Everything below is implemented by the codebase; this doc just tells you which files to read and which commands to run in what order.

---

## 1. Operator-side (run on the Nova host)

### 1a. Mint a single-use invite for Hermes

Invite schema, lifetime rules, and one-time-use semantics: `packages/shared/src/admin-schemas.ts` (`InviteCreateSchema`) and `packages/a2a-server/src/routes/register.ts` (see the `Gotchas — read before step 5` notes in `packages/mcp-server/src/prompts.ts` that describe when a token is consumed vs. re-usable).

```bash
ADMIN=my-secure-admin-token-12345
TENANT=<your-tenant-id>      # e.g. tenant_496bdb38306a — look up with:
                             # curl -s http://127.0.0.1:3005/admin/tenants -H "Authorization: Bearer $ADMIN"

curl -s -X POST "http://127.0.0.1:3005/admin/tenants/$TENANT/invites" \
  -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"agentIdHint":"hermes-agent","ttlSeconds":3600}'
```

Hand the returned `token` to the Hermes operator out-of-band. `agentIdHint` MUST match the `agentId` Hermes will use at registration (see `SelfRegisterSchema` → `AGENT_ID_MISMATCH` error).

### 1b. Approve the registration (after Hermes runs step 2)

Approval endpoint and UCAN-stash behaviour: `packages/admin-api/src/routes/agents.ts` approve handler + the `GET /register/status` claim-on-read flow in `packages/a2a-server/src/routes/register.ts` (lines 185–236).

```bash
curl -s -X POST \
  "http://127.0.0.1:3005/admin/tenants/$TENANT/agents/hermes-agent/approve" \
  -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"trustTier":2}'
```

Trust tiers are defined in `packages/gate-service/src` — tier 2 is the default for a new third-party runtime; tier 3 requires deeper vetting.

---

## 2. Hermes-side MCP configuration

Read first:
- `packages/mcp-server/README.md` — full tool list, env vars, local state layout at `~/.nova/`
- `README.md` §"MCP integration" — runtime matrix (the Hermes-specific line is there)

Config, in whatever file Hermes uses for MCP servers:

```json
{
  "mcpServers": {
    "nova": {
      "command": "node",
      "args": ["/Users/tyewolfe/Projects/Nova/packages/mcp-server/dist/index.js"],
      "env": {
        "NOVA_URL": "http://localhost:3001",
        "NOVA_ADMIN_URL": "http://127.0.0.1:3005",
        "NOVA_AGENT_ID": "hermes-agent"
      }
    }
  }
}
```

`NOVA_AGENT_ID=hermes-agent` MUST match the invite's `agentIdHint`. Identity + UCAN land at `~/.nova/agents/hermes-agent.json` (mode 0600) — see `packages/mcp-server/src/identity.ts` and `ucan-store.ts`.

---

## 3. Hermes onboarding ceremony

Hermes should invoke the canonical `/nova_onboard` prompt — full script lives in `packages/mcp-server/src/prompts.ts` (lines 4–42). That prompt enumerates the exact MCP tool calls, escalating backoff for approval polling, and the verbatim fallback messages for the two operator-intervention cases (approval timeout, UCAN claim window expired).

**Hermes-specific deviation from the default prompt:** step 5 in the prompt defaults skills to `__sender_only`. Hermes needs to receive, so pass a real skill instead, for example:

```json
"skills": [{
  "id": "chat",
  "name": "Chat",
  "description": "General conversation. Accepts a text prompt and returns a text response.",
  "tags": ["chat", "general"]
}]
```

Do **not** pass `operatorUrl` — its absence is what makes this a broker-mode registration (see `packages/a2a-server/src/routes/register.ts` line 64 and `packages/shared/src/broker-config.ts` for the receiver semantics).

At the end of the ceremony, `nova_whoami` should show a cached `grant` object with `expiresAt` and `lifetimeRemaining` populated. This is the Nova-signed **approval grant** — a tenant-scoped root (`att: [{ with: "nova:<tenantId>:*", can: "invoke" }]`) delegated to the agent's DID. Per-destination narrowing happens at send time when `nova_send_task` mints a short-lived invocation token locally (chain-rooted at the grant). See `docs/superpowers/specs/2026-04-21-sender-signed-ucans.md` for the full token shape.

---

## 4. Sending tasks

Use the canonical `/nova_first_task` prompt (`packages/mcp-server/src/prompts.ts` lines 44–69) — it walks through `nova_get_agent_card` → schema check → `nova_send_task` → `nova_get_task_result`.

If the destination is itself a broker-mode agent (like `claude-code`), you may omit `replyTo`; the reply lands in Hermes's **reply inbox** (see §5.2).

---

## 5. Receiving tasks (broker mode)

This is the half of the workflow the default prompts don't cover. Design and rationale: `docs/superpowers/specs/2026-04-19-mcp-broker-receiver-design.md`. Reply-inbox internals (pulled-into-in-flight, visibility timeouts, DLQ reclaim): `docs/superpowers/specs/2026-04-21-broker-reply-inbox.md` and `packages/shared/src/broker-config.ts`. Push-subscription design (SSE, MCP resources): `docs/superpowers/specs/2026-04-22-mcp-push-subscriptions.md`.

Two ways to run the claim loops — pick one:

- **In-process (this doc, §5.1–5.3).** Hermes drives the loops itself via the MCP tools. Best when Hermes is a long-running runtime that can host a subscription + handler.
- **Supervised daemon (`@nova/broker-receiver`).** A separate process holds the identity + approval grant, subscribes to `/inbox/stream`, and runs pluggable handlers. Good when Hermes is ephemeral or you'd rather keep receive plumbing out of the model loop. See `docs/superpowers/specs/2026-04-21-broker-receiver-daemon.md` and `packages/broker-receiver/README.md` for launchd/systemd templates. The two modes are mutually exclusive per `agentId`.

### 5.1 Inbound task loop (Hermes as recipient)

Prefer push; fall back to long-poll only if your MCP client can't subscribe.

**Push (recommended).** `nova_watch_inbox` subscribes to `nova://inbox`; Nova streams notifications over SSE (`/agents/:agentId/inbox/stream`) with ~100 ms latency. On each notification, call `nova_next_task({ waitMs: 0 })` to claim.

1. `nova_watch_inbox()` once on startup. (Tool def: `packages/mcp-server/src/tools.ts` line 813.)
2. On each notification: `nova_next_task({ waitMs: 0 })` → `{ task, visibleUntil }` or `null`.
3. Handle the task.
4. `nova_respond({ taskId, result })` **before** `visibleUntil` (5 min default) — idempotent; a second call returns `{ status: "already_completed" }`.
5. On shutdown: `nova_unwatch_inbox()`.

**Long-poll (fallback).** Same claim/respond contract, just drive it yourself:

1. `nova_next_task({ waitMs: 30000 })` — returns `{ task, visibleUntil }` or `null` on timeout.
2–4 as above, then loop.

Tools: `nova_next_task` at `packages/mcp-server/src/tools.ts` line 589, `nova_respond` at line 687. HTTP route both paths share: `packages/a2a-server/src/routes/inbox.ts` → `GET /agents/:agentId/inbox`. Default visibility timeout, reclaim cadence, and DLQ ceiling: `packages/shared/src/broker-config.ts` (`BROKER_VISIBILITY_TIMEOUT_MS`, `BROKER_RECLAIM_CEILING`, `BROKER_MAX_WAIT_MS`).

### 5.2 Reply-inbox loop (Hermes as sender, collecting replies without a webhook)

When Hermes sends a task and omits `replyTo`, the result lands in its reply inbox. Same push-first pattern:

**Push.** `nova_watch_replies()` subscribes to `nova://replies`. On each notification, call `nova_next_reply({ waitMs: 0 })`, then `nova_ack_reply({ taskId })`.

**Long-poll fallback.** `nova_next_reply({ waitMs: 30000 })` → `{ taskId, result, visibleUntil } | null`; then `nova_ack_reply({ taskId })` (idempotent; second call returns `already_acked`).

The stored `TaskResult` stays queryable via `nova_get_task_result` for 24 h after ack (configurable — `BROKER_REPLY_RESULT_TTL_SECONDS`).

### 5.3 Single-task watches (optional)

If Hermes wants to react to a specific outbound task's lifecycle without the reply inbox, `nova_watch_task({ taskId })` subscribes to `nova://tasks/{taskId}` — status transitions stream over `/tasks/:taskId/stream` (see `packages/a2a-server/src/stream.ts`). Unsubscribe with `nova_unwatch_task({ taskId })`.

---

## 6. Lifecycle / maintenance

- **Approval-grant renewal.** The grant expires ~30 days after approval. Under the sender-signed-UCAN model (`docs/superpowers/specs/2026-04-21-sender-signed-ucans.md`), there is no client-side renewal — per-request invocation tokens are minted locally on every `nova_send_task`, and only the long-lived grant is Nova-signed. `nova_ucan_status` reports the grant's expiry and lifetime remaining; when it drops low, ask the operator to run `nova_reissue_ucan` (requires `NOVA_ADMIN_TOKEN`). Hermes then re-claims via `nova_check_registration`. `nova_renew_ucan` still exists but is now a status-report tool — it cannot refresh anything on its own.
- **Key rotation.** `nova_rotate_key` handles the canonical flow: generate a fresh Ed25519 keypair, prove possession of the old key (nonce signed over `nonce|newDid|newPublicKey`), swap the registered pubkey+DID on Nova. All grants issued to the old DID in this tenant are revoked; a fresh approval grant is minted for the new DID. The old identity file is preserved at `{agentId}.json.rotated-{ISO}.bak` for audit. Cross-tenant trust that referenced the old DID must be re-seeded by the counterparty operator. Also see `scripts/rotate-keys.ts` and `scripts/acceptance-test-p2.7-rotation.ts`.
- **Revocation.** Operator triggers via the admin UI / admin API; the grant's CID is added to the revocation set and every subsequent invocation token fails chain verification at the gate. Trust-registry revocation paths: `packages/admin-api/src/routes/trust.ts`.

---

## 7. Verification checklist

After onboarding, confirm the full loop works before handing Hermes to end-users:

- [ ] `curl http://localhost:3001/discover` lists `hermes-agent` with the real skill.
- [ ] `nova_whoami` shows `status: "active"`, self-UCAN cached.
- [ ] Send a test task Hermes → `claude-code`: `nova_send_task` without `replyTo`, then `nova_next_reply` returns the result and `nova_ack_reply` succeeds.
- [ ] Receive a test task `claude-code` → Hermes: `nova_next_task` returns the task, `nova_respond` ships a result, sender sees it.

The broker-mode receiver design doc (`docs/superpowers/specs/2026-04-19-mcp-broker-receiver-design.md` §"Verification procedure") has a more thorough version of this checklist.
