import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerPrompts(_server: McpServer): void {
  const server: any = _server;
  server.registerPrompt(
    'nova_onboard',
    {
      title: 'Onboard this agent onto Nova',
      description: 'Walks through identity generation, invite acceptance, registration, and UCAN claim.',
    },
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            'Help me onboard this runtime onto the Nova network. Use the mcp server tools in this order:',
            '',
            '1. Call nova_whoami to see current state.',
            '2. If no identity exists for NOVA_AGENT_ID, call nova_generate_identity with a lowercase agent ID matching NOVA_AGENT_ID.',
            '3. Ask me for the invite token (provided by the tenant operator out-of-band), then call nova_accept_invite with it.',
            '4. Before calling nova_register_agent, call nova_inspect_invite with the token to read its claims. The agentId you pass to nova_register_agent MUST equal the returned agentIdHint exactly. If they differ (or agentIdHint is null, or expired is true), STOP and ask me for a new invite with the correct hint — do NOT call nova_register_agent yet (see gotcha below).',
            '5. Call nova_register_agent EXACTLY ONCE with the agent name, description, skills, and the invite token. Skills can start with just { id: "__sender_only", name: "Sender only", description: "send-only" } if the agent will not receive tasks.',
            '6. Poll nova_check_registration every 10 seconds until status is "active" (the operator must approve via the admin UI).',
            '7. Confirm nova_whoami shows a cached self-UCAN.',
            '',
            'Gotchas — read before step 5:',
            '- Invite tokens are single-use. The server consumes the token only after all agent-side validation passes (agentIdHint match, tenant exists, agentId not already registered), so AGENT_ID_MISMATCH / TENANT_NOT_FOUND / AGENT_EXISTS errors leave the invite reusable — fix the input and retry with the SAME token. Only a successful 201, an expired token, or a concurrent race returns INVITE_INVALID on retry.',
            '- Operators: always mint with an agentIdHint matching the agent id the runtime will use (e.g. "hermes-agent", not "hermes") so the operator-agent handshake is unambiguous.',
            '',
            'Report any errors from the tool responses verbatim — they include Nova error codes.',
          ].join('\n'),
        },
      }],
    }),
  );

  server.registerPrompt(
    'nova_first_task',
    {
      title: 'Send my first task to another agent',
      description: 'Guides sending a task end-to-end with schema-validated params.',
      argsSchema: { targetAgentId: z.string() },
    },
    ({ targetAgentId }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Walk me through sending my first task to agent "${targetAgentId}":`,
            '',
            `1. Call nova_get_agent_card with agentId="${targetAgentId}" to see the skill list and their inputSchema.`,
            '2. Tell me which skill to invoke and show me the inputSchema so I can craft valid params.',
            `3. Once I\'ve given you params, call nova_send_task with targetAgentId="${targetAgentId}", the chosen intent, and the params.`,
            '4. Report back the taskId and statusUrl. Ask me if I want you to poll nova_get_task_result.',
            '',
            'If any step fails, surface the Nova error code and suggest a fix.',
          ].join('\n'),
        },
      }],
    }),
  );
}
