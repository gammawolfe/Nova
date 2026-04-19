import { z } from 'zod';

export const SUPPORTED_PROTOCOL_VERSIONS = ['1.0'] as const;

export const TaskRequestSchema = z.object({
  id: z.string().uuid(),
  schemaVersion: z.literal('1.0'),
  intent: z.string(),
  params: z.record(z.unknown()), // Tightly validated later via per-skill schemas
  replyTo: z.string().url(),
  ttl: z.string().datetime(),
  idempotencyKey: z.string().uuid(),
});

export const TaskResultSchema = z.object({
  type: z.literal('TaskResult'),
  requestId: z.string().uuid(),
  status: z.enum(['ok', 'error', 'input_required']),
  result: z.record(z.unknown()).optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean()
  }).optional(),
  auditToken: z.string(),
  completedAt: z.string().datetime(),
  schemaVersion: z.literal('1.0')
});

export const QueuedTaskSchema = z.object({
  taskId: z.string().uuid(), // Derived from idempotencyKey
  tenantId: z.string(),
  agentId: z.string(),
  intent: z.string(),
  params: z.record(z.unknown()),
  replyTo: z.string().url(),
  senderDid: z.string(),
  tier: z.number().int().min(0).max(3),
  queuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  confirmId: z.string().uuid().optional(),
  confirmRequestAt: z.string().datetime().optional(),
});

export const AuditEventSchema = z.object({
  eventId: z.string().uuid(),
  timestamp: z.string().datetime(),
  tenantId: z.string(),
  agentId: z.string(),
  event: z.enum([
    'message_received',
    'message_parse_failed',
    'gate_503',
    'ucan_verified',
    'ucan_failed',
    'actor_resolved',
    'actor_unknown',
    'schema_valid',
    'schema_invalid',
    'injection_clear',
    'injection_pattern_match',
    'injection_detected',
    'injection_suspected',
    'injection_pattern_clear',
    'classifier_unavailable',
    'task_queued',
    'task_classification_started',
    'task_classification_complete',
    'task_quarantined',
    'task_dropped',
    'task_started',
    'task_broker_queued',
    'task_completed',
    'task_failed',
    'task_error',
    'task_expired',
    'confirm_requested',
    'confirm_approved',
    'confirm_denied',
    'confirm_timeout',
    'delivery_success',
    'delivery_permanent_failure',
    'delivery_transient_failure',
    'delivery_exhausted',
    'dead_letter_written',
    'agent_output_schema_violation',
    'quarantine_full',
    'redis_unavailable',
    'key_rotation_detected',
    'agent_registered',
    'agent_approved',
    'agent_rejected',
    'ucan_renewed',
    'ucan_renewal_failed',
    'agent_discovered'
  ]),
  taskId: z.string().uuid().optional(),
  senderDid: z.string().optional(),
  tier: z.number().int().min(0).max(3).optional(),
  reason: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});

export const AgentCardSchema = z.object({
  name: z.string(),
  description: z.string(),
  url: z.string().url(),
  version: z.string(),
  protocolVersions: z.array(z.enum(SUPPORTED_PROTOCOL_VERSIONS)),
  provider: z.object({
    name: z.string(),
    url: z.string().url().optional()
  }).optional(),
  renewalContact: z.string().optional(),
  capabilities: z.object({
    streaming: z.boolean(),
    pushNotifications: z.boolean(),
    stateTransitionHistory: z.boolean()
  }),
  authentication: z.object({
    schemes: z.array(z.string()),
    ucapabilityPrefix: z.string()
  }),
  skills: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    tags: z.array(z.string()).optional(),
    inputSchema: z.record(z.unknown()),   // JSON Schema object
    outputSchema: z.record(z.unknown())   // JSON Schema object
  }))
});

export const ActorRecordSchema = z.object({
  did: z.string(),
  displayName: z.string(),
  tier: z.number().int().min(0).max(3),
  allowedSkills: z.array(z.string()),
  addedAt: z.string().datetime(),
  addedBy: z.string(),
  notes: z.string().optional(),
  lastSeenAt: z.string().datetime().optional()
});
