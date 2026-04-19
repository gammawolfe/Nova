# Admin UI agent detail panel

**Status:** design approved 2026-04-19
**Scope:** Shared non-modal detail panel that opens when an agent card (Agents tab) or planet (Live tab) is clicked. Replaces the current "click navigates to galaxy detail" behavior with RUBRIC-flow-style inline detail.
**Prior context:** All six admin UI bites merged. User flagged that click → galaxy detail is unintuitive. Explored RUBRIC's flows-canvas node-click pattern (non-modal detail panel, adjacent to content, click-to-open, click-X to close). This bite brings that pattern to Nova's Agents + Live tabs.

## Motivation

The Agents tab card click currently navigates to `#/galaxy/<tenant>`. The Live tab planet click does the same. Both surface *galaxy* context when the operator clicked an *agent* — semantic mismatch. RUBRIC's flows surface solves the analogous problem with a non-modal inline detail panel: click a node, the panel shows the node's metadata adjacent to the canvas. The operator stays in the tab, can click other nodes to switch panel content, and dismisses with a close-X.

This bite ports that pattern. No new route, no full-page replacement, no blocking modal.

## Scope

**In scope**
- New Alpine state: `selectedAgent` (the full `ParsedAgentMeta` object, or `null` when closed)
- New methods: `openAgentDetail(agentId)` to set selection; `closeAgentDetail()` to clear
- Shared HTML for `.nova-agent-detail` panel — fixed-position right-side panel, 380px wide, non-modal (no backdrop)
- Agents tab card: `<a href>` → `<div @click>` that calls `openAgentDetail(a.agentId)`; prevents the current galaxy navigation
- Live tab planet: `<a href>` → `<g @click>` that calls `openAgentDetail(p.agentId)` on the planet group; no longer navigates
- Galaxy pill on the agent card remains clickable as a separate link to `#/galaxy/<slug>` (keeps galaxy navigation as an explicit opt-in)
- Tab change closes the panel (`$watch('activeTab', () => closeAgentDetail())`)
- New CSS: `.nova-agent-detail`, its close button, and layout
- Panel content: agent name (gradient title), DID (mono, wrap-anywhere), galaxy slug (pill, clickable to galaxy), description, skills (id + name + description + tags), capabilities (three indicators), close-X top-right
- Playwright smoke tests for both triggers + close

**Out of scope**
- Dedicated `#/agent/:agentId` route — deferred indefinitely
- Fetching additional per-agent data (operatorUrl, createdAt, trust tier) — those require extra calls; current bite uses only the `ParsedAgentMeta` we already have
- Recent audit-log entries per agent inside the panel — separate bite
- Keyboard shortcuts (Escape to close) — nice-to-have; defer
- Animation on open/close — flat appear/disappear this bite, polish later if desired

## Panel layout

Fixed position, right edge of viewport, height fills the area between ticker and bottom. Non-modal: no backdrop, pointer events on rest of the page stay live.

```
┌──── viewport ────────────────────────────────────────────────┬──────────────┐
│  ticker (28px)                                               │              │
├──────────┬──────────────────────────────────────────┬────────┤              │
│ sidebar  │ tab content (Agents grid / Live solar)   │        │   panel      │
│          │                                          │        │   380px fixed│
│          │                                          │        │              │
│          │                                          │        │              │
└──────────┴──────────────────────────────────────────┴────────┴──────────────┘
```

Panel sits at `position: fixed; top: 28px; right: 0; bottom: 0; width: 380px; z-index: 60` (above content, below modals at z=100, below toasts at z=200). When open, nothing is pushed — it overlays the right portion of the tab content. Operators can still click other cards/planets through the un-covered portion.

## Panel content

```html
<aside class="nova-agent-detail" x-show="selectedAgent" x-cloak>
  <button class="nova-agent-detail-close" @click="closeAgentDetail()" aria-label="Close">×</button>

  <div class="nova-eyebrow">◉ AGENT</div>
  <h2 class="nova-display" style="font-size:28px;margin:8px 0 12px" x-text="selectedAgent?.name"></h2>

  <div class="nova-mono" style="margin-bottom:16px" x-text="selectedAgent?.agentId"></div>

  <div style="margin-bottom:16px">
    <div class="nova-label">galaxy</div>
    <a :href="`#/galaxy/${encodeURIComponent(galaxySlug(selectedAgent?.tenantId))}`"
       class="nova-pill"
       style="color:var(--text-secondary);border-color:var(--border);text-decoration:none"
       x-text="galaxySlug(selectedAgent?.tenantId)"></a>
  </div>

  <div x-show="selectedAgent?.did" style="margin-bottom:16px">
    <div class="nova-label">did</div>
    <div class="nova-mono" style="overflow-wrap:anywhere;font-size:11px" x-text="selectedAgent?.did"></div>
  </div>

  <div x-show="selectedAgent?.description" style="margin-bottom:16px">
    <div class="nova-label">description</div>
    <p class="nova-subtitle" style="margin:0" x-text="selectedAgent?.description"></p>
  </div>

  <div x-show="selectedAgent?.skills?.length > 0" style="margin-bottom:16px">
    <div class="nova-label" style="margin-bottom:8px">skills</div>
    <div style="display:flex;flex-direction:column;gap:10px">
      <template x-for="s in (selectedAgent?.skills || [])" :key="s.id">
        <div style="padding:10px;border:1px solid var(--border);border-radius:8px">
          <div style="color:#fff;font-weight:500" x-text="s.name"></div>
          <div class="nova-mono" style="font-size:10px;margin-top:2px" x-text="s.id"></div>
          <p x-show="s.description" class="nova-subtitle" style="margin:6px 0 0" x-text="s.description"></p>
        </div>
      </template>
    </div>
  </div>

  <div>
    <div class="nova-label" style="margin-bottom:8px">capabilities</div>
    <div class="nova-row" style="gap:14px;color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:1px">
      <span class="nova-capability-indicator" :class="selectedAgent?.capabilities?.streaming && 'is-on'">streaming</span>
      <span class="nova-capability-indicator" :class="selectedAgent?.capabilities?.pushNotifications && 'is-on'">push</span>
      <span class="nova-capability-indicator" :class="selectedAgent?.capabilities?.stateTransitionHistory && 'is-on'">history</span>
    </div>
  </div>
</aside>
```

## Frontend — state and methods

**New state** added alongside the existing tab-level state:

```js
    selectedAgent: null,
```

**New methods:**

```js
    openAgentDetail(agentId) {
      const match = this.allAgents.find(a => a.agentId === agentId);
      if (!match) return;
      this.selectedAgent = match;
    },

    closeAgentDetail() {
      this.selectedAgent = null;
    },
```

**Tab-change close:** In `init()`, after `connectSse()`, register a `$watch` via Alpine's `.$watch(...)` API to close the panel whenever `activeTab` changes:

```js
      // close the detail panel on tab navigation
      Alpine.effect(() => {
        // read activeTab to subscribe; value itself is unused
        const _ = this.activeTab;
        if (this.selectedAgent) this.closeAgentDetail();
      });
```

Wait — `Alpine.effect` runs immediately, and the first read of `activeTab` would close on first render. Cleaner: track the previous value.

```js
      // close the detail panel on tab navigation
      let _lastTab = this.activeTab;
      Alpine.effect(() => {
        const current = this.activeTab;
        if (current !== _lastTab) {
          _lastTab = current;
          if (this.selectedAgent) this.closeAgentDetail();
        }
      });
```

## Frontend — Agents card click change

Current agent card markup in `index.html`:

```html
<a class="nova-agent-card" :href="`#/galaxy/${encodeURIComponent(galaxySlug(a.tenantId))}`">
```

Change to a `<div>` with click handler:

```html
<div class="nova-agent-card" role="button" tabindex="0"
     @click="openAgentDetail(a.agentId)"
     @keydown.enter="openAgentDetail(a.agentId)"
     @keydown.space.prevent="openAgentDetail(a.agentId)">
```

The galaxy pill inside the card remains clickable as a link to the galaxy (separate concern). To make that work we need to stop the click from propagating to the card click handler:

```html
<a class="nova-pill" :href="`#/galaxy/${encodeURIComponent(galaxySlug(a.tenantId))}`"
   style="color:var(--text-secondary);border-color:var(--border);text-decoration:none"
   @click.stop x-text="galaxySlug(a.tenantId)"></a>
```

Replaces the current `<span class="nova-pill">` with an `<a>`.

## Frontend — Live planet click change

Current planet group is created by `renderLiveSvg` imperatively:

```js
const a = document.createElementNS(NS, 'a');
a.setAttributeNS(XLINK, 'xlink:href', `#/galaxy/${encodeURIComponent(p.galaxySlug)}`);
a.setAttribute('href', `#/galaxy/${encodeURIComponent(p.galaxySlug)}`);
```

Change to a `<g>` with a click listener that calls `openAgentDetail`:

```js
const g = document.createElementNS(NS, 'g');
g.setAttribute('class', 'nova-live-planet-group');
g.style.cursor = 'pointer';
const agentId = p.agentId;
g.addEventListener('click', () => this.openAgentDetail(agentId));
// ... append children as before ...
planetsGroup.appendChild(g);  // no wrapping <a>
cached = { group: g, circle, label };
```

Cache shape updates: no more `.a` field, only `.group` (renamed from `.root`). Simpler.

## Frontend — CSS

Append to `styles.css`:

```css
/* ── Agent detail panel ────────────────────────────────────────────────── */
.nova-agent-detail {
  position: fixed;
  top: 28px;
  right: 0;
  bottom: 0;
  width: 380px;
  background: var(--surface);
  border-left: 1px solid var(--border);
  padding: 28px 24px;
  overflow-y: auto;
  z-index: 60;
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.3);
}

.nova-agent-detail-close {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-muted);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.nova-agent-detail-close:hover {
  border-color: var(--accent);
  color: var(--text);
}
```

## Data flow

- Operator clicks an agent card or planet → `openAgentDetail(agentId)` → looks up the agent in `allAgents` → sets `selectedAgent`
- Panel becomes visible via `x-show="selectedAgent"`
- Operator clicks another card/planet → `selectedAgent` is replaced with the new agent → panel content updates reactively
- Operator clicks the close-X → `closeAgentDetail()` → `selectedAgent = null` → panel hides
- Operator clicks the galaxy pill (inside the card OR inside the panel) → `@click.stop` on the card pill, or plain link behavior in the panel → hash navigates to `#/galaxy/<slug>` → Galaxies tab activates → `activeTab` changes → Alpine.effect detects transition → `closeAgentDetail()` fires automatically
- Operator clicks a sidebar nav item → same path as above
- SSE `agent` event refreshes `allAgents`; if the currently-selected agent was deregistered, next `openAgentDetail(sameId)` would fail the lookup. `selectedAgent` hangs around until the operator dismisses — acceptable; stale detail is informational only.

## Error handling

- `openAgentDetail(badId)` with no match in `allAgents` → silently no-op. Safe for stale clicks.
- `selectedAgent` with missing optional fields (no DID, no description) → guarded by `x-show` on each section.
- Panel overlays the right 380px of content. On viewport widths < 768px, the panel would cover most of the screen. For this bite we accept the overlay; mobile polish is its own concern (already out of scope).

## Verification

Manual + Playwright:

1. **Agents tab click** — click any card, panel appears on the right with the agent's details. URL does not change (stays `#/agents`).
2. **Live tab click** — click any planet, panel appears with the same content. URL does not change.
3. **Click another agent** — panel content updates without flicker; no stacking.
4. **Galaxy pill** (inside Agents card) — click only that pill → URL becomes `#/galaxy/<slug>` → Galaxies tab activates → panel closes automatically.
5. **Close-X** — click the X → panel disappears.
6. **Sidebar nav click** — click Audit (or any other tab) → panel closes automatically.
7. **Close mid-rotation (Live)** — open a planet's panel, wait 5 seconds while ring rotates, click another planet — panel content swaps cleanly even with positions changing.
8. Existing smoke tests still pass: the current `Agents tab renders cards with DID and skill chips` test asserts the card renders but does not assert the card is an `<a>`, so the swap to `<div role="button">` is compatible. The Live test `Live tab: Simulate conversation adds a line` also remains valid (Simulate doesn't depend on planet click behavior).
9. New Playwright test: `Agents card click opens detail panel` — click card, assert `.nova-agent-detail` visible with the expected name and DID. Click close-X, assert hidden.
10. New Playwright test: `Tab navigation closes the detail panel` — open panel, click a nav item, assert panel hides.

## Files expected to change

- `packages/admin-api/public/index.html` — replace Agents card `<a>` with `<div>` + click, replace inline galaxy `<span>` with `<a @click.stop>`, insert the new `.nova-agent-detail` panel after the authenticated `</section>` but inside the `<main>` (so it's above the `.nova-app` layer but still scoped to the authenticated view). Actually — cleanest is INSIDE the authenticated `<section>` right before the toast stack: that keeps it scoped to `x-show="token"` and renders in the same Alpine context. Confirm during implementation.
- `packages/admin-api/public/js/app.js` — add `selectedAgent` state, `openAgentDetail`, `closeAgentDetail`, wire `Alpine.effect` in `init`; modify `renderLiveSvg` to remove the wrapping `<a>` and add `click` listener with `openAgentDetail`. Cache shape gains `group` / loses `a`.
- `packages/admin-api/public/styles.css` — append `.nova-agent-detail` + `.nova-agent-detail-close` block
- `packages/admin-api/test/e2e/admin-ui-tabs.spec.ts` — two new tests (`Agents card click opens detail panel`, `Tab navigation closes the detail panel`). Existing tests unchanged.

Approximate size: ~50 HTML lines replaced/inserted, ~40 CSS lines added, ~35 JS lines added + the `renderLiveSvg` click-handler swap (~10 lines changed).

## Risks and decisions deferred

- **`openAgentDetail` relies on `allAgents`.** If the user opens Live before Agents was hit, `allAgents` still populates because the Live tab's `loadAllAgents` fires on entry. Verified by the existing shared-state approach.
- **No Escape-to-close.** Considered but deferred — adds a document-level `keydown` listener that needs careful cleanup. Can add in a polish follow-up.
- **No animation.** Panel appears/disappears instantly via `x-show`. A slide-in transition is nice but adds CSS complexity that interacts oddly with `x-show`. Defer.
- **Panel width on narrow viewports.** At 380px fixed width on a 500px viewport, the panel would cover 76% of the screen. Acceptable for admin use (operators typically on desktop); a future responsive pass can make the panel full-screen below a breakpoint.
- **Stale selection when an agent deregisters.** Panel content doesn't auto-refresh on SSE changes. If a selected agent is removed, the panel shows stale data until dismissed. Low risk for admin use; not worth complicating the watcher logic for now.
- **No click-outside-to-close.** Clicking anywhere outside the panel does NOT close it (only the X or tab nav does). RUBRIC's pattern matches — it's non-modal and intentional. If this feels unnatural, adding a document click listener that checks `!event.target.closest('.nova-agent-detail')` is a one-line change later.
