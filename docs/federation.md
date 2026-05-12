# Federation: cross-Nova invocation

This is the operator runbook for setting up cross-Nova invocation. It walks
through the end-to-end flow: minting a federation grant on one Nova,
configuring trust on the other side, and verifying that an agent on Nova B
can call an agent on Nova A.

## What federation does

By default, every Nova trusts only itself. An agent registered on Nova A
can call other agents on Nova A; an agent on Nova B can call other agents
on Nova B. The two Novas don't know about each other.

Federation lets the operator of Nova A say: *"I delegate authority over
this scope to Nova B."* Once that delegation is in place, agents on Nova B
can construct a UCAN proof chain that walks back to Nova A's signature,
and Nova A's gate accepts the call.

A few invariants to keep in mind:

- **The receiver authorizes; the sender invokes.** Nova A (the receiver)
  decides which peer Novas can carry delegations into its tenants. Nova B
  (the sender) decides which of its agents can use those delegations.
- **Authority is cryptographic.** Trust is established by the signed UCAN
  chain, not by configuration. The operator's allowlist
  (`trusted-issuers.json`) is a defense-in-depth kill switch — it can
  remove a peer atomically without revoking individual grants.
- **Tenants are independent.** A federation grant scoped to
  `nova:public:calendar:*` does not give a peer access to
  `nova:billing:*`. The chain's capability narrows monotonically.
- **Names are local.** "claude-cli on Nova A" and "claude-cli on Nova B"
  are different agents with different DIDs. The name `claude-cli` is just
  a local label.

## Topology

```
Alice (planner agent)         Nova A's gate         Bob (calendar agent)
 on Nova B's machine    →   on alice.example   →     on alice.example
                                  │
                                  └── verifies the UCAN chain
                                      back to its own signature
```

The arrows are HTTP calls. Alice's MCP layer attaches a UCAN whose `prf`
chain proves Nova A authorized this scope to Nova B, and Nova B in turn
authorized Alice. Nova A walks the chain and either accepts or rejects.

## Prerequisites

Both Novas should be running with `did:web` identities so each can
publish its public key under `/.well-known/did.json`. Generate them once:

```bash
# On Nova A
npm run generate-keys -- --did-web=alice.example.com

# On Nova B
npm run generate-keys -- --did-web=bob.example.com
```

This writes `data/keys/nova.did` with the `did:web:…` form and
`data/keys/nova.private.pem` with the Ed25519 signing key. The
`a2a-server` will start serving the DID document at
`https://<host>/.well-known/did.json` after restart.

Verify both ends are reachable:

```bash
curl -sf https://alice.example.com/.well-known/did.json | jq .id
# "did:web:alice.example.com"

curl -sf https://bob.example.com/.well-known/did.json | jq .id
# "did:web:bob.example.com"
```

## Step 1 — Mint the federation grant on Nova A

Nova A's operator issues a grant authorizing Nova B for some scope. The
scope follows the capability format used throughout Nova:
`nova:<tenant>:<agent-or-pattern>:*`.

```bash
ADMIN_TOKEN=$(cat /etc/nova/admin-token)

curl -sf -X POST https://alice.example.com/admin/federation/grants \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "peerDid":    "did:web:bob.example.com",
    "scope":      ["nova:public:calendar:*"],
    "expiryDays": 30,
    "note":       "Bob ↔ Alice calendar federation, 2026-Q2 rollout"
  }'
```

Response:

```json
{
  "jwt": "eyJhbGciOiJFZERTQSIs…",
  "cid": "0a3b…",
  "expiresAt": "2026-06-09T00:00:00.000Z",
  "peerDid": "did:web:bob.example.com"
}
```

The `jwt` is the artifact you hand to Nova B's operator. The `cid` is the
revocation handle — keep it.

## Step 2 — Add Nova B to the trusted-issuers allowlist

Minting a grant is "I'm willing to issue you authority." Adding the peer
to `trusted-issuers.json` is "I'm willing to accept invocations chained
through you." They are intentionally two steps so operators can pre-issue
grants without yet enabling them.

```bash
# On Nova A
cat > data/keys/trusted-issuers.json <<'EOF'
{
  "trusted": [
    "did:web:bob.example.com"
  ]
}
EOF

# Restart so the trusted set reloads
systemctl restart nova-a2a nova-gate
```

If `trusted-issuers.json` is missing or `bob.example.com` isn't listed,
the gate rejects federated chains with `chain_peer_untrusted`. The
defense-in-depth check fires only for chains of length > 2 — i.e.
federation chains. Today's tenant-local single-link grants
(`chainLength: 2`) are unaffected.

## Step 3 — Receive and store the grant on Nova B

Nova B's operator gets the JWT out-of-band and gives it to the agent's
MCP layer.

> **Note.** As of this writing, MCP-side import of a federation grant is
> a manual step. The agent's MCP server needs to include the JWT in the
> `prf` chain when minting invocations targeting Nova A. A formal import
> primitive is on the roadmap; for now, treat the JWT as configuration:
> store it in the agent's secret store, and have the MCP server attach
> it when the outbound target matches `did:web:alice.example.com`.

The invocation Alice's MCP produces looks like:

```json
{
  "iss": "did:key:z6Mk…alice…",
  "aud": "did:web:alice.example.com",
  "att": [{ "with": "nova:public:calendar:check_availability", "can": "invoke" }],
  "prf": [
    "<Nova B's grant to alice>",
    "<Nova A's federation grant to Nova B>"
  ],
  "exp": <now + 5 minutes>,
  "jti": "<random>"
}
```

Alice's grant from Nova B is the standard per-agent approval grant —
nothing new here. The federation grant is what makes the chain walk back
to Nova A.

## Step 4 — Smoke test

From Nova B's host, invoke a calendar skill on Nova A:

```bash
curl -sf -X POST https://alice.example.com/agents/calendar/tasks \
  -H "Authorization: UCAN $(./mint-invocation.sh calendar check_availability)" \
  -H "Content-Type: application/json" \
  -d '{ "skill": "check_availability", "input": { "date": "2026-05-15" } }'
```

A successful response means the chain validated and the request was
queued for the calendar agent. Confirm in Nova A's audit log:

```bash
tail -n 1 data/audit/public/audit-$(date +%F).jsonl | jq .
```

Look for:

```json
{
  "event": "ucan_verified",
  "metadata": {
    "chainLength": 3,
    "peerDid": "did:web:bob.example.com"
  }
}
```

`chainLength: 3` confirms this came through a federation chain (vs. 2 for
a local grant). `peerDid` attributes the request to a specific peer Nova.

## Operational surface

| Action | Endpoint / file |
|---|---|
| Mint a federation grant | `POST /admin/federation/grants` |
| List issued federation grants | `GET /admin/federation/grants` |
| Revoke (any UCAN, by CID) | `POST /admin/tenants/<tenant>/ucans/revoke` |
| Add/remove a trusted peer | `data/keys/trusted-issuers.json` + service restart |
| Verify the published DID doc | `GET /.well-known/did.json` |
| Audit federated traffic | `data/audit/<tenant>/audit-<date>.jsonl`, filter on `metadata.peerDid` |

## Troubleshooting

Audit events use the `reason` field for the categorical failure; the
`metadata.chainDepth` field (when present) tells you where in the chain
the rejection happened (`0` = outer, `1` = immediate grant, `2` = peer
grant in a federation chain, …).

| `reason` | Likely cause | Fix |
|---|---|---|
| `chain_no_root` | The chain doesn't terminate at a link signed by this Nova. Usually because the peer attached the wrong federation grant (or none). | Confirm Nova B is attaching Nova A's federation grant to the chain, not Nova B's own self-grant. |
| `chain_peer_untrusted` | Chain is cryptographically valid but the peer Nova isn't in `trusted-issuers.json`. | Add the peer's DID and restart. Verify the trusted entry matches the chain root's `aud` exactly (case-sensitive). |
| `chain_audience_mismatch` | Some link's `aud` doesn't equal the next link's `iss`. Typical when the federation grant was issued to a different peer DID than the one currently signing. | Re-mint the federation grant with the correct `peerDid`. |
| `chain_capability_widened` | Some link claims more authority than its parent grants. Usually the agent's grant from Nova B has a broader scope than the federation grant it's chaining through. | Narrow the agent's grant to fit within the federation scope. |
| `chain_link_invalid_signature` | A link's signature doesn't verify against its claimed `iss`. Either the iss is wrong, or the JWT was tampered with. | Re-mint the affected link. If the failing link is the federation grant, suspect a copy-paste error. |
| `chain_link_expired` | A link's `exp` has passed. | Re-mint. Federation grants default to 30 days; reissue before expiry. |
| `chain_root_has_proofs` | The chain root claims to be Nova-signed but also carries proofs of its own — looks like an attempt to graft a longer chain onto our trust anchor. | Almost certainly malicious; investigate the sender. |
| `chain_link_too_many_proofs` | A link carries more than one entry in `prf`. Nova currently requires strict-chain semantics (one proof per link). | Reissue with a single proof per link. Multi-proof composition isn't supported in this version. |
| `chain_too_deep` | Chain exceeds the depth bound (default 8). | Either the chain is malformed (loop) or there are too many intermediate delegations. Federation chains are typically depth 3. |
| `ucan_revoked` | Some link in the chain has its CID in `data/ucans/revoked/`. | Mint a new grant or remove the tombstone if the revocation was a mistake. |

## Threat model

The federation flow assumes:

- Operators of both Novas are trustworthy with respect to their own
  Nova's signing key.
- The out-of-band JWT transfer (operator-to-operator) is over an
  authenticated channel.
- DNS for `did:web` hosts is not under active attack, AND the DID
  document is served over HTTPS with a valid certificate.
- The `trusted-issuers.json` file is only writable by the operator.

If a peer Nova's signing key is compromised, the attacker can mint
invocations within the scope our federation grant authorized. Mitigations:

- Keep the federation scope narrow. Prefer `nova:public:calendar:*` over
  `nova:*:*` even if the peer is otherwise trusted.
- Keep expiries short and re-mint regularly.
- On compromise notification, remove the peer from
  `trusted-issuers.json` AND revoke the federation grant CID. Both close
  the breach; removing only the peer is faster but the grant remains
  valid against a future re-add.

## Limitations of this version

- **Outbound replies require `replyTo` URL.** When an agent on Nova A
  completes a federated task, its reply is delivered via the `replyTo`
  URL in the original task. Broker-mode reply queues don't currently
  flow cross-Nova.
- **MCP-side grant import is manual.** The peer's MCP server needs to
  know how to attach the federation grant to outbound invocations. No
  formal import primitive yet.
- **Discovery is out-of-band.** Operators exchange peer Nova URLs and
  DIDs manually. There's no federation directory.
- **Handle resolution.** `alice@bob.example.com` style addressing isn't
  implemented. Federation today is DID-to-DID; human-friendly names are
  a separate workstream.

These are intentional v1 scope cuts. The current code is enough to
demonstrate that the inbound trust pipeline works correctly; the outbound
+ discovery side is a separate phase.
