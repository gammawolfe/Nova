# Nova
## The Secure Agent Communication Layer

---

## What Nova Is

Nova is infrastructure. It sits between AI agents and makes communication between them trustworthy, auditable, and interoperable.

Agents run on their owners' infrastructure — on a laptop, a VPS, a cloud provider, an enterprise data centre. Nova doesn't host agents. Nova provides the secure endpoint in front of each agent: the interface through which other agents reach it, the security layer that validates every inbound message before the agent ever sees it, and the audit trail that proves what happened.

When your agent needs to talk to another agent, it talks to that agent's Nova endpoint. Nova validates the request, enforces trust policy, and delivers it. When a result comes back, Nova delivers that too. Neither agent operator needs to trust the other's infrastructure — they trust Nova's security guarantees.

The closest analogy is Cloudflare. Cloudflare doesn't host your website — your server does. Cloudflare sits in front and provides security, routing, and reliability. Nova does the same for agents.

---

## Why It Exists

Agent-to-agent communication is an unsolved problem in practice.

The protocols are arriving. Google's A2A standard defines how agents advertise capabilities and exchange tasks. Anthropic's MCP defines how agents access tools. The ecosystem is converging. But protocols define message formats and delivery semantics — they don't define what happens between "message arrives" and "agent processes it."

That gap is the problem Nova solves.

Without a security layer in front of an agent:

- Any agent that knows your endpoint can send messages
- Those messages can contain prompt injection attempts — text crafted to manipulate your agent's behaviour
- There is no capability model — you can't say "this agent may query knowledge but not schedule actions"
- There is no audit trail — you can't prove what was sent, when, by whom, or what your agent did in response
- There is no trust model — "we exchanged agent cards" is not enterprise-grade authorisation

Nova provides all of this, built on top of A2A as the standard wire protocol, with UCAN capability delegation as the trust model, and a multi-layer validation pipeline between every inbound message and the agent that receives it.

---

## What Nova Is Not

**Nova is not an agent framework.** It has no opinion about what LLM your agent uses, how it reasons, or what it does with tasks. Agents are built with whatever tools their operators choose.

**Nova is not an agent host.** Agents run on their owners' infrastructure. Nova provides the endpoint, not the compute.

**Nova is not a replacement for A2A or MCP.** Nova implements A2A as its wire protocol. MCP governs how agents access their own tools — a separate concern at a different layer. Nova, A2A, and MCP are complementary.

**Nova is not a messaging queue.** It has a task queue for reliability, but the product is the security and trust layer, not the delivery mechanism.

---

## The Stack

```
                    External agents
                          │
                          │  A2A protocol
                          │
              ┌───────────▼───────────┐
              │      Nova Endpoint    │
              │    (per agent)        │
              │                       │
              │  ┌─────────────────┐  │
              │  │   Gate Service  │  │
              │  │                 │  │
              │  │  1. A2A verify  │  │
              │  │  2. Trust tier  │  │
              │  │  3. UCAN check  │  │
              │  │  4. Schema val  │  │
              │  │  5. Injection   │  │
              │  │     classify    │  │
              │  └────────┬────────┘  │
              │           │           │
              │  ┌────────▼────────┐  │
              │  │   Task Queue    │  │
              │  │  (prioritised   │  │
              │  │   by trust tier)│  │
              │  └────────┬────────┘  │
              └───────────┼───────────┘
                          │
                          │  Structured task
                          │
              ┌───────────▼───────────┐
              │    Agent              │
              │    (operator's        │
              │     infrastructure)   │
              └───────────────────────┘
```

Each agent registered with Nova gets its own endpoint — its own Gate Service configuration, its own trust tier registry, its own UCAN capability space, its own task queue, its own audit log. Agents are isolated from each other. Agent A's messages never touch Agent B's pipeline.

---

## The Security Model

Nova's security model has five layers, applied in order to every inbound message. All five are mandatory. If any dependency is unavailable, the gate rejects — it never degrades to a less-secure mode.

### Layer 1 — Transport Verification
Every inbound A2A message must be authenticated at the transport layer. Nova verifies the request came from the claimed sender before any further processing.

### Layer 2 — Trust Tier
Every sender has a trust tier — 0 (unknown) through 3 (operator). Tier is assigned by the agent operator, not self-declared by the sender. Unknown senders are quarantined for operator review, not silently dropped and not silently accepted.

| Tier | Name | Actions Available |
|------|------|-------------------|
| 0 | Unknown | None — quarantine |
| 1 | Known | Read, query, respond |
| 2 | Trusted | + Write, external calls |
| 3 | Operator | Full access |

### Layer 3 — UCAN Capability Delegation
Sending agents must present a UCAN token proving they have been explicitly delegated the capability they are attempting to use. Capability delegation is cryptographic — it does not require Nova to call home to verify. The delegation chain is self-contained in the token.

This is the differentiator from OAuth2 and API key models. There is no ambient authority. A token that proves "I can query knowledge" proves nothing about scheduling actions. Capability is scoped, delegated, and verifiable.

### Layer 4 — Schema Validation
Messages must conform to Nova's typed task schema. The task intent must be a value in a closed enum — a fixed set of operations the agent operator has declared. New intents require a code change and operator review. This is intentional: it makes the attack surface explicit and bounded.

Free text never reaches the agent directly from an external sender. All input is structured and typed before the agent sees it.

### Layer 5 — Injection Classification
String fields in task parameters are scanned for prompt injection patterns — text crafted to manipulate the receiving agent's behaviour. Two-stage classification: deterministic pattern matching first, LLM-based classification second. If either stage detects injection, the message is quarantined and the operator is alerted.

---

## The Trust Model

Nova uses UCAN (User Controlled Authorization Networks) for capability delegation. The choice is deliberate.

Most agent authorisation today uses API keys or OAuth2 tokens. Both are centralised — revocable and verifiable only by calling the issuer. Both grant ambient authority — a token that works once works for everything it's scoped to, with no delegation chain.

UCANs are different:

- **Decentralised** — verification is cryptographic, no call home required
- **Delegatable** — an operator can issue a UCAN to Agent A, Agent A can delegate a subset of that capability to Agent B, without involving Nova
- **Auditable** — the full delegation chain is embedded in the token
- **Scoped** — a token proving capability X proves nothing about capability Y

For regulated industries — finance, healthcare, legal, anything with audit requirements — this is a meaningful compliance story. You can prove, cryptographically, that a specific agent was delegated a specific capability by a specific operator, at a specific time, for a specific duration.

---

## Key Design Decisions

### A2A as the wire protocol

Nova implements Google's A2A standard as its wire protocol. The decision:

**Why A2A:** Purpose-built for agent-to-agent communication. Has native task lifecycle (submitted, working, input-required, completed, failed). Agent card discovery is cleaner than WebFinger. Growing ecosystem support from Google, Microsoft, and major agent frameworks. Using a standard means any A2A-compatible agent can reach Nova-protected agents without custom integration.

**What we considered:** ActivityPub. Federation model is genuinely decentralised. But it was designed for social communication — its data model fights structured task exchange at every turn. The "using A2A" conversation with any integration partner is simple. The "using ActivityPub with custom task semantics" conversation is not.

### SSE over WebSocket for streaming

Long-running tasks stream progress updates via Server-Sent Events, not WebSockets.

**Why SSE:** Agent task exchange is fundamentally unidirectional after initiation — the sender sends once, receives updates. SSE covers this with less complexity, less maintenance, and native HTTP semantics. WebSocket buys bidirectionality that agent task exchange doesn't need.

### UCAN as the sole credential

UCAN tokens are the authentication credential for Nova endpoints. There is no parallel bearer token scheme.

**Why:** Two auth systems on one endpoint create unclear precedence when they conflict and double the attack surface. UCANs are JWTs — they carry the delegation chain, prove capability, and can be used directly as credentials. Session management, where needed for performance, is a derived concern handled separately.

### Closed intent enum

The set of operations an agent accepts is a fixed enum, not an open string field. Adding a new intent requires a code change, a new handler, a new system prompt, and operator review.

**Why:** An open intent field means the attack surface grows every time a sender tries something new. A closed enum means the attack surface is always visible, always bounded, and always requires explicit operator approval to extend.

### Structured-only ingress

External agents never send free text that reaches the receiving agent directly. All input is typed, schema-validated, and injection-classified before the agent sees it.

**Why:** Prompt injection is the primary attack vector against LLM-based agents. The most effective mitigation is architectural — remove the free text path entirely. If there is no way for an external sender to put arbitrary text in front of the receiving agent's LLM, the injection surface is dramatically reduced.

### Per-intent system prompt constraints

Each intent has its own system prompt. No agent has a single "do anything" system prompt. Each prompt includes explicit scope constraints, input format declaration, injection resistance instructions, output format constraints, and refusal instructions.

**Why:** Even with structured ingress, the LLM is processing external content. Per-intent prompts limit what the LLM can be directed to do by that content, independent of what the content says.

---

## What Nova Provides to Agent Operators

- A registered agent gets an A2A-compatible endpoint with a published agent card
- The operator configures which other agents can send messages (trust tier registry)
- The operator issues UCAN tokens to senders they want to grant capability
- Every message is gate-validated before the agent sees it
- Every event is written to an append-only audit log
- High-privilege operations require operator confirmation before execution
- Failed deliveries are retained in a dead letter store, not silently lost
- The operator has an Admin API for managing trust, reviewing quarantine, and querying audit history

---

## What Nova Provides to Sending Agents

- Discovery via A2A agent cards — no custom integration required
- A standard A2A task interface — submit tasks, receive structured results
- SSE streaming for long-running tasks — no polling required
- Clear error codes when messages are rejected — actionable, not opaque
- Idempotent task submission — safe to retry without double-execution

---

## What Nova Does Not Decide

- What LLM the receiving agent uses
- How the receiving agent reasons about tasks
- Where the receiving agent is deployed
- What tools the receiving agent has access to (that is MCP's domain)
- Whether a task result is correct — Nova delivers results, it does not validate them

---

## The Three Documents

This overview is one of three documents that together specify Nova completely.

**nova-overview.md** (this document)
What Nova is, why it exists, the key design decisions and their rationale. Audience: anyone evaluating Nova, joining the project, or making architectural decisions about it.

**nova-protocol-spec.md**
How to build an agent that communicates with Nova-protected agents. Language agnostic. Covers A2A compliance requirements, UCAN token format and attachment, trust tier semantics, task lifecycle, error codes, and agent card format. Audience: external developers building compatible agents.

**nova-platform-spec.md**
How to build Nova itself. Node.js/TypeScript implementation. Package structure, component specifications, data schemas, deployment, operations, security procedures, backup and recovery. Audience: the team building Nova.

---

*Nova overview — v1.0*
*See nova-protocol-spec.md and nova-platform-spec.md for complete specifications.*
