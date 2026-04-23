# Nova

**A zero-trust gateway for agent-to-agent communication.** Any AI runtime —
Claude Code, Cursor, Hermes, OpenClaw, custom agents — joins a Nova network
and can then discover peers and send tasks through a hardened capability-based
pipeline instead of unauthenticated JSON APIs.

Nova implements the **A2A** (Agent-to-Agent) wire protocol with UCAN-based
capabilities, a five-layer gate for auth and injection defense, and an
**MCP on-ramp** (`@nova/mcp-server`) so any MCP-native AI runtime can onboard
without learning A2A directly.

---

## Mental model

```
                    ┌──────────────── Nova deployment ────────────────┐
                    │                                                 │
     Galaxy A1      │   Galaxy C3                      Galaxy B7      │
  (your household)  │   (bookstore)                   (aunt's)        │
   ┌──────────┐    │    ┌──────────┐                  ┌──────────┐   │
   │  Planet  │    │    │  Planet  │                  │  Planet  │   │
   │  Claude  │◀──┼────▶│ bookstore│                  │  Hermes  │   │
   │   Code   │    │    │  agent   │                  │          │   │
   └──────────┘    │    └──────────┘                  └──────────┘   │
   ┌──────────┐    │                                                 │
   │  Planet  │    │           Tasks flow: any → any,                │
   │  Hermes  │    │           gated by UCAN + trust tier            │
   └──────────┘    │                                                 │
                    └─────────────────────────────────────────────────┘
```

- A **tenant** is a galaxy. One per household, org, or product.
- An **agent** is a planet inside a galaxy — one per runtime (your Claude
  Code is a planet, your Hermes is a different planet, each with its own DID
  and audit trail).
- **Intra-tenant** talk (planet ↔ planet within a galaxy) and **cross-tenant**
  talk (galaxy ↔ galaxy on the same Nova) are both supported. Every task
  carries a narrowly-scoped **invocation token** — minted locally by the
  sender from its long-lived Nova-signed **approval grant**, audience-bound
  to the destination agent + skill, short TTL. Nova's gate verifies the
  delegation chain before the destination agent sees anything.

There are three kinds of agents:

| Role | What they do | How they connect |
|---|---|---|
| **Sender** | Originates tasks (your Claude Code asking the bookstore for a price quote) | Uses `@nova/mcp-server` — no HTTP endpoint needed |
| **Webhook receiver** | Accepts tasks via push to a hosted endpoint (the bookstore's order agent) | Hosts an A2A operator webhook per `nova-protocol-spec.md §7` |
| **Broker receiver** | Accepts tasks via pull — no inbound HTTP, suitable for MCP-native runtimes and headless daemons | Runs `@nova/broker-receiver` (supervised daemon) or pulls interactively via `nova_next_task` from `@nova/mcp-server` |

Most runtimes are senders. Webhook receivers are services with a public HTTP
surface; broker receivers are runtimes that can't (or won't) host a webhook —
Nova holds their inbox and they claim tasks when ready, with push
notifications over SSE so latency is ~100ms, not a poll cycle.

---

## Quick start

### 1. Run Nova locally

```bash
npm install
npm run generate:keys        # Ed25519 keypair for the gateway
docker compose up -d         # redis :6379, a2a-server :3001, gate-service, agent-connector, admin-api :3005, caddy :80/:8443
```

### 2. Create your galaxy and mint an invite

Via admin UI at `http://localhost:3005/` once wired up, or directly:

```bash
# Create tenant
curl -X POST http://localhost:3005/admin/tenants \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"My Household","slug":"my-household"}'

# Mint an invite for a new agent
curl -X POST http://localhost:3005/admin/tenants/TENANT_ID/invites \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agentIdHint":"claude-code","ttlSeconds":3600}'
# → { "token": "eyJhbGci...", "jti": "...", "expiresAt": "..." }
```

### 3. Onboard an AI runtime

**Canonical guide: [`docs/agent-onboarding.md`](docs/agent-onboarding.md)** — read this first if you're an AI agent being asked to join a Nova deployment, or an operator onboarding one. It covers transport choice (local / SSH / public URL), MCP config snippets, the exact onboarding ceremony, and a list of common hallucinations to avoid (spoiler: there's no `nova.mcp.json`, no port 4077, no `@ucan/cli`).

Short version: point any MCP-native runtime at `@nova/mcp-server` and run the `/nova_onboard` prompt. See [MCP integration](#mcp-integration) below for per-runtime config snippets.

---

## MCP integration

`@nova/mcp-server` is the universal on-ramp. It turns every Nova operation
into a typed MCP tool so your existing AI runtime can register, discover, and
send tasks without speaking A2A directly.

### Tools exposed

```
# Identity & onboarding
nova_generate_identity     Ed25519 keypair + DID, stored at ~/.nova/agents/
nova_whoami                active identity, tenant, approval-grant status
nova_inspect_invite        local decode of an invite JWT — no network, no consumption
nova_accept_invite         save an invite locally (consumed by nova_register_agent)
nova_register_agent        POST /register (consumes the invite)
nova_check_registration    poll until operator approves, claim approval grant
nova_rotate_key            rotate the agent's Ed25519 keypair (PoP-signed with old key)
nova_renew_ucan            report grant status (no client-side refresh in the delegation model)
nova_ucan_status           approval-grant cache inspection

# Discovery & send
nova_list_agents           discovery across all galaxies
nova_get_agent_card        skill schemas for a specific agent
nova_send_task             mint invocation token locally + POST task to destination
nova_get_task_result       poll task state

# Broker-mode receive (no webhook)
nova_next_task             long-poll for a task; claims with 5-min visibility
nova_respond               ship TaskResult back (must respond before visibility expires)

# Broker-mode sender reply collection
nova_next_reply            long-poll for a TaskResult addressed to this agent as sender
nova_ack_reply             clear in-flight state for a pulled reply

# Push subscriptions (fallbacks if client can't speak MCP resources/subscribe)
nova_watch_inbox           subscribe to nova://inbox
nova_unwatch_inbox         unsubscribe
nova_watch_replies         subscribe to nova://replies
nova_unwatch_replies       unsubscribe
nova_watch_task            subscribe to nova://tasks/{taskId}
nova_unwatch_task          unsubscribe

# Operator-only (requires NOVA_ADMIN_TOKEN)
nova_create_tenant         create a galaxy
nova_create_invite         mint an invite JWT
nova_reissue_ucan          regenerate an approval grant after the claim window lapsed
```

Resources: `nova://agents`, `nova://agents/{agentId}/card`, `nova://inbox`
(subscribable), `nova://replies` (subscribable), `nova://tasks/{taskId}`
(subscribable).
Prompts: `/nova_onboard`, `/nova_first_task`

### Claude Code

Add to `~/.claude/mcp.json` or project-scoped `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "nova": {
      "command": "node",
      "args": ["/abs/path/to/nova/packages/mcp-server/dist/index.js"],
      "env": {
        "NOVA_URL": "https://nova.yourdomain.com",
        "NOVA_AGENT_ID": "claude-code"
      }
    }
  }
}
```

### Cursor / Claude Desktop

Same shape, in each product's MCP config file.

### Hermes (Nous Research)

Hermes advertises "Connect to any MCP server" — point its MCP config at the
same binary with `NOVA_AGENT_ID=hermes`. Hermes shows up as a distinct planet.

### OpenClaw

OpenClaw is CLI-driven — MCP servers go under `mcp.servers` in its config,
managed via `openclaw mcp set`. Register nova-mcp with:

```bash
openclaw mcp set nova '{
  "command": "node",
  "args": ["/abs/path/to/nova/packages/mcp-server/dist/index.js"],
  "env": {
    "NOVA_URL": "https://nova.yourdomain.com",
    "NOVA_AGENT_ID": "openclaw"
  }
}'
```

Two OpenClaw-specific quirks (from
[docs.openclaw.ai/cli/mcp](https://docs.openclaw.ai/cli/mcp)):

- It blocks interpreter-hijack env vars (`NODE_OPTIONS`, `PYTHONPATH`,
  `PERL5OPT`, etc.) before spawning the child. Nova-mcp doesn't need any of
  them, so this is fine — just don't wrap the binary in a launcher that
  relies on those.
- It tears down MCP children as a process tree on shutdown. Nova-mcp is a
  thin translator with no background workers, so nothing is lost; the
  `~/.nova/agents/openclaw.json` identity persists across sessions.

### Multiple runtimes on the same machine

Different `NOVA_AGENT_ID` values give each runtime its own DID, its own
keypair (`~/.nova/agents/{agentId}.json`, file mode 0600), and its own planet
in the galaxy. Revocation and audit are per-runtime.

---

## End-to-end example

Your Claude Code ordering a book from your dad's bookstore's agent.

```
# In Claude Code, after MCP config is live:

> /nova_onboard

Claude calls:
  nova_generate_identity({ agentId: "claude-code" })
    → did:key:z6Mk7H...
  # (You paste the invite JWT from the admin UI)
  nova_accept_invite({ invite: "eyJhbGc..." })
    → { tenantId: "tenant_abc", agentIdHint: "claude-code" }
  nova_register_agent({
    agentId: "claude-code",
    name: "My Claude Code",
    skills: [{ id: "__sender_only", name: "Sender only", description: "sends tasks only" }],
    invite: "eyJhbGc..."
  })
    → { status: "pending", statusUrl: "/register/status/tenant_abc/claude-code" }
  # (Operator approves in admin UI)
  nova_check_registration()
    → { status: "active", claimed: true, trustTier: 2, ucanExpiresAt: "..." }

> find me a used copy of "Ficciones" by Borges and quote me a price

Claude calls:
  nova_list_agents({ skills: "book" })
    → [{ agentId: "bookstore", tenantId: "tenant_dads", skills: [{ id: "quote_book", ... }] }]
  nova_get_agent_card("bookstore")
    → inputSchema for quote_book: { title: string, author: string, condition: enum }
  nova_send_task({
    targetAgentId: "bookstore",
    intent: "quote_book",
    params: { title: "Ficciones", author: "Jorge Luis Borges", condition: "used" }
  })
    # Under the hood: MCP server mints a fresh invocation token locally —
    # delegated from the agent's long-lived approval grant, audience-bound
    # to nova:tenant_dads:bookstore:skill:quote_book, short TTL — and POSTs
    # the task with the token in the UCAN header. Nova gate validates the
    # full delegation chain, queues, delivers to bookstore operator webhook.
    → { taskId: "uuid", statusUrl: "...", streamUrl: "..." }
  nova_get_task_result({ targetAgentId: "bookstore", taskId: "uuid" })
    → { status: "completed", result: { price: "$18", condition: "good", ... } }
```

Every send mints a fresh invocation token locally — there is no per-
destination cache and no round trip to Nova to get one. The credential that
*is* cached is the long-lived approval grant that backs those tokens; when
it nears expiry the operator runs `nova_reissue_ucan` and the agent picks up
the fresh grant on its next `nova_check_registration` call.

---

## Monorepo layout

| Package | Purpose |
|---|---|
| `@nova/shared` | Zod schemas, tenant/error types, Redis helpers, invite JWT service |
| `@nova/a2a-server` | Wire-protocol ingestion, `POST /register`, `GET /register/status`, task submission, agent cards |
| `@nova/gate-service` | Five-layer gate pipeline: trust tier, UCAN, schema, injection patterns, classifier |
| `@nova/task-queue` | BullMQ queues backing async task ingress |
| `@nova/agent-connector` | Workers that deliver approved tasks to destination operator webhooks (push mode) or into the broker inbox (pull mode) |
| `@nova/broker-receiver` | Supervised daemon for broker-mode receivers — holds its own identity + approval grant, subscribes to `/inbox/stream`, runs pluggable handlers (`echo`, `claude-api`, …), ships with launchd/systemd templates |
| `@nova/admin-api` | Operator-only admin endpoints: tenants, agents, trust registry, invites, UCAN issuance + reissue + rotate-key, quarantine, dead-letter, audit, SSE `/admin/events` |
| `@nova/mcp-server` | **MCP on-ramp for AI runtimes.** stdio MCP server exposing Nova operations as typed tools, plus subscribable resources (`nova://inbox`, `nova://replies`, `nova://tasks/{id}`) for push notifications |
| `@nova/operator-mock` | Test receiver for acceptance tests |

---

## Admin API surface

Operator endpoints (require `Authorization: Bearer $ADMIN_TOKEN`):

```
# Tenants & invites
POST    /admin/tenants                                             create a galaxy
GET     /admin/tenants                                             list galaxies
GET     /admin/tenants/:id                                         tenant detail
DELETE  /admin/tenants/:id                                         delete tenant
POST    /admin/tenants/:id/invites                                 mint invite JWT (one-time)

# Agents
GET     /admin/agents                                              list agents across all tenants
GET     /admin/tenants/:id/agents                                  list agents in tenant
GET     /admin/tenants/:id/agents/:agentId                         agent detail
POST    /admin/tenants/:id/agents/:agentId/approve                 approve + issue approval grant
POST    /admin/tenants/:id/agents/:agentId/reject                  reject pending agent
DELETE  /admin/tenants/:id/agents/:agentId                         deregister agent
POST    /admin/tenants/:id/agents/:agentId/ucans/reissue           regenerate approval grant

# Trust registry (per receiving agent)
POST    /admin/tenants/:id/agents/:agentId/trust                   upsert trust entry
GET     /admin/tenants/:id/agents/:agentId/trust                   list trust entries
GET     /admin/tenants/:id/agents/:agentId/trust/:did              get trust entry
DELETE  /admin/tenants/:id/agents/:agentId/trust/:did              revoke trust entry

# UCAN inventory (operator-issued UCANs)
POST    /admin/tenants/:id/ucans/issue                             issue a UCAN
POST    /admin/tenants/:id/ucans/revoke                            revoke a UCAN by CID
GET     /admin/tenants/:id/ucans                                   list UCANs

# Quarantine (inbound tasks the gate held)
GET     /admin/tenants/:id/agents/:agentId/quarantine              list quarantined tasks
GET     /admin/tenants/:id/agents/:agentId/quarantine/stats        counts
GET     /admin/tenants/:id/agents/:agentId/quarantine/:id          item detail
POST    /admin/tenants/:id/agents/:agentId/quarantine/:id/release  release to inbox
DELETE  /admin/tenants/:id/agents/:agentId/quarantine/:id          discard

# Dead-letter (delivery failures)
GET     /admin/tenants/:id/agents/:agentId/dead-letter             list dead-lettered tasks
GET     /admin/tenants/:id/agents/:agentId/dead-letter/:id         item detail
DELETE  /admin/tenants/:id/agents/:agentId/dead-letter/:id         discard

# Confirmation queue (high-privilege operations awaiting operator approval)
GET     /admin/tenants/:id/agents/:agentId/confirm-queue           list pending confirmations
GET     /admin/tenants/:id/agents/:agentId/confirm-queue/:id       item detail
POST    /admin/tenants/:id/agents/:agentId/confirm-queue/:id       approve
DELETE  /admin/tenants/:id/agents/:agentId/confirm-queue/:id       reject

# Audit
GET     /admin/tenants/:id/audit                                   tenant-scoped audit events
GET     /admin/tenants/:id/audit/:taskId                           task-scoped audit trail
GET     /admin/audit                                               audit events across all tenants

# Lifecycle stream (SSE, no auth — v1 trust model is localhost)
GET     /admin/events                                              tenant/agent/task lifecycle
```

Public endpoints on the a2a-server (no admin bearer auth — discovery, self-registration, or invocation-token-authorised):

```
# Self-registration & discovery
POST    /register                                        self-register (invite required)
GET     /register/status/:tenantId/:agentId              poll approval, claim approval grant
GET     /discover                                        list active agents
GET     /discover/:agentId                               agent detail
GET     /agents/:agentId/.well-known/agent.json          A2A agent card
GET     /agents/:agentId/health                          agent status + UCAN revocation probe

# Task submission (UCAN invocation token required in Authorization header)
POST    /agents/:agentId/tasks                           submit a task
GET     /agents/:agentId/tasks/:taskId                   task status

# Broker-mode receive (pull inbox, for agents without a webhook)
GET     /agents/:agentId/inbox                           long-poll claim (next task)
GET     /agents/:agentId/inbox/peek                      non-destructive snapshot
GET     /agents/:agentId/inbox/stream                    SSE push notifications

# Broker-mode reply collection (for senders without a replyTo webhook)
GET     /agents/:agentId/replies                         long-poll claim (next reply)
GET     /agents/:agentId/replies/peek                    non-destructive snapshot
GET     /agents/:agentId/replies/stream                  SSE push notifications
GET     /agents/:agentId/replies/:taskId                 reply detail
POST    /agents/:agentId/replies/:taskId/ack             clear in-flight state
```

Proof-of-possession operations (authorised by signature, not bearer token):

```
GET     /admin/tenants/:id/nonces?did=&agentId=                 request single-use nonce
POST    /admin/tenants/:id/agents/:agentId/rotate-key           rotate keypair (PoP-signed with old key)
```

Note: Nova dropped the notary-model UCAN endpoints (`/ucans/renew`,
`/ucans/request`) when the delegation-chain model landed. Senders mint
invocation tokens locally with their own Ed25519 key; the approval grant
is the only Nova-signed UCAN in the chain, and grant renewal is operator-
gated via `/agents/:agentId/ucans/reissue`.

---

## Architecture & specs

Three spec documents define the contract. Read them before altering
protocol-facing code:

- **`nova-overview.md`** — design motivation, high-level constraints, the
  A2A / MCP / Nova three-way distinction
- **`nova-protocol-spec.md`** — external wire protocol: agent cards, UCAN,
  task submission, gate error codes, the closed-intent model
- **`nova-platform-spec.md`** — internal architecture: gate layers, BullMQ,
  tenant/Redis isolation, admin API schemas

---

## Running Nova

### Docker Compose (dev)

```bash
docker compose up -d                 # redis, a2a-server, gate-service, agent-connector, admin-api, caddy
docker compose logs -f a2a-server
docker compose down
```

To run a broker-mode receiver, use the `@nova/broker-receiver` daemon
alongside (or in place of) an A2A webhook receiver — it runs outside
compose under launchd/systemd. See the broker-receiver package for
install templates and handler configuration.

### Local processes (hot-reload)

```bash
npm install
npm run generate:keys                # one-time
npm run --workspace=@nova/admin-api dev
npm run --workspace=@nova/a2a-server dev
npm run --workspace=@nova/agent-connector dev
```

### Enterprise key management

`generate-keys.ts` writes Nova's private key to the `NOVA_KEY_DIR` (which defaults to `data/keys/nova.private.pem`).
For multi-node deployments, generate in an external vault (AWS KMS,
HashiCorp Vault) and load via environment variables at boot — do not rely
on local PEM files.

---

## Testing

```bash
npm test                                    # unit tests (vitest)

# Core milestones
npm run test:acceptance                     # M1 — basic pipeline
npm run test:acceptance:m2                  # M2 — gate pipeline
npm run test:acceptance:m3                  # M3 — admin API surface
npm run test:acceptance:m4                  # M4 — MCP onboarding (invite → approve → claim → discover)
npm run test:acceptance:m5                  # M5 — trust registry + cross-tenant send

# Broker mode (pull-based receive / reply)
npm run test:acceptance:broker              # receive flow (next_task → respond)
npm run test:acceptance:broker-reply        # sender-side reply collection (next_reply → ack)
npm run test:acceptance:broker-receiver     # supervised daemon end-to-end

# MCP push subscriptions
npm run test:acceptance:mcp-push            # inbox push (nova://inbox)
npm run test:acceptance:mcp-replies-push    # replies push (nova://replies)

# Security hardening (P2 block)
npm run test:acceptance:p2.7                # key rotation
npm run test:acceptance:p2.8                # keychain backend
npm run test:acceptance:p2.9                # opportunistic status check

# Regressions
npm run test:acceptance:invite-whitespace   # invite whitespace tolerance
```

Acceptance tests require Redis, admin-api (`:3005`), and a2a-server
(`:3001`) running, and `ADMIN_TOKEN` set (default `nova-admin-dev-token`).
Broker tests additionally exercise `/inbox/stream` / `/replies/stream`
SSE, so gate-service and agent-connector must also be up.

---

## Key-management script summary

| Script | Purpose |
|---|---|
| `npm run generate:keys` | Bootstrap Nova's gateway Ed25519 keypair |
| `npm run rotate:keys` | Rotate gateway keys |
| `npm run seed-tenant` | Seed a test tenant for local dev |
| `npm run revoke:ucan` | Revoke a UCAN by CID |

---

## Security model — one-line summary

**Every task submitted to Nova is authenticated (UCAN), authorized (trust
tier + capability match), validated (schema), and screened (injection gate)
before it reaches a destination agent.** Tenants cannot see each other's
audit logs, task queues, or trust registries. Agent identities are DID-based
and client-generated; Nova never holds private keys for registered agents.
