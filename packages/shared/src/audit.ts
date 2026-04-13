import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { AuditEvent } from './types';
import { TenantContext } from './tenant';
import { getSharedRedis } from './redis';

/**
 * Write an audit event to the Redis stream.
 * Fills eventId and timestamp automatically.
 * Throws if Redis is unavailable (caller must handle — spec says return 503).
 */
const AUDIT_STREAM_KEY = 'nova:audit:stream';
const AUDIT_CONSUMER_GROUP = 'audit-workers';

export async function auditLog(
  ctx: TenantContext,
  event: Omit<AuditEvent, 'eventId' | 'timestamp' | 'tenantId' | 'agentId'>
): Promise<void> {
  const redis = getSharedRedis();

  const fullEvent: AuditEvent = {
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    tenantId: ctx.tenantId,
    agentId: ctx.agentId,
    ...event,
  };

  await redis.xadd(
    AUDIT_STREAM_KEY,
    '*',
    'tenantId', ctx.tenantId,
    'agentId', ctx.agentId,
    'event', JSON.stringify(fullEvent)
  );
}

/**
 * Background worker that drains the Redis audit stream and writes to daily JSONL files.
 * Call this once at startup in a long-running process (e.g., agent-connector).
 */
export async function startAuditLogConsumer(dataRoot: string): Promise<void> {
  const redis = getSharedRedis();

  // Create consumer group if it doesn't exist
  try {
    await redis.xgroup('CREATE', AUDIT_STREAM_KEY, AUDIT_CONSUMER_GROUP, '$', 'MKSTREAM');
  } catch (err: any) {
    if (!err.message?.includes('BUSYGROUP')) throw err;
    // Group already exists — OK
  }

  const consumerId = `consumer-${process.pid}`;

  async function drainLoop(): Promise<void> {
    while (true) {
      try {
        const results = await redis.xreadgroup(
          'GROUP', AUDIT_CONSUMER_GROUP, consumerId,
          'COUNT', '100',
          'BLOCK', '5000',
          'STREAMS', AUDIT_STREAM_KEY, '>'
        ) as Array<[string, Array<[string, string[]]>]> | null;

        if (!results) continue;

        for (const [, messages] of results) {
          for (const [msgId, fields] of messages) {
            // Fields come back as flat array: [key, val, key, val, ...]
            const fieldMap: Record<string, string> = {};
            for (let i = 0; i < fields.length; i += 2) {
              fieldMap[fields[i]!] = fields[i + 1]!;
            }

            const eventJson = fieldMap['event'];
            if (!eventJson) continue;

            try {
              const event: AuditEvent = JSON.parse(eventJson);
              const date = event.timestamp.slice(0, 10); // YYYY-MM-DD
              const logDir = path.join(dataRoot, 'audit', event.tenantId);
              await fsp.mkdir(logDir, { recursive: true });
              const logFile = path.join(logDir, `audit-${date}.jsonl`);
              await fsp.appendFile(logFile, JSON.stringify(event) + '\n', 'utf8');

              await redis.xack(AUDIT_STREAM_KEY, AUDIT_CONSUMER_GROUP, msgId);
            } catch (parseErr: any) {
              process.stderr.write(`[audit] Failed to process message ${msgId}: ${parseErr.message}\n`);
              // ACK anyway to avoid blocking
              await redis.xack(AUDIT_STREAM_KEY, AUDIT_CONSUMER_GROUP, msgId);
            }
          }
        }
      } catch (err: any) {
        process.stderr.write(`[audit] drainLoop error: ${err.message}\n`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  // Run in background — do not await
  drainLoop().catch(err => {
    process.stderr.write(`[audit] Fatal drain error: ${err.message}\n`);
  });
}
