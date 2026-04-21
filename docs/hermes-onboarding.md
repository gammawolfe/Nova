# Hermes onboarding onto Nova (send + receive)

Hermes joins the Wolfe Dev galaxy as a **broker-mode agent** — meaning it both sends tasks *and* receives them, but without running an HTTP webhook. Inbound tasks are pulled over the MCP channel instead. This is the model meant for any AI runtime that can't host an inbound server (Hermes, Claude Code, Cursor, etc.).

Everything below is implemented by the codebase; this doc just tells you which files to read and which commands to run in what order.

---

## 1. Operator-side (run on the Nova host)

### 1a. Mint a single-use invite for Hermes

Invite schema, lifetime rules, and one-time-use semantics: `packages/shared/src/admin-schemas.ts` (`InviteCreateSchema`) and `packages/a2a-server/src/routes/register.ts` (see the `Gotchas — read before step 5` notes in `packages/mcp-server/src/prompts.ts` that describe when a token is consumed vs. re-usable).

```bash
ADMIN=my-secure-admin-token-12345
TENANT=tenant_727c25261efa   # Wolfe Dev

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

At the end of the ceremony, `nova_whoami` should show a cached self-UCAN scoped `nova:tenant_727c25261efa:hermes-agent:skill:*` with `can: invoke`.

---

## 4. Sending tasks

Use the canonical `/nova_first_task` prompt (`packages/mcp-server/src/prompts.ts` lines 44–69) — it walks through `nova_get_agent_card` → schema check → `nova_send_task` → `nova_get_task_result`.

If the destination is itself a broker-mode agent (like `claude-code`), you may omit `replyTo`; the reply lands in Hermes's **reply inbox** (see §5.2).

---

## 5. Receiving tasks (broker mode)

This is the half of the workflow the default prompts don't cover. Design and rationale: `docs/superpowers/specs/2026-04-19-mcp-broker-receiver-design.md`. Reply-inbox internals (pulled-into-in-flight, visibility timeouts, DLQ reclaim): `docs/superpowers/specs/2026-04-21-broker-reply-inbox.md` and `packages/shared/src/broker-config.ts`.

### 5.1 Inbound task loop (Hermes as recipient)

Keep a long-poll running whenever Hermes is up:

1. `nova_next_task({ waitMs: 30000 })` — returns `{ task, visibleUntil }` or `null` on timeout.
   - Tool definition: `packages/mcp-server/src/tools.ts` line 600.
   - HTTP route it proxies: `packages/a2a-server/src/routes/inbox.ts` → `GET /agents/:agentId/inbox`.
2. Handle the task (call the skill's handler in Hermes).
3. `nova_respond({ taskId, result })` **before** `visibleUntil` (5 min default) or the task is reclaimed and redelivered.
   - Tool: `packages/mcp-server/src/tools.ts` line 707.
   - Idempotent: a second `nova_respond` with the same `taskId` returns `{ status: "already_completed" }`.
4. Loop back to step 1.

Default visibility timeout, reclaim cadence, and DLQ ceiling: `packages/shared/src/broker-config.ts` (`BROKER_VISIBILITY_TIMEOUT_MS`, `BROKER_RECLAIM_CEILING`, `BROKER_MAX_WAIT_MS`).

### 5.2 Reply-inbox loop (Hermes as sender, collecting replies without a webhook)

When Hermes sends a task and omits `replyTo`, the result lands in its reply inbox.

1. `nova_next_reply({ waitMs: 30000 })` — `{ taskId, result, visibleUntil } | null`.
2. Act on the result.
3. `nova_ack_reply({ taskId })` — idempotent; second call returns `already_acked`.

The stored `TaskResult` stays queryable via `nova_get_task_result` for 24 h after ack (configurable — `BROKER_REPLY_RESULT_TTL_SECONDS`).

---

## 6. Lifecycle / maintenance

- **UCAN renewal.** Self-UCAN expires ~30 days after claim. Hermes should call `nova_renew_ucan` when `nova_ucan_status` reports < 20 % lifetime remaining. Renewal uses a proof-of-possession nonce; route contract in `packages/admin-api/src/routes` (see `/admin/tenants/:id/ucans/renew`).
- **Key rotation.** See `scripts/rotate-keys.ts` and `scripts/acceptance-test-p2.7-rotation.ts` for the supported rotation ceremony.
- **Revocation.** Operator triggers via the admin UI / admin API; Hermes sees the next UCAN refresh fail with a clear error code. Trust-registry revocation paths: `packages/admin-api/src/routes/trust.ts`.

---

## 7. Verification checklist

After onboarding, confirm the full loop works before handing Hermes to end-users:

- [ ] `curl http://localhost:3001/discover` lists `hermes-agent` with the real skill.
- [ ] `nova_whoami` shows `status: "active"`, self-UCAN cached.
- [ ] Send a test task Hermes → `claude-code`: `nova_send_task` without `replyTo`, then `nova_next_reply` returns the result and `nova_ack_reply` succeeds.
- [ ] Receive a test task `claude-code` → Hermes: `nova_next_task` returns the task, `nova_respond` ships a result, sender sees it.

The broker-mode receiver design doc (`docs/superpowers/specs/2026-04-19-mcp-broker-receiver-design.md` §"Verification procedure") has a more thorough version of this checklist.
