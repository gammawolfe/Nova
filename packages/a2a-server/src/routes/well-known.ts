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

wellKnownRouter.get('/.well-known/did.json', wellKnownHelmet, async (_req: Request, res: Response) => {
  const novaDid = await loadNovaDid();
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
    const pubKey = createPublicKey(await loadNovaPrivateKey());

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
      publicKey: pubKey,
      services,
    });

    res.set('Cache-Control', 'public, max-age=60');
    res.type('application/did+json').json(doc);
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Failed to build /.well-known/did.json');
    res.status(500).json({ error: 'DID_DOC_BUILD_FAILED' });
  }
});
