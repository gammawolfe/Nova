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
            'Before you start: nova-mcp is a stdio child process spawned by your MCP host, not a service you need to start yourself. The long-running Nova service is the a2a-server at NOVA_URL (default http://localhost:3001). If tool calls fail with connection/unreachable errors, the problem is in your MCP client config (missing "nova" entry, wrong binary path, or missing NOVA_URL / NOVA_AGENT_ID env), not with the Nova deployment. See the top-level server instructions for the exact config shape.',
            '',
            '1. Call nova_identity({action:"whoami"}) to see current state. Confirm NOVA_AGENT_ID is set — every subsequent step uses it to resolve the active identity, tenant config, and credentials.',
            '2. If no identity exists for NOVA_AGENT_ID, call nova_identity({action:"generate", agentId:"<NOVA_AGENT_ID>"}) with a lowercase agent ID matching NOVA_AGENT_ID.',
            '3. Ask me for the invite token (provided by the tenant operator out-of-band), then call nova_onboard({action:"accept_invite", invite:"<token>"}). The accept_invite action verifies the token signature and tenant existence against the server before writing local state, so stale or mistyped invites are rejected up front with a clear error rather than silently corrupting tenant.json.',
            '4. Before registering, call nova_onboard({action:"inspect_invite", invite:"<token>"}) to read its claims. The agentId you pass to the register action MUST equal the returned agentIdHint exactly. If they differ (or agentIdHint is null, or expired is true), STOP and ask me for a new invite with the correct hint — do NOT register yet (see gotcha below).',
            '5. Call nova_onboard({action:"register", agentId, name, description, skills, invite}) EXACTLY ONCE. Skills declare what this agent accepts. If the agent will only send and never receive, pass skills:[{ id: "__sender_only", name: "Sender only", description: "send-only" }]. Otherwise list real skill IDs — sender-only agents cannot be invoked, and you cannot upgrade a sender-only registration later without re-registering.',
            '6. Poll nova_onboard({action:"check_status"}) on an escalating backoff until status is "active" AND claimed: true. Cadence:',
            '     - For the first 2 minutes: every 10 seconds',
            '     - From 2 min to 10 min: every 30 seconds',
            '     - After 10 min: every 60 seconds',
            '     - If still pending after 30 total minutes, STOP polling and tell me verbatim: "The operator has not approved this registration within 30 minutes. Please check the Nova admin UI and approve, then I can resume with nova_onboard({action:\'check_status\'}) — it is idempotent and re-polling is safe."',
            '7. If check_status returns the GRANT_CLAIM_EXPIRED error code, STOP polling and tell me verbatim: "The one-time grant claim window expired before I picked up the credential. Please run nova_admin({action:\'reissue_grant\', tenantId:<X>, agentId:<Y>}) (requires NOVA_ADMIN_TOKEN), then I will call nova_onboard({action:\'check_status\'}) once more." Do NOT retry polling automatically — reissue_grant is operator-gated and every subsequent check will hit the same error until a human acts.',
            '7a. If check_status returns the CLAIM_LOCKED error code, STOP polling and tell me verbatim: "Nova has locked grant pickup for this agent after repeated claim-secret mismatches. This usually means another process is racing the claim with a wrong secret. Investigate before reissuing — if my local identity is intact, ask the operator to run nova_admin({action:\'reissue_grant\', ...}); if you suspect a leak, deregister this agentId and start over with a fresh invite." Do NOT retry polling — the lockout persists until reissue.',
            '8. Once claimed, confirm nova_identity({action:"whoami"}) shows a cached grant.',
            '9. If this agent registered with receiving skills (anything other than __sender_only), immediately call nova_inbox({action:"watch"}) to open the push stream for nova://inbox. From this point on, Nova emits notifications/resources/updated whenever a task lands, and you claim via nova_inbox({action:"next"}). The full receiver loop is in the nova_serve prompt — use it.',
            '10. If this agent is sender-only, no inbox subscription is needed. See the nova_first_task prompt for the push-driven send flow (subscribe to nova://replies via nova_replies({action:"watch"}) before sending so results push back instead of requiring polling).',
            '11. For long-running runtimes: subscriptions stay open for the life of the MCP session. The shared SSE client reconnects automatically on transient drops. On clean shutdown call nova_inbox({action:"unwatch"}) / nova_replies({action:"unwatch"}); abrupt exits are fine too (Nova closes the stream server-side).',
            '',
            'Gotchas — read before step 5:',
            '- Invite tokens are single-use. The server consumes the token only after all agent-side validation passes (agentIdHint match, tenant exists, agentId not already registered), so AGENT_ID_MISMATCH / TENANT_NOT_FOUND / AGENT_EXISTS errors leave the invite reusable — fix the input and retry with the SAME token. Only a successful 201, an expired token, or a concurrent race returns INVITE_INVALID on retry.',
            '- Operators: always mint with an agentIdHint matching the agent id the runtime will use (e.g. "hermes-agent", not "hermes") so the operator-agent handshake is unambiguous.',
            '- If AGENT_EXISTS comes back on a fresh registration attempt, the prior record may be in "deregistered" state — Nova now treats deregistered agents as re-registerable, overwriting the stale config. If the error persists with an active or pending record, ask the operator to reject or delete the existing agent before retrying.',
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
            `1. Call nova_discover({action:"card", agentId:"${targetAgentId}"}) to see the skill list and their inputSchema.`,
            '2. Tell me which skill to invoke and show me the inputSchema so I can craft valid params.',
            '3. Before sending, call nova_replies({action:"watch"}) so task results push in via notifications/resources/updated instead of requiring polling. (If your MCP client implements resources/subscribe natively, it may already be subscribed to nova://replies — the watch action is the fallback for clients that do not.)',
            `4. Call nova_task({action:"send", targetAgentId:"${targetAgentId}", intent:"<skill>", params:{...}}). Capture the returned taskId.`,
            '5. Optionally call nova_task({action:"watch", taskId}) to stream state transitions (submitted → claimed → completed / failed) as notifications. This stream closes automatically on terminal state.',
            '6. When the reply push fires (or the watch reports completed), call nova_replies({action:"next"}) to claim the TaskResult, then nova_replies({action:"ack", taskId}) to mark it handled. If you skipped watching, nova_task({action:"result", targetAgentId, taskId}) works as a poll.',
            '',
            'If any step fails, surface the Nova error code and suggest a fix.',
          ].join('\n'),
        },
      }],
    }),
  );

  server.registerPrompt(
    'nova_serve',
    {
      title: 'Receive tasks from other agents',
      description: 'Guides a receiving agent through push-subscribed task handling: watch inbox, claim on notify, respond, ack.',
    },
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            'Help me serve incoming tasks on Nova. The push model avoids polling: Nova emits notifications/resources/updated when a task lands, and I claim it on demand.',
            '',
            '1. Confirm this agent has registered with at least one receiving skill (not just __sender_only). If nova_identity({action:"whoami"}) shows only __sender_only, STOP and tell me to re-register with real skills — receivers need skill IDs that match what senders invoke.',
            '2. Call nova_inbox({action:"watch"}) to open the push stream for nova://inbox. Idempotent — calling twice is fine. If the MCP client implements resources/subscribe natively, it may be watching already; the watch action is the fallback.',
            '3. Wait for an MCP notifications/resources/updated event on nova://inbox. Each event is a hint that a task is waiting — the event payload is not the task itself.',
            '4. On notification, call nova_inbox({action:"next", waitMs:1000}) to claim the task. The task is now held with a 5-minute visibility timeout; if you do not respond before it expires, Nova redelivers.',
            '5. Validate params against the skill\'s declared inputSchema before doing work. Reject with a structured error if params do not validate.',
            '6. Do the work. The respond action is terminal — there is no intermediate/progress status. If the skill cannot finish within the 5-minute visibility window, call nova_inbox({action:"respond", ...}) with status="error" before the window elapses rather than blocking silently (silent timeouts cause Nova to redeliver to the next puller, which is usually not what you want).',
            '7. Call nova_inbox({action:"respond", taskId, status, result?/error?}) with the final TaskResult (status="ok" with `result`, or status="error" with `error`) well before the 5-minute window elapses.',
            '8. Continue listening for further notifications. On shutdown, call nova_inbox({action:"unwatch"}) to close the stream cleanly.',
            '',
            'Gotchas:',
            '- Notifications are hints, not deliveries. Always claim via nova_inbox({action:"next"}) — the task object is not in the notification payload.',
            '- If the stream drops (network glitch, Nova restart), the shared SSE client auto-reconnects. You may briefly miss a push; a nova_inbox({action:"next"}) call on reconnect picks up anything queued.',
            '- Do not ack inbox tasks with nova_replies({action:"ack"}) — that is for the sender side collecting replies. Receivers close the loop with nova_inbox({action:"respond"}).',
          ].join('\n'),
        },
      }],
    }),
  );
}
