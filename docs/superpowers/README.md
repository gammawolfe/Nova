# superpowers/ — design records (historical)

These `plans/` and `specs/` are **point-in-time design documents**, dated in
their filenames (`YYYY-MM-DD-*`). They capture the design and rationale of a
feature *as it was being built* — they are an archive, not living reference
docs, and are intentionally left as-written.

**They predate the MCP tool consolidation.** Many reference the original
one-tool-per-operation MCP names (`nova_send_task`, `nova_next_task`,
`nova_register_agent`, …). Those names still work behind `NOVA_MCP_LEGACY_TOOLS=1`,
but the supported surface is now 7 action-based tools (`nova_task`, `nova_inbox`,
`nova_onboard`, …).

For the **current** state of the system, use:

- [`../../README.md`](../../README.md) — overview + current tool surface
- [`../../packages/mcp-server/README.md`](../../packages/mcp-server/README.md) — full MCP tool/resource/env reference
- [`../agent-onboarding.md`](../agent-onboarding.md) — canonical onboarding workflow
- [`../admin-api.md`](../admin-api.md) — full HTTP endpoint reference
- [`../mcp-tool-consolidation.md`](../mcp-tool-consolidation.md) — the legacy→consolidated mapping and rationale

When reading a spec here, treat any tool name as historical and cross-check
against the docs above before acting on it.
