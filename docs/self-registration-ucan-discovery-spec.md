# Nova Milestone 4+ — Self-Registration, Autonomous UCANs, Agent Discovery

## Design Decisions

### Self-Registration: Approval Gate (not auto-approve)
Rationale: This is a platform where agents can execute actions. An uncontrolled registration
endpoint would let anyone spam agents onto the platform. Self-registration says "I want to join"
— admin approval says "I trust you." The agent can see itself as `pending` but cannot receive
or send tasks until approved.

### UCAN Issuance: Proof-of-Possession (Option B)
Rationale: During registration the agent sends its public key. Post-approval, the agent proves
it holds the matching private key by signing a nonce. The UCAN service verifies the signature
and issues a fresh UCAN. Admin approves once — agent manages its own lifecycle forever.

### Discovery: `/discover` endpoint gated by skill permission
Rationale: Foundation is a simple HTTP endpoint (Option A). Access is gated by the existing
gate pipeline skill-checking mechanism — an agent must have the `query_discover` skill in its
config to read the list. This maps cleanly to Nova's existing permission model.

---

## 1. SELF-REGISTRATION

### 1.1 New Endpoint: `POST /register`

**Location:** `packages/a2a-server/src/routes/register.ts`
**Auth:** None (public)
**Method:** POST

#### Request Body Schema

```typescript
const SelfRegisterSchema = z.object({
  agentId: z.string().regex(/^[a-z0-9_-]+$/).min(1).max(64),
  tenantSlug: z.string().regex(/^[a-z0-9-]+$/).min(1).max(64),
  tenantName: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  publicKey: z.string().min(1),           // Ed25519 public key (base64)
  did: z.string().startsWith('did:'),      // did:key:z6Mk...
  operatorUrl: z.string().url().optional(),
  skills: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    inputSchema: z.record(z.unknown()).optional(),
    outputSchema: z.record(z.unknown()).optional(),
  })).min(1),
  replyUrl: z.string().url(),              // Where to send approval notification
});
```

> **Tenant auto-creation:** If `tenantSlug` doesn't exist, a new tenant is created 
> automatically. If it exists, the agent is added to the existing tenant.

#### Response

**201 Created:**
```json
{
  "status": "pending",
  "registrationId": "reg_a1b2c3d4",
  "tenantId": "tenant_abc123",
  "agentId": "my-agent-01",
  "pendingReason": "Requires admin approval before activation"
}
```

**409 Conflict:** Agent ID already registered
**400 Bad Request:** Schema validation failure

#### Sequence

```
External Agent                              Nova a2a-server
     │                                            │
     │── POST /register ──────────────────────────▶│
     │    { agentId, tenantSlug, name,             │
     │      publicKey, did, skills, replyUrl }     │
     │                                            │
     │                          1. Validate request body
     │                          2. Check if tenant exists
     │                             └─ If not: create tenant
     │                          3. Check agentId not taken
     │                          4. Create agent-config.json
     │                             (status: "pending")
     │                          5. Set Redis index
     │                          6. Audit log: agent_registered
     │                          7. POST approval webhook to replyUrl
     │◀── 201 { status: "pending", ... } ─────────────│
     │                                            │
     │         (agent waits for approval)          │
```

### 1.2 Admin Approval Endpoint

**Location:** `packages/admin-api/src/routes/agents.ts` — new route
**Auth:** Admin API bearer token
**Method:** `POST /admin/tenants/{tenantId}/agents/{agentId}/approve`

**Request:**
```json
{
  "trustTier": 2,
  "ucanExpiryDays": 30,
  "allowedSkills": ["query_knowledge", "query_discover"]
}
```

**What happens:**
1. `agent-config.json` status: `"pending"` → `"active"`
2. Trust registry entry created (DID + tier specified in the approval request)
3. Initial UCAN issued to the agent's registered DID
4. Audit log: `agent_approved`
5. Notification POSTed to the agent's `replyUrl` with UCAN + renewal URL

### 1.3 Pending Agents Cannot Communicate

A pending agent has a Redis index entry (so it's discoverable), but the gate pipeline will
quarantine any task from it because its DID isn't in the trust registry yet. Registration
without approval = visible but powerless.

### 1.4 Trust Tier on Registration

The `SelfRegisterSchema` includes an optional `requestedTier` field (1-3). This goes into
the audit log and admin sees it during approval but is NOT automatically granted. Admin always
sets the actual tier. If the field is omitted, the default approved tier is 1 (lowest trusted).

### 1.5 Files Changed

| File | Change |
|------|--------|
| `packages/a2a-server/src/routes/register.ts` | **NEW** — Registration endpoint + handler |
| `packages/a2a-server/src/index.ts` | Mount register route (outside agent router) |
| `packages/shared/src/admin-schemas.ts` | Add `SelfRegisterSchema`, `AgentApprovalSchema` |
| `packages/admin-api/src/routes/agents.ts` | Add `approve` POST route |
| `packages/admin-api/src/services/agent-service.ts` | Add `approveAgent()` method |

---

## 2. AUTONOMOUS UCAN ISSUANCE

### 2.1 The Problem

Currently agents get UCANs only via `scripts/issue-ucan.ts` (manual). UCANs expire. When
one expires, the agent's tasks get quarantined with `ucan_expired` — no automatic recovery.

### 2.2 Solution: Proof-of-Possession Renewal

The agent proves it holds the private key matching the public key registered during sign-up.

### 2.3 Nonce Request — `GET /ucans/renew?did={did}&agentId={agentId}`

Returns a challenge nonce:
```json
{ "nonce": "random32bytes", "validUntil": "2026-04-13T04:40:00Z" }
```

Nonce expires in 5 minutes. Stored in memory (one-time use, deleted on verification).

### 2.4 Renewal — `POST /ucans/renew`

```json
{
  "did": "did:key:z6Mk...",
  "agentId": "my-agent-01",
  "nonce": "random32bytes",
  "signature": "base64url(Ed25519_sign(privateKey, nonce))"
}
```

**Server verifies:**
1. Nonce exists and hasn't expired (lookup in nonce store)
2. Signature is valid for the nonce using the stored public key (read from agent-config.json)
3. DID exists in trust registry (approved, not revoked)
4. Agent status is "active" (not "pending", not "deregistered")

If all pass → issues a new UCAN with `subjectDid` = the agent's DID.

### 2.5 Response

**200:**
```json
{ "jwt": "eyJhbGci...", "cid": "a1b2c3d4...", "expiresAt": "2026-05-13T00:00:00Z" }
```

**403:** DID not approved or agent still pending
**401:** Invalid signature (proof-of-possession failed)
**410:** Nonce expired
**429:** Too many renewal attempts (rate-limited, 10/min per DID)

### 2.6 Agent-Connector Renewal Logic

On startup and before each task delivery:

```
1. Check current UCAN expiry
2. If expired or <20% remaining:
   a. GET /ucans/renew?did={did}&agentId={id} → nonce
   b. Sign nonce with Ed25519 private key
   c. POST /ucans/renew { did, agentId, nonce, signature }
   d. Store new UCAN in memory + disk cache
3. Use UCAN for task delivery Authorization header
```

The connector needs the agent's private key path:
```
AGENT_PRIVATE_KEY_PATH=/path/to/agent.private.pem
```

On first boot (no UCAN cached), the connector requests one before processing any tasks.

### 2.7 UCAN Caching

The connector caches the UCAN in two places:
1. **Memory:** Fast access for each task delivery
2. **Disk:** `{DATA_ROOT}/agents/{agentId}/ucan-cache.json` for crash recovery

Cache format:
```json
{
  "jwt": "eyJhbGci...",
  "expiresAt": "2026-05-13T00:00:00Z",
  "refreshedAt": "2026-04-13T00:00:00Z"
}
```

### 2.8 Files Changed

| File | Change |
|------|--------|
| `packages/admin-api/src/routes/ucan.ts` | Add GET `/renew` (nonce) and POST `/renew` (verify + issue) |
| `packages/admin-api/src/services/ucan-service.ts` | Add `renewUcan()` with proof-of-possession verification |
| `packages/admin-api/src/services/nonce-service.ts` | **NEW** — nonce store |
| `packages/shared/src/admin-schemas.ts` | Add `UcanRenewSchema` |
| `packages/agent-connector/src/index.ts` | Add UCAN renewal logic in processTask() |
| `packages/agent-connector/src/config.ts` | Add `AGENT_PRIVATE_KEY_PATH` config |

---

## 3. AGENT DISCOVERY

### 3.1 New Endpoint: `GET /discover`

**Location:** `packages/admin-api/src/routes/discover.ts`
**Auth:** None (public) — returns basic info only
**Method:** GET

### 3.2 Response

```json
{
  "agents": [
    {
      "agentId": "agent_aria",
      "name": "Aria Data Helper",
      "description": "Internal analytical agent",
      "url": "http://host:3001/agents/agent_aria",
      "skills": [
        { "id": "query_knowledge", "name": "Query Knowledge", "description": "..." },
        { "id": "request_summary", "name": "Request Summary", "description": "..." }
      ],
      "status": "active"
    }
  ],
  "total": 1
}
```

**Only active agents shown.** Pending and deregistered agents are excluded.

No sensitive data exposed — never shows publicKey, DID, internal file paths, or UCAN info.

Optional query params:
- `?status=active|pending` — filter by status
- `?agentId=xxx` — lookup single agent (useful for agents checking their own status after registration)
- `?skills=search` — filter agents that have a skill containing "search"

### 3.3 How the `query_discover` Skill Works (Option D)

The skill approach: an agent discovers by sending a **task through the pipeline** with intent
`query_discover`. The gate pipeline's schema validation confirms this agent has `query_discover`
in its skills list. If not → `INTENT_UNKNOWN` → task dropped.

This means:
- The discovery request itself is **authenticated** (goes through the gate pipeline's UCAN verification)
- It's **audited** (audit log captures who queried and when)
- It's **rate-limited** (same rate limits as any other task)
- An agent **without** the skill can't discover anything

The discover route on the admin API serves the raw data. The `query_discover` skill handler
in the operator/agent-connector is what calls it and wraps the response in a TaskResult.

### 3.4 Skill Definition

Added to an agent's config to enable discovery capability:

```json
{
  "id": "query_discover",
  "name": "Agent Discovery",
  "description": "Discover other agents on the platform",
  "inputSchema": {
    "type": "object",
    "properties": {
      "skills": { "type": "string", "description": "Filter by skill name" },
      "status": { "type": "string", "enum": ["active", "pending"] }
    }
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "agents": { "type": "array" },
      "total": { "type": "number" }
    }
  }
}
```

### 3.5 Discovery Flow

```
Agent A                                    Nova Platform
   │                                             │
   │── Intent: query_discover ──────────────────▶│
   │    (through gate pipeline)                  │
   │    Gate checks: does agent_A have           │
   │    "query_discover" in skills? ──── Yes     │
   │                                             │
   │                          Connector picks up │
   │                          task. Handler calls│
   │                          GET /discover      │
   │                                             │
   │◀── TaskResult with agent list ─────────────│
   │    "agent_aria has query_knowledge skill"   │
   │    "agent_bob has search_web skill"         │
   │                                             │
   │── Now Agent A can POST tasks ───────────────▶│
   │    to /agents/agent_aria/tasks              │
   │    with intent: "query_knowledge"           │
```

### 3.6 Files Changed

| File | Change |
|------|--------|
| `packages/admin-api/src/routes/discover.ts` | **NEW** — GET /discover |
| `packages/admin-api/src/index.ts` | Mount discover route |
| `packages/shared/src/schemas.ts` | Add `DiscoverQuerySchema` for discover skill params |

No changes to gate pipeline needed — existing schema validation already handles intent-vs-skill
checking. If `query_discover` isn't in the agent's skills, the schema validator rejects it.

---

## 4. COMPLETE END-TO-END FLOW

```
1. Agent generates Ed25519 keypair → gets DID + publicKey
2. Agent POSTs /register → status: "pending"
3. Admin: POST /admin/tenants/{tid}/agents/{aid}/approve
   → status: "pending" → "active"
   → trust registry entry created (DID + tier)
   → initial UCAN issued
   → agent notified at replyUrl
4. Agent-connector:
   a. Reads private key from AGENT_PRIVATE_KEY_PATH
   b. Caches UCAN from registration notification
   c. Sets up UCAN auto-renewal (GET nonce → sign → POST /ucans/renew)
5. Agent sends task with intent "query_discover" → gets list of agents
6. Agent discovers Agent B at /agents/agent_b
7. Agent renews its own UCAN (if expiring) via /ucans/renew
8. Agent POSTs task to /agents/agent_b/tasks with UCAN
   → gate pipeline: UCAN verified, trust tier checked, schema valid
   → task queued → connector delivers → response via replyTo
```

---

## 5. WHAT DOESN'T CHANGE

| Component | Status | Reason |
|-----------|--------|--------|
| Gate pipeline | Unchanged | UCAN verification, trust tier, schema validation intact |
| UCAN verifier | Unchanged | Sig, expiry, audience, cap checks work as-is |
| Trust tier resolver | Unchanged | Still reads trust-registry files |
| Task queue | Unchanged | Still queues to tier-specific queues |
| Agent config format | Extended | New fields: publicKey, did, status |
| Docker compose | Unchanged | No new services needed |
| Existing agent_aria | Unchanged | Existing agents keep working |
| Admin API auth | Unchanged | Still uses ADMIN_API_KEY header |

### Impact on agent_aria

`agent_aria` was registered before self-registration existed. Its config has no `publicKey`,
`did`, or `status` fields. These are optional:
- Missing `status` → treated as "active" (backwards compatible)
- Missing `publicKey`/`did` → UCAN renewal not available (must use manual issue)
- Existing UCAN-based tasks continue to work unchanged

---

## 6. SECURITY

1. **Rate limit `/register`**: 60/min per IP (same as task submission)
2. **Public key immutable**: Can't be changed after registration without admin intervention
3. **Nonces expire**: 5-min TTL, one-time use, deleted after verification
4. **Audit trail**: Every registration, approval, UCAN issue/renewal logged
5. **Tenant quotas**: Auto-created tenants respect `agentsMax` limit; registration fails if exceeded
6. **No leaked secrets**: Public discovery never shows privateKey, DID, or internal paths
7. **UCAN scope**: Each UCAN is scoped to one agent (`nova:{tenantId}:{agentId}`) — can't be reused across agents
8. **Revocation**: Admin can revoke any UCAN → immediately invalidates the token

---

## 7. IMPLEMENTATION ORDER

1. **`POST /register`** (a2a-server) — foundation, everything depends on this
2. **`POST /admin/agents/{id}/approve`** (admin-api) — activates registered agents
3. **`GET /ucans/renew` + `POST /ucans/renew`** (admin-api) — autonomous token lifecycle
4. **`GET /discover`** (admin-api) — agent visibility
5. **`query_discover` skill handler** (agent-connector) — skill-based discovery through pipeline
6. **Agent-connector UCAN renewal logic** — connector manages its own tokens

Each step is independently testable. No single change breaks existing functionality.
End-of-spec tests can run after all six are in place.
