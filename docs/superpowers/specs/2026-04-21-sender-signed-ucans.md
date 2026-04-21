# Sender-signed UCANs — abandoning the Nova-as-notary model

**Status:** implemented 2026-04-21. E2E verified: broker→broker send with no `replyTo`, grant issued at approval, invocation minted locally, gate chain-verified, delivery + respond + reply-inbox round-trip all green.
**Scope:** Replace Nova-signed self-UCANs with canonical delegation-chain UCANs where the sender signs with its own key. Root of trust for capabilities becomes a Nova-signed *approval grant* carried as `prf` in the sender's token.
**Motivation:** Today `iss = aud = novaDid` on every issued UCAN (`packages/admin-api/src/services/ucan-service.ts:45-61`). The sender's DID never appears in the token payload, so ingress cannot resolve the sender from the UCAN alone — which is why broker→broker sends fail with `REPLY_TARGET_UNRESOLVED` (documented failure mode in `packages/a2a-server/src/index.ts:270`). The notary model also requires a PoP round-trip (`requestUcan`, `/admin/tenants/:id/ucans/request`) just to hand the sender back a token signed by Nova — a redundant trust bounce given the sender has already proved possession of its key.

---

## The new token shape

Two token types. Both are valid UCAN JWTs produced by `@ucans/ucans@0.12.0`.

### 1. Approval grant (Nova → sender)

Issued once at agent-approval time by admin-api. Delegates a capability root to the sender.

```
iss: novaDid                      // Nova's gateway key
aud: <sender agent DID>           // e.g. did:key:z6Mkwbkez...
att: [{ with: "nova:<tenantId>:*", can: "invoke" }]   // broad tenant-scope grant
exp: <approval_ttl>               // default 30d, renewable
nnc: <random>
```

This is a standard UCAN delegation. The sender holds it locally (replaces the self-UCAN stashed in `~/.nova/agents/<agentId>.ucan.json`).

### 2. Invocation token (sender → Nova, per request)

The sender mints this on demand with its own private key. It proves the sender wants to exercise a narrow capability right now, rooted in the approval grant.

```
iss: <sender agent DID>           // signed by sender's Ed25519 private key
aud: novaDid                      // Nova is the recipient/gate
att: [{ with: "nova:<tenantId>:<destAgentId>:skill:<skillId>", can: "invoke" }]
exp: <short — 5m default>
prf: [<approval_grant_jwt>]       // chain root
```

Ingress uses `@ucans/ucans` `delegationChains` to verify the chain:
1. Signature on invocation token verifies against `iss` pubkey (from the agent registry via DID → pubkey lookup).
2. `prf[0]` is the approval grant — signature verifies against Nova's pubkey.
3. Grant's `att` must subsume the invocation's `att` (narrowing only).
4. No token in the chain is revoked.

After verification, `senderDid = iss` is trustworthy; ingress's `getAgentByDid(senderDid)` resolves, and the broker→broker reply-routing bug goes away as a side effect.

---

## Component-by-component change map

### `packages/admin-api/src/services/ucan-service.ts`

- `issueUcan` → renamed `issueApprovalGrant`. Iss stays novaDid, but **aud becomes the subject (sender) DID** instead of novaDid, and att is a tenant-scoped root grant.
- `requestUcan` (cross-destination PoP) → **deleted**. Senders mint per-destination invocation tokens locally from their approval grant; no admin-api call needed.
- `reissueUcan` → renamed `reissueApprovalGrant`, same shape as issuance.
- `renewSubmit` (nonce-based self-UCAN renewal) → **deleted**. Sender just mints a new invocation token whenever; only the grant needs renewing, which is a direct admin-api call signed with the old grant's chain (or operator-authed).
- `issuedDir` metadata format stays — CID → sender DID, expiry, revoked bit. Still used for revocation.

### `packages/admin-api/src/routes/agents.ts` (approve handler)

- Writes trust-registry entry (unchanged).
- Calls `issueApprovalGrant` for the approved agent, aud=agent DID.
- Stashes the grant in Redis `nova:grant-claim:<tenantId>:<agentId>` with 1h TTL for one-time pickup (same pattern as today's UCAN stash).

### `packages/gate-service/src/ucan-verifier.ts`

Full rewrite. Uses `@ucans/ucans` `validate` + `validateProofs` / `delegationChains`. Shape:

```ts
export async function verifyUCAN(ucanJwt: string, ctx: TenantContext, destAgentDid: string): Promise<UCANVerificationResult> {
  const ucan = await ucans.validate(ucanJwt);
  // 1. aud must be novaDid (gateway is the receiver)
  if (ucan.payload.aud !== (await loadAgentDid())) return { valid: false, reason: 'ucan_wrong_audience' };
  // 2. iss must be a registered, active Nova agent
  const sender = await getAgentByDid(redis, ucan.payload.iss);
  if (!sender || sender.status !== 'active') return { valid: false, reason: 'actor_unknown' };
  // 3. Full chain validation — proofs, signatures, capability subsumption, revocation
  for await (const chain of ucans.delegationChains(novaSemantics, ucan, isRevoked)) {
    if (chain instanceof Error) return { valid: false, reason: 'ucan_invalid_chain' };
    // 4. Chain root must be a Nova-signed approval grant
    // 5. Invocation's att must subsume required `nova:<t>:<destAgentId>:skill:<skillId>`
  }
  return { valid: true, issuerDid: ucan.payload.iss };
}
```

`extractIssuerDid` stays — now actually returns the sender's DID.

### `packages/gate-service/src/pipeline.ts`

No change in logic — `senderDid = extractIssuerDid(ucanJwt)` still works, but now returns the correct value. Trust-tier resolution keys on the sender's DID (which is how the trust-registry records are already written). The auto-seeded "Nova root" trust record at `packages/admin-api/src/services/agent-service.ts:*` (seen at approval time) becomes unnecessary and should be removed.

### `packages/a2a-server/src/index.ts`

No code change. `getAgentByDid(gateResult.senderDid)` now resolves because `senderDid` is the sender agent's DID. `REPLY_TARGET_UNRESOLVED` path becomes a genuine error case (e.g., sender was deregistered between send and ingest), not a structural bug.

### `packages/mcp-server/src/ucan-store.ts`

- Self-UCAN store → approval-grant store. Filename stays `<agentId>.ucan.json` for disk compatibility; shape changes.
- Per-destination UCAN cache → **local mint cache**. On `nova_send_task`, mint a fresh invocation token signed with the sender's private key (loaded from `agents/<agentId>.json`), with `prf` = approval grant. 5-minute expiry; negligible cost to mint.

### `packages/mcp-server/src/nova-client.ts`

- Drop `requestUcan`.
- Task submission now carries `Authorization: UCAN <invocation_jwt>`; the `<invocation_jwt>` is minted locally, not fetched.

### `packages/mcp-server/src/tools.ts`

- `nova_renew_ucan` → renews the approval grant (calls admin-api with proof via current grant); sender-side invocation minting needs no renewal.
- `nova_ucan_status` → reports grant expiry + whether a grant exists.

### Scripts

- `scripts/issue-ucan.ts` → repurpose as `issue-grant.ts` or delete (approval handler already does it).
- `scripts/acceptance-test-m1.ts` through `m5.ts`, `-broker.ts`, `-broker-reply.ts`, `-p2.7-rotation.ts`, `-p2.8-keychain.ts`, `-p2.9-status-check.ts` — audit each. Most use `scripts/issue-ucan.ts` or equivalent to mint tokens; those paths all change.
- `scripts/did-exchange.ts` — already designed around sender-signed verification; fold its helpers into ucan-verifier.
- `scripts/rotate-keys.ts` (gateway keys) — untouched.
- Agent-key rotation (`scripts/acceptance-test-p2.7-rotation.ts`) — needs a small update: rotating an agent's key invalidates all invocation tokens (signature chain breaks), which is correct. Old grants stay valid until refreshed with new key.

---

## Key decisions that need sign-off

### D1 — Token audience

Two reasonable choices:
- **aud = novaDid** (Nova is the notary/gate — recommended). Simpler: one key to verify the audience against, matches "token presented to the gateway." Matches today's audience check.
- **aud = destAgentDid** (token is for the destination agent itself). More canonical UCAN, but requires ingress to know the destination agent's DID to validate audience, and recipients in broker mode don't directly consume the token.

**Recommend: aud = novaDid.** Simpler, matches the gating reality.

### D2 — Grant scope

Two options for the approval grant's `att`:
- **Broad tenant scope** (`nova:<tenantId>:*`): sender can invoke any agent in its own tenant *and* (via discovery) any cross-tenant agent it has discovered. Narrowing happens in the invocation token.
- **Per-skill grant**: operator approves specific skills the sender can invoke. More restrictive but requires re-approval for new capabilities.

**Recommend: broad tenant scope.** Current approval flow is "trust this sender at tier N"; skill-level granularity is already enforced at the destination by its own registered skill list. Keeping the grant broad matches existing operator intuition.

### D3 — Backwards compatibility

- **Option A — clean break.** Wipe tenants + Redis, re-onboard claude-code and hermes under the new model. We did this today already; two agents to redo. Low cost.
- **Option B — dual-verify.** Ingress accepts either old Nova-notary UCANs OR new delegation-chain UCANs for a transition window. Doubles the verifier surface; keeps acceptance tests alive.

**Recommend: Option A — clean break.** Nothing is in production. The whole point of D is "do it right"; carrying legacy shapes through a protocol redesign is how you accumulate the technical debt we're refactoring out of.

### D4 — Revocation keying

Today: revoked CIDs tombstone under `data/tenants/*/ucans/revoked/`. Invocation tokens now have CIDs too but are ephemeral (5 min); revoking them individually is pointless. Grants are the useful revocation target.

**Proposal: revocation tombstones apply to approval grants only.** Invocation tokens derive validity from the grant chain, so grant-revocation invalidates every derived invocation immediately. Add a lightweight "revoke grant" admin endpoint that just tombstones the grant CID.

---

## Migration plan (assuming D3: clean break)

Three phases, each independently committable:

**Phase 1: scaffolding.** Add `issueApprovalGrant` alongside `issueUcan`; add local-mint helpers to MCP server alongside existing self-UCAN loading. No wire changes. Tests still pass.

**Phase 2: cut over.** Admin-api approval now issues a grant (not a self-UCAN). MCP server mints invocation tokens locally. Gate verifier switches to chain validation. All acceptance tests updated in the same commit (they'll all fail mid-commit otherwise). Wipe + re-onboard claude-code and hermes as part of verification.

**Phase 3: cleanup.** Delete `requestUcan`, `renewSubmit`, and the now-dead PoP nonce flow for cross-destination UCANs (`packages/admin-api/src/services/nonce-service.ts` — keep nonces for the rotation flow, which still needs PoP). Delete the "Nova root" trust-registry auto-seed in the approve handler.

---

## Verification checklist

After Phase 2 is in:

- [ ] `scripts/acceptance-test-m1.ts` through `m5.ts` pass against the new stack.
- [ ] Re-onboard claude-code end-to-end; `curl /discover` shows it; local mint of an invocation token to a nonexistent destination returns `ucan_insufficient_capability` (grant subsumes but no destination means no agent card).
- [ ] Re-onboard hermes end-to-end; broker→broker send claude-code → hermes-agent without `replyTo` succeeds, reply lands in claude-code's reply inbox, `nova_next_reply` returns it, `nova_ack_reply` clears it.
- [ ] Revoke hermes's grant; next invocation from hermes fails with `ucan_revoked` (chain root revoked).
- [ ] Agent-key rotation: rotate claude-code's Ed25519 key via `scripts/rotate-keys.ts` equivalent; old-key-signed invocation tokens fail signature check; new-key-signed invocations pass.

## Non-goals for this bite

- Per-request HTTP-level PoP (the option-C design). Adds cryptographic authentication at the request layer on top of the UCAN's capability proof; useful but orthogonal. Separate bite.
- Federation. This redesign unblocks federation (senders from a peer Nova can be verified with only their registered pubkey — no trust in the peer Nova needed) but federation itself is a separate bite.
- Grant renewal flow polish. Phase 2 just needs a working renewal path; ergonomics (automatic renewal at <20% lifetime, etc.) is a phase-4 concern.
