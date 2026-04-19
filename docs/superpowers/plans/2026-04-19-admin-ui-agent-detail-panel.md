# Admin UI Agent Detail Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared non-modal inline detail panel that opens when an Agents tab card or Live tab planet is clicked. Replace the current click→galaxy-detail navigation with RUBRIC-flow-style contextual detail.

**Architecture:** Pure frontend. New Alpine state `selectedAgent` plus `openAgentDetail` / `closeAgentDetail` methods. New `<aside class="nova-agent-detail">` fixed-position 380px right-side panel, non-modal, with close-X. Agents card becomes a `<div @click>`; Live planet loses its `<a>` wrapper in `renderLiveSvg` and gains a click listener. Tab navigation closes the panel automatically via `Alpine.effect`. The galaxy pill inside the card stays clickable as an explicit opt-in to galaxy detail.

**Tech Stack:** Alpine.js 3 (reactive state, `x-show`, `Alpine.effect`), vanilla CSS, `createElementNS` for SVG manipulation, Playwright for e2e. No new dependencies, no backend changes.

**Spec:** `docs/superpowers/specs/2026-04-19-admin-ui-agent-detail-panel-design.md`

---

## Dev loop

```bash
cd packages/admin-api && npx tsc --noEmit   # after any JS/TS work
cd packages/admin-api && npm test           # 11/11 expected
cd packages/admin-api && npm run test:e2e   # 13 existing + 2 new = 15 expected
cd /Users/tyewolfe/Projects/Nova && docker-compose up -d --build admin-api  # end of plan
```

Admin token: `my-secure-admin-token-12345`. UI at `http://localhost:3005`.

---

## Task 1: Append detail-panel CSS

**Why:** Additive. The new classes have no HTML consumers until Task 3 — UI unchanged.

**Files:**
- Modify: `packages/admin-api/public/styles.css` (append)

- [ ] **Step 1: Append the panel block**

Open `packages/admin-api/public/styles.css`. The last block is the Audit tab (`.nova-audit-metadata`). Append:

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

- [ ] **Step 2: Verify UI unchanged**

Refresh the browser. Walk every tab — nothing should look different. The new classes have no consumers yet.

- [ ] **Step 3: Commit**

```bash
git add packages/admin-api/public/styles.css
git commit -m "feat(admin-ui): add CSS for agent detail panel

Additive block only — no HTML consumes it yet. Fixed-position
380px right-side panel, below ticker (top:28), above tab content
(z:60 < modal z:100 < toast z:200). Circular close button in the
top-right corner with amber-on-hover border."
```

---

## Task 2: Add Alpine state + methods + tab-change watcher

**Why:** Data layer for the panel. After this task the state exists and methods work, but no HTML consumes them.

**Files:**
- Modify: `packages/admin-api/public/js/app.js` (state, methods, init extension)

- [ ] **Step 1: Add `selectedAgent` state**

Open `packages/admin-api/public/js/app.js`. Find the existing tab-level state block near the top:

```js
    auditFilters: { event: '', taskId: '', tenantId: '' },
    auditExpanded: null,
    sidebarCollapsed: readSidebarState(),
```

Add `selectedAgent: null` between `auditExpanded` and `sidebarCollapsed`:

```js
    auditFilters: { event: '', taskId: '', tenantId: '' },
    auditExpanded: null,
    selectedAgent: null,
    sidebarCollapsed: readSidebarState(),
```

- [ ] **Step 2: Add `openAgentDetail` + `closeAgentDetail` methods**

Find the existing `toggleAuditRow` method (added in the Audit-tab bite):

```js
    toggleAuditRow(eventId) {
      this.auditExpanded = this.auditExpanded === eventId ? null : eventId;
    },
```

Add two methods immediately after:

```js
    toggleAuditRow(eventId) {
      this.auditExpanded = this.auditExpanded === eventId ? null : eventId;
    },

    openAgentDetail(agentId) {
      const match = this.allAgents.find(a => a.agentId === agentId);
      if (!match) return;
      this.selectedAgent = match;
    },

    closeAgentDetail() {
      this.selectedAgent = null;
    },
```

- [ ] **Step 3: Add the tab-change watcher to `init`**

Find the existing `init()` function:

```js
    init() {
      onUnauthorized(() => {
        this.token = '';
        location.hash = '';
        this.route = parseRoute();
        this.pushToast('Session ended', 'err');
      });
      window.addEventListener('hashchange', () => {
        this.route = parseRoute();
        this.routeLoad();
        if (this.route.name === 'live') this.startLiveTicker();
        else this.stopLiveTicker();
      });
      if (this.token) {
        this.routeLoad();
        this.connectSse();
        if (this.route.name === 'live') this.startLiveTicker();
      }
    },
```

Extend it with a watcher that closes the panel on tab transitions. Replace with:

```js
    init() {
      onUnauthorized(() => {
        this.token = '';
        location.hash = '';
        this.route = parseRoute();
        this.pushToast('Session ended', 'err');
      });
      window.addEventListener('hashchange', () => {
        this.route = parseRoute();
        this.routeLoad();
        if (this.route.name === 'live') this.startLiveTicker();
        else this.stopLiveTicker();
      });
      if (this.token) {
        this.routeLoad();
        this.connectSse();
        if (this.route.name === 'live') this.startLiveTicker();
      }

      // Close the detail panel on tab navigation
      let _lastTab = this.activeTab;
      Alpine.effect(() => {
        const current = this.activeTab;
        if (current !== _lastTab) {
          _lastTab = current;
          if (this.selectedAgent) this.closeAgentDetail();
        }
      });
    },
```

`Alpine.effect` is a global provided by Alpine 3 (confirmed by the existing `Alpine.$data(...)` usage in Playwright tests).

- [ ] **Step 4: Verify data layer works**

Refresh, log in, open Console:

```js
Alpine.$data(document.querySelector('[x-data]')).openAgentDetail('claude-code')
Alpine.$data(document.querySelector('[x-data]')).selectedAgent
```

Expected: the second line returns the Claude Code agent object (or the real agentId present on the instance).

```js
Alpine.$data(document.querySelector('[x-data]')).closeAgentDetail()
Alpine.$data(document.querySelector('[x-data]')).selectedAgent
```

Expected: `null`.

Navigate between tabs with the panel open. Because no HTML renders the panel yet, there's no visible effect — but the Alpine.effect is firing.

- [ ] **Step 5: Run tests**

```bash
cd packages/admin-api && npm test
```

Expected: 11/11 passing.

- [ ] **Step 6: Commit**

```bash
git add packages/admin-api/public/js/app.js
git commit -m "feat(admin-ui): add agent detail panel state and tab watcher

New state: selectedAgent. New methods openAgentDetail (looks up
agentId in allAgents, fails silently on miss) and closeAgentDetail
(clears selection). init registers an Alpine.effect that tracks
activeTab transitions and auto-closes the panel on navigation. No
template consumes this state yet — HTML wiring lands in later tasks."
```

---

## Task 3: Insert the detail-panel HTML (hidden until selectedAgent set)

**Why:** Adds the panel markup inside the authenticated section. `x-show="selectedAgent"` keeps it invisible until a card/planet is clicked (that wiring comes in Task 4).

**Files:**
- Modify: `packages/admin-api/public/index.html` (insert before authenticated `</section>`)

- [ ] **Step 1: Insert the panel just before the authenticated section closer**

Open `packages/admin-api/public/index.html`. Find the closing line of the authenticated section at line ~521 — the `</section>` that precedes the `<!-- Toasts -->` comment:

```html
        </div>
      </template>

    </section>

    <!-- Toasts -->
    <div class="nova-toast-stack">
```

Insert the panel block immediately before `</section>`:

```html
        </div>
      </template>

      <!-- AGENT DETAIL PANEL -->
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

    </section>

    <!-- Toasts -->
```

- [ ] **Step 2: Verify the panel appears on demand**

Refresh, log in. Open Console and call `openAgentDetail` with a valid agentId:

```js
Alpine.$data(document.querySelector('[x-data]')).openAgentDetail('claude-code')
```

Expected: the panel slides in on the right (or just appears — no animation). Shows name, agentId, galaxy pill, DID, description, skill cards, and three capability indicators.

Click the close-X. Panel disappears.

Navigate to another tab via the sidebar — if the panel was open, it auto-closes via the Alpine.effect watcher.

- [ ] **Step 3: Run tests**

```bash
cd packages/admin-api && npm test
```

Expected: 11/11 passing.

- [ ] **Step 4: Commit**

```bash
git add packages/admin-api/public/index.html
git commit -m "feat(admin-ui): insert detail panel markup inside authenticated section

Panel is x-show-gated on selectedAgent so it stays hidden until a
trigger in the next task fires openAgentDetail. Guarded reads
(selectedAgent?.field) tolerate the initial null state. Galaxy pill
inside the panel links to #/galaxy/<slug> — clicking it naturally
transitions the tab and the Alpine.effect watcher auto-closes the
panel."
```

---

## Task 4: Wire up Agents card + Live planet click triggers

**Why:** Switches the click behavior. Agents card becomes a `<div>` with click; its galaxy pill becomes a standalone link with `@click.stop`. Live planet loses the `<a>` wrapper and gains a click listener in `renderLiveSvg`.

**Files:**
- Modify: `packages/admin-api/public/index.html` (Agents card root + pill)
- Modify: `packages/admin-api/public/js/app.js` (renderLiveSvg planet wrapper)

- [ ] **Step 1: Swap Agents card root from `<a>` to `<div>` with click**

In `packages/admin-api/public/index.html`, find the current Agents card root (inside the Agents tab template):

```html
            <template x-for="a in allAgents" :key="a.agentId">
              <a class="nova-agent-card" :href="`#/galaxy/${encodeURIComponent(galaxySlug(a.tenantId))}`">
                <div class="nova-row" style="margin-bottom:12px;align-items:flex-start">
```

Replace the `<a>` with a `<div role="button">`:

```html
            <template x-for="a in allAgents" :key="a.agentId">
              <div class="nova-agent-card" role="button" tabindex="0"
                   @click="openAgentDetail(a.agentId)"
                   @keydown.enter="openAgentDetail(a.agentId)"
                   @keydown.space.prevent="openAgentDetail(a.agentId)">
                <div class="nova-row" style="margin-bottom:12px;align-items:flex-start">
```

- [ ] **Step 2: Find the closing `</a>` for that same card and change to `</div>`**

Still in `index.html`, scroll down within that agent card block — look for the closing `</a>` that matches the opening `<a class="nova-agent-card">` you just replaced. It sits just before the closing `</template>` of the `x-for`:

```html
                  <span class="nova-capability-indicator" :class="a.capabilities?.stateTransitionHistory && 'is-on'">history</span>
                </div>
              </a>
            </template>
```

Change the `</a>` to `</div>`:

```html
                  <span class="nova-capability-indicator" :class="a.capabilities?.stateTransitionHistory && 'is-on'">history</span>
                </div>
              </div>
            </template>
```

- [ ] **Step 3: Convert the in-card galaxy pill from `<span>` to `<a @click.stop>`**

Still in `index.html`, in the same Agents card block, find the galaxy pill:

```html
                  <span class="nova-pill" style="color:var(--text-secondary);border-color:var(--border)" x-text="galaxySlug(a.tenantId)"></span>
```

Replace with a clickable anchor that stops propagation so it doesn't also fire the card's click:

```html
                  <a class="nova-pill" :href="`#/galaxy/${encodeURIComponent(galaxySlug(a.tenantId))}`"
                     style="color:var(--text-secondary);border-color:var(--border);text-decoration:none"
                     @click.stop x-text="galaxySlug(a.tenantId)"></a>
```

- [ ] **Step 4: Remove the Live planet `<a>` wrapper and add click listener**

Open `packages/admin-api/public/js/app.js`. Find the planet-creation block inside `renderLiveSvg` (around line 387):

```js
        // Planet group
        let cached = svg._planetNodes.get(p.agentId);
        if (!cached) {
          const a = document.createElementNS(NS, 'a');
          a.setAttributeNS(XLINK, 'xlink:href', `#/galaxy/${encodeURIComponent(p.galaxySlug)}`);
          a.setAttribute('href', `#/galaxy/${encodeURIComponent(p.galaxySlug)}`);
          const g = document.createElementNS(NS, 'g');
          g.setAttribute('class', 'nova-live-planet-group');
          const circle = document.createElementNS(NS, 'circle');
          circle.setAttribute('class', 'nova-live-planet');
          circle.setAttribute('r', '10');
          circle.setAttribute('fill', `url(#planet-${p.agentId})`);
          const label = document.createElementNS(NS, 'text');
          label.setAttribute('class', 'nova-live-label');
          label.setAttribute('text-anchor', 'middle');
          label.textContent = p.name;
          const title = document.createElementNS(NS, 'title');
          title.textContent = `${p.agentId} — ${p.galaxySlug}`;
          g.appendChild(circle);
          g.appendChild(label);
          g.appendChild(title);
          a.appendChild(g);
          planetsGroup.appendChild(a);
          cached = { root: a, circle, label };
          svg._planetNodes.set(p.agentId, cached);
        }
```

Replace with a plain `<g>` that has a click listener and cursor pointer:

```js
        // Planet group
        let cached = svg._planetNodes.get(p.agentId);
        if (!cached) {
          const g = document.createElementNS(NS, 'g');
          g.setAttribute('class', 'nova-live-planet-group');
          g.style.cursor = 'pointer';
          const agentId = p.agentId;
          g.addEventListener('click', () => this.openAgentDetail(agentId));
          const circle = document.createElementNS(NS, 'circle');
          circle.setAttribute('class', 'nova-live-planet');
          circle.setAttribute('r', '10');
          circle.setAttribute('fill', `url(#planet-${p.agentId})`);
          const label = document.createElementNS(NS, 'text');
          label.setAttribute('class', 'nova-live-label');
          label.setAttribute('text-anchor', 'middle');
          label.textContent = p.name;
          const title = document.createElementNS(NS, 'title');
          title.textContent = `${p.agentId} — ${p.galaxySlug}`;
          g.appendChild(circle);
          g.appendChild(label);
          g.appendChild(title);
          planetsGroup.appendChild(g);
          cached = { root: g, circle, label };
          svg._planetNodes.set(p.agentId, cached);
        }
```

Changes from the original:
- `const a = document.createElementNS(NS, 'a');` — **deleted**
- `a.setAttributeNS(XLINK, ...)` and `a.setAttribute('href', ...)` — **deleted**
- `g.style.cursor = 'pointer';` — **added** (previously the `<a>` gave it cursor)
- `const agentId = p.agentId;` — **added** (captures for the closure; avoids referencing `p` which mutates)
- `g.addEventListener('click', () => this.openAgentDetail(agentId));` — **added**
- `a.appendChild(g); planetsGroup.appendChild(a);` → `planetsGroup.appendChild(g);` — **simplified**
- `cached = { root: a, circle, label };` → `cached = { root: g, circle, label };` — cached root is now the `<g>` itself (cache key name stays `root` for consistency with the removal path at line ~354, `cached.root.remove()`)

- [ ] **Step 5: Verify Agents card click opens the panel**

Refresh the browser. Navigate to Agents tab. Click an agent card — panel slides in with that agent's details. Click another card — content updates.

Click the galaxy pill inside a card (the small slug badge on the right of the card). URL should change to `#/galaxy/<slug>`, Galaxies tab activates, and the panel closes automatically.

- [ ] **Step 6: Verify Live planet click opens the panel**

Navigate to Live. Click a planet (the orbiting circle). Panel appears with the same details as on the Agents tab. Rotation continues underneath the panel.

Click the close-X. Panel dismisses. Rotation continues.

Navigate to any other tab — panel stays closed.

- [ ] **Step 7: Run tests**

```bash
cd packages/admin-api && npm test
```

Expected: 11/11 passing.

- [ ] **Step 8: Commit**

```bash
git add packages/admin-api/public/index.html packages/admin-api/public/js/app.js
git commit -m "feat(admin-ui): replace click-to-galaxy with click-to-detail

Agents card root becomes a <div role=button> calling openAgentDetail.
The in-card galaxy pill becomes a standalone <a> with @click.stop,
preserving the explicit galaxy-navigation affordance without double
-triggering the card. Live planet loses the <a xlink:href> wrapper;
the planet <g> gains cursor:pointer and a click listener that calls
openAgentDetail with the captured agentId. Both tabs now open the
non-modal detail panel without leaving the current view."
```

---

## Task 5: Playwright tests for panel behavior

**Why:** Locks the new behavior in so future edits don't regress it.

**Files:**
- Modify: `packages/admin-api/test/e2e/admin-ui-tabs.spec.ts`

- [ ] **Step 1: Update the existing Agents card test (the card is no longer an `<a>`)**

Open `packages/admin-api/test/e2e/admin-ui-tabs.spec.ts`. Find the existing test:

```ts
test('Agents tab renders cards with DID and skill chips', async ({ page }) => {
  await login(page);
  await page.click('.nova-nav-item:has-text("Agents")');

  await expect(page.locator('.nova-agent-card')).toHaveCount(2);
  await expect(page.locator('.nova-agent-card').first()).toContainText('Alpha');
  await expect(page.locator('.nova-agent-card').first()).toContainText('alpha');
  await expect(page.locator('.nova-agent-card').first()).toContainText('did:key:z6MkTestAlpha');
  await expect(page.locator('.nova-agent-card').first().locator('.nova-skill-chip')).toContainText('Search');
});
```

No code change needed — the selector `.nova-agent-card` still matches the new `<div>`. Leave it as-is.

- [ ] **Step 2: Add new `Agents card click opens detail panel` test**

After the existing `Agents tab renders cards with DID and skill chips` test, add:

```ts
test('Agents card click opens detail panel and X closes it', async ({ page }) => {
  await login(page);
  await page.click('.nova-nav-item:has-text("Agents")');
  await expect(page.locator('.nova-agent-card')).toHaveCount(2);

  // Panel hidden initially
  await expect(page.locator('.nova-agent-detail')).toBeHidden();

  // Click first card → panel shows Alpha
  await page.locator('.nova-agent-card').first().click();
  await expect(page.locator('.nova-agent-detail')).toBeVisible();
  await expect(page.locator('.nova-agent-detail')).toContainText('Alpha');
  await expect(page.locator('.nova-agent-detail')).toContainText('did:key:z6MkTestAlpha');

  // Click second card → panel content swaps to Beta
  await page.locator('.nova-agent-card').nth(1).click();
  await expect(page.locator('.nova-agent-detail')).toContainText('Beta');

  // URL should not have changed from the Agents tab
  await expect(page).toHaveURL(/#\/agents$/);

  // Close-X dismisses
  await page.locator('.nova-agent-detail-close').click();
  await expect(page.locator('.nova-agent-detail')).toBeHidden();
});
```

- [ ] **Step 3: Add `Tab navigation closes the detail panel` test**

Add immediately after the previous test:

```ts
test('Tab navigation closes the detail panel', async ({ page }) => {
  await login(page);
  await page.click('.nova-nav-item:has-text("Agents")');
  await page.locator('.nova-agent-card').first().click();
  await expect(page.locator('.nova-agent-detail')).toBeVisible();

  // Sidebar nav to Audit closes the panel via the Alpine.effect watcher
  await page.click('.nova-nav-item:has-text("Audit")');
  await expect(page.locator('.nova-agent-detail')).toBeHidden();
});
```

- [ ] **Step 4: Add `Agents card galaxy pill navigates without triggering panel` test**

Add immediately after:

```ts
test('Agents card galaxy pill navigates without triggering panel', async ({ page }) => {
  await login(page);
  await page.click('.nova-nav-item:has-text("Agents")');

  // Click the pill inside the first card
  await page.locator('.nova-agent-card').first().locator('.nova-pill').click();

  // URL should be the galaxy route, NOT the agents route
  await expect(page).toHaveURL(/#\/galaxy\//);

  // Panel never opened
  await expect(page.locator('.nova-agent-detail')).toBeHidden();
});
```

- [ ] **Step 5: Run the e2e suite**

```bash
cd packages/admin-api && npm run test:e2e
```

Expected: **16 passed** — 4 onboarding + 9 original admin-UI tests + 3 new panel tests.

If a test fails, the likely cause is either:
- Agents card `<a>` → `<div>` swap not picked up (selectors should still match).
- Galaxy pill `.nova-pill` selector now ambiguous (the panel also has a `.nova-pill` for the galaxy link). Fix by scoping: `.nova-agent-card .nova-pill` (already scoped in the test above — good).

- [ ] **Step 6: Commit**

```bash
git add packages/admin-api/test/e2e/admin-ui-tabs.spec.ts
git commit -m "test(admin-ui): cover detail panel open/close/swap behavior

Three new Playwright tests:
  - card click opens the panel, click second card swaps content, URL
    stays on #/agents, close-X dismisses
  - tab navigation auto-closes the panel via the Alpine.effect watcher
  - galaxy pill click navigates to #/galaxy and does NOT open the
    panel (verifies the @click.stop on the pill)"
```

---

## Task 6: Sweep + container rebuild

**Why:** Confirm nothing stale and ship into the running container.

**Files:** No code changes expected unless Step 1 surfaces an issue.

- [ ] **Step 1: Grep for the new class names + symbols**

```bash
rg "nova-agent-detail|selectedAgent|openAgentDetail|closeAgentDetail" packages/admin-api
```

Expected: matches in `styles.css` (class), `index.html` (panel + card click), `js/app.js` (state + methods + renderLiveSvg click), and `test/e2e/admin-ui-tabs.spec.ts` (the three new tests).

- [ ] **Step 2: Grep for leftover `<a class="nova-agent-card"`**

```bash
rg 'nova-agent-card' packages/admin-api/public
```

Expected: the remaining matches are the `<div class="nova-agent-card">` in index.html plus the CSS rule in styles.css. No `<a class="nova-agent-card"` should remain.

- [ ] **Step 3: Grep in renderLiveSvg for the deleted `<a>` wrapper**

```bash
rg "createElementNS.*'a'" packages/admin-api/public/js/app.js
```

Expected: **zero matches**. The only `createElementNS(NS, 'a')` was the planet wrapper, now removed.

- [ ] **Step 4: Run the full test suite**

```bash
cd packages/admin-api && npm test
cd packages/admin-api && npm run test:e2e
```

Expected: 11/11 unit + 16/16 e2e.

- [ ] **Step 5: Rebuild the container**

```bash
cd /Users/tyewolfe/Projects/Nova
docker-compose up -d --build admin-api
```

Wait for `Container nova-admin-api-1 Started`. Give ~5 seconds to boot.

- [ ] **Step 6: Verify the new UI is deployed**

```bash
# CSS has the new classes
curl -s http://localhost:3005/styles.css | grep -c 'nova-agent-detail'
# Expected: 2 or more

# HTML has the panel + click handlers
curl -s http://localhost:3005/ | grep -c '@click="openAgentDetail\|nova-agent-detail'
# Expected: 3 or more (Agents card, Live via JS does not show in HTML grep, panel aside)
```

- [ ] **Step 7: Final browser smoke**

Visit `http://localhost:3005`, log in, walk:
- Agents tab: click a card → panel on the right. Click close-X → closes.
- Live tab: click a planet → panel. Rotation continues underneath.
- Click galaxy pill in a card: navigates to `#/galaxy/<slug>`, panel auto-closes.
- Click sidebar Audit while panel open: panel closes.
- Reduced-motion still works on Live ticker.

- [ ] **Step 8: If Steps 1–7 surfaced any fixes, commit them**

```bash
git add packages/admin-api/
git commit -m "fix(admin-ui): cleanup after detail panel sweep"
```

If no fixes, skip.

---

## Self-review

**Spec coverage** — every spec requirement traces to a task:

- `.nova-agent-detail` panel + close-X CSS → Task 1
- `selectedAgent` state → Task 2 Step 1
- `openAgentDetail` / `closeAgentDetail` methods → Task 2 Step 2
- Tab-change watcher via `Alpine.effect` → Task 2 Step 3
- Panel HTML (all content sections: name, DID, galaxy, description, skills, capabilities) → Task 3
- Agents card click swap → Task 4 Steps 1–2
- Galaxy pill `@click.stop` link → Task 4 Step 3
- Live planet click swap in `renderLiveSvg` → Task 4 Step 4
- Playwright coverage (open/swap/close, tab-nav close, pill navigates without panel) → Task 5
- Container rebuild → Task 6 Step 5

**Placeholder scan** — no TBD/TODO. Every code block has concrete code.

**Type consistency** — `selectedAgent`, `openAgentDetail`, `closeAgentDetail`, `.nova-agent-detail`, `.nova-agent-detail-close` — spelled identically across tasks. The `cached.root` field keeps its name (consistent with the existing removal path at `cached.root.remove()`), but now points at the `<g>` instead of the `<a>`.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-19-admin-ui-agent-detail-panel.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
