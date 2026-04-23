#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import { SubscriptionManager } from './subscriptions.js';

async function main(): Promise<void> {
  const server = new McpServer(
    { name: 'nova-mcp', version: '1.0.0' },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: true },
        prompts: { listChanged: false },
      },
      instructions: [
        'nova-mcp is the stdio bridge between your runtime and a Nova a2a-server. It is NOT a long-running network service — it is a child process your MCP host spawns per session. There is nothing to "start up" separately.',
        '',
        'Architecture:',
        '- Your AI runtime (the MCP host) launches this binary (node dist/index.js) via its MCP client config.',
        '- This binary then talks to the Nova a2a-server over HTTP at NOVA_URL (default http://localhost:3001).',
        '- The a2a-server is the long-running service in Docker; this MCP process is a thin translator.',
        '',
        'If Nova tool calls fail with "unreachable", "connection refused", or your MCP host reports it cannot reach nova-mcp, the problem is in YOUR MCP client config — not on Nova\'s side. Check that your host has an entry like:',
        '  "nova": { "command": "node", "args": ["<path-to>/packages/mcp-server/dist/index.js"], "env": { "NOVA_URL": "http://localhost:3001", "NOVA_AGENT_ID": "<your-agent-id>" } }',
        'Required env: NOVA_URL (the a2a-server base URL), NOVA_AGENT_ID (lowercase identifier for this agent — distinct per runtime). Optional: NOVA_ADMIN_URL, NOVA_ADMIN_TOKEN for operator-scoped tools, NOVA_HOME to override the ~/.nova state directory.',
        '',
        'If a tool returns a Nova error code (INVITE_INVALID, AGENT_EXISTS, TENANT_NOT_FOUND, GRANT_CLAIM_EXPIRED, GRANT_REVOKED, etc.), that is a Nova-side response and the message tells you what to do. Do NOT conclude the MCP itself is down — the MCP is clearly up if it returned a structured error.',
        '',
        'To onboard a new agent, invoke the nova_onboard prompt. To send tasks, nova_first_task. To receive tasks with push, nova_serve.',
      ].join('\n'),
    },
  );

  const subscriptions = new SubscriptionManager(server.server);

  registerTools(server, subscriptions);
  registerResources(server);
  registerPrompts(server);

  // resources/subscribe and resources/unsubscribe handlers. The McpServer
  // wrapper doesn't expose these directly; we attach them to the underlying
  // Server instance.
  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    await subscriptions.subscribe(req.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    await subscriptions.unsubscribe(req.params.uri);
    return {};
  });

  const prevOnClose = server.server.onclose;
  server.server.onclose = () => {
    subscriptions.shutdown().catch(() => { /* best-effort teardown */ });
    if (prevOnClose) prevOnClose();
  };

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Process stays alive via stdio transport; SIGINT handled by transport.
}

main().catch((err) => {
  console.error('nova-mcp fatal:', err);
  process.exit(1);
});
