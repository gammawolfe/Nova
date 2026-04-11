# Nova: Zero-Trust Agent-to-Agent Gateway

Nova is an AI-centric protocol layer, firewall, and reverse proxy designed specifically to securely broker external, cross-tenant AI agent API invocations. It replaces the naive, unauthenticated JSON API interactions seen in DIY agents with a hardened capability-based architecture.

## Architecture & Specifications

This repository acts as the host layer for the entire platform. 
Please refer strictly to the spec documents before altering root configurations:
- **`nova-overview.md`**: Broad design justifications and high-level architectural constraints.
- **`nova-protocol-spec.md`**: The external wire protocol interacting agents must abide by (UCAN parsing, Intent limits, Request schemas).
- **`nova-platform-spec.md`**: Internal system-architecture. Strict mapping of Gate functionality, queuing rules, tenant Redis isolation, and the Admin API schemas.

## Milestones & Setup

The Nova package relies strictly on isolated npm sub-workspaces (`packages/*`), sharing a strict unified Zod validation dependency via `@nova/shared`.

### Bootstrapping Identity

To initialize a localized Nova server, you must generate the gateway's cryptographic `did` (Decentralized Identifier) and internal keypair:

```bash
# Ensures local dependencies like @ucans/ucans are downloaded
npm install 

# Creates Ed25519 Keys under data/keys/
npm run generate:keys 
```

> [!WARNING]
> **Enterprise Deployments & Key Management:**
> By default, `generate-keys.ts` persists the private identity keys to the physical host volume (`data/keys/nova.private.pem`). This pattern strictly adheres to the platform spec for VPS or Docker Compose deploy targets.
>
> If deploying Nova into a massively distributed cluster (e.g. Kubernetes), do **not** rely on locally stored `.pem` capabilities. Instead, identity keys should be generated directly within an external Vault setup (AWS KMS, HashiCorp Vault) and loaded strictly via process environment variables at boot.

## Monorepo Layout 

| Package | Purpose |
|---------|---------|
| `@nova/shared` | Core isolated schemas, tenant boundaries, custom errors, Types. |
| `@nova/a2a-server` | Synchronous ingestion Gateway & protocol proxy routing. |
| `@nova/task-queue` | BullMQ Redis queuing framework wrapping async ingress tasks. |
| `@nova/agent-connector` | Worker looping to deliver verified payloads to the Operator's destination agents. |
| `@nova/gate-service` | The intensive, multi-layered security checks preventing Prompt Injection and DID failures. |
| `@nova/admin-api` | Local loopback Admin routing for issuing Operator tenant restrictions. |