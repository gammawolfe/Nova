# Admin UI Manual Test Playbook

Use this for the real-world onboarding test — spinning up the stack and
walking an operator through creating a galaxy, issuing an invite, and
approving a self-registered planet.

## Preflight

```bash
# One-time
npm install
npm run generate:keys       # writes data/keys/nova.{did,private.pem}

# Every session
docker compose up -d redis
ADMIN_TOKEN=dev-token REDIS_URL=redis://localhost:6379 \
  npm --workspace=packages/admin-api run dev
```

Open <http://localhost:3005/>.

## Test 1 — Login

1. Submit empty token → HTML5 required validation blocks submit.
2. Submit `wrong` → shake animation + "Invalid token." visible.
3. Submit `dev-token` → lands on the **Galaxies** home.
4. Refresh → stays on home (sessionStorage restores the token).
5. Click **Log out** → back to login.

## Test 2 — Create galaxy

1. On home, click **+ New galaxy**.
2. Submit with slug `ACME Corp` (uppercase + space) → blocked by input
   pattern (no POST fires).
3. Submit with `acme-corp`, name `ACME`, plan `developer` → URL changes
   to `#/galaxy/acme-corp`, detail header renders with the galaxy DID.

## Test 3 — Issue invite

1. On galaxy detail, click **+ Issue invite** and submit defaults.
2. Reveal modal appears with QR code, the JWT body, jti, and expiry.
3. Click **Copy token** → button flashes "Copied ✓".
4. Keep the token somewhere for the next step, then click **Dismiss**.

## Test 4 — Self-register a planet

In another terminal (substitute `$JWT` for the copied token):

```bash
JWT=paste-here
PUB=$(openssl genpkey -algorithm ed25519 -outform der | tail -c 32 | base64)
curl -s -X POST http://localhost:3005/admin/register \
  -H 'Content-Type: application/json' \
  -d "{
    \"invite\": \"$JWT\",
    \"agentId\": \"planet_manual\",
    \"name\": \"Manual Planet\",
    \"publicKey\": \"$PUB\",
    \"did\": \"did:key:zManualTest\",
    \"skills\": [{\"id\":\"ping\",\"name\":\"Ping\",\"description\":\"Pings\"}]
  }"
```

If `/admin/register` is mounted on a2a-server instead of admin-api (it is,
as of this writing — see `packages/a2a-server/src/routes/register.ts`),
target `http://localhost:3001/register` instead.

Expected in the browser (without refreshing): a pending card for
`planet_manual` appears within ~2s, driven by the SSE subscription.

## Test 5 — Approve

1. Click **Approve** on the pending card.
2. In the modal: tier 1, skills `ping`, expiry 30, submit.
3. Toast "UCAN issued · <cid>…" appears. Card moves out of pending.

## Test 6 — Reject

Repeat Test 4 with `planet_reject`, then click **Reject**, confirm. Card
disappears.

## Test 7 — SSE resilience

Kill admin-api while the UI is on a galaxy detail page:

```bash
pkill -f 'admin-api/dist/index.js'
```

Restart:

```bash
ADMIN_TOKEN=dev-token REDIS_URL=redis://localhost:6379 \
  npm --workspace=packages/admin-api run dev
```

Within ~30s the browser's EventSource reconnects. DevTools → Network →
`events` shows the re-established stream.

## Test 8 — Reduced motion

Browser DevTools → Rendering → emulate CSS `prefers-reduced-motion: reduce`.
Confirm:

- The starfield stops twinkling
- The mesh gradient stops drifting
- The CTA button stops pulsing
- The status ticker stops scrolling
