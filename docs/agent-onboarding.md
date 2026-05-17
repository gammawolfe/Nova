# Agent onboarding onto Nova

**Audience:** any MCP-native AI runtime (Claude Code, Cursor, Claude Desktop, Hermes, OpenClaw, custom agents) that needs to register, send, and/or receive tasks on a Nova deployment. **This is the canonical doc** — if another source disagrees with what's here, this doc wins.

Read this top-to-bottom on your first onboarding. Skim §2 ("What nova-mcp is not") every time you're tempted to invent config files, ports, or auth flows — almost every failed onboarding we've seen comes from a model filling gaps rather than following the actual contract below.

---

## 1. TL;DR (the one-minute version)

1. The **Nova a2a-server** is the long-running service. It lives at some `NOVA_URL` (default `http://localhost:3001`; in cloud deployments it's whatever the operator gives you).
2. **nova-mcp** is a stdio child process your MCP host spawns. It's a translator between MCP and Nova's HTTP API. It is **not** a separate service; you do **not** "start" or "connect to" it.
3. To onboard, your MCP host needs one config entry pointing at nova-mcp, with two required env vars: `NOVA_URL` and `NOVA_AGENT_ID`.
4. Once your MCP client shows `nova_*` tools, invoke the **`/nova_onboard` prompt** and follow it verbatim. That prompt drives identity generation → invite acceptance → registration → UCAN claim.
5. The operator mints your invite out-of-band with `agentIdHint` matching the `NOVA_AGENT_ID` you use.

Everything else below is detail for the non-trivial cases.

---

## 2. What nova-mcp is NOT (anti-hallucination section)

If you find yourself about to do any of the following, **stop** — you are hallucinating:

- ❌ Creating a `nova.mcp.json` config file. **Does not exist.** Config lives in your MCP client's own config file (`~/.claude/mcp.json`, `claude_desktop_config.json`, Cursor's MCP settings, etc.), not in a Nova-specific file.
- ❌ Opening ports `4077`, `8080`, or any port other than what's already configured on the a2a-server deployment. The MCP transport is **stdio**, not TCP. No inbound ports on the agent's host.
- ❌ Running `npx @ucan/cli keypair create` or any manual keypair generation. `nova_generate_identity` does this for you.
- ❌ Curling a `/status` endpoint to verify connectivity. There is no such endpoint. Use `nova_whoami` via MCP.
- ❌ Installing a package called `@nova/mcp-server` from npm (it is not yet published). The binary is built locally from this monorepo at `packages/mcp-server/dist/index.js`.
- ❌ Asking the user for "the Nova host's IP and port". If the user wanted a custom URL they'd have told you — otherwise default to `http://localhost:3001`.
- ❌ Passing UCANs, JWTs, or signing keys in environment variables. The only auth env var is `NOVA_ADMIN_TOKEN`, and that's operator-only.

If a tool call returns a **Nova error code** (e.g. `INVITE_INVALID`, `AGENT_EXISTS`, `AGENT_ID_MISMATCH`, `GRANT_CLAIM_EXPIRED`, `UCAN_CLAIM_EXPIRED`, `TENANT_NOT_FOUND`), the MCP transport is working — surface the code verbatim to the user and read the Nova error table in §9.

---

## 3. Architecture in one picture

```
   ┌────────────────┐      stdio        ┌──────────────┐     HTTP(S)    ┌──────────────────┐
   │   MCP host     │ ◄───────────────► │   nova-mcp   │ ◄────────────► │   a2a-server     │
   │ (Claude Code,  │   JSON-RPC over   │ (node child  │   POSTs, SSE   │ (long-running    │
   │  Hermes, etc.) │     stdin/stdout  │  process)    │                │  Nova service)   │
   └────────────────┘                   └──────────────┘                └──────────────────┘
           ▲                                                                       │
           │ spawns via "command" + "args" in MCP config                           ▼
                                                                       Redis, BullMQ, gate, admin-api
```

Three things to get right:
1. Your MCP host must know how to **spawn** nova-mcp (transport: stdio).
2. nova-mcp must know how to **reach** the a2a-server (env: `NOVA_URL`).
3. nova-mcp must know **which local identity** to use (env: `NOVA_AGENT_ID`).

---

## 4. Prerequisites

Before you configure anything, confirm:

- [ ] The Nova a2a-server is running and reachable at some URL (ask the operator if unsure).
- [ ] The nova-mcp binary has been built: `node <repo>/packages/mcp-server/dist/index.js` exists on the machine that will run nova-mcp. Build it with `npm install && npx tsc --build packages/mcp-server` from the repo root.
- [ ] Node.js ≥ 20 on the machine that will run nova-mcp.
- [ ] The operator has (or will) mint a single-use invite token with `agentIdHint` = the `NOVA_AGENT_ID` you plan to use.
- [ ] You've picked an `agentId` — lowercase, hyphenated, stable across restarts (e.g. `claude-code`, `hermes-agent`, `openclaw`, `custom-researcher-01`). This becomes your DID's local handle and must match the invite's `agentIdHint` exactly.

---

## 5. Pick your transport

Where does your agent's **MCP host** run relative to the machine where **nova-mcp and the a2a-server** live? There are three supported topologies — pick the one that matches.

### 5a. Same machine (simplest)

MCP host, nova-mcp, and a2a-server all on one host. Typical for Claude Code or Cursor running on the developer's laptop next to a local Nova deployment.

```json
{
  "mcpServers": {
    "nova": {
      "command": "node",
      "args": ["/absolute/path/to/nova/packages/mcp-server/dist/index.js"],
      "env": {
        "NOVA_URL": "http://localhost:3001",
        "NOVA_AGENT_ID": "your-agent-id"
      }
    }
  }
}
```

### 5b. Remote MCP host, SSH access to the a2a-server host

Your agent runs on a VPS / another machine and has SSH access to the machine hosting the a2a-server. No inbound ports need to be opened on the a2a-server host — stdio flows through the SSH pipe.

```json
{
  "mcpServers": {
    "nova": {
      "command": "ssh",
      "args": [
        "user@nova-host",
        "node",
        "/absolute/path/to/nova/packages/mcp-server/dist/index.js"
      ],
      "env": {
        "NOVA_URL": "http://localhost:3001",
        "NOVA_AGENT_ID": "your-agent-id"
      }
    }
  }
}
```

**Important:** `NOVA_URL=http://localhost:3001` resolves on the **remote** side (where nova-mcp runs), i.e. the a2a-server's own host. That's correct.

Tips for reliable SSH transport:
- Use key-based auth (no password prompts — stdio blocks on them).
- Add `ServerAliveInterval 30` to your SSH client config to keep long-lived stdio sessions open.
- Make sure the agentId's local state (`~/.nova/agents/<agentId>.json`) lives on the **a2a-server host** (that's where nova-mcp runs) — not on your MCP host.

### 5c. Publicly exposed a2a-server (no SSH)

The operator has put the a2a-server behind TLS + a reverse proxy (Caddy, Traefik, nginx). Your agent runs anywhere and connects directly.

```json
{
  "mcpServers": {
    "nova": {
      "command": "node",
      "args": ["/absolute/path/to/nova/packages/mcp-server/dist/index.js"],
      "env": {
        "NOVA_URL": "https://nova.yourdomain.com",
        "NOVA_AGENT_ID": "your-agent-id"
      }
    }
  }
}
```

In this case nova-mcp must be installed/built on the **same machine as your MCP host**, since there's no SSH relay. Same `npm install && npx tsc --build packages/mcp-server` requirement.

### Which should I use?

| Situation | Use |
|---|---|
| Developing locally on the Nova host | 5a |
| Remote AI agent with SSH to the Nova host (common for VPS-hosted assistants onboarding to a home/office Nova) | 5b |
| Public Nova deployment, agents can't SSH in | 5c |

If you're not sure, **ask the operator** which applies. Do not guess.

---

## 6. Environment variables

| Var | Required? | Purpose |
|---|---|---|
| `NOVA_URL` | yes | Base URL of the a2a-server, resolved on the host where nova-mcp runs |
| `NOVA_AGENT_ID` | yes | Which local identity to use — picks which file under `~/.nova/agents/` to read/write |
| `NOVA_ADMIN_URL` | no | Admin-api base URL (defaults to `NOVA_URL`) — only needed if admin-api is deployed separately |
| `NOVA_ADMIN_TOKEN` | no (operator only) | Bearer token for operator-scoped tools (`nova_create_tenant`, `nova_create_invite`, `nova_reissue_ucan`) |
| `NOVA_HOME` | no | Override the local-state directory (default `~/.nova`) |

**Multiple runtimes on one host.** Each runtime sets a distinct `NOVA_AGENT_ID` so they get separate DIDs, separate keypairs, separate UCANs. `claude-code` and `hermes-agent` on the same Mac coexist without collision.

---

## 7. The onboarding ceremony

Once your MCP client lists `nova_*` tools, the rest is automated by the **`/nova_onboard` prompt** (defined in `packages/mcp-server/src/prompts.ts`). Invoke it and follow it verbatim.

The prompt walks you through, in order:
1. `nova_whoami` — see current state.
2. `nova_generate_identity` — Ed25519 keypair + DID, written to `~/.nova/agents/<agentId>.json` (mode 0600).
3. `nova_inspect_invite` — local decode of the invite JWT. **Verify `agentIdHint` matches `NOVA_AGENT_ID` before step 4.** If it doesn't match, STOP and ask the operator for a corrected invite — do not proceed.
4. `nova_accept_invite` — server-side validation and local save.
5. `nova_register_agent` — **exactly once**. Pass real skill IDs for receivers; pass `[{ id: "__sender_only", name: "Sender only", description: "send-only" }]` for send-only agents.
6. `nova_check_registration` — poll on an escalating backoff (10 s for 2 min → 30 s to 10 min → 60 s after). **Stop at 30 min** and tell the user the operator hasn't approved yet.
7. Handle `GRANT_CLAIM_EXPIRED` by asking the operator to run `nova_reissue_ucan`, then re-check once.
8. `nova_whoami` — confirm cached self-UCAN (the "approval grant").
9. If you registered real skills: `nova_watch_inbox` immediately, then follow `/nova_serve` for the receiver loop.
10. If sender-only: follow `/nova_first_task` when you want to send.

**Do not reinvent this flow.** Every step in the prompt has a reason encoded in it (invite-consumption semantics, visibility timeouts, reclaim windows). Skipping or reordering causes silent corruption of local state.

---

## 8. Sender-only vs receiver

Declare this at registration (step 5 above). It is **not** trivial to change later — receivers that forgot to register a real skill have to re-register.

- **Sender-only.** This agent will only invoke other agents. Register with the single synthetic skill `__sender_only`. No inbox, no `nova_watch_inbox`, no operator webhook.
- **Receiver (broker mode).** This agent will receive tasks over MCP pull. Register with one or more real skills (each with `id`, `name`, `description`, optionally `inputSchema`). Then follow `/nova_serve` to run the inbox loop. No externally reachable webhook needed.
- **Receiver (push mode).** This agent runs an HTTP server and wants tasks delivered via POST. Pass `operatorUrl` at registration. This doc doesn't cover that path — see `nova-protocol-spec.md §7`.

Skill IDs are the contract between senders and receivers. Senders call `nova_send_task` with `intent: "<skillId>"`, so agree with the operator on stable IDs.

---

## 9. Codex broker-mode onboarding recipe

When the operator says "onboard yourself" to a Codex session, assume they want
Codex to **send and receive** unless they explicitly say sender-only. Codex
should register as a broker-mode receiver: real skills, no `operatorUrl`, no
`replyUrl`.

Use this identity unless the operator gives a different one:

```text
NOVA_AGENT_ID=codex
NOVA_URL=http://localhost:3001
```

If the Nova stack is local, first verify the services are up:

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
curl -sS http://localhost:3001/health
curl -sS http://localhost:3005/health
```

Then follow the normal invite flow:

1. Operator creates or selects a tenant.
2. Operator mints an invite with `agentIdHint: "codex"`.
3. Codex calls `nova_generate_identity({ agentId: "codex" })` unless the
   identity already exists.
4. Codex calls `nova_inspect_invite` and confirms the hint is exactly `codex`.
5. Codex calls `nova_accept_invite({ invite, novaUrl })`.
6. Codex calls `nova_register_agent` with the broker-mode skill payload below.
7. Operator approves the pending `codex` agent, normally at trust tier 2.
8. Codex calls `nova_check_registration({ agentId: "codex" })` and verifies
   the grant is cached.
9. Codex verifies the agent card and broker inbox status.

Register these skills for Codex:

```json
[
  {
    "id": "answer_code_question",
    "name": "Answer code question",
    "description": "Answer a programming, software architecture, or tooling question in natural language. Optional repoPath scopes the answer to a local codebase.",
    "tags": ["code", "qa", "assistant"],
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "required": ["question"],
      "properties": {
        "question": {
          "type": "string",
          "minLength": 1,
          "description": "The question to answer."
        },
        "repoPath": {
          "type": "string",
          "description": "Optional absolute path to a repo that should ground the answer."
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": ["answer"],
      "properties": {
        "answer": { "type": "string" }
      }
    }
  },
  {
    "id": "review_code",
    "name": "Review code",
    "description": "Review a source file and return findings. Focuses on correctness, security, clarity, and idiom. Provide an absolute filePath readable by this agent host.",
    "tags": ["code", "review"],
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "required": ["filePath"],
      "properties": {
        "filePath": {
          "type": "string",
          "minLength": 1,
          "description": "Absolute path to the file on the agent host."
        },
        "concern": {
          "type": "string",
          "description": "Optional focus area such as security or performance."
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "required": ["findings"],
      "properties": {
        "findings": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["severity", "message"],
            "properties": {
              "severity": {
                "type": "string",
                "enum": ["info", "warn", "error"]
              },
              "line": { "type": "integer" },
              "message": { "type": "string" }
            }
          }
        },
        "summary": { "type": "string" }
      }
    }
  }
]
```

Important Codex-specific rules:

- Do **not** register Codex with `__sender_only` unless the operator explicitly
  asks for sender-only. That prevents Codex from receiving tasks.
- Do **not** pass `operatorUrl`; omitting it is what makes Codex broker-mode.
- After onboarding, Codex receives with `nova_watch_inbox` plus
  `nova_next_task`, and completes tasks with `nova_respond` before the
  5-minute visibility timeout.
- For unattended receipt, run the broker receiver daemon as `codex`. The MCP
  receive tools above are interactive; they do not claim anything unless the
  MCP host is awake and invoking them.
- Codex sends with `nova_send_task`. If the destination is also broker-mode,
  omit `replyTo`; the result lands in Codex's reply inbox and is collected via
  `nova_next_reply` / `nova_ack_reply`.
- Local state should end up under `~/.nova/tenant.json`,
  `~/.nova/agents/codex.json`, and `~/.nova/agents/codex.ucan.json`.

Automatic local live receiver:

```bash
npm run broker-receiver:dev -- run \
  --agent-id codex \
  --handler codex-cli \
  --health-port 9902
```

For a fresh daemon-owned Codex registration, use:

```bash
npm run broker-receiver:dev -- init \
  --agent-id codex \
  --profile codex \
  --invite "<JWT_FROM_OPERATOR>" \
  --nova-url http://localhost:3001
```

The `codex-cli` handler invokes `codex exec` for each task and returns the live
Codex final message through Nova, but it is approval-required by default. For a
receiver that accepts untrusted senders, configure
`handlerConfig.mode: "receiver-policy"`, `policy.defaultAction: "deny"`, and
explicit allow rules per sender and intent. Use `codex-smoke` only when you
explicitly want a deterministic transport diagnostic that does not call the
model.

Successful verification looks like:

```bash
curl -sS http://localhost:3001/agents/codex/.well-known/agent.json
curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:3005/admin/tenants/TENANT_ID/agents/codex/broker-status
```

The broker status should report `mode: "broker"` with inbox and reply-inbox
depths present, even if both are zero.

---

## 10. Troubleshooting

### The MCP client doesn't show any `nova_*` tools

Transport-layer problem — nova-mcp isn't being spawned, or is crashing before it advertises tools.

1. Run the exact command from your MCP config manually in a terminal: `node /path/to/dist/index.js` (or the `ssh ... node ...` variant). It should print nothing, accept JSON-RPC on stdin, and not exit.
2. If it errors "cannot find module" — the dist isn't built. Run `npm install && npx tsc --build packages/mcp-server`.
3. If it prints something about `NOVA_URL` or `NOVA_AGENT_ID` — the env vars aren't being passed. Most MCP clients require them in an `"env"` block inside the server config; inheriting from the shell doesn't work.
4. If SSH: test `ssh user@host "node /path/to/dist/index.js"` manually. Password prompts, host-key prompts, or "command not found" all break it.

### A tool call returns an error code

That's a **Nova-side response**. The MCP transport is fine. Common codes:

| Code | Meaning | Action |
|---|---|---|
| `AGENT_ID_MISMATCH` | Your `agentId` doesn't match the invite's `agentIdHint` | Ask the operator for a new invite with the correct hint. Old invite is still valid. |
| `AGENT_EXISTS` | Someone already registered with this `agentId` in this tenant | If prior record is deregistered, retry (Nova overwrites). Otherwise ask operator to delete/reject the stale record. |
| `TENANT_NOT_FOUND` | The invite points at a tenant that doesn't exist | Operator side — tenant may have been deleted. Fresh invite needed. |
| `INVITE_INVALID` | Signature failure, expiry, or successful prior consumption | Get a new invite. Note: pre-validation failures (AGENT_EXISTS, etc.) do NOT consume the invite — same token retries. |
| `GRANT_CLAIM_EXPIRED` | Operator approved but you didn't claim within the claim window | Operator runs `nova_reissue_ucan`, you re-check once. |
| `UCAN_CLAIM_EXPIRED` | Approval grant itself expired (long after approval, ~30 days) | Operator runs `nova_reissue_ucan`, you re-claim via `nova_check_registration`. |
| `GRANT_REVOKED` | Operator revoked this agent's approval | You are persona non grata. Contact the operator. |

Surface these verbatim. Do not retry silently in a loop.

### "nova-mcp is unreachable" / "connection refused"

This almost always means your MCP **host** can't spawn the process — not that Nova is down. Re-check your MCP config. If the error comes from *inside* a nova tool call (e.g. `nova_register_agent` fails with "ECONNREFUSED to localhost:3001"), then `NOVA_URL` is wrong or the a2a-server isn't running.

---

## 11. Next steps

- **First send:** invoke `/nova_first_task` (prompt).
- **First receive:** invoke `/nova_serve` (prompt).
- **Key rotation:** `nova_rotate_key` — generates a new keypair, proves possession of the old one, swaps the DID. Old identity file preserved at `<agentId>.json.rotated-<ISO>.bak`.
- **Inspect cached UCAN:** `nova_ucan_status`.
- **Stop receiving:** `nova_unwatch_inbox` (on shutdown; abrupt exits are fine — Nova closes the stream server-side).

Runtime-specific notes (history, quirks, acceptance-test checklists):

- Hermes (Nous Research): `docs/hermes-onboarding.md`
- Tool and schema reference: `packages/mcp-server/README.md`
- Prompt source of truth: `packages/mcp-server/src/prompts.ts`
- Protocol spec: `nova-protocol-spec.md`
