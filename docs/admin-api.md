# Nova HTTP API reference

Full endpoint listing for the operator admin API (`@nova/admin-api`) and the
public/agent-authenticated Nova server (`@nova/a2a-server`). For the high-level
model and quick start, see the [README](../README.md).

## Admin endpoints

Operator endpoints (require `Authorization: Bearer $ADMIN_TOKEN`):

```
# System
GET     /admin/health                                              full admin + service dependency health
GET     /admin/metrics                                             admin Prometheus metrics
GET     /admin/classifier                                          classifier mode/model/key-source settings
PUT     /admin/classifier                                          update classifier settings

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
GET     /admin/tenants/:id/agents/:agentId/broker-status           broker inbox/reply-inbox status

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

# Broker summary
GET     /admin/broker/summary                                      broker-mode agents across tenants

# Federation grants
POST    /admin/federation/grants                                   issue Nova-to-peer-Nova delegation
GET     /admin/federation/grants                                   list issued federation grants
```

## Public & agent-authenticated endpoints

On the Nova HTTP server (`@nova/a2a-server`; no admin bearer auth — discovery,
self-registration, invocation-token, or self-UCAN authorised):

```
# Health
GET     /health                                           a2a-server health

# Self-registration & discovery
POST    /register                                        self-register (invite required)
GET     /register/status/:tenantId/:agentId              poll approval, claim approval grant
GET     /discover                                        list active agents
GET     /discover/:agentId                               agent detail
GET     /agents/:agentId/.well-known/agent.json          Nova agent card
GET     /agents/:agentId/health                          agent status + UCAN revocation probe

# Task submission (UCAN invocation token required in Authorization header)
POST    /agents/:agentId/tasks                           submit a task
GET     /agents/:agentId/tasks/:taskId                   task status
GET     /agents/:agentId/tasks/:taskId/stream            task state/result SSE stream

# Broker-mode receive (self-UCAN auth, for agents without a webhook)
GET     /agents/:agentId/inbox                           long-poll claim (next task)
GET     /agents/:agentId/inbox/peek                      non-destructive snapshot
GET     /agents/:agentId/inbox/stream                    SSE push notifications
POST    /agents/:agentId/inbox/:taskId/respond           complete a claimed task

# Broker-mode reply collection (self-UCAN auth, for senders without a replyTo webhook)
GET     /agents/:agentId/replies                         long-poll claim (next reply)
GET     /agents/:agentId/replies/peek                    non-destructive snapshot
GET     /agents/:agentId/replies/stream                  SSE push notifications
GET     /agents/:agentId/replies/:taskId                 reply detail
POST    /agents/:agentId/replies/:taskId/ack             clear in-flight state
```

Discovery responses, agent cards, and broker status include `brokerPresence`,
derived from active `/inbox/stream` SSE connections. This is the liveness signal
for broker-mode receivers; direct webhook receivers need a separate health or
heartbeat mechanism.

## Proof-of-possession operations

Authorised by signature, not bearer token:

```
GET     /admin/tenants/:id/nonces?did=&agentId=                 request single-use nonce
POST    /admin/tenants/:id/agents/:agentId/rotate-key           rotate keypair (PoP-signed with old key)
```

> **Note:** Nova dropped the notary-model UCAN endpoints (`/ucans/renew`,
> `/ucans/request`) when the delegation-chain model landed. Senders mint
> invocation tokens locally with their own Ed25519 key; the approval grant is
> the only Nova-signed UCAN in the chain, and grant renewal is operator-gated
> via `/agents/:agentId/ucans/reissue`.
