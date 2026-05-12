// packages/a2a-server/src/routes/well-known.ts
//
// Nova-level well-known endpoints. Currently:
//
//   GET /.well-known/did.json
//     Publishes Nova's gateway identity as a W3C DID document, so peers can
//     resolve Nova's `did:web:<host>` to a verification key. Returns 404 when
//     Nova's DID is still in `did:key:` form (i.e. did:web has not been
//     adopted on this deployment) — the absence of a document is the
//     intended signal that the deployment is not yet federated.
//
// Per-agent well-known endpoints live on the per-agent router
// (`/agents/:agentId/.well-known/agent.json` in index.ts).

import { Router, Request, Response } from 'express';
import helmet from 'helmet';
import { logger } from '@nova/shared/src/logger';
import { loadNovaDid, loadNovaPrivateKey } from '@nova/shared/src/invites';
import { buildDidDocument, DidService } from '@nova/shared/src/did-document';
import { createPublicKey } from 'crypto';

export const wellKnownRouter = Router();

const wellKnownHelmet = helmet({
  contentSecurityPolicy: { directives: { 'default-src': ["'none'"] } },
  crossOriginEmbedderPolicy: false,
});

// ── /.well-known/did.json — cached read of nova.did + nova.private.pem ─────
//
// The endpoint sets `Cache-Control: public, max-age=60`, telling clients
// they may treat the response as fresh for 60s. Doing two disk reads on
// every request behind that header was leaving free perf on the table.
//
// Match the in-process key cache to the same TTL so the disk reads
// happen at most once per minute regardless of request rate. On rotation
// the operator already has to restart the process (private-key path is
// loaded once at boot in key-manager too), so a 60s window of stale-on-
// disk reads is consistent with the rest of the deployment model.

const DID_DOC_CACHE_TTL_MS = 60_000;

interface DidDocCache {
  novaDid: string;
  pubKey: ReturnType<typeof createPublicKey>;
  expiresAt: number;
}

let didDocCache: DidDocCache | null = null;

async function loadDidDocSources(): Promise<{ novaDid: string | null; pubKey: ReturnType<typeof createPublicKey> | null }> {
  if (didDocCache && didDocCache.expiresAt > Date.now()) {
    return { novaDid: didDocCache.novaDid, pubKey: didDocCache.pubKey };
  }
  const novaDid = await loadNovaDid();
  if (!novaDid) return { novaDid: null, pubKey: null };
  const pubKey = createPublicKey(await loadNovaPrivateKey());
  didDocCache = { novaDid, pubKey, expiresAt: Date.now() + DID_DOC_CACHE_TTL_MS };
  return { novaDid, pubKey };
}

wellKnownRouter.get('/.well-known/did.json', wellKnownHelmet, async (_req: Request, res: Response) => {
  const { novaDid, pubKey } = await loadDidDocSources();
  if (!novaDid) {
    return res.status(404).json({
      error: 'NO_DID',
      message: 'Nova gateway DID not configured. Run scripts/generate-keys.ts.',
    });
  }
  if (!novaDid.startsWith('did:web:')) {
    // Did:key Novas don't need a published document — the key is encoded in
    // the DID itself. Surface a clear 404 so peers understand this Nova has
    // not been provisioned for did:web federation.
    return res.status(404).json({
      error: 'NOT_DID_WEB',
      message: `This Nova publishes its identity as ${novaDid.split(':').slice(0, 2).join(':')}:..., not did:web. No DID document to serve.`,
    });
  }

  try {
    // Optional service entries describing where peers can reach Nova. The
    // A2A entrypoint is the host this DID document was served from; we
    // reconstruct it from the DID rather than the request to avoid leaking
    // a proxy hostname (caddy → a2a-server) into the public document.
    const novaHost = decodeURIComponent(novaDid.slice('did:web:'.length).split(':')[0]!);
    const services: DidService[] = [
      { id: '#a2a', type: 'NovaA2A', serviceEndpoint: `https://${novaHost}` },
    ];

    const doc = buildDidDocument({
      did: novaDid,
      publicKey: pubKey!,
      services,
    });

    res.set('Cache-Control', 'public, max-age=60');
    res.type('application/did+json').json(doc);
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Failed to build /.well-known/did.json');
    res.status(500).json({ error: 'DID_DOC_BUILD_FAILED' });
  }
});
