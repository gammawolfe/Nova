# Nova

**A zero-trust gateway for agent-to-agent communication.** Any AI runtime —
Claude Code, Cursor, Hermes, OpenClaw, custom agents — joins a Nova network
and can then discover peers and send tasks through a hardened capability-based
pipeline instead of unauthenticated JSON APIs.

Nova implements a native brokered agent-communication protocol with UCAN-based
capabilities, a five-layer gate for auth and injection defense, and an
**MCP on-ramp** (`@nova/mcp-server`) so any MCP-native AI runtime can onboard
without learning Nova HTTP, Redis, or UCAN internals.

Nova borrows useful A2A concepts such as agent cards, skills, task lifecycle,
streaming, and push notifications, but it is **not currently an A2A-compliant
wire implementation**. Nova's native model is brokered, capability-scoped, and
supports inbox-based receivers behind NAT or on personal devices. A future A2A
adapter can sit beside the native protocol for ecosystem interop.

---

## Contents

- [Mental model](#mental-model)
- [Quick start](#quick-start)
- [MCP integration](#mcp-integration) — [tools exposed](#tools-exposed), per-runtime config
- [End-to-end example](#end-to-end-example)
- [Monorepo layout](#monorepo-layout)
- [API surface](#api-surface) — full reference in [`docs/admin-api.md`](docs/admin-api.md)
- [Architecture & specs](#architecture--specs)
- [Running Nova](#running-nova)
- [Testing](#testing)
- [Key-management scripts](#key-management-script-summary)
- [Security model](#security-model--one-line-summary)

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
| **Webhook receiver** | Accepts tasks via push to a hosted endpoint (the bookstore's order agent) | Hosts a Nova operator webhook per `nova-protocol-spec.md §7` |
| **Broker receiver** | Accepts tasks via pull — no inbound HTTP, suitable for MCP-native runtimes and headless daemons | Runs `@nova/broker-receiver` (supervised daemon) or pulls interactively via `nova_inbox({action:"next"})` from `@nova/mcp-server` |

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
export ADMIN_TOKEN="$(openssl rand -hex 32)"  # or put this in .env
docker compose up -d         # redis :6379, a2a-server :3001, gate-service, agent-connector, admin-api :3005, caddy :80/:8443
```

### 2. Create your galaxy and mint an invite

Via the admin UI at `http://localhost:3005/`, or directly:

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

Codex-specific note: when a Codex session is asked to onboard itself, it should
register as a **broker-mode sender + receiver** by default, with real skills
such as `answer_code_question` and `review_code`. Do not register Codex as
`__sender_only` unless the operator explicitly asks for a send-only agent. The
exact Codex recipe is in
[`docs/agent-onboarding.md#9-codex-broker-mode-onboarding-recipe`](docs/agent-onboarding.md#9-codex-broker-mode-onboarding-recipe).

---

## MCP integration

`@nova/mcp-server` is the universal on-ramp. It turns every Nova operation
into a typed MCP tool so your existing AI runtime can register, discover, and
send tasks without speaking the native Nova HTTP protocol directly.

Build the MCP server before pointing an MCP client at `dist/index.js`:

```bash
npm run build
# or just:
npx tsc --build packages/mcp-server
```

### Tools exposed

The surface is 7 tools, each taking a required `action` plus action-specific
params (e.g. `nova_task({action:"send", targetAgentId, intent, params})`).

```
nova_identity   action: generate | whoami | rotate_key | grant_status
                  identity + approval-grant status. generate = Ed25519 keypair + DID
                  (~/.nova/agents/); rotate_key = PoP-signed key swap; grant_status
                  reports cid/expiry/lifetime (renewal is operator-gated).

nova_onboard    action: inspect_invite | accept_invite | register | check_status
                  invite-driven join + registration. inspect_invite decodes locally;
                  accept_invite verifies + saves the tenant; register POSTs /register;
                  check_status polls approval and claims the one-time grant.

nova_discover   action: list | card
                  list = discovery across all galaxies (skill substring filter);
                  card = full skill schemas for one agent (use before send).

nova_task       action: send | result | watch | unwatch
                  send mints an invocation token locally + POSTs the task; result
                  returns the broker reply or falls back to task state; watch/unwatch
                  push for nova://tasks/{taskId}.

nova_inbox      action: next | respond | watch | unwatch
                  broker-mode receive (no webhook). next long-polls + claims with 5-min
                  visibility; respond ships the TaskResult; watch/unwatch push for
                  nova://inbox.

nova_replies    action: next | ack | watch | unwatch
                  broker-mode sender reply collection. next long-polls a TaskResult;
                  ack clears in-flight state; watch/unwatch push for nova://replies.

nova_admin      action: create_tenant | create_invite | reissue_grant   (NOVA_ADMIN_TOKEN)
                  create a galaxy; mint an invite JWT; regenerate an approval grant
                  after the claim window lapsed.
```

The `watch`/`unwatch` actions are fallbacks for clients that can't speak MCP
`resources/subscribe` — clients that can should use the subscribable resources
directly and ignore them.

Setting `NOVA_MCP_LEGACY_TOOLS=1` additionally exposes the original
one-tool-per-operation surface (`nova_generate_identity`, `nova_send_task`, …)
for back-compat with scripts that hardcode the old names. Off by default; the
consolidated surface above is the supported path.

Resources: `nova://agents`, `nova://agents/{agentId}/card`, `nova://inbox`
(subscribable), `nova://replies` (subscribable), `nova://tasks/{taskId}`
(subscribable).
Prompts: `/nova_onboard`, `/nova_first_task`, `/nova_serve`

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
  nova_identity({ action: "generate", agentId: "claude-code" })
    → did:key:z6Mk7H...
  # (You paste the invite JWT from the admin UI)
  nova_onboard({ action: "accept_invite", invite: "eyJhbGc..." })
    → { tenantId: "tenant_abc", agentIdHint: "claude-code" }
  nova_onboard({
    action: "register",
    agentId: "claude-code",
    name: "My Claude Code",
    skills: [{ id: "__sender_only", name: "Sender only", description: "sends tasks only" }],
    invite: "eyJhbGc..."
  })
    → { status: "pending", statusUrl: "/register/status/tenant_abc/claude-code" }
  # (Operator approves in admin UI)
  nova_onboard({ action: "check_status" })
    → { status: "active", claimed: true, trustTier: 2, grantExpiresAt: "..." }

> find me a used copy of "Ficciones" by Borges and quote me a price

Claude calls:
  nova_discover({ action: "list", skills: "book" })
    → [{ agentId: "bookstore", tenantId: "tenant_dads", skills: [{ id: "quote_book", ... }] }]
  nova_discover({ action: "card", agentId: "bookstore" })
    → inputSchema for quote_book: { title: string, author: string, condition: enum }
  nova_task({
    action: "send",
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
  nova_task({ action: "result", targetAgentId: "bookstore", taskId: "uuid" })
    → { status: "completed", result: { price: "$18", condition: "good", ... } }
```

Every send mints a fresh invocation token locally — there is no per-
destination cache and no round trip to Nova to get one. The credential that
*is* cached is the long-lived approval grant that backs those tokens; when it
nears expiry the operator runs `nova_admin({ action: "reissue_grant" })` and the
agent picks up the fresh grant on its next `nova_onboard({ action: "check_status" })`.

---

## Monorepo layout

| Package | Purpose |
|---|---|
| `@nova/shared` | Zod schemas, tenant/error types, Redis helpers, invite JWT service |
| `@nova/a2a-server` | Nova HTTP ingress, `POST /register`, `GET /register/status`, task submission, discovery, broker inboxes, reply inboxes, agent cards |
| `@nova/gate-service` | Five-layer gate pipeline: trust tier, UCAN, schema, injection patterns, classifier |
| `@nova/task-queue` | BullMQ queues backing async task ingress |
| `@nova/agent-connector` | Workers that deliver approved tasks to destination operator webhooks (push mode) or into the broker inbox (pull mode) |
| `@nova/broker-receiver` | Supervised daemon for broker-mode receivers — holds its own identity + approval grant, subscribes to `/inbox/stream`, runs pluggable handlers (`echo`, `claude-api`, …), ships with launchd/systemd templates |
| `@nova/admin-api` | Operator-only admin endpoints: tenants, agents, trust registry, invites, UCAN issuance + reissue + rotate-key, quarantine, dead-letter, audit, SSE `/admin/events` |
| `@nova/mcp-server` | **MCP on-ramp for AI runtimes.** stdio MCP server exposing Nova operations as 7 consolidated, action-based tools, plus subscribable resources (`nova://inbox`, `nova://replies`, `nova://tasks/{id}`) for push notifications |
| `@nova/cli` | Operator CLI (`nova` binary) — scriptable access to tenant/agent/invite operations; builds to a standalone executable via `npm run cli:build` (macOS arm64/x64, Linux, Windows) |
| `@nova/operator-mock` | Test receiver for acceptance tests |

---

## API surface

Two HTTP surfaces, documented in full in **[`docs/admin-api.md`](docs/admin-api.md)**:

- **Operator admin API** (`@nova/admin-api`, `Authorization: Bearer $ADMIN_TOKEN`) —
  tenants & invites, agent approval/rejection/deregistration, trust registry,
  UCAN issuance + reissue, quarantine, dead-letter, the confirmation queue for
  high-privilege operations, audit, the `/admin/events` SSE lifecycle stream,
  broker summary, and federation grants.
- **Public & agent-authenticated server** (`@nova/a2a-server`, no admin bearer) —
  `/register` + `/register/status`, `/discover`, agent cards, task submission +
  status + SSE stream, the broker inbox and reply-inbox endpoints (long-poll,
  peek, stream, respond/ack), and proof-of-possession key rotation.

Most operators never call these directly — the admin UI and `@nova/mcp-server`
sit in front of them. Reach for the reference when scripting against Nova or
building a new client.

> **Note:** Nova dropped the notary-model UCAN endpoints (`/ucans/renew`,
> `/ucans/request`) when the delegation-chain model landed. Senders mint
> invocation tokens locally with their own Ed25519 key; the approval grant is
> the only Nova-signed UCAN in the chain, and grant renewal is operator-gated
> via `/agents/:agentId/ucans/reissue`.

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
export ADMIN_TOKEN="$(openssl rand -hex 32)"  # or use the same value from .env
docker compose up -d                 # redis, a2a-server, gate-service, agent-connector, admin-api, caddy
docker compose logs -f a2a-server
docker compose down
```

To run a broker-mode receiver, use the `@nova/broker-receiver` daemon
alongside (or in place of) a Nova webhook receiver — it runs outside
compose under launchd/systemd. See the broker-receiver package for
install templates and handler configuration.

For an unattended local Codex receiver backed by live `codex exec` output,
create a broker-receiver config with `handlerConfig.mode: "receiver-policy"`,
`policy.defaultAction: "deny"`, and explicit sender/intent allow rules, then
run:

```bash
npm run broker-receiver:dev -- run \
  --agent-id codex \
  --handler codex-cli \
  --health-port 9902
```

That process is what makes broker-mode receive/reply automatic. The MCP
`nova_inbox` actions (`watch` / `next` / `respond`) are interactive; they do not
run unless the MCP host is awake and invoking them.

### Local processes (hot-reload)

```bash
npm install
npm run generate:keys                # one-time
docker compose up -d redis           # or provide REDIS_URL to another Redis

# Run these in separate shells:
REDIS_URL=redis://127.0.0.1:6379 DATA_ROOT=data GATE_PORT=3002 \
  npx tsx packages/gate-service/src/server.ts

REDIS_URL=redis://127.0.0.1:6379 DATA_ROOT=data PORT=3005 \
  A2A_HEALTH_URL=http://127.0.0.1:3001/health \
  GATE_HEALTH_URL=http://127.0.0.1:3002/health \
  CONNECTOR_HEALTH_URL=http://127.0.0.1:3003/health \
  ADMIN_TOKEN="$ADMIN_TOKEN" \
  npm run --workspace=@nova/admin-api dev

REDIS_URL=redis://127.0.0.1:6379 DATA_ROOT=data PORT=3001 \
  npm run --workspace=@nova/a2a-server dev

REDIS_URL=redis://127.0.0.1:6379 DATA_ROOT=data HEALTH_PORT=3003 \
  npm run --workspace=@nova/agent-connector dev
```

### Enterprise key management

`generate-keys.ts` writes Nova's private key under `NOVA_KEY_DIR`, which
defaults to `data/keys/nova.private.pem` via `DATA_ROOT/keys`. At runtime the
a2a-server reads `NOVA_PRIVATE_KEY_PATH` if set, otherwise
`$NOVA_KEY_DIR/nova.private.pem`. The loader accepts canonical PKCS8 PEM and
legacy 64-byte base64 keys.

For multi-node deployments, mount or provision the key material from an
external secret manager or vault into those file paths. Do not put private key
material directly in environment variables; the current implementation reads
keys from files.

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
(`:3001`) running, and `ADMIN_TOKEN` set to a value of at least 32 characters.
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
