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
