import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadAgentRuntime, bootstrapClient } from './context.js';

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
    async (uri) => {
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
    async (uri, vars) => {
      const agentId = Array.isArray(vars['agentId']) ? vars['agentId'][0] : vars['agentId'];
      if (!agentId) throw new Error('agentId is required');
      const rt = await loadAgentRuntime();
      const client = rt?.client ?? bootstrapClient();
      const res = await client.getAgentCard(agentId);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(res, null, 2) }] };
    },
  );
}
