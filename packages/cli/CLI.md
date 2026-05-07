# Nova CLI (`nova`)

The `nova` CLI is the primary operator interface for a Nova deployment.
It covers every day-to-day task: creating tenants, minting invites,
approving agents, watching the live event feed, and inspecting queues.

## Installation

`@nova/cli` is not yet published to npm. Run from source:

```bash
# From the Nova monorepo root
npm install
npm run cli -- --help

# Or add a shell alias for convenience
alias nova="npx tsx /path/to/nova/packages/cli/src/index.ts"
```

When C2 ships (Homebrew tap), installation will be:
```bash
brew install nova/tap/nova
```

## First run

```bash
nova setup
```

Interactive wizard that writes `~/.nova/cli.json` (mode 0600).
Re-run any time credentials change. Or non-interactively:

```bash
nova setup \
  --nova-url   https://nova.example.com \
  --admin-url  https://admin.example.com \
  --admin-token $NOVA_ADMIN_TOKEN
```

Config is also read from environment variables, which override the file:
`NOVA_URL`, `NOVA_ADMIN_URL`, `NOVA_ADMIN_TOKEN`.

---

## Command reference

### `nova status`

Health check all services and show a network summary.

```
nova status
nova status --json
```

Sample output:
```
Nova status
  Status:  ● up

  Services
    ✓ redis              2ms
    ✓ data_dir           0ms
    ✓ a2a_server         4ms
    ✓ gate_service        3ms
    ✓ agent_connector    5ms

  Network
    Tenants:       2
    Agents:        5 total  4 active  1 pending

  ⚠  1 agent awaiting approval:
     nova agent approve --tenant tenant_abc --agent openclaw
```

---

### `nova events`

Stream the live lifecycle event feed. **The primary way to watch what's
happening across the network in real time.**

```
nova events
nova events --filter task
nova events --filter agent
nova events --tenant tenant_abc
nova events --tenant tenant_abc --agent claude-code
nova events --raw | jq .
```

Sample output:
```
  Nova events  http://localhost:3005/admin/events
  Streaming… press Ctrl-C to stop

12:04:31.221  agent   approved      claude-code [tenant_abc] → active
12:04:33.847  task    queued        claude-code → bookstore [tenant_abc] t/3f2a1c…
12:04:34.102  task    completed     claude-code → bookstore [tenant_abc] t/3f2a1c…
12:04:41.009  agent   created       openclaw [tenant_abc] → pending
```

**Flags:**
| Flag | Description |
|---|---|
| `--filter task\|agent\|tenant` | Show only this event class |
| `--tenant <id>` | Show only events for this tenant |
| `--agent <id>` | Show only events involving this agent |
| `--raw` | Print raw JSON (pipe to jq) |
| `--no-header` | Skip the connection banner |

---

### `nova tenant`

```
nova tenant list
nova tenant create --name "Acme Corp" --slug acme [--plan developer|pro|enterprise]
nova tenant get    <tenantId>
nova tenant delete <tenantId> [--yes]
```

Plans: `developer` (default), `pro`, `enterprise`.
Quotas default: 1000 messages/day, 5 agents max.

---

### `nova invite`

Mint a one-time invite JWT for a new agent to self-register.
The token is printed prominently for copy-paste into `nova_accept_invite`.

```
nova invite mint --tenant <tenantId> --agent-id-hint <agentId>
nova invite mint --tenant <tenantId> --agent-id-hint openclaw --ttl 7200 --note "dev laptop"
```

**`--agent-id-hint` is required** — it binds the invite to a specific
agent ID and is visible in the approval flow.

Default TTL: 3600s (1 hour). Maximum: 604800s (7 days).

---

### `nova agent`

```
nova agent list
nova agent list --tenant <tenantId>
nova agent get     --tenant <tenantId> --agent <agentId>
nova agent approve --tenant <tenantId> --agent <agentId> [--tier 1|2|3] [--expiry-days 30]
nova agent reject  --tenant <tenantId> --agent <agentId>
nova agent delete  --tenant <tenantId> --agent <agentId> [--yes]
nova agent reissue --tenant <tenantId> --agent <agentId>
```

**Trust tiers:**
- `1` = restricted (default) — limited capabilities
- `2` = standard — normal cross-tenant access
- `3` = privileged — broad capabilities

**`reissue`** regenerates the UCAN approval grant when an agent missed
its claim window (24h TTL). The agent picks it up on next
`nova_check_registration` call.

---

### `nova audit`

```
nova audit tail --tenant <tenantId>
nova audit tail --tenant <tenantId> --event task_completed --limit 20
nova audit tail --tenant <tenantId> --from 2026-04-01T00:00:00Z
nova audit task --tenant <tenantId> --task <taskId>
```

`nova audit task` prints a per-task event timeline — useful for
debugging why a specific task failed or was quarantined.

---

### `nova quarantine`

Tasks that fail the injection gate land here for operator review.

```
nova quarantine list    --tenant <tenantId> --agent <agentId>
nova quarantine show    --tenant <tenantId> --agent <agentId> <id>
nova quarantine release --tenant <tenantId> --agent <agentId> <id>
nova quarantine drop    --tenant <tenantId> --agent <agentId> <id>
```

`release` re-enqueues the task through the normal delivery pipeline.
`drop` discards it permanently.

---

### `nova dl`

Tasks that failed permanent delivery (repeated 4xx, inactive sender).

```
nova dl list  --tenant <tenantId> --agent <agentId>
nova dl show  --tenant <tenantId> --agent <agentId> <id>
nova dl drop  --tenant <tenantId> --agent <agentId> <id> [--yes]
```

---

### `nova trust`

```
nova trust list   --tenant <tenantId> --agent <agentId>
nova trust revoke --tenant <tenantId> --agent <agentId> --did <did>
```

An entry is auto-created when an agent is approved. Use `revoke` to
remove a sender's access to a specific agent without deregistering them.

---

### `nova confirm`

High-privilege tasks park here until operator approval.

```
nova confirm list    --tenant <tenantId> --agent <agentId>
nova confirm approve --tenant <tenantId> --agent <agentId> <id>
nova confirm reject  --tenant <tenantId> --agent <agentId> <id>
```

Items have a configurable timeout (per-skill, set in agent registration).
Timed-out items move to the dead-letter queue.

---

### `nova broker`

```
nova broker summary
nova broker status --tenant <tenantId> --agent <agentId>
```

Shows inbox depth, in-flight task count, and reply inbox depth for
pull-mode agents. Use when an agent appears to have stopped processing.

---

## Global flags

These flags work on every command:

| Flag | Description |
|---|---|
| `--help` | Show help for the command |
| `--json` | Output raw JSON (machine-readable, pipe-safe) |
| `--nova-url <url>` | Override a2a-server URL for this invocation |
| `--admin-url <url>` | Override admin-api URL for this invocation |
| `--admin-token <token>` | Override admin token for this invocation |

---

## Typical operator workflows

### Onboard a new agent

```bash
# 1. Create a tenant if needed
nova tenant create --name "My Team" --slug my-team

# 2. Mint an invite
nova invite mint --tenant tenant_abc --agent-id-hint claude-code

# 3. Share the token with the agent operator
#    They run: /nova_onboard (in their MCP-connected runtime)

# 4. Watch for the registration in the event feed
nova events --filter agent

# 5. Approve when it appears
nova agent approve --tenant tenant_abc --agent claude-code --tier 2

# 6. Confirm it's live
nova agent get --tenant tenant_abc --agent claude-code
```

### Debug a stuck task

```bash
# Check if it was quarantined
nova quarantine list --tenant tenant_abc --agent my-agent

# Check if it dead-lettered
nova dl list --tenant tenant_abc --agent my-agent

# Check the full task audit trail
nova audit task --tenant tenant_abc --task <taskId>

# Check broker inbox if the agent is pull-mode
nova broker status --tenant tenant_abc --agent my-agent
```

### Watch live task flow between two agents

```bash
nova events --filter task --tenant tenant_abc
```

### Emergency: revoke a compromised agent's trust

```bash
# Get the agent's DID
nova agent get --tenant tenant_abc --agent compromised-agent

# Revoke from specific targets
nova trust revoke --tenant tenant_abc --agent target-agent --did did:key:z6Mk...

# Or fully deregister
nova agent delete --tenant tenant_abc --agent compromised-agent --yes
```
