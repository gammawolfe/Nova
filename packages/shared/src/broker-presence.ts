import type IORedis from 'ioredis';
import { getSharedRedis } from './redis';
import { TenantContext } from './tenant';

export type BrokerPresenceStatus = 'online' | 'offline';

export interface BrokerPresence {
  status: BrokerPresenceStatus;
  activeConnections: number;
  lastSeenAt: string | null;
  updatedAt: string | null;
}

const ONLINE_TTL_SECONDS = 45;
const OFFLINE_TTL_SECONDS = 24 * 60 * 60;

function presenceKey(ctx: TenantContext): string {
  return `nova:broker-presence:${ctx.tenantId}:${ctx.agentId}`;
}

function connectionsKey(ctx: TenantContext): string {
  return `${presenceKey(ctx)}:connections`;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function refreshExpiry(redis: IORedis, ctx: TenantContext): Promise<void> {
  await Promise.all([
    redis.expire(presenceKey(ctx), ONLINE_TTL_SECONDS),
    redis.expire(connectionsKey(ctx), ONLINE_TTL_SECONDS),
  ]);
}

export async function markBrokerPresenceOnline(
  ctx: TenantContext,
  connectionId: string,
  redis: IORedis = getSharedRedis(),
): Promise<void> {
  const at = nowIso();
  await redis.sadd(connectionsKey(ctx), connectionId);
  const activeConnections = await redis.scard(connectionsKey(ctx));
  await redis.hset(presenceKey(ctx), {
    status: 'online',
    activeConnections: String(activeConnections),
    lastSeenAt: at,
    updatedAt: at,
  });
  await refreshExpiry(redis, ctx);
}

export async function refreshBrokerPresence(
  ctx: TenantContext,
  connectionId: string,
  redis: IORedis = getSharedRedis(),
): Promise<void> {
  const isKnownConnection = await redis.sismember(connectionsKey(ctx), connectionId);
  if (!isKnownConnection) return;

  const activeConnections = await redis.scard(connectionsKey(ctx));
  await redis.hset(presenceKey(ctx), {
    status: 'online',
    activeConnections: String(activeConnections),
    updatedAt: nowIso(),
  });
  await refreshExpiry(redis, ctx);
}

export async function markBrokerPresenceOffline(
  ctx: TenantContext,
  connectionId: string,
  redis: IORedis = getSharedRedis(),
): Promise<void> {
  await redis.srem(connectionsKey(ctx), connectionId);
  const activeConnections = await redis.scard(connectionsKey(ctx));
  const at = nowIso();

  if (activeConnections > 0) {
    await redis.hset(presenceKey(ctx), {
      status: 'online',
      activeConnections: String(activeConnections),
      updatedAt: at,
    });
    await refreshExpiry(redis, ctx);
    return;
  }

  await redis.hset(presenceKey(ctx), {
    status: 'offline',
    activeConnections: '0',
    lastSeenAt: at,
    updatedAt: at,
  });
  await redis.expire(presenceKey(ctx), OFFLINE_TTL_SECONDS);
  await redis.del(connectionsKey(ctx));
}

export async function getBrokerPresence(
  ctx: TenantContext,
  redis: IORedis = getSharedRedis(),
): Promise<BrokerPresence> {
  const raw = await redis.hgetall(presenceKey(ctx));
  if (!raw || Object.keys(raw).length === 0) {
    return {
      status: 'offline',
      activeConnections: 0,
      lastSeenAt: null,
      updatedAt: null,
    };
  }

  const activeConnections = Number(raw.activeConnections);
  return {
    status: raw.status === 'online' ? 'online' : 'offline',
    activeConnections: Number.isFinite(activeConnections) ? activeConnections : 0,
    lastSeenAt: raw.lastSeenAt ?? null,
    updatedAt: raw.updatedAt ?? null,
  };
}
