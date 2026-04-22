// scripts/acceptance-test-invite-whitespace.ts
/**
 * Whitespace-tolerance acceptance test for invite token parsing.
 *
 * Reproduces the failure mode that bit the Hermes onboarding session:
 * a JWT pasted through a terminal arrives with embedded newlines from
 * line-wrapping. verifyInvite previously fed the raw string (with
 * newlines) into crypto.verify and failed signature verification;
 * decodeInvitePayload tolerated the whitespace via base64url's loose
 * decoder. The two paths disagreed, which the server surfaced as
 * INVITE_INVALID — misleading the caller into believing the token had
 * been consumed.
 *
 * Both functions now normalize whitespace up front. This test mints an
 * invite, injects newlines into the middle of each segment, and asserts
 * that both functions accept the mangled input.
 *
 * Run:  npx tsx scripts/acceptance-test-invite-whitespace.ts
 * Requires: data/keys/nova.private.pem exists.
 */

import { createInvite, verifyInvite } from '../packages/shared/src/invites';
import { decodeInvitePayload } from '../packages/mcp-server/src/tenant-config';

let passed = 0;
let failed = 0;

function check(name: string, condition: unknown, detail?: string): void {
  if (condition) {
    console.log(`  \u2713 ${name}`);
    passed += 1;
  } else {
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`);
    failed += 1;
  }
}

function assertEq(name: string, actual: unknown, expected: unknown): void {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, match, match ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/**
 * Simulate terminal line-wrap mangling: break the token at ~60-char
 * intervals with a real \n. Matches what the Hermes session actually
 * pasted in.
 */
function mangleWithNewlines(token: string): string {
  const chunks: string[] = [];
  for (let i = 0; i < token.length; i += 60) {
    chunks.push(token.slice(i, i + 60));
  }
  return chunks.join('\n');
}

async function main(): Promise<void> {
  const tenantId = `t-ws-${Date.now()}`;
  const agentIdHint = `a-ws-${Date.now()}`;

  console.log('\nWhitespace-tolerant invite parsing:');

  const { token, jti, expiresAt } = await createInvite(tenantId, {
    agentIdHint,
    ttlSeconds: 300,
  });

  // Control: clean token works everywhere.
  const cleanPayload = await verifyInvite(token);
  assertEq('clean token verifies', cleanPayload.tenantId, tenantId);
  assertEq('clean token jti matches', cleanPayload.jti, jti);
  const cleanDecoded = decodeInvitePayload(token);
  assertEq('clean token decodes (agentIdHint)', cleanDecoded.agentIdHint, agentIdHint);

  // Mangled: embedded newlines across all three segments.
  const mangled = mangleWithNewlines(token);
  check('mangled token contains newlines', mangled.includes('\n'));

  try {
    const mangledPayload = await verifyInvite(mangled);
    assertEq('verifyInvite accepts mangled token (tenantId)', mangledPayload.tenantId, tenantId);
    assertEq('verifyInvite accepts mangled token (jti)', mangledPayload.jti, jti);
  } catch (e: any) {
    check('verifyInvite should not throw on mangled token', false, e.message);
  }

  try {
    const mangledDecoded = decodeInvitePayload(mangled);
    assertEq('decodeInvitePayload accepts mangled token', mangledDecoded.agentIdHint, agentIdHint);
  } catch (e: any) {
    check('decodeInvitePayload should not throw on mangled token', false, e.message);
  }

  // Leading/trailing whitespace — common when copy-pasting.
  const padded = `  \n${token}\n  `;
  try {
    const paddedPayload = await verifyInvite(padded);
    assertEq('verifyInvite tolerates leading/trailing whitespace', paddedPayload.jti, jti);
  } catch (e: any) {
    check('verifyInvite padded token', false, e.message);
  }

  // Tampered token — whitespace fix must not weaken signature verification.
  // Flip one character of the signature and assert rejection.
  const parts = token.split('.');
  const sigLen = parts[2]!.length;
  const flipped = parts[2]!.charAt(0) === 'A' ? 'B' + parts[2]!.slice(1) : 'A' + parts[2]!.slice(1);
  const tampered = `${parts[0]}.${parts[1]}.${flipped}`;
  check('tampered signature differs', tampered !== token && tampered.length === token.length);
  try {
    await verifyInvite(tampered);
    check('verifyInvite rejects tampered signature', false, 'expected throw');
  } catch (e: any) {
    check('verifyInvite rejects tampered signature', e.message.toLowerCase().includes('signature'));
  }

  console.log(`\n  expiresAt: ${expiresAt} (${sigLen}-char sig)`);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Acceptance test failed:', err);
  process.exit(1);
});
