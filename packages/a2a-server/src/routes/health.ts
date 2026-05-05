// packages/a2a-server/src/routes/health.ts
//
// GET /agents/:agentId/health?ucanCid=XYZ
//
// Lightweight pre-flight probe for MCP clients. Returns current agent status
// (active | pending | deregistered | unknown) and, when ucanCid is supplied,
// the issue / revocation state of that specific UCAN. Public, no auth — the
// same information is already derivable via /discover and via observing
// gate-pipeline quarantine outcomes, so this endpoint is a convenience, not
// a new disclosure surface.
//
// Clients call this before nova_send_task so operator-driven revocations
// surface as an explicit AGENT_INACTIVE / UCAN_REVOKED error with remediation
// text, instead of the task silently quarantining at the destination gate.
// It is advisory: the server-side gate remains authoritative.
import { Router, Request, Response } from 'express';
import fsp from 'fs/promises';
import path from 'path';
import { DATA_ROOT } from '@nova/shared';
import { getSharedRedis } from '@nova/shared';
import { getAgentMeta } from '@nova/shared';
import { logger } from '@nova/shared';

export const healthRouter = Router({ mergeParams: true });

// cid format matches `computeCid` in admin-api ucan-service: sha256 hex
// truncated to 32 chars. Reject anything outside [0-9a-f]{32} to avoid
// path-traversal via ucanCid.
const CID_RE = /^[0-9a-f]{32}$/;

const issuedDir = path.join(DATA_ROOT, 'ucans', 'issued');
const revokedDir = path.join(DATA_ROOT, 'ucans', 'revoked');

async function fileExists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true; } catch { return false; }
}

healthRouter.get('/:agentId/health', async (req: Request, res: Response) => {
  const agentId = req.params['agentId'];
  if (!agentId) return res.status(400).json({ error: 'INVALID_AGENT_ID' });

  let agentStatus: 'active' | 'pending' | 'deregistered' | 'unknown' = 'unknown';
  try {
    const meta = await getAgentMeta(getSharedRedis(), agentId);
    if (meta) agentStatus = meta.status as typeof agentStatus;
  } catch (err: any) {
    logger.warn({ err: err.message, agentId }, 'health probe: agent-meta lookup failed');
  }

  const response: {
    agentId: string;
    agentStatus: typeof agentStatus;
    ucan?: { cid: string; revoked: boolean; expiresAt?: string; found: boolean };
  } = { agentId, agentStatus };

  const ucanCid = req.query['ucanCid'];
  if (typeof ucanCid === 'string' && ucanCid.length > 0) {
    if (!CID_RE.test(ucanCid)) {
      return res.status(400).json({ error: 'INVALID_CID', message: 'ucanCid must be 32 lowercase hex chars' });
    }
    const revoked = await fileExists(path.join(revokedDir, ucanCid + '.json'));
    let expiresAt: string | undefined;
    let found = false;
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(issuedDir, ucanCid + '.json'), 'utf8'));
      expiresAt = meta.expiresAt;
      found = true;
    } catch { /* not in issued set — may have been rotated out or never existed */ }
    response.ucan = { cid: ucanCid, revoked, found, ...(expiresAt ? { expiresAt } : {}) };
  }

  res.json(response);
});
