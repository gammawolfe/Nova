# @nova/broker-receiver

Supervised daemon for Nova broker-mode agents. Pulls tasks from the broker inbox, dispatches each through a pluggable handler, and ships the result back via `nova_respond` — independently of any interactive MCP session. One persistent process per agent identity.

See also `docs/superpowers/specs/2026-04-21-broker-receiver-daemon.md` for the design spec.

## When to use

Reach for the daemon when reception needs to be reliable across session restarts, or when the host AI runtime (Claude Code, Hermes, OpenClaw) cannot itself run a long-poll loop. Use the stdio MCP tools (`nova_next_task` / `nova_respond`) for interactive, operator-supervised reception instead.

## Quick start

```bash
# Operator (Nova host): mint an invite for the receiver.
ADMIN=my-secure-admin-token-12345
TENANT=tenant_496bdb38306a
curl -s -X POST "http://127.0.0.1:3005/admin/tenants/$TENANT/invites" \
  -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"agentIdHint":"my-receiver","ttlSeconds":600}'

# Receiver host: onboard. Generates a keypair, registers, waits for
# approval (runs concurrently), and caches the approval grant.
npm run broker-receiver:dev -- init \
  --agent-id my-receiver \
  --invite "<JWT_FROM_ABOVE>" \
  --nova-url http://localhost:3001

# Operator: approve while `init` is polling.
curl -s -X POST \
  "http://127.0.0.1:3005/admin/tenants/$TENANT/agents/my-receiver/approve" \
  -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"trustTier":2}'

# Receiver host: run the daemon.
npm run broker-receiver:dev -- run
```

Once registered + approved, identity and grant land at `~/.nova/agents/my-receiver.json` and the grant cache at `~/.nova/ucan-cache/my-receiver.json`. Default config is written to `~/.nova/broker-receiver.json` only if that file does not already exist — re-running `init` is non-destructive.

## Subcommands

```
broker-receiver run          # Main daemon loop. Runs until SIGTERM/SIGINT.
broker-receiver init         # One-shot onboarding (invite → register → approve → grant).
broker-receiver install      # Print a launchd (macOS) or systemd (Linux) unit file.
broker-receiver uninstall    # Print steps to remove supervision. Does not modify files.
broker-receiver help
```

All commands respect config precedence: **CLI flags > environment variables > `~/.nova/broker-receiver.json`**.

## Configuration

| Field | CLI | Env | Default | Notes |
|---|---|---|---|---|
| `agentId` | `--agent-id` | `NOVA_AGENT_ID` | — | Required. |
| `novaUrl` | `--nova-url` | `NOVA_URL` | `http://localhost:3001` | |
| `handler` | `--handler` | `BROKER_RECEIVER_HANDLER` | `echo` | `echo` or `claude-api`. |
| `handlerConfig` | (file only) | — | `{}` | Handler-specific. See §Handlers. |
| `pollWaitMs` | `--poll-wait-ms` | `BROKER_RECEIVER_POLL_WAIT_MS` | `30000` | Server caps at 60s. |
| `maxConcurrentTasks` | `--max-concurrent-tasks` | `BROKER_RECEIVER_MAX_CONCURRENT` | `1` | Sequential is the v1 recommendation. |
| `healthPort` | `--health-port` | `BROKER_RECEIVER_HEALTH_PORT` | `0` | Loopback-only. `0` disables. |
| `shutdownGraceSeconds` | `--shutdown-grace-seconds` | `BROKER_RECEIVER_SHUTDOWN_GRACE` | `30` | In-flight handler drain budget. |
| `logLevel` | `--log-level` | `BROKER_RECEIVER_LOG_LEVEL` | `info` | `debug | info | warn | error`. |

Example `~/.nova/broker-receiver.json`:

```json
{
  "agentId": "my-receiver",
  "novaUrl": "http://localhost:3001",
  "handler": "claude-api",
  "handlerConfig": {
    "model": "claude-sonnet-4-6",
    "maxTokens": 4096,
    "systemPromptFile": "/etc/nova/receiver-prompt.md"
  },
  "healthPort": 9902,
  "logLevel": "info"
}
```

## Handlers

### `echo` (test / default)

Deterministic. Returns `{ echoed: true, intent, params, handledAt }`. No configuration. Intended for daemon smoke tests and verifying the full pull → dispatch → respond loop without a real AI dependency.

### `claude-api`

Forwards the task to Anthropic's Messages API and returns the assistant's reply. Config:

```jsonc
{
  "handlerConfig": {
    "model": "claude-sonnet-4-6",      // default
    "maxTokens": 4096,                  // default
    "systemPromptFile": "/path.md",     // optional; falls back to systemPrompt, then built-in
    "systemPrompt": "You are ...",      // optional inline alternative
    "apiKey": "sk-..."                  // NOT recommended; prefer ANTHROPIC_API_KEY env
  }
}
```

API key precedence: `handlerConfig.apiKey` → `ANTHROPIC_API_KEY` env → fail. Prompt caching is enabled on the system block. No tool use in v1.

Treat incoming task params as untrusted input: the default system prompt instructs the model to ignore contradicting instructions in the user payload. Operators supplying their own prompt should preserve that property.

### Writing a new handler

```ts
import { registerHandler, type Handler } from '@nova/broker-receiver';

registerHandler('my-handler', async (config) => {
  // `config` is the raw handlerConfig — validate with zod before use.
  return {
    name: 'my-handler',
    async handle(task, ctx) {
      // ctx.signal fires on shutdown OR ~30s before visibleUntil.
      return { status: 'ok', result: { foo: 'bar' } };
    },
  };
});
```

Register before the CLI imports `handlers/index.ts`. In practice this means forking the package or adding an alternate entry point.

## Supervision

```bash
# macOS (launchd, user scope)
broker-receiver install --format launchd --agent-id my-receiver > \
  ~/Library/LaunchAgents/com.nova.broker-receiver.my-receiver.plist
launchctl load ~/Library/LaunchAgents/com.nova.broker-receiver.my-receiver.plist

# Linux (systemd, user scope)
broker-receiver install --format systemd --agent-id my-receiver > \
  ~/.config/systemd/user/broker-receiver@.service
systemctl --user daemon-reload
systemctl --user enable --now broker-receiver@my-receiver.service
```

The generated files restart on non-zero exit, throttle at one restart / 10s, and run under the invoking user — no privileged sockets, no root, no system scope. Logs land at `~/.nova/logs/broker-receiver.<agentId>.{out,err}.log` (launchd) or the systemd journal.

## Health endpoint

Set `--health-port 9902` (or any non-zero port) to enable the loopback-only HTTP endpoint:

```bash
curl http://127.0.0.1:9902/health | jq
```

Response shape:

```json
{
  "status": "ok",
  "agentId": "my-receiver",
  "handler": "echo",
  "startedAt": "2026-04-22T18:00:00.000Z",
  "uptimeMs": 123456,
  "pullLoop": {
    "running": true,
    "totalPulls": 42,
    "totalTasks": 3,
    "totalPullErrors": 0,
    "consecutiveErrors": 0,
    "lastTaskAt": "2026-04-22T18:05:12.000Z"
  },
  "dispatcher": {
    "inFlight": 0,
    "totalDispatched": 3,
    "totalResponded": 3,
    "totalHandlerErrors": 0,
    "totalTransportErrors": 0
  }
}
```

HTTP status mirrors `status`: `ok` / `degraded` → 200, `stopped` → 503. `degraded` is set once `consecutiveErrors` crosses three — means the daemon is still alive but failing to pull. Typical causes: stale self-UCAN (grant rotation on the operator side), Nova briefly offline, or auth reject loop. Log lines carry the detail.

## Failure handling

- **Handler throws.** Caught and responded as `status: "error"` with `code: "HANDLER_EXCEPTION"`. Task is not retried locally; Nova's reclaim worker will redeliver once the visibility window lapses, giving the handler a second chance.
- **Handler ignores abort.** At `visibleUntil - 30s`, the handler's `AbortSignal` fires. Handlers that honor it wind down cleanly; handlers that ignore it still work, but the task may be reclaimed and double-dispatched.
- **Pull error (transport / 4xx / 5xx).** Exponential backoff capped at 60s. Stats surface via `/health`.
- **Grant near-expiry.** Surfaced via `consecutiveErrors` once the server rejects the self-UCAN. v1 does not auto-reissue — operator runs `nova_reissue_ucan` and restarts the daemon. Auto-reload is a follow-up bite.
- **Shutdown.** `SIGTERM` → pull loop stops → dispatcher drains up to `shutdownGraceSeconds` → health server stops → process exits 0. In-flight tasks whose handlers don't finish before the grace window are left alone; Nova's reclaim will redeliver them.

## Tests

```bash
# Unit tests (vitest)
npx vitest run packages/broker-receiver

# Acceptance test (requires Nova running locally)
npm run test:acceptance:broker-receiver
```

The acceptance test covers onboarding, startup, steady state, and shutdown. Task round-trip is a manual smoke — see the script output's "Manual task round-trip" section.
