// packages/broker-receiver/src/receiver-policy.ts
//
// Receiver-side execution policy. Nova decides whether a task may be delivered;
// the receiver decides whether it is willing to spend local resources to run it.

import { z } from 'zod';
import type { QueuedTask } from '@nova/shared/src/types';
import type { HandlerResult } from './handlers/types.js';

export const ReceiverPolicyRuleSchema = z.object({
  senderAgentId: z.string().min(1).optional(),
  senderDid: z.string().min(1).optional(),
  intent: z.string().min(1).optional(),
  action: z.enum(['allow', 'deny']),
  maxTasksPerHour: z.number().int().min(1).optional(),
});

export const ReceiverPolicySchema = z.object({
  defaultAction: z.enum(['allow', 'deny']).default('deny'),
  rules: z.array(ReceiverPolicyRuleSchema).default([]),
});

export type ReceiverPolicy = z.infer<typeof ReceiverPolicySchema>;
export type ReceiverPolicyRule = z.infer<typeof ReceiverPolicyRuleSchema>;

export interface PolicyDecisionAllow {
  allowed: true;
  rule?: ReceiverPolicyRule | undefined;
}

export interface PolicyDecisionDeny {
  allowed: false;
  code: string;
  message: string;
  rule?: ReceiverPolicyRule | undefined;
}

export type PolicyDecision = PolicyDecisionAllow | PolicyDecisionDeny;

export class ReceiverPolicyEvaluator {
  private readonly counters = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly policy: ReceiverPolicy) {}

  evaluate(task: QueuedTask): PolicyDecision {
    const rule = this.findRule(task);
    const action = rule?.action ?? this.policy.defaultAction;

    if (action === 'deny') {
      return {
        allowed: false,
        code: 'RECEIVER_POLICY_DENIED',
        message: `Receiver policy denied sender '${task.senderAgentId ?? task.senderDid}' for intent '${task.intent}'.`,
        ...(rule ? { rule } : {}),
      };
    }

    if (rule?.maxTasksPerHour !== undefined) {
      const rate = this.checkRateLimit(task, rule);
      if (!rate.allowed) return rate;
    }

    return { allowed: true, ...(rule ? { rule } : {}) };
  }

  private findRule(task: QueuedTask): ReceiverPolicyRule | undefined {
    for (const rule of this.policy.rules) {
      if (rule.senderAgentId !== undefined && rule.senderAgentId !== task.senderAgentId) continue;
      if (rule.senderDid !== undefined && rule.senderDid !== task.senderDid) continue;
      if (rule.intent !== undefined && rule.intent !== task.intent) continue;
      return rule;
    }
    return undefined;
  }

  private checkRateLimit(task: QueuedTask, rule: ReceiverPolicyRule): PolicyDecision {
    const key = [
      rule.senderAgentId ?? task.senderAgentId ?? task.senderDid,
      rule.senderDid ?? task.senderDid,
      rule.intent ?? task.intent,
    ].join('|');
    const now = Date.now();
    const current = this.counters.get(key);
    const windowMs = 60 * 60 * 1000;
    const bucket = current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + windowMs };

    if (bucket.count >= rule.maxTasksPerHour!) {
      this.counters.set(key, bucket);
      return {
        allowed: false,
        code: 'RECEIVER_RATE_LIMITED',
        message: `Receiver policy rate limit exceeded for sender '${task.senderAgentId ?? task.senderDid}' and intent '${task.intent}'.`,
        rule,
      };
    }

    bucket.count += 1;
    this.counters.set(key, bucket);
    return { allowed: true, rule };
  }
}

export function policyDenyResult(decision: PolicyDecisionDeny): HandlerResult {
  return {
    status: 'error',
    error: {
      code: decision.code,
      message: decision.message,
      retryable: false,
    },
  };
}
