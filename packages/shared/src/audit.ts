import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { AuditEvent } from './types';
import { TenantContext } from './tenant';
import { getSharedRedis } from './redis';
import { logger } from './logger';

export const AUDIT_STREAM_KEY = 'nova:audit:stream';
export const AUDIT_CONSUMER_GROUP = 'audit-workers';

/**
 * Dead-letter stream for messages the consumer couldn't parse. The drain
 * loop ACKs malformed entries upstream (otherwise they'd block subsequent
 * deliveries) and forwards them here with the parse error so operators can
 * inspect later. XLEN on this key is a useful health metric.
 */
export const AUDIT_DLQ_STREAM_KEY = 'nova:audit:dead-letter';

/**
 * Write an audit event to the Redis stream.
 * Fills eventId and timestamp automatically.
 * Throws if Redis is unavailable (caller must handle — spec says return 503).
 *
 * `redis` is injectable for tests; production callers omit it and pick up
 * the shared singleton.
 */
export async function auditLog(
  ctx: TenantContext,
  event: Omit<AuditEvent, 'eventId' | 'timestamp' | 'tenantId' | 'agentId'>,
  redis: ReturnType<typeof getSharedRedis> = getSharedRedis(),
): Promise<void> {

  const fullEvent: AuditEvent = {
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    tenantId: ctx.tenantId,
    agentId: ctx.agentId,
    ...event,
  };

  // The full event lives in the `event` field as a JSON blob; the consumer
  // parses it out to write the JSONL line. Top-level tenantId/agentId fields
  // are NOT mirrored here — they're recoverable from the parsed event and
  // mirroring would waste bytes per write on what is the hottest write path
  // in the system.
  await redis.xadd(AUDIT_STREAM_KEY, '*', 'event', JSON.stringify(fullEvent));
}

/**
 * Options for the audit drain consumer.
 *
 * `signal` lets a long-running host (e.g. agent-connector) request a clean
 * shutdown — the BLOCK on XREADGROUP returns periodically, the loop checks
 * the signal, and the function returns. Without it, the consumer runs
 * forever and is terminated mid-call on SIGTERM, which can lose the
 * just-claimed-but-not-yet-ACK'd batch.
 *
 * `redis` is injectable so callers don't have to share the singleton
 * connection if they don't want to (and so tests can pass a stub without
 * fighting vi.mock module resolution). Defaults to the shared singleton.
 */
export interface StartAuditConsumerOptions {
  signal?: AbortSignal;
  redis?: ReturnType<typeof getSharedRedis>;
}

/**
 * Background worker that drains the Redis audit stream and writes to daily
 * JSONL files under `<dataRoot>/audit/<tenantId>/audit-<YYYY-MM-DD>.jsonl`.
 *
 * Resolves once `signal` is aborted (or never if no signal is provided);
 * the drain itself runs on an internal promise. Crashes inside the drain are
 * logged through the structured logger and the loop continues — a transient
 * Redis blip or a malformed event should not bring down the consumer.
 *
 * Malformed events (non-JSON `event` field) are XADD'd to
 * `AUDIT_DLQ_STREAM_KEY` with the original fields + parse error, then ACKed
 * upstream so they don't block the next batch.
 */
export async function startAuditLogConsumer(
  dataRoot: string,
  opts: StartAuditConsumerOptions = {},
): Promise<void> {
  const redis = opts.redis ?? getSharedRedis();
  const signal = opts.signal;

  // Create the consumer group if absent. `MKSTREAM` makes XGROUP CREATE
  // tolerate an empty (not-yet-existent) stream.
  try {
    await redis.xgroup('CREATE', AUDIT_STREAM_KEY, AUDIT_CONSUMER_GROUP, '$', 'MKSTREAM');
  } catch (err: any) {
    if (!err.message?.includes('BUSYGROUP')) throw err;
    // Group already exists — OK.
  }

  const consumerId = `consumer-${process.pid}`;
  logger.info({ consumerId, group: AUDIT_CONSUMER_GROUP }, 'audit consumer starting');

  // 5s BLOCK so abort signals are picked up promptly without a busy loop.
  const BLOCK_MS = 5000;

  async function drainLoop(): Promise<void> {
    while (signal === undefined || !signal.aborted) {
      try {
        const results = await redis.xreadgroup(
          'GROUP', AUDIT_CONSUMER_GROUP, consumerId,
          'COUNT', '100',
          'BLOCK', String(BLOCK_MS),
          'STREAMS', AUDIT_STREAM_KEY, '>',
        ) as Array<[string, Array<[string, string[]]>]> | null;

        if (!results) continue;

        for (const [, messages] of results) {
          for (const [msgId, fields] of messages) {
            await processMessage(msgId, fields, dataRoot, redis);
          }
        }
      } catch (err: any) {
        if (signal?.aborted) return;
        logger.error({ err: err.message, tag: 'audit-drain' }, 'audit drain loop error');
        // Short sleep before retry so we don't tight-loop on a persistent error.
        await sleep(2000, signal);
      }
    }
    logger.info({ consumerId }, 'audit consumer stopped (signal aborted)');
  }

  // Run the drain in the background; return a promise that resolves on abort.
  void drainLoop().catch((err) => {
    logger.error({ err, tag: 'audit-drain' }, 'audit drain loop crashed unexpectedly');
  });

  if (signal === undefined) {
    // No shutdown signal — caller wants fire-and-forget behaviour. Resolve
    // immediately so the host can continue with other startup work.
    return;
  }
  // Resolve when the abort fires so callers can `await` the shutdown.
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

async function processMessage(
  msgId: string,
  fields: string[],
  dataRoot: string,
  redis: ReturnType<typeof getSharedRedis>,
): Promise<void> {
  // Fields come back as a flat array: [key, val, key, val, ...]
  const fieldMap: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    fieldMap[fields[i]!] = fields[i + 1]!;
  }
  const eventJson = fieldMap['event'];

  if (!eventJson) {
    await dlqAndAck(msgId, fieldMap, 'missing-event-field', redis);
    return;
  }

  let event: AuditEvent;
  try {
    event = JSON.parse(eventJson);
  } catch (parseErr: any) {
    await dlqAndAck(msgId, fieldMap, `parse-failed: ${parseErr.message}`, redis);
    return;
  }

  try {
    const date = event.timestamp.slice(0, 10); // YYYY-MM-DD
    const logDir = path.join(dataRoot, 'audit', event.tenantId);
    await fsp.mkdir(logDir, { recursive: true });
    const logFile = path.join(logDir, `audit-${date}.jsonl`);
    await fsp.appendFile(logFile, JSON.stringify(event) + '\n', 'utf8');
    await redis.xack(AUDIT_STREAM_KEY, AUDIT_CONSUMER_GROUP, msgId);
  } catch (writeErr: any) {
    // Disk write failure — leave the message unACKed so a later drain attempt
    // can retry. xreadgroup with '>' won't re-deliver this same msgId to the
    // same consumer until XPEL recovery, so this path effectively drops the
    // message on the floor for now. Surfacing the error makes ops aware.
    logger.error(
      { err: writeErr.message, msgId, tag: 'audit-drain' },
      'audit JSONL write failed; message left unACKed',
    );
  }
}

/**
 * Forward a malformed message to the dead-letter stream and ACK it upstream
 * so the next batch can be processed. Failure to write the DLQ entry is
 * logged but does not block the ACK — losing one observability record is
 * better than blocking every subsequent audit event behind a poisoned one.
 */
async function dlqAndAck(
  msgId: string,
  fieldMap: Record<string, string>,
  reason: string,
  redis: ReturnType<typeof getSharedRedis>,
): Promise<void> {
  logger.warn({ msgId, reason, tag: 'audit-dlq' }, 'audit consumer: forwarding malformed message to DLQ');
  try {
    await redis.xadd(
      AUDIT_DLQ_STREAM_KEY,
      '*',
      'msgId', msgId,
      'reason', reason,
      'originalFields', JSON.stringify(fieldMap),
      'failedAt', new Date().toISOString(),
    );
  } catch (dlqErr: any) {
    logger.error(
      { err: dlqErr.message, msgId, tag: 'audit-dlq' },
      'audit consumer: DLQ write failed; ACKing original anyway',
    );
  }
  try {
    await redis.xack(AUDIT_STREAM_KEY, AUDIT_CONSUMER_GROUP, msgId);
  } catch (ackErr: any) {
    logger.error(
      { err: ackErr.message, msgId, tag: 'audit-dlq' },
      'audit consumer: upstream ACK failed for malformed message',
    );
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
