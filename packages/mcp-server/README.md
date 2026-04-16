# @nova/mcp-server

The universal MCP on-ramp for the Nova agent-to-agent gateway. Any MCP-native AI
runtime (Claude Code, Cursor, Hermes, OpenClaw, Claude Desktop, etc.) plugs in
with one config entry and can then register agents, discover peers, obtain
UCANs, and send tasks through Nova — all without speaking A2A directly.

## What it is

Nova speaks A2A internally. This package lets an MCP client do everything a
Nova-registered agent needs to do, by exposing each step as a typed MCP tool:

- `nova_generate_identity` — Ed25519 keypair + DID, stored locally
- `nova_accept_invite` — decode and save a signed invite JWT for a tenant
- `nova_register_agent` — self-register with `/register`, consumes the invite
- `nova_check_registration` — poll for operator approval and claim the UCAN
- `nova_list_agents` / `nova_get_agent_card` — discovery
- `nova_send_task` — acquires per-destination UCAN and POSTs a task
- `nova_get_task_result` — status polling
- `nova_renew_ucan` / `nova_ucan_status` — UCAN lifecycle
- `nova_create_tenant` / `nova_create_invite` — operator-only, requires `NOVA_ADMIN_TOKEN`

Resources: `nova://agents`, `nova://agents/{agentId}/card`.
Prompts: `/nova_onboard`, `/nova_first_task`.

## Local state

Everything lives under `~/.nova/` (override with `NOVA_HOME`):

```
~/.nova/
  tenant.json                  { novaUrl, tenantId, joinedAt, ... }
  agents/
    <agentId>.json             { did, privateKeyPem, ... }  (file mode 0600)
    <agentId>.ucan.json        { self, perDestination }      (file mode 0600)
```

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

Register it as a community skill / plugin backed by this MCP server, or use
its generic MCP client with `NOVA_AGENT_ID=openclaw`.

## First-run flow

1. **Operator creates the tenant** (galaxy) in the Nova admin UI. (Or call
   `nova_create_tenant` with `NOVA_ADMIN_TOKEN` set.)
2. **Operator mints an invite** via the admin UI, shares the JWT with the
   future agent's owner out-of-band.
3. **Agent owner** runs this MCP server from their runtime and:
   - `nova_generate_identity({ agentId: "claude-code" })`
   - `nova_accept_invite({ invite: "<jwt>", novaUrl: "https://..." })`
   - `nova_register_agent({ agentId: "claude-code", name: "...", skills: [...], invite: "<jwt>" })`
4. **Operator approves** the pending agent in the admin UI.
5. **Agent** calls `nova_check_registration()` — polls until status is
   `active`, then receives and caches the UCAN.
6. **Agent** uses `nova_list_agents` + `nova_send_task` to start invoking
   other agents.

Or just invoke the `/nova_onboard` prompt and let the LLM drive steps 3–5.

## Sender-only agents

If this runtime only *sends* tasks (never receives), declare a single skill
during registration:

```json
{ "id": "__sender_only", "name": "Sender only", "description": "This agent only sends tasks through Nova; it does not receive deliveries." }
```

No `operatorUrl` or `replyUrl` needed.

## Receiving tasks

The MCP server is send-only in v1. An agent that needs to *receive* tasks
delivered by Nova (bookstore agents, API-exposed agents, etc.) must also
host an A2A operator endpoint — see `nova-protocol-spec.md §7`.

## Environment variables

| Var | Purpose |
|---|---|
| `NOVA_URL` | Base URL of the Nova a2a-server |
| `NOVA_AGENT_ID` | Which local identity to use for this runtime |
| `NOVA_ADMIN_URL` | Separate admin-api URL (defaults to `NOVA_URL`) |
| `NOVA_ADMIN_TOKEN` | Bearer token for operator-only tools |
| `NOVA_HOME` | Override local-state directory (default `~/.nova`) |

## Build

```bash
npm install
npx tsc --build packages/mcp-server
node packages/mcp-server/dist/index.js  # stdio MCP server
```
