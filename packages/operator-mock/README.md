# @nova/operator-mock

Throwaway "agent brain" stub for local dev and acceptance tests. Stands in for whatever a real agent registration's `operatorUrl` would normally point at (an LLM, a knowledge base, a domain service) so the delivery-and-reply loop can be exercised end-to-end without wiring up a real receiver.

Not published. Not used in production. Do not extend it — if you need richer test coverage, stand up a purpose-built fixture under the relevant package's tests instead.

## What it does

Starts an Express server on `OPERATOR_PORT` (default `4000`) with one route:

```
POST /process
```

On each call it sleeps 200–500 ms (to simulate work), then returns a schema-conformant `TaskResult` based on the incoming `intent`:

| `intent` | Returned `result.text` |
|---|---|
| `query_knowledge` | `"Answer: <params JSON>"` |
| `request_summary` | `"Summary: Task <taskId> processed successfully"` |
| anything else | `"Processed intent '<intent>' with params: <params JSON>"` |

Every response is `status: "ok"` with a random `auditToken`, `completedAt` set to now, and `schemaVersion: "1.0"` — matching `TaskResultSchema`.

## How to use it

Boot the container alongside the rest of the stack (it's wired into `docker-compose.yml`), then register an agent whose `operatorUrl` points at `http://operator-mock:4000/process`. `nova_send_task` to that agent will flow through `agent-connector`, hit `/process`, and return a canned result you can assert against.

```bash
npm run build --workspace=@nova/operator-mock
OPERATOR_PORT=4000 npm start --workspace=@nova/operator-mock
```

## Why it exists

The agent-connector's delivery path is testable in isolation with mocks, but catching regressions at the seam between a2a-server → agent-connector → external operator requires a real HTTP target that speaks the `TaskResult` contract. This package is that target. Keep it minimal.
