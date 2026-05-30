# MCP tool consolidation spec

**Status:** proposal · **Target:** `packages/mcp-server/src/tools.ts`
**Lifted from:** Archon's MCP "2-tool consolidation" pattern (find/manage + `action`),
adapted to Nova's domain.

## Problem

`registerTools()` currently exposes **26 tools** (20 unconditional + 6 push-subscription).
Every connecting runtime (Claude Code, Cursor, Hermes, OpenClaw) pays for all 26 in:

- **Context tokens** — 26 names + titles + descriptions + input schemas are injected
  into the model's tool list every session. Several descriptions are 3–6 sentences.
- **Selection error rate** — the agent must disambiguate near-duplicates:
  `watch_inbox`/`unwatch_inbox`/`next_task`/`respond` vs
  `watch_replies`/`unwatch_replies`/`next_reply`/`ack_reply`. These are easy to confuse.
- **Cognitive load** — six near-identical `watch_*`/`unwatch_*` tools dominate the list
  but are fallbacks most clients never use (clients with `resources/subscribe` ignore them).

## Target surface: 26 → 7

Each tool takes a required `action` discriminator plus action-specific params.

| New tool | `action` values | Replaces |
|---|---|---|
| `nova_identity` | `generate` · `whoami` · `rotate_key` · `grant_status` | generate_identity, whoami, rotate_key, ucan_status, renew_ucan |
| `nova_onboard` | `inspect_invite` · `accept_invite` · `register` · `check_status` | inspect_invite, accept_invite, register_agent, check_registration |
| `nova_discover` | `list` · `card` | list_agents, get_agent_card |
| `nova_task` | `send` · `result` · `watch` · `unwatch` | send_task, get_task_result, watch_task, unwatch_task |
| `nova_inbox` | `next` · `respond` · `watch` · `unwatch` | next_task, respond, watch_inbox, unwatch_inbox |
| `nova_replies` | `next` · `ack` · `watch` · `unwatch` | next_reply, ack_reply, watch_replies, unwatch_replies |
| `nova_admin` | `create_tenant` · `create_invite` · `reissue_grant` | create_tenant, create_invite, reissue_ucan |

`nova_renew_ucan` and `nova_ucan_status` already return the *same* payload today
(`cid`, `expiresAt`, `lifetimeRemaining` — see tools.ts:346–350 vs 450–454), so the
merge into `nova_identity({action:"grant_status"})` loses no capability. But `renew_ucan`
carries a conceptual warning that MUST survive: in the delegation-chain model there is no
client-side renewal. Preserve it as structured output, not just prose:

```json
{ "cid": "…", "expiresAt": "…", "lifetimeRemaining": 0.18,
  "renewal": { "mode": "operator_reissue_required",
    "remediation": "operator runs nova_admin({action:'reissue_grant', tenantId, agentId}), then nova_onboard({action:'check_status'})" } }
```

and restate it in the tool description. The six `watch_*`/`unwatch_*` tools fold into the
`watch`/`unwatch` actions of the resource they target.

## Schema strategy: flat raw-shape (forced by the SDK)

We intended "union-first" for stronger planning hints. **Verified against
`@modelcontextprotocol/sdk` 1.29.0, that does not work:**

- `normalizeObjectSchema` (`server/zod-compat.js`) returns a usable schema only for a raw
  shape or an object schema (one with `.shape`). A top-level `z.discriminatedUnion` has no
  `.shape`, so it returns `undefined`.
- In `ListTools` (`server/mcp.js:76–83`), an `undefined` normalization makes the advertised
  `inputSchema` fall back to `EMPTY_OBJECT_JSON_SCHEMA`.

Net: a discriminated union **validates** fine (mcp.js:172–173 parses with the schema
directly) but advertises an **empty** parameter schema — *zero* planning hints. That is
strictly worse than flat. So:

- **Wire `inputSchema` = a flat raw shape:** required `action` enum + all other params
  optional, each with a precise `.describe()` (e.g. "respond: the taskId from action:'next'").
  This is the only shape the SDK renders into a full property list for the client.
- **Validation = per-action zod schema, re-parsed in the handler** via `forAction()` (single
  source of truth for each action's real requirements). Server-side safety is unchanged; a
  bad-shape call returns a precise zod error.

The flat schema's all-optional weakness is bought back three ways: the `action` enum is a
strong hint, every param's `.describe()` names which action(s) need it, and the description
carries the `ACTIONS:` map + happy-path order. Consolidation also narrows the choice before
params matter (tool → action → params), so any hint-loss bites only at the third step.

## Instruction-driven descriptions (Archon's second lesson)

Consolidation only works if the description teaches the agent the action map and the
*sequence*. Pattern for every consolidated tool:

```
<one-line purpose>.

ACTIONS:
- generate(agentId)         → create identity. Run once per runtime.
- whoami()                  → active DID, tenant, grant status.
- rotate_key(agentId?)      → rotate keypair; surfaces new DID to notify counterparties.
- grant_status()            → approval-grant expiry / lifetime remaining.

TYPICAL ORDER: generate → (nova_onboard) → whoami to confirm.
```

Embedding the happy-path order in the description is how Archon keeps agents from getting
lost without a 26-tool menu. Return values should also point forward, e.g. `nova_task`'s
`send` already returns `statusUrl`; add `"nextStep": "nova_task({action:'result', taskId})"`.

## Reference implementation pattern

Helper to dispatch + validate, plus the existing per-broker boilerplate extracted once
(today `loadAgentRuntime`/`loadIdentity`/`loadTenantConfig`/`mintSelfAuthToken` is copy-pasted
across `next_task`/`respond`/`next_reply`/`ack_reply`):

```ts
// dispatch helper — validate the slice of args relevant to the chosen action
function forAction<T extends z.ZodTypeAny>(
  schema: T,
  args: unknown,
  fn: (v: z.infer<T>) => Promise<ReturnType<typeof ok>>,
) {
  const parsed = schema.safeParse(args);
  if (!parsed.success) return err(`Invalid params: ${parsed.error.issues.map(i => i.message).join('; ')}`);
  return fn(parsed.data);
}

// shared broker preamble — replaces the 4-line block repeated in 4 tools
async function brokerCtx() {
  const rt = await loadAgentRuntime();
  if (!rt) throw new Error('No active agent runtime. Set NOVA_AGENT_ID.');
  const identity = await loadIdentity(rt.agentId);
  if (!identity) throw new Error(`Identity missing for ${rt.agentId}`);
  const selfUcan = mintSelfAuthToken({ senderDid: identity.did, senderPrivateKeyPem: identity.privateKeyPem });
  return { rt, identity, selfUcan };
}
```

Consolidated `nova_inbox` (subsumes next_task, respond, watch_inbox, unwatch_inbox):

```ts
server.registerTool('nova_inbox', {
  title: 'Broker-mode inbox: pull, respond, and watch tasks for this agent',
  description: [
    'Receive tasks addressed to this agent (no webhook needed).',
    '',
    'ACTIONS:',
    "- next(waitMs?)                       → long-poll a task; claims it for 5 min. null on timeout.",
    "- respond(taskId, status, result?, error?) → complete a claimed task. Call before the 5-min visibility expires.",
    "- watch()                             → fallback push subscription to nova://inbox (clients with resources/subscribe should skip).",
    "- unwatch()                           → stop the watch subscription.",
    '',
    'TYPICAL LOOP: next → (do work) → respond. Use watch only if your client cannot subscribe to resources.',
  ].join('\n'),
  inputSchema: {
    action: z.enum(['next', 'respond', 'watch', 'unwatch']),
    waitMs: z.number().int().min(0).max(60_000).optional().describe('next: max wait (server caps 60s). Default 30000.'),
    taskId: z.string().uuid().optional().describe('respond: the taskId from action:"next".'),
    status: z.enum(['ok', 'error']).optional().describe('respond: outcome.'),
    result: z.record(z.unknown()).optional().describe('respond+ok: payload shaped to the skill outputSchema.'),
    error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean().optional() }).optional(),
  },
}, async (args: any) => {
  switch (args.action) {
    case 'next':
      return forAction(z.object({ waitMs: z.number().int().min(0).max(60_000).default(30_000) }), args, async ({ waitMs }) => {
        const { rt, selfUcan } = await brokerCtx();
        const result = await rt.client.inboxPull(rt.agentId, selfUcan, waitMs);
        return ok(result ?? { task: null, message: 'No task available within wait window.' });
      });
    case 'respond':
      return forAction(
        z.object({
          taskId: z.string().uuid(),
          status: z.enum(['ok', 'error']),
          result: z.record(z.unknown()).optional(),
          error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean().optional() }).optional(),
        }).refine(v => v.status !== 'error' || !!v.error, { message: '`error` required when status is "error"', path: ['error'] }),
        args,
        async ({ taskId, status, result, error }) => {
          const { rt, selfUcan } = await brokerCtx();
          const res = await rt.client.inboxRespond(rt.agentId, selfUcan, taskId, {
            status, ...(result !== undefined ? { result } : {}), ...(error !== undefined ? { error } : {}),
          });
          return ok(res);
        });
    case 'watch':
      if (!subscriptions) return err('Push subscriptions not available in this MCP host.');
      await subscriptions.subscribe('nova://inbox');
      return ok({ status: 'subscribed', uri: 'nova://inbox' });
    case 'unwatch':
      if (!subscriptions) return err('Push subscriptions not available in this MCP host.');
      await subscriptions.unsubscribe('nova://inbox');
      return ok({ status: 'unsubscribed', uri: 'nova://inbox' });
  }
});
```

`nova_task` follows the same shape (`send` = the existing 90-line body unchanged; `result`,
`watch`, `unwatch` map to current handlers). `nova_replies`, `nova_discover`, `nova_identity`,
`nova_onboard`, `nova_admin` likewise wrap the existing handler bodies — **no protocol or
nova-client changes**, this is purely a surface re-shape.

## Migration / back-compat

The three prompts in `prompts.ts` (`/nova_onboard`, `/nova_first_task`, `/nova_serve`)
and the README reference the old names — they must be updated in lockstep.

Two true constraints pull apart here: (a) don't break external scripts that hardcode old
names; (b) you cannot measure the 7-tool ergonomics while 26 legacy tools are *also* in the
surface — both-visible is a 33-tool degraded state, and LLMs offered a legacy + a preferred
tool will pick legacy a non-trivial fraction of the time despite a "Prefer…" note.

**Reconciliation (recommended):** ship the 7 as the **default** surface; keep the 26 as
thin shims to the new handlers **behind `NOVA_MCP_LEGACY_TOOLS=1`, default OFF**, with
descriptions tagged `[legacy] prefer nova_task({action:'send'})`. Default-off means the
measured surface *is* the target surface; the flag is the escape hatch for stragglers.
Drop the shims after one release. Update `prompts.ts`, the README "Tools exposed" block, and
`docs/agent-onboarding.md` in lockstep regardless.

**Open question:** if the signal you actually want is *migration stickiness* (do agents
abandon legacy when both are present?), default the flag ON for one release instead — that
trades clean, measurable ergonomics for a migration signal. Recommend OFF: "are the 7 tools
good?" is the question worth answering first.

`nova_send_task` is the single hottest tool; if discoverability of "send" matters more than
list-consistency, it may be kept top-level (`nova_send_task`) while everything else
consolidates — flagged as an open choice, not a blocker.

## Expected payoff

- Tool list: **26 → 7** (~73% fewer entries; the 6 redundant watch/unwatch descriptions
  collapse into 4 one-line action bullets).
- One `brokerCtx()` helper removes the 4-line preamble duplicated across 4 handlers.
- Net: smaller per-session context, fewer wrong-tool calls, and a forward-pointing
  description that teaches sequence — Archon's actual win, not just "fewer tools".
