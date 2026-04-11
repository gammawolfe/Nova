/**
 * scripts/issue-ucan.ts
 * Issue a UCAN JWT delegating nova task capabilities to a DID.
 *
 * Usage:
 *   npx tsx scripts/issue-ucan.ts \
 *     --audience <recipientDid> \
 *     --tenant <tenantId> \
 *     --agent <agentId> \
 *     --lifetime <seconds>  (default: 86400)
 *     --skills <skill1,skill2,...> (default: all)
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as ucans from '@ucans/ucans';

const DATA_ROOT = process.env.DATA_ROOT || path.resolve(process.cwd(), 'data');

function usage(): never {
  console.error(`
Usage: npx tsx scripts/issue-ucan.ts \\
  --audience <recipientDid> \\
  --tenant <tenantId> \\
  --agent <agentId> \\
  [--lifetime <seconds>] \\
  [--skills <skill1,skill2>]
`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const audience = get('--audience') ?? usage();
  const tenantId = get('--tenant') ?? usage();
  const agentId = get('--agent') ?? usage();
  const lifetimeSecs = parseInt(get('--lifetime') ?? '86400', 10);
  const skillsArg = get('--skills');

  // Load Nova's private key
  const privKeyPath = path.join(DATA_ROOT, 'keys', 'nova.private.pem');
  if (!fs.existsSync(privKeyPath)) {
    console.error(`Private key not found at ${privKeyPath}. Run: npm run generate:keys`);
    process.exit(1);
  }

  // Read PEM key and convert to EdKeypair
  const privKeyPem = fs.readFileSync(privKeyPath, 'utf8');
  // Extract raw key bytes from PEM
  const privKeyDer = Buffer.from(
    privKeyPem
      .replace('-----BEGIN PRIVATE KEY-----', '')
      .replace('-----END PRIVATE KEY-----', '')
      .replace(/\s+/g, ''),
    'base64'
  );

  // Ed25519 PKCS#8 DER prefix (32 byte private key follows after 16 byte prefix)
  const rawPrivKey = privKeyDer.slice(16); // Strip PKCS#8 header
  const keypair = await ucans.EdKeypair.fromSecretKey(
    Buffer.from(rawPrivKey).toString('base64pad')
  );

  const issuerDid = keypair.did();
  const capabilities: ucans.Capability[] = [];

  if (skillsArg) {
    // Per-skill capabilities
    for (const skill of skillsArg.split(',').map(s => s.trim())) {
      capabilities.push({
        with: `nova:${tenantId}:${agentId}:skill:${skill}`,
        can: 'nova/task',
      } as ucans.Capability);
    }
  } else {
    // Wildcard capability for all tasks on this agent
    capabilities.push({
      with: `nova:${tenantId}:${agentId}`,
      can: 'nova/task',
    } as ucans.Capability);
  }

  const ucan = await ucans.build({
    issuer: keypair,
    audience,
    capabilities,
    lifetimeInSeconds: lifetimeSecs,
  });

  const token = ucans.encode(ucan);

  // Compute stable identifier for revocation (sha256 of JWT)
  const cid = crypto.createHash('sha256').update(token).digest('hex');

  // Store issued UCAN metadata
  const issuedDir = path.join(DATA_ROOT, 'tenants', tenantId, 'ucans', 'issued');
  fs.mkdirSync(issuedDir, { recursive: true });
  const metadata = {
    cid,
    token,
    issuer: issuerDid,
    audience,
    tenantId,
    agentId,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + lifetimeSecs * 1000).toISOString(),
    skills: skillsArg?.split(',') ?? ['*'],
  };
  fs.writeFileSync(path.join(issuedDir, cid + '.json'), JSON.stringify(metadata, null, 2));

  console.log('\n✅ UCAN issued successfully');
  console.log(`Issuer:    ${issuerDid}`);
  console.log(`Audience:  ${audience}`);
  console.log(`Expires:   ${metadata.expiresAt}`);
  console.log(`CID:       ${cid}`);
  console.log('\nToken (add to Authorization header as "UCAN <token>"):');
  console.log(token);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
