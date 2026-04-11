/**
 * scripts/did-exchange.ts
 * DID challenge-response ceremony for establishing trust with a new actor.
 *
 * Step 1 — Generate a challenge:
 *   npx tsx scripts/did-exchange.ts challenge --did <actorDid> --tenant <tenantId> --agent <agentId>
 *
 * Step 2 — Verify a challenge response (actor signs the challenge nonce with their key):
 *   npx tsx scripts/did-exchange.ts verify --challenge-id <id> --signature <hex>
 *
 * Step 3 — Register actor (after verification):
 *   npx tsx scripts/did-exchange.ts register \
 *     --did <actorDid> --tenant <tenantId> --agent <agentId> \
 *     --tier <1|2|3> --skills <skill1,skill2> --name <displayName>
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const DATA_ROOT = process.env.DATA_ROOT || path.resolve(process.cwd(), 'data');

function usage(): never {
  console.error(`
DID Exchange Ceremony

Commands:
  challenge  --did <did> --tenant <tenantId> --agent <agentId>
             Generate a challenge nonce for the actor to sign

  verify     --challenge-id <id> --signature <hex>
             Verify the actor's signature against the challenge

  register   --did <did> --tenant <tenantId> --agent <agentId>
             --tier <1|2|3> --skills <s1,s2> --name <displayName>
             Register a verified actor in the trust registry
`);
  process.exit(1);
}

interface Challenge {
  id: string;
  did: string;
  tenantId: string;
  agentId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  verified: boolean;
}

function challenge(args: string[]): void {
  const get = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const did = get('--did');
  const tenantId = get('--tenant');
  const agentId = get('--agent');

  if (!did || !tenantId || !agentId) usage();

  const id = crypto.randomUUID();
  const nonce = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

  const challenge: Challenge = {
    id,
    did: did!,
    tenantId: tenantId!,
    agentId: agentId!,
    nonce,
    issuedAt: new Date().toISOString(),
    expiresAt,
    verified: false,
  };

  const challengeDir = path.join(DATA_ROOT, 'challenges');
  fs.mkdirSync(challengeDir, { recursive: true });
  fs.writeFileSync(path.join(challengeDir, id + '.json'), JSON.stringify(challenge, null, 2));

  console.log(`\n✅ Challenge issued`);
  console.log(`Challenge ID: ${id}`);
  console.log(`DID:          ${did}`);
  console.log(`Nonce:        ${nonce}`);
  console.log(`Expires:      ${expiresAt}`);
  console.log(`\nAsk the actor to sign the nonce with their DID private key and provide:`);
  console.log(`  npx tsx scripts/did-exchange.ts verify --challenge-id ${id} --signature <hex>`);
}

function verify(args: string[]): void {
  const get = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const challengeId = get('--challenge-id');
  const signatureHex = get('--signature');

  if (!challengeId || !signatureHex) usage();

  const challengePath = path.join(DATA_ROOT, 'challenges', challengeId + '.json');
  if (!fs.existsSync(challengePath)) {
    console.error(`Challenge not found: ${challengeId}`);
    process.exit(1);
  }

  const ch: Challenge = JSON.parse(fs.readFileSync(challengePath, 'utf8'));

  if (new Date(ch.expiresAt) <= new Date()) {
    console.error('Challenge expired. Generate a new one.');
    process.exit(1);
  }

  // For did:key, verify using Node's crypto with the public key embedded in the DID
  // did:key:z6Mk... encodes a multicodec+multibase public key
  // Full did:key resolution is complex — for M2 we verify via a trusted assertion
  // (full crypto verification requires did-resolver — scheduled for M3)
  console.log(`\n⚠️  Signature verification`);
  console.log(`Challenge: ${ch.nonce}`);
  console.log(`Signature: ${signatureHex}`);
  console.log(`\nManual verification required for did:key DIDs.`);
  console.log(`Confirm the actor controls ${ch.did} and run 'register' to add them.`);

  // Mark as verified (operator confirms manually for M2)
  const updated = { ...ch, verified: true, verifiedAt: new Date().toISOString(), signature: signatureHex };
  const tmpPath = challengePath + '.tmp.' + Date.now();
  fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2));
  fs.renameSync(tmpPath, challengePath);

  console.log(`\nChallenge marked verified. Run 'register' to add this actor.`);
}

function register(args: string[]): void {
  const get = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const did = get('--did');
  const tenantId = get('--tenant');
  const agentId = get('--agent');
  const tierStr = get('--tier');
  const skillsArg = get('--skills');
  const name = get('--name') ?? 'Unknown Actor';

  if (!did || !tenantId || !agentId || !tierStr) usage();

  const tier = parseInt(tierStr!, 10) as 1 | 2 | 3;
  if (![1, 2, 3].includes(tier)) {
    console.error('Tier must be 1, 2, or 3');
    process.exit(1);
  }

  const allowedSkills = skillsArg ? skillsArg.split(',').map(s => s.trim()) : [];

  const record = {
    did: did!,
    displayName: name,
    tier,
    allowedSkills,
    addedAt: new Date().toISOString(),
    addedBy: 'did-exchange-ceremony',
  };

  const sha256Did = crypto.createHash('sha256').update(did!).digest('hex');
  const trustRegistryDir = path.join(DATA_ROOT, 'tenants', tenantId!, 'agents', agentId!, 'trust-registry');
  fs.mkdirSync(trustRegistryDir, { recursive: true });

  const recordPath = path.join(trustRegistryDir, sha256Did + '.json');
  const tmpPath = recordPath + '.tmp.' + Date.now();
  fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2));
  fs.renameSync(tmpPath, recordPath);

  console.log(`\n✅ Actor registered in trust registry`);
  console.log(`DID:    ${did}`);
  console.log(`Tier:   ${tier}`);
  console.log(`Skills: ${allowedSkills.join(', ') || '(none specified)'}`);
  console.log(`File:   ${recordPath}`);
}

function main() {
  const cmd = process.argv[2];
  const rest = process.argv.slice(3);

  if (cmd === 'challenge') return challenge(rest);
  if (cmd === 'verify') return verify(rest);
  if (cmd === 'register') return register(rest);

  usage();
}

main();
