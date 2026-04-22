import { describe, it, expect } from 'vitest';
import { NovaBrokerClient, TransportError, HttpError } from '../src/nova-client';

interface FakeCall {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function mockRequest(responses: Array<{ statusCode: number; body: string }>): {
  fetchImpl: any;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const queue = [...responses];
  const fetchImpl = async (url: string, init: any) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers as Record<string, string>,
      body: init?.body,
    });
    const next = queue.shift();
    if (!next) throw new Error('no more fake responses queued');
    return {
      statusCode: next.statusCode,
      body: {
        text: async () => next.body,
      },
    };
  };
  return { fetchImpl, calls };
}

describe('NovaBrokerClient.pull', () => {
  it('returns null on 204', async () => {
    const { fetchImpl, calls } = mockRequest([{ statusCode: 204, body: '' }]);
    const client = new NovaBrokerClient({ novaUrl: 'http://x', fetchImpl });
    const result = await client.pull('a', 'ucan', 1000);
    expect(result).toBeNull();
    expect(calls[0]!.url).toContain('/agents/a/inbox?wait=1000');
    expect(calls[0]!.headers!.authorization).toBe('Bearer ucan');
  });

  it('returns the parsed task on 200', async () => {
    const body = JSON.stringify({ task: { taskId: 't1' }, visibleUntil: '2026-01-01T00:00:00Z' });
    const { fetchImpl } = mockRequest([{ statusCode: 200, body }]);
    const client = new NovaBrokerClient({ novaUrl: 'http://x', fetchImpl });
    const result = await client.pull('a', 'ucan', 1000);
    expect(result).toEqual({ task: { taskId: 't1' }, visibleUntil: '2026-01-01T00:00:00Z' });
  });

  it('wraps 401 in HttpError with status and body', async () => {
    const { fetchImpl } = mockRequest([{ statusCode: 401, body: '{"error":"UCAN_INVALID"}' }]);
    const client = new NovaBrokerClient({ novaUrl: 'http://x', fetchImpl });
    await expect(client.pull('a', 'ucan', 1000)).rejects.toMatchObject({
      name: 'HttpError',
      status: 401,
      body: { error: 'UCAN_INVALID' },
    });
  });

  it('wraps a thrown fetch error in TransportError', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    const client = new NovaBrokerClient({ novaUrl: 'http://x', fetchImpl });
    const err = await client.pull('a', 'ucan', 1000).catch(e => e);
    expect(err).toBeInstanceOf(TransportError);
    expect(err.message).toContain('ECONNREFUSED');
  });

  it('treats unparseable success body as HttpError', async () => {
    const { fetchImpl } = mockRequest([{ statusCode: 200, body: 'not json' }]);
    const client = new NovaBrokerClient({ novaUrl: 'http://x', fetchImpl });
    await expect(client.pull('a', 'ucan', 1000)).rejects.toBeInstanceOf(HttpError);
  });
});

describe('NovaBrokerClient.respond', () => {
  it('returns accepted on 202', async () => {
    const { fetchImpl, calls } = mockRequest([{ statusCode: 202, body: '{"status":"accepted"}' }]);
    const client = new NovaBrokerClient({ novaUrl: 'http://x', fetchImpl });
    const outcome = await client.respond('a', 'ucan', 't1', { status: 'ok', result: { ping: true } });
    expect(outcome).toBe('accepted');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/agents/a/inbox/t1/respond');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ status: 'ok', result: { ping: true } });
  });

  it('returns already_completed on 409', async () => {
    const { fetchImpl } = mockRequest([{ statusCode: 409, body: '{"status":"already_completed"}' }]);
    const client = new NovaBrokerClient({ novaUrl: 'http://x', fetchImpl });
    expect(await client.respond('a', 'ucan', 't1', { status: 'ok' })).toBe('already_completed');
  });

  it('returns task_not_found on 404', async () => {
    const { fetchImpl } = mockRequest([{ statusCode: 404, body: '{"status":"task_not_found"}' }]);
    const client = new NovaBrokerClient({ novaUrl: 'http://x', fetchImpl });
    expect(await client.respond('a', 'ucan', 't1', { status: 'ok' })).toBe('task_not_found');
  });

  it('wraps 500 in HttpError', async () => {
    const { fetchImpl } = mockRequest([{ statusCode: 500, body: '{"error":"oops"}' }]);
    const client = new NovaBrokerClient({ novaUrl: 'http://x', fetchImpl });
    await expect(client.respond('a', 'ucan', 't1', { status: 'ok' })).rejects.toMatchObject({
      name: 'HttpError',
      status: 500,
    });
  });

  it('wraps a thrown fetch error in TransportError', async () => {
    const fetchImpl = async () => { throw new Error('EPIPE'); };
    const client = new NovaBrokerClient({ novaUrl: 'http://x', fetchImpl });
    await expect(client.respond('a', 'ucan', 't1', { status: 'ok' })).rejects.toBeInstanceOf(TransportError);
  });
});
