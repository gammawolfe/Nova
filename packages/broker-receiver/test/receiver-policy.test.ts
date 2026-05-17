import { describe, expect, it } from 'vitest';
import { ReceiverPolicyEvaluator } from '../src/receiver-policy';
import type { QueuedTask } from '@nova/shared/src/types';

function mkTask(senderAgentId = 'claude-code', intent = 'answer_code_question'): QueuedTask {
  return {
    taskId: '33333333-3333-4333-8333-333333333333',
    tenantId: 'tenant-1',
    agentId: 'codex',
    intent,
    params: { question: 'What is Nova?' },
    senderTenantId: 'tenant-1',
    senderAgentId,
    senderDid: 'did:key:z6sender',
    tier: 1,
    queuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe('ReceiverPolicyEvaluator', () => {
  it('denies by default when configured deny-by-default', () => {
    const policy = new ReceiverPolicyEvaluator({ defaultAction: 'deny', rules: [] });
    expect(policy.evaluate(mkTask())).toMatchObject({
      allowed: false,
      code: 'RECEIVER_POLICY_DENIED',
    });
  });

  it('allows matching sender and intent rule', () => {
    const policy = new ReceiverPolicyEvaluator({
      defaultAction: 'deny',
      rules: [
        {
          senderAgentId: 'claude-code',
          intent: 'answer_code_question',
          action: 'allow',
        },
      ],
    });
    expect(policy.evaluate(mkTask())).toMatchObject({ allowed: true });
    expect(policy.evaluate(mkTask('other-agent'))).toMatchObject({ allowed: false });
  });

  it('rate-limits matching rules per hour', () => {
    const policy = new ReceiverPolicyEvaluator({
      defaultAction: 'deny',
      rules: [
        {
          senderAgentId: 'claude-code',
          intent: 'answer_code_question',
          action: 'allow',
          maxTasksPerHour: 1,
        },
      ],
    });

    expect(policy.evaluate(mkTask())).toMatchObject({ allowed: true });
    expect(policy.evaluate(mkTask())).toMatchObject({
      allowed: false,
      code: 'RECEIVER_RATE_LIMITED',
    });
  });
});
