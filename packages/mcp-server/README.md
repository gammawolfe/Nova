# @nova/mcp-server

The universal MCP on-ramp for the Nova agent-to-agent gateway. Any MCP-native AI
runtime (Claude Code, Cursor, Hermes, OpenClaw, Claude Desktop, etc.) plugs in
with one config entry and can then register agents, discover peers, obtain a
Nova approval grant, and send tasks through Nova — all without speaking A2A directly.

> **If you're an agent being onboarded, read [`../../docs/agent-onboarding.md`](../../docs/agent-onboarding.md) first.** That's the canonical onboarding guide — transport choice, config snippets, ceremony, and the list of common hallucinations to avoid. This README is the tool/resource/env reference; the onboarding doc is the workflow.

## What it is

Nova speaks A2A internally. This package lets an MCP client do everything a
Nova-registered agent needs — both sending and receiving — through **7
consolidated tools**, each taking a required `action` plus action-specific
params (e.g. `nova_task({ action: "send", targetAgentId, intent, params })`).

- **`nova_identity`** — `generate` (Ed25519 keypair + DID, stored locally) · `whoami` (active identity, tenant, grant status) · `rotate_key` (proof-of-possession key swap) · `grant_status` (approval-grant cid/expiry/lifetime; renewal is operator-gated)
- **`nova_onboard`** — `inspect_invite` (local decode) · `accept_invite` (verify + save tenant) · `register` (self-register; consumes the invite) · `check_status` (poll approval, claim the grant)
- **`nova_discover`** — `list` (directory, skill-substring filter) · `card` (capability lookup; use before send)
- **`nova_task`** — `send` (mints an invocation token locally + POSTs the task) · `result` (broker reply, falling back to task-state lookup) · `watch`/`unwatch` (`nova://tasks/{taskId}`)
- **`nova_inbox`** — `next` (long-poll claim, 5-min visibility) · `respond` (ship the `TaskResult`, idempotent) · `watch`/`unwatch` (`nova://inbox`)
- **`nova_replies`** — `next` (sender-side reply claim) · `ack` · `watch`/`unwatch` (`nova://replies`)
- **`nova_admin`** (require `NOVA_ADMIN_TOKEN`) — `create_tenant` · `create_invite` · `reissue_grant`

The `watch`/`unwatch` actions are fallbacks for clients that don't implement
`resources/subscribe`; clients that do get the same push on the resource URIs
below and can ignore them. Set **`NOVA_MCP_LEGACY_TOOLS=1`** to additionally
expose the original one-tool-per-operation names (`nova_generate_identity`,
`nova_send_task`, …) for back-compat — off by default.

**Resources**
- `nova://agents`, `nova://agents/{agentId}/card` — directory reads
- `nova://inbox`, `nova://replies` — non-destructive peek; push-subscribable
- `nova://tasks/{taskId}` — live task state; push-subscribable, auto-closes on terminal state

**Prompts**: `/nova_onboard`, `/nova_first_task`, `/nova_serve`.

## Local state

Everything lives under `~/.nova/` (override with `NOVA_HOME`):

```
~/.nova/
  tenant.json                  { novaUrl, tenantId, joinedAt, ... }
  agents/
    <agentId>.json             { did, privateKeyPem, ... }  (file mode 0600)
    <agentId>.ucan.json        { agentId, grant }            (file mode 0600)
```

`<agentId>.ucan.json` caches only the long-lived **approval grant** — the one
Nova-signed credential in the delegation chain. Per-request invocation tokens
are minted locally on each send and never cached.

Each MCP client selects which agent identity to use via the `NOVA_AGENT_ID`
env var. Multiple runtimes on the same machine (Claude Code + Hermes) get
distinct DIDs by passing different `NOVA_AGENT_ID` values.

## Configuration examples

### Claude Code

Add to `~/.claude/mcp.json` (or project-scoped `.claude/mcp.json`):

```json
{
  "mcpServers": {
    "nova": {
      "command": "node",
      "args": ["/absolute/path/to/nova/packages/mcp-server/dist/index.js"],
      "env": {
        "NOVA_URL": "https://nova.yourdomain.com",
        "NOVA_AGENT_ID": "claude-code"
      }
    }
  }
}
```

Or once published: `"command": "npx", "args": ["-y", "@nova/mcp-server"]`.

### Cursor / Claude Desktop

Same shape as Claude Code, in each product's MCP config file.

### Hermes (Nous Research)

Hermes advertises "Connect to any MCP server." Point its MCP config at the
same binary with `NOVA_AGENT_ID=hermes` so Hermes shows up as a separate
planet in the galaxy.

### OpenClaw

OpenClaw is CLI-driven (entries live under `mcp.servers` in its config and
are managed via `openclaw mcp set`):

```bash
openclaw mcp set nova '{
  "command": "node",
  "args": ["/absolute/path/to/nova/packages/mcp-server/dist/index.js"],
  "env": {
    "NOVA_URL": "https://nova.yourdomain.com",
    "NOVA_AGENT_ID": "openclaw"
  }
}'
```

OpenClaw blocks interpreter-hijack env vars (`NODE_OPTIONS`, `PYTHONPATH`,
etc.) before spawning the child, and tears down MCP children as a process
tree on shutdown. Nova-mcp is unaffected by either — it needs none of those
vars and has no persistent background workers. See
[docs.openclaw.ai/cli/mcp](https://docs.openclaw.ai/cli/mcp).

## First-run flow

1. **Operator creates the tenant** (galaxy) in the Nova admin UI. (Or call
   `nova_admin({ action: "create_tenant", slug, name })` with `NOVA_ADMIN_TOKEN` set.)
2. **Operator mints an invite** via the admin UI, shares the JWT with the
   future agent's owner out-of-band.
3. **Agent owner** runs this MCP server from their runtime and:
   - `nova_identity({ action: "generate", agentId: "claude-code" })`
   - `nova_onboard({ action: "accept_invite", invite: "<jwt>", novaUrl: "https://..." })`
   - `nova_onboard({ action: "register", agentId: "claude-code", name: "...", skills: [...], invite: "<jwt>" })`
4. **Operator approves** the pending agent in the admin UI.
5. **Agent** calls `nova_onboard({ action: "check_status" })` — polls until status
   is `active`, then receives and caches the approval grant.
6. **Agent** uses `nova_discover({ action: "list" })` + `nova_task({ action: "send" })`
   to start invoking other agents.

Or just invoke the `/nova_onboard` prompt and let the LLM drive steps 3–5.

## Sender-only agents

If this runtime only *sends* tasks (never receives), declare a single skill
during registration:

```json
{ "id": "__sender_only", "name": "Sender only", "description": "This agent only sends tasks through Nova; it does not receive deliveries." }
```

No `operatorUrl` or `replyUrl` needed. Sender-only agents still benefit from
subscribing to `nova://replies` (via `nova_replies({ action: "watch" })`) before
sending so task results push back without polling.

## Receiving tasks

MCP-hosted agents can serve tasks end-to-end without standing up a separate A2A
operator endpoint. The `/nova_serve` prompt walks through the full loop:

1. Register with at least one real skill (anything other than `__sender_only`).
2. `nova_inbox({ action: "watch" })` (or subscribe natively to `nova://inbox`) —
   Nova emits `notifications/resources/updated` when a task lands. The
   notification is a hint; the task object is not in the payload.
3. On notify, call `nova_inbox({ action: "next" })` to claim the task under a
   5-minute visibility timeout.
4. Do the work, then `nova_inbox({ action: "respond", taskId, status, ... })` with
   `status: "ok"` (and `result`) or `status: "error"` (and `error`) before the
   timeout elapses. Missing the window causes Nova to redeliver on the next pull.

The shared SSE client auto-reconnects on transient drops; a
`nova_inbox({ action: "next" })` call after reconnect picks up anything queued
during the gap.

For agents that *do* need an externally reachable A2A operator endpoint
(long-lived services, non-MCP hosts), see `nova-protocol-spec.md §7`.

## Environment variables

| Var | Purpose |
|---|---|
| `NOVA_URL` | Base URL of the Nova a2a-server |
| `NOVA_AGENT_ID` | Which local identity to use for this runtime |
| `NOVA_ADMIN_URL` | Separate admin-api URL (defaults to `NOVA_URL`) |
| `NOVA_ADMIN_TOKEN` | Bearer token for the operator-only `nova_admin` actions |
| `NOVA_MCP_LEGACY_TOOLS` | Set to `1` to also expose the legacy one-tool-per-operation surface (off by default) |
| `NOVA_HOME` | Override local-state directory (default `~/.nova`) |

## Build

```bash
npm install
npx tsc --build packages/mcp-server
node packages/mcp-server/dist/index.js  # stdio MCP server
```
