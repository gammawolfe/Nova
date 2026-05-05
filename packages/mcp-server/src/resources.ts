import { request } from 'undici';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadAgentRuntime, bootstrapClient } from './context.js';
import { loadIdentity } from '@nova/shared';
import { mintSelfAuthToken } from '@nova/shared';

export function registerResources(_server: McpServer): void {
  const server: any = _server;
  server.registerResource(
    'nova-agents',
    'nova://agents',
    {
      title: 'Nova agent directory',
      description: 'All active agents across all tenants on this Nova, JSON-encoded.',
      mimeType: 'application/json',
    },
    async (uri: URL) => {
      const rt = await loadAgentRuntime();
      const client = rt?.client ?? bootstrapClient();
      const res = await client.listAgents({ status: 'active' });
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(res, null, 2) }] };
    },
  );

  server.registerResource(
    'nova-agent-card',
    new ResourceTemplate('nova://agents/{agentId}/card', { list: undefined }),
    {
      title: 'A2A agent card',
      description: 'The public agent card (skills, schemas, capabilities) for a specific agent.',
      mimeType: 'application/json',
    },
    async (uri: URL, vars: Record<string, string | string[]>) => {
      const agentId = Array.isArray(vars['agentId']) ? vars['agentId'][0] : vars['agentId'];
      if (!agentId) throw new Error('agentId is required');
      const rt = await loadAgentRuntime();
      const client = rt?.client ?? bootstrapClient();
      const res = await client.getAgentCard(agentId);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(res, null, 2) }] };
    },
  );

  // ── Subscribable resources ────────────────────────────────────────────────
  // `reads` are non-destructive (no claim). Subscribing on these is wired via
  // SubscriptionManager in index.ts — each URI opens a backing SSE stream and
  // the MCP server emits notifications/resources/updated on events.

  server.registerResource(
    'nova-inbox',
    'nova://inbox',
    {
      title: 'Pending inbox tasks (push-subscribable)',
      description:
        'Non-destructive snapshot of this agent\'s inbox. Subscribe to receive push notifications on new arrivals. Reading returns current pending items; claiming still requires nova_next_task.',
      mimeType: 'application/json',
    },
    async (uri: URL) => {
      const rt = await loadAgentRuntime();
      if (!rt) throw new Error('No active agent runtime. Set NOVA_AGENT_ID.');
      const identity = await loadIdentity(rt.agentId);
      if (!identity) throw new Error(`Identity missing for ${rt.agentId}`);
      const selfUcan = mintSelfAuthToken({
        senderDid: identity.did,
        senderPrivateKeyPem: identity.privateKeyPem,
      });
      const url = `${rt.novaUrl.replace(/\/$/, '')}/agents/${encodeURIComponent(rt.agentId)}/inbox/peek`;
      const res = await request(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${selfUcan}` },
      });
      const text = await res.body.text();
      if (res.statusCode >= 400) throw new Error(`inbox peek ${res.statusCode}: ${text}`);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] };
    },
  );

  server.registerResource(
    'nova-replies',
    'nova://replies',
    {
      title: 'Pending reply-inbox items (push-subscribable)',
      description:
        'Non-destructive snapshot of this agent\'s broker-reply inbox — replies to tasks it has issued that were delivered via broker mode (no webhook). Subscribe to receive push notifications on new arrivals. Reading returns current pending items; claiming still requires nova_next_reply.',
      mimeType: 'application/json',
    },
    async (uri: URL) => {
      const rt = await loadAgentRuntime();
      if (!rt) throw new Error('No active agent runtime. Set NOVA_AGENT_ID.');
      const identity = await loadIdentity(rt.agentId);
      if (!identity) throw new Error(`Identity missing for ${rt.agentId}`);
      const selfUcan = mintSelfAuthToken({
        senderDid: identity.did,
        senderPrivateKeyPem: identity.privateKeyPem,
      });
      const url = `${rt.novaUrl.replace(/\/$/, '')}/agents/${encodeURIComponent(rt.agentId)}/replies/peek`;
      const res = await request(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${selfUcan}` },
      });
      const text = await res.body.text();
      if (res.statusCode >= 400) throw new Error(`replies peek ${res.statusCode}: ${text}`);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] };
    },
  );

  server.registerResource(
    'nova-task',
    new ResourceTemplate('nova://tasks/{taskId}', { list: undefined }),
    {
      title: 'Live task state (push-subscribable)',
      description:
        'State of a specific task, keyed by taskId. Subscribe to receive push notifications on every state change. Stream auto-closes when the task reaches a terminal status.',
      mimeType: 'application/json',
    },
    async (uri: URL, vars: Record<string, string | string[]>) => {
      const taskId = Array.isArray(vars['taskId']) ? vars['taskId'][0] : vars['taskId'];
      if (!taskId) throw new Error('taskId is required');
      const rt = await loadAgentRuntime();
      if (!rt) throw new Error('No active agent runtime. Set NOVA_AGENT_ID.');
      // Task state read goes through the existing task status endpoint.
      // Senders and receivers both route through the same path — the server
      // checks agent DID against the task's tenant.
      const state = await rt.client.getTaskStatus(rt.agentId, taskId);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(state, null, 2) }] };
    },
  );
}
