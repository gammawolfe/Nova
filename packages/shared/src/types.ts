import { z } from 'zod';
import {
  TaskRequestSchema,
  TaskResultSchema,
  QueuedTaskSchema,
  AuditEventSchema,
  AgentCardSchema,
  ActorRecordSchema
} from './schemas';

export type TaskRequest = z.infer<typeof TaskRequestSchema>;
export type TaskResult = z.infer<typeof TaskResultSchema>;
export type QueuedTask = z.infer<typeof QueuedTaskSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AgentCard = z.infer<typeof AgentCardSchema>;
export type ActorRecord = z.infer<typeof ActorRecordSchema>;

export type TrustTier = 0 | 1 | 2 | 3;

export const TERMINAL_STATUSES = ['completed', 'failed', 'canceled'] as const;

export type GateStep = 'tier' | 'ucan' | 'schema' | 'classifier';

export interface QuarantineEntry {
  id: string;
  tenantId: string;
  agentId: string;
  receivedAt: string;
  senderDid: string | null;
  rawTask: unknown;
  gateStep: GateStep;
  reason: string;
  status: 'pending_review' | 'released' | 'dropped';
  reviewedAt: string | null;
  reviewedBy: string | null;
}

export type DeadLetterFailureReason =
  | 'http_4xx'
  | 'exhausted_retries'
  | 'broker_no_response'
  | 'reply_sender_inactive'
  | 'reply_webhook_failed'
  | 'broker_reply_no_response';

export interface DeadLetterEntry {
  id: string;
  tenantId: string;
  agentId: string;
  taskId: string;
  targetUrl: string;
  taskResult: TaskResult;
  failureReason: DeadLetterFailureReason;
  lastAttemptAt: string;
  attemptCount: number;
  httpStatus: number;
  createdAt: string;
  expiresAt: string;
}

export interface TaskState {
  taskId: string;
  tenantId: string;
  agentId: string;
  status: 'submitted' | 'pending_classification' | 'working' | 'input_required' | 'queued' | 'completed' | 'failed' | 'canceled';
  intent: string;
  submittedAt: string;
  updatedAt: string;
  expiresAt: string;
  submitterDid: string;
  result?: TaskResult;
  statusMessage?: string;
  estimatedResponseBy?: string;
}
