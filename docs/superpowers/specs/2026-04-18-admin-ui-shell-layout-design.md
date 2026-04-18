# Admin UI shell layout — second bite

**Status:** design approved 2026-04-18
**Scope:** Introduce a sidebar + tab shell into `packages/admin-api/public`. Move existing views into tabs. Add placeholder tabs for Agents / Live / Audit.
**Prior bite:** `2026-04-18-admin-ui-palette-refresh-design.md` (palette + calmed ornament) — merged to main.
**Next bites (not this work):** Agents detail tab content, Live solar-system view, Audit log view.

## Motivation

The palette refresh calmed the admin UI's chrome and set up RUBRIC's black + amber token system. This second bite replaces the single centered-column layout with a sidebar + main-content shell that can grow to host multiple tabs. Placeholder tabs for Agents, Live, and Audit tell future us (and future operators) where those surfaces will land.

The shell is deliberately structural, not functional. No new data surfaces gain real content this bite. Placeholders are honest "Coming soon" stubs — not fake data. This lets us validate the shell visually and on interaction before committing to the detail work of any one tab.

## Scope

**In scope**
- New HTML structure: wrap the authenticated view in `.nova-app` (sidebar + main)
- New CSS for `.nova-sidebar`, `.nova-sidebar-toggle`, `.nova-nav`, `.nova-nav-item`, `.nova-main`, `.nova-placeholder`
- New hash routes: `#/agents`, `#/live`, `#/audit` (in addition to existing `#/` and `#/galaxy/:slug`)
- New Alpine state: `sidebarCollapsed`, `activeTab` (computed)
- Sidebar collapse toggle with `localStorage` persistence (key: `nova-admin-sidebar-collapsed`, value `'1'` for collapsed)
- Placeholder views for Agents, Live, Audit — amber eyebrow + one-sentence description
- Existing Galaxies list + galaxy detail move inside the shell, rendered in the Galaxies tab's content area

**Out of scope**
- Topbar (no search, no notifications, no user menu this bite)
- Global search / keyboard shortcut
- Agent-status panel inside the sidebar (distinct from the Agents tab)
- Real content for Agents / Live / Audit — each is a later bite
- Mobile responsiveness polish beyond "doesn't completely break"
- Any backend changes (no new routes, no new SSE events, no schema changes)
- Automated visual-regression tests

## Layout

Authenticated view only. The login screen is untouched.

```
┌──────────────────────────────────────────────────────────────┐
│ ◉ nova admin · 3 galaxies · 1 pending  (kinetic ticker, 28px) │
├────────────┬─────────────────────────────────────────────────┤
│ ◉ NOVA     │                                                 │
│ · ADMIN    │                                                 │
│            │                                                 │
│ Galaxies ● │     Tab content area                            │
│ Agents     │     (Galaxies list, galaxy detail,              │
│ Live       │      Agents placeholder, Live placeholder,      │
│ Audit      │      Audit placeholder)                         │
│            │                                                 │
│            │                                                 │
│            │                                                 │
│ ──────     │                                                 │
│ Log out    │                                                 │
└────────────┴─────────────────────────────────────────────────┘
 [◀] sidebar toggle
```

- Sidebar: `220px` wide, fixed height to viewport. Collapses to `0` width via a small circular toggle on the sidebar's right edge. Toggle stays visible in both states (flush-left when collapsed).
- Main area: fills the remaining width. Existing content renders inside it. No topbar this bite.
- Ticker: stays as a full-width `28px` strip at the very top of the viewport, spanning both sidebar and main.
- Galaxy detail: hash-routed as today (`#/galaxy/:slug`), renders in the Galaxies tab's content slot. The Galaxies sidebar item stays highlighted. A back-link (`← All galaxies`) returns to `#/`.

## HTML restructure

Current authenticated section at `packages/admin-api/public/index.html`:

```html
<section x-show="token" x-cloak>
  <div class="nova-row" style="justify-content:space-between;margin-bottom:24px">
    <div class="nova-eyebrow">◉ NOVA · ADMIN</div>
    <button class="nova-input" …>Log out</button>
  </div>

  <template x-if="route.name === 'home'">…galaxies list…</template>
  <template x-if="route.name === 'galaxy'">…galaxy detail…</template>
  <!-- modals -->
</section>
```

New structure:

```html
<section x-show="token" x-cloak class="nova-app" :class="sidebarCollapsed && 'is-sidebar-collapsed'">
  <aside class="nova-sidebar">
    <div class="nova-sidebar-brand">
      <div class="nova-eyebrow">◉ NOVA · ADMIN</div>
    </div>
    <nav class="nova-nav">
      <a href="#/"        class="nova-nav-item" :class="activeTab === 'galaxies' && 'is-active'">Galaxies</a>
      <a href="#/agents"  class="nova-nav-item" :class="activeTab === 'agents'   && 'is-active'">Agents</a>
      <a href="#/live"    class="nova-nav-item" :class="activeTab === 'live'     && 'is-active'">Live</a>
      <a href="#/audit"   class="nova-nav-item" :class="activeTab === 'audit'    && 'is-active'">Audit</a>
    </nav>
    <div class="nova-sidebar-spacer"></div>
    <button class="nova-sidebar-logout" @click="logout()">Log out</button>
  </aside>

  <button class="nova-sidebar-toggle" @click="toggleSidebar()" :aria-label="sidebarCollapsed ? 'Open sidebar' : 'Collapse sidebar'">
    <span x-text="sidebarCollapsed ? '▶' : '◀'"></span>
  </button>

  <section class="nova-main">
    <template x-if="route.name === 'home'">
      <!-- existing galaxies list, unchanged -->
    </template>
    <template x-if="route.name === 'galaxy'">
      <!-- existing galaxy detail, unchanged -->
    </template>

    <template x-if="route.name === 'agents'">
      <div class="nova-placeholder">
        <div class="nova-eyebrow">◉ AGENTS</div>
        <h1 class="nova-display" style="font-size:32px;margin:8px 0 6px">Coming soon.</h1>
        <p class="nova-subtitle">Flat cross-galaxy view of every registered agent — advertised skills, trust tier, DID, last-seen.</p>
      </div>
    </template>

    <template x-if="route.name === 'live'">
      <div class="nova-placeholder">
        <div class="nova-eyebrow">◉ LIVE</div>
        <h1 class="nova-display" style="font-size:32px;margin:8px 0 6px">Coming soon.</h1>
        <p class="nova-subtitle">Solar-system visualization. Planets orbit a star; dotted lines light up as A2A conversations flow, streamed from <code>/admin/events</code>.</p>
      </div>
    </template>

    <template x-if="route.name === 'audit'">
      <div class="nova-placeholder">
        <div class="nova-eyebrow">◉ AUDIT</div>
        <h1 class="nova-display" style="font-size:32px;margin:8px 0 6px">Coming soon.</h1>
        <p class="nova-subtitle">Task audit log — which agent sent what to whom, when, and with what result. Feeds from <code>/admin/audit</code>.</p>
      </div>
    </template>
  </section>

  <!-- create-galaxy, create-invite, invite-reveal, approve modals unchanged -->
</section>
```

Notes:
- The previous inline logout button next to the brand eyebrow is removed — logout moves into the sidebar bottom.
- The previous top-of-section inline `.nova-row` with the brand + logout is removed — brand now lives inside `.nova-sidebar-brand`.
- The content `<template x-if="route.name === ...">` guards stay keyed on the route, not on `activeTab`. The route already uniquely determines which content to show; `activeTab` exists only to style the sidebar nav (since both `home` and `galaxy` routes map to the Galaxies nav item).
- Modals stay siblings of `.nova-app` inside the authenticated `<section>`. They render above the shell thanks to their existing `position: fixed` backdrop — DOM depth does not matter.

## CSS additions

Append to `packages/admin-api/public/styles.css`, after the existing `/* ── Layout ─── */` block. The existing `.nova-shell` rule needs adjusting so the authenticated shell can go full-bleed.

```css
/* ── Shell layout (authenticated) ──────────────────────────────────────── */
.nova-app {
  display: flex;
  min-height: calc(100vh - 28px); /* leaves room for the 28px ticker */
  position: relative;
}

.nova-sidebar {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 20px 16px;
  border-right: 1px solid var(--border);
  background: var(--bg);
  transition: width 0.2s ease, padding 0.2s ease, opacity 0.2s ease;
  overflow: hidden;
}
.nova-app.is-sidebar-collapsed .nova-sidebar {
  width: 0;
  padding-left: 0;
  padding-right: 0;
  opacity: 0;
  border-right: none;
}
@media (prefers-reduced-motion: reduce) {
  .nova-sidebar { transition: none; }
}

.nova-sidebar-brand {
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
  white-space: nowrap;
}

.nova-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nova-nav-item {
  display: block;
  padding: 10px 14px;
  border-radius: 8px;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
  transition: background 0.15s ease, color 0.15s ease;
  white-space: nowrap;
}
.nova-nav-item:hover {
  background: rgba(255, 255, 255, 0.04);
  color: var(--text);
}
.nova-nav-item.is-active {
  background: rgba(245, 166, 35, 0.08);
  color: var(--accent);
}

.nova-sidebar-spacer { flex: 1; }

.nova-sidebar-logout {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 14px;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.nova-sidebar-logout:hover {
  border-color: var(--border-hover);
  color: var(--text);
}

.nova-sidebar-toggle {
  position: absolute;
  top: 20px;
  left: 208px; /* 220 sidebar - 12 offset for half-overlap */
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text-muted);
  cursor: pointer;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: left 0.2s ease, border-color 0.15s ease, color 0.15s ease;
  z-index: 10;
}
.nova-sidebar-toggle:hover {
  border-color: var(--border-hover);
  color: var(--text-secondary);
}
.nova-app.is-sidebar-collapsed .nova-sidebar-toggle { left: 8px; }
@media (prefers-reduced-motion: reduce) {
  .nova-sidebar-toggle { transition: none; }
}

.nova-main {
  flex: 1;
  min-width: 0;
  padding: 40px 32px;
  overflow-y: auto;
  max-height: calc(100vh - 28px);
}

.nova-placeholder {
  max-width: 560px;
  margin: 80px auto 0;
  text-align: center;
}
```

**`.nova-shell` modification.** Today it caps content at 1100px and adds 52px top padding. The authenticated view now uses `.nova-main` for its padding, so `.nova-shell` becomes an unstyled container for the authenticated section — but the login view still relies on its centered column. The cleanest fix is to keep `.nova-shell` unchanged and simply not apply it inside `.nova-app`. Since `.nova-shell` is set on `<main>` in `index.html`, and `.nova-app` becomes its child, the existing `max-width` on the `<main>` will constrain the shell too.

Resolution: add a rule that neutralizes `.nova-shell`'s centering when it contains `.nova-app`:

```css
.nova-shell:has(.nova-app) {
  max-width: none;
  padding: 0;
}
```

Fallback for browsers without `:has()` (Safari < 15.4, Firefox < 121): add a class `nova-shell--full` to the `<main>` element via Alpine when `token` is truthy — `.nova-shell.nova-shell--full { max-width: none; padding: 0; }`. Use the class-based approach since it's robust; `:has()` is nicer but the class version works everywhere and costs almost nothing.

Final rule:

```css
.nova-shell--full { max-width: none; padding: 0; }
```

And update the `<main>` element in `index.html` to include `:class="token && 'nova-shell--full'"`.

## JavaScript changes

`packages/admin-api/public/js/app.js`:

**1. New state** in the object returned by `novaApp()`:

```js
sidebarCollapsed: readSidebarState(),
```

Where `readSidebarState` is a small helper defined in the file (or in `utils.js`):

```js
function readSidebarState() {
  try { return localStorage.getItem('nova-admin-sidebar-collapsed') === '1'; }
  catch { return false; }
}
function writeSidebarState(collapsed) {
  try { localStorage.setItem('nova-admin-sidebar-collapsed', collapsed ? '1' : '0'); }
  catch {}
}
```

**2. New computed-like getter** for `activeTab`:

Alpine doesn't have first-class computed properties, but we can expose it as a getter on the returned object:

```js
get activeTab() {
  switch (this.route.name) {
    case 'home':
    case 'galaxy':  return 'galaxies';
    case 'agents':  return 'agents';
    case 'live':    return 'live';
    case 'audit':   return 'audit';
    default:        return 'galaxies';
  }
},
```

**3. New action** `toggleSidebar()`:

```js
toggleSidebar() {
  this.sidebarCollapsed = !this.sidebarCollapsed;
  writeSidebarState(this.sidebarCollapsed);
},
```

**4. Extend `parseRoute()`:**

```js
function parseRoute() {
  const h = location.hash.replace(/^#/, '');
  const galaxy = h.match(/^\/galaxy\/([^/]+)$/);
  if (galaxy) return { name: 'galaxy', slug: decodeURIComponent(galaxy[1]) };
  if (h === '/agents') return { name: 'agents' };
  if (h === '/live')   return { name: 'live' };
  if (h === '/audit')  return { name: 'audit' };
  return { name: 'home' };
}
```

**5. `routeLoad()` unchanged** — only `home` and `galaxy` trigger data loads. The new routes (`agents`, `live`, `audit`) have no data to fetch this bite, so no-op is correct.

**6. `logout()` unchanged** — still clears token, closes SSE, resets hash.

## Data flow

- User arrives at `/` → hash is empty → `parseRoute()` returns `{ name: 'home' }` → `activeTab === 'galaxies'` → Galaxies list renders
- User clicks "Agents" nav item → hash becomes `#/agents` → `hashchange` fires → `parseRoute()` returns `{ name: 'agents' }` → `activeTab === 'agents'` → Agents placeholder renders
- User clicks a galaxy card → hash becomes `#/galaxy/:slug` → `activeTab === 'galaxies'` (galaxy route still maps to galaxies tab) → galaxy detail renders, Galaxies nav item stays highlighted
- User clicks sidebar toggle → `toggleSidebar()` → `sidebarCollapsed` flips → `writeSidebarState()` persists → CSS transition closes the sidebar, toggle button slides left
- User reloads → `readSidebarState()` returns previous value → sidebar renders in its persisted state
- SSE event arrives for current galaxy → `loadGalaxy()` refreshes data (unchanged behavior)

## Error handling

- **localStorage blocked:** `readSidebarState()` returns `false` (default expanded); `writeSidebarState()` silently fails. Runtime toggle still works for the session.
- **Unknown hash route:** `parseRoute()` already falls through to `{ name: 'home' }`. Active tab defaults to galaxies.
- **Tab clicked during a modal:** modal stays open; content behind it changes. Modals are user-dismissed only, so this is intentional.
- **`:has()` unsupported:** covered by the class-based `.nova-shell--full` workaround.

No new failure modes. Error-response handling for `loadGalaxies` / `loadGalaxy` is unchanged.

## Verification

Manual, same as the palette bite.

1. **Run admin-api:** `docker-compose up admin-api`, browse to `http://localhost:3005`, log in with the admin token.
2. **Shell renders:** sidebar on left with brand, four nav items, logout at bottom. Toggle button on right edge of sidebar.
3. **Tab navigation:** click each of Galaxies / Agents / Live / Audit. URL hash updates. Active-tab styling (amber text, subtle amber-tinted background) moves with the click. Content area swaps between galaxies list / placeholder.
4. **Browser back/forward:** navigate several tabs, use browser back button. Each step reverses the hash; active tab follows. No reload.
5. **Galaxy detail:** click a galaxy in the list. Hash becomes `#/galaxy/:slug`. Galaxy detail renders in main area. Sidebar Galaxies item stays highlighted. Click "← All galaxies" — back to list.
6. **Sidebar collapse:** click the toggle. Sidebar collapses to 0 width over ~200ms. Toggle slides flush-left. Main area expands to fill. Click again, sidebar expands. Reload page — state persists.
7. **localStorage blocked:** in DevTools → Application → Storage, block localStorage for the origin. Reload. Sidebar defaults expanded. Toggle still works during the session but doesn't persist across reload. No errors in console.
8. **Modals over shell:** click `+ New galaxy`, `+ Issue invite`, and a planet's `Approve`. Each modal covers the full viewport including the sidebar. Cancel / submit still work.
9. **Reduced motion:** DevTools → Rendering → "Emulate CSS prefers-reduced-motion: reduce". Toggle the sidebar — it still opens/closes but without transition. No other animations to check.
10. **Direct URL entry:** paste `http://localhost:3005/#/agents` (or `/live` / `/audit`) into a fresh tab, log in. After login, the correct tab should be active.
11. **Unauth login screen:** log out. Sidebar disappears. Login input + CTA render centered on black. No visual regressions from the first bite.
12. **Grep sweep:** no stale class names — `rg "nova-shell(?![\-])" packages/admin-api/public` should only match the `<main>` element and the new `.nova-shell--full` rule. Confirm no orphaned references to removed inline logout button or the old `.nova-row` at the top of the authenticated view.

## Files expected to change

- `packages/admin-api/public/index.html` — restructure authenticated `<section>` to add `.nova-app` / `.nova-sidebar` / `.nova-main`; remove the old inline brand + logout row; add toggle button; add placeholder templates for Agents / Live / Audit; add `:class="token && 'nova-shell--full'"` on the `<main>` element.
- `packages/admin-api/public/styles.css` — append the shell layout block (`.nova-app`, `.nova-sidebar*`, `.nova-nav*`, `.nova-main`, `.nova-placeholder`, `.nova-shell--full`). No existing rules removed.
- `packages/admin-api/public/js/app.js` — add `sidebarCollapsed`, `activeTab` getter, `toggleSidebar()`, extended `parseRoute()`, and the two `localStorage` helpers (inlined here or moved to `utils.js` — implementer picks, both are fine).

Approximate size: ~80 HTML lines restructured, ~120 CSS lines added, ~25 JS lines added.

## Risks and decisions deferred

- **No topbar.** The main area starts directly with content, no frame around it. If it looks naked, add a topbar in a follow-up bite — don't pre-emptively add something empty.
- **Placeholder tabs are dead-ends for now.** Users who click Agents / Live / Audit see a "Coming soon" stub. That's honest but potentially disappointing. Mitigation: each placeholder copy names what the tab will do, so the promise is clear.
- **Galaxy detail staying hash-routed rather than becoming a drawer.** Drawers over the galaxies list would feel more "modern dashboard" but lose deep-linkability. Hash routes preserve sharable URLs (useful for support: "check galaxy X"). We keep it.
- **Sidebar collapse state global, not per-tab.** A user who collapses while in Galaxies gets a collapsed sidebar in every other tab too. That's the expected behavior from every dashboard we've used, and simpler than per-tab state.
- **No keyboard shortcut for toggle.** Could add `[` / `]` or Cmd+\. Defer until someone misses it.
