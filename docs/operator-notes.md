# Operator notes

Short-form reference for running Nova. Complements the per-package READMEs and design specs under `docs/superpowers/specs/`.

## Rolling containers after a merge

Nova's server-side services run in Docker (`docker-compose.yml`). When a PR touches code that any service imports, rebuild those service containers — otherwise the stack runs stale code against fresh client-side changes, producing silent behavioural skews.

### Which services to rebuild

Use the import graph as the trigger. If a PR modifies any file under these packages, the listed containers must be rebuilt:

| Package touched | Services to rebuild |
|---|---|
| `packages/shared/**` | **all** — every service imports shared types, Redis helpers, agent-index, etc. |
| `packages/task-queue/**` | `a2a-server`, `agent-connector` |
| `packages/a2a-server/**` | `a2a-server` |
| `packages/gate-service/**` | `gate-service` |
| `packages/agent-connector/**` | `agent-connector` |
| `packages/admin-api/**` | `admin-api` |

The MCP server (`packages/mcp-server/`) and broker-receiver daemon (`packages/broker-receiver/`) run on the operator host, not inside a container — they pick up changes via `tsc --build` or `tsx` directly with no container step.

### The command

```bash
# Rebuild specific services without touching the rest.
docker compose up -d --build a2a-server agent-connector

# Or rebuild the whole stack after a shared change.
docker compose up -d --build
```

`--build` forces a fresh image; `-d` keeps it detached. `docker compose` rebuilds only what was flagged, recreates the matching containers, and brings them back up under existing volumes.

### Why this matters

The containers share a single Redis instance. A partial rebuild can produce invisible version skew. Two real incidents from the push-subscriptions rollouts:

1. **PR #27 enqueue change (a2a-server only rebuilt).** The push-subscriptions patch modified `packages/task-queue/src/inbox.ts:enqueue` to publish a notification on a new Redis channel. `a2a-server` was rebuilt and served the new `/inbox/stream` route. But `agent-connector` (which owns the broker-branch enqueue for inbound webhook-less tasks) was still running the pre-change build — so no notifications fired, and the daemon saw every task via the fallback tick instead of SSE. Total fix: rebuild `agent-connector` and the SSE trigger path lit up.
2. **Reply-inbox push (PR #31).** Same pattern: `packages/task-queue/src/reply-inbox.ts:enqueueReply` grew publish logic. Both `a2a-server` (serves `/replies/stream`) and `agent-connector` (not actually involved in reply enqueue, but shares code imports) had to be rebuilt to be safe.

Rule of thumb: **if you touched a file under `packages/shared`, `packages/task-queue`, or any package a service imports, rebuild all affected containers before running acceptance tests**. The unit tests will lie to you about readiness because they run against source, not the running stack.

## Local development topology

- **Docker containers** (one Redis instance, all services on the `nova_default` network — compose auto-names it from the project directory):
  - `redis` — port 6379 on host.
  - `a2a-server` — port 3001.
  - `admin-api` — 127.0.0.1:3005 (intentionally localhost-only).
  - `gate-service`, `agent-connector` — internal only.
  - `caddy` — ports 80, 8443 (optional edge).
- **Host-local state** under `~/.nova/`:
  - `agents/<agentId>.json` — agent identity (keychain-backed or file-backed).
  - `agents/<agentId>.ucan.json` — cached approval grant.
  - `tenant.json` — last joined tenant (for MCP-server runtime resolution).
  - `broker-receiver.json` — daemon defaults written by `broker-receiver init`.
  - `logs/broker-receiver.<agentId>.{out,err}.log` — launchd capture when supervised.

If you have a brew-installed Redis running locally, it will race with docker-compose's `nova-redis-1` for port 6379 — the brew redis usually wins the 127.0.0.1 bind, meaning host tools hit brew while containers hit their internal Redis. Symptom: `redis-cli` from the host shows empty, but containers see populated keys. Fix: `brew services stop redis` before running acceptance tests that do direct host-side Redis writes.

## Running acceptance tests

Each PR that ships behavior has an automated script in `scripts/`. Convention: `scripts/acceptance-test-<area>.ts`, wired as `npm run test:acceptance:<area>`.

Expected order when regressing after a shared-package change:

```bash
# 1. Rebuild all affected containers (see matrix above).
docker compose up -d --build a2a-server agent-connector

# 2. Wait for a2a-server to be healthy.
until curl -sf http://localhost:3001/health > /dev/null; do sleep 1; done

# 3. Run the acceptance suites.
npm run test:acceptance:invite-whitespace
npm run test:acceptance:mcp-push
npm run test:acceptance:mcp-replies-push
npm run test:acceptance:broker-receiver
```

Unit tests don't need a running stack: `npx vitest run` is self-contained.

## Admin token

`ADMIN_TOKEN` is read from `.env` by docker-compose. The dev default (`my-secure-admin-token-12345`) is committed on purpose — this repo assumes dev-local use. For any deployment beyond your laptop, override via `.env.local` or the deployment platform's secret store and **never** commit the replacement value. `admin-api` requires it for every mutating route; read-only routes don't need auth.

## Agent identities and keychain

Identities stored at `~/.nova/agents/<agentId>.json`. The `keyBackend` field indicates whether the private key PEM is stored inline (legacy `file` backend) or in the OS keychain (`keychain` backend, opt-in per PR that shipped it). Both are respected on load; swapping backends requires generating a new identity.

Public DID and public key are published to Nova's discovery API at registration. Rotating a key (`nova_rotate_key`) generates a fresh Ed25519 pair and re-registers; the old identity file is preserved as `{agentId}.json.rotated-{ISO}.bak` for audit.
