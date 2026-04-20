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
  carries a narrow UCAN scoped to the destination; Nova's gate verifies it
  before the destination agent sees anything.

There are two kinds of agents:

| Role | What they do | How they connect |
|---|---|---|
| **Sender** | Originates tasks (your Claude Code asking the bookstore for a price quote) | Uses `@nova/mcp-server` — no HTTP endpoint needed |
| **Receiver** | Accepts delivered tasks from Nova (the bookstore's order agent) | Hosts an A2A operator webhook per `nova-protocol-spec.md §7` |

Most runtimes are senders. Receivers are the services you're invoking.

---

## Quick start

### 1. Run Nova locally

```bash
npm install
npm run generate:keys        # Ed25519 keypair for the gateway
docker compose up -d         # a2a-server :3001, admin-api :3005, redis :6379
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

Point any MCP-native runtime at `@nova/mcp-server` and run the `/nova_onboard`
prompt. See [MCP integration](#mcp-integration) below for per-runtime config.

---

## MCP integration

`@nova/mcp-server` is the universal on-ramp. It turns every Nova operation
into a typed MCP tool so your existing AI runtime can register, discover, and
send tasks without speaking A2A directly.

### Tools exposed

```
nova_generate_identity     Ed25519 keypair + DID, stored at ~/.nova/agents/
nova_whoami                active identity, tenant, UCAN status
nova_accept_invite         decode and save an invite JWT
nova_register_agent        POST /register (consumes the invite)
nova_check_registration    poll until operator approves, claim UCAN
nova_renew_ucan            force UCAN refresh
nova_ucan_status           cache inspection
nova_list_agents           discovery across all galaxies
nova_get_agent_card        skill schemas for a specific agent
nova_send_task             acquires per-destination UCAN + POSTs task
nova_get_task_result       poll task state
nova_create_tenant         operator-only (needs NOVA_ADMIN_TOKEN)
nova_create_invite         operator-only
```

Resources: `nova://agents`, `nova://agents/{agentId}/card`
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

Register as a community skill backed by this MCP server, or use OpenClaw's
generic MCP client with `NOVA_AGENT_ID=openclaw`.

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
    # Under the hood: MCP server does proof-of-possession to mint a UCAN
    # narrowed to nova:tenant_dads:bookstore:skill:quote_book, caches it,
    # POSTs the task with UCAN header. Nova gate validates, queues,
    # delivers to bookstore operator webhook.
    → { taskId: "uuid", statusUrl: "...", streamUrl: "..." }
  nova_get_task_result({ targetAgentId: "bookstore", taskId: "uuid" })
    → { status: "completed", result: { price: "$18", condition: "good", ... } }
```

The second time Claude Code sends to the bookstore, the cached UCAN is
reused — no round trip to mint a new one until it drops below 20% lifetime.

---

## Monorepo layout

| Package | Purpose |
|---|---|
| `@nova/shared` | Zod schemas, tenant/error types, Redis helpers, invite JWT service |
| `@nova/a2a-server` | Wire-protocol ingestion, `POST /register`, `GET /register/status`, task submission, agent cards |
| `@nova/gate-service` | Five-layer gate pipeline: trust tier, UCAN, schema, injection patterns, classifier |
| `@nova/task-queue` | BullMQ queues backing async task ingress |
| `@nova/agent-connector` | Workers that deliver approved tasks to destination operator webhooks |
| `@nova/admin-api` | Operator-only admin endpoints: tenants, agents, trust registry, invites, UCAN issuance, audit, SSE `/admin/events` |
| `@nova/mcp-server` | **MCP on-ramp for AI runtimes.** stdio MCP server exposing Nova operations as typed tools |
| `@nova/operator-mock` | Test receiver for acceptance tests |

---

## Admin API surface

Operator endpoints (require `Authorization: Bearer $ADMIN_TOKEN`):

```
POST    /admin/tenants                              create a galaxy
GET     /admin/tenants                              list galaxies
GET     /admin/tenants/:id                          tenant detail
POST    /admin/tenants/:id/invites                  mint invite JWT (one-time)
POST    /admin/tenants/:id/agents/:agentId/approve  approve pending agent + issue UCAN
POST    /admin/tenants/:id/agents/:agentId/reject   reject pending agent
GET     /admin/tenants/:id/audit                    audit events
GET     /admin/events                               SSE stream: tenant/agent/task lifecycle
...
```

Public endpoints on the a2a-server (no auth):

```
POST    /register                                   self-register (invite required)
GET     /register/status/:tenantId/:agentId         poll approval, claim UCAN
GET     /discover                                   list active agents
GET     /agents/:agentId/.well-known/agent.json     A2A agent card
POST    /agents/:agentId/tasks                      task submission (UCAN required)
GET     /agents/:agentId/tasks/:taskId              task status
```

Proof-of-possession UCAN operations (no admin auth, self-signed nonce):

```
GET     /admin/tenants/:id/ucans/renew?did=&agentId=  request nonce
POST    /admin/tenants/:id/ucans/renew                submit signed nonce, receive fresh UCAN
POST    /admin/tenants/:id/ucans/request              request destination-scoped UCAN
```

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
docker compose up -d                 # a2a-server, admin-api, agent-connector, redis
docker compose logs -f a2a-server
docker compose down
```

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
npm test                             # unit tests (vitest)
npm run test:acceptance              # milestone 1: basic pipeline
npm run test:acceptance:m2           # milestone 2: gate pipeline
npm run test:acceptance:m3           # milestone 3: admin API surface
npm run test:acceptance:m4           # milestone 4: MCP onboarding (invite → approve → claim → discover)
```

Acceptance tests require Redis, admin-api (`:3005`), and a2a-server
(`:3001`) running, and `ADMIN_TOKEN` set (default `nova-admin-dev-token`).

---

## Key-management script summary

| Script | Purpose |
|---|---|
| `npm run generate:keys` | Bootstrap Nova's gateway Ed25519 keypair |
| `npm run rotate:keys` | Rotate gateway keys |
| `npm run seed-tenant` | Seed a test tenant for local dev |
| `npm run issue:ucan` | Manually issue a UCAN for debugging |
| `npm run revoke:ucan` | Revoke a UCAN by CID |

---

## Security model — one-line summary

**Every task submitted to Nova is authenticated (UCAN), authorized (trust
tier + capability match), validated (schema), and screened (injection gate)
before it reaches a destination agent.** Tenants cannot see each other's
audit logs, task queues, or trust registries. Agent identities are DID-based
and client-generated; Nova never holds private keys for registered agents.
