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
            '4. Before calling nova_register_agent, base64url-decode the middle segment of the invite JWT and read the "agentIdHint" claim. The agentId you pass to nova_register_agent MUST equal agentIdHint exactly. If they differ, STOP and ask me for a new invite minted with the correct hint — do NOT call nova_register_agent yet (see gotcha below).',
            '5. Call nova_register_agent EXACTLY ONCE with the agent name, description, skills, and the invite token. Skills can start with just { id: "__sender_only", name: "Sender only", description: "send-only" } if the agent will not receive tasks.',
            '6. Poll nova_check_registration every 10 seconds until status is "active" (the operator must approve via the admin UI).',
            '7. Confirm nova_whoami shows a cached self-UCAN.',
            '',
            'Gotchas — read before step 5:',
            '- Invite tokens are single-use on the FIRST nova_register_agent call, success or failure. The server atomically marks the invite jti as consumed before any other validation runs. If the call fails for ANY reason (AGENT_ID_MISMATCH, schema error, tenant missing, duplicate agent), the token is burned. Retrying with the same token returns INVITE_INVALID — you must ask me for a fresh invite.',
            '- Do NOT retry nova_register_agent with the same invite. If it errors once, stop and request a new token.',
            '- Operators: mint the invite with agentIdHint set to the agent id the runtime will use (e.g. "hermes-agent", not "hermes"), or the first register call will mismatch and burn the token.',
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
