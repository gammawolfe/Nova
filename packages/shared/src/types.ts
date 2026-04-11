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

export interface TaskState {
  taskId: string;
  tenantId: string;
  agentId: string;
  status: 'submitted' | 'pending_classification' | 'working' | 'input_required' | 'completed' | 'failed' | 'canceled';
  intent: string;
  submittedAt: string;
  updatedAt: string;
  expiresAt: string;
  submitterDid: string;
  result?: TaskResult;
  statusMessage?: string;
  estimatedResponseBy?: string;
}
