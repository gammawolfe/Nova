# Admin UI Live Tab (Live-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Live placeholder with a rotating SVG solar-system visualization of active agents — Nova sun at center, planets grouped in galaxy arcs on a single dashed orbital ring, with a "Demo conversation" button that draws a stubbed dotted line.

**Architecture:** Pure frontend, additive across three existing files. Reuses `allAgents` state and `loadAllAgents()` method from the Agents tab. rAF loop updates a reactive `rotationDeg`; Alpine recomputes planet positions every frame, keeping labels upright. No backend changes — `TASK_LIFECYCLE_CHANNEL` publishers and real conversation lines are the next bite (Live-2).

**Tech Stack:** Inline SVG, Alpine.js computed getters, CSS. `requestAnimationFrame` for orbital motion. `matchMedia('(prefers-reduced-motion: reduce)')` for accessibility opt-out.

**Spec:** `docs/superpowers/specs/2026-04-18-admin-ui-live-tab-design.md`

---

## Dev loop — running the admin UI locally

Pure frontend bite, so:

```bash
# Option A: hot reload (faster iteration; npm run dev outside docker)
cd packages/admin-api && npm run dev

# Option B: rebuild container (end-of-plan step; mirrors production)
docker-compose up -d --build admin-api
```

UI at `http://localhost:3005`. Admin token is in repo `.env` (`my-secure-admin-token-12345` at time of writing).

Run `cd packages/admin-api && npm test` after every task. Expected: `Tests  11 passed (11)`.

---

## Task 1: Append Live tab CSS

**Why:** Additive only. After this task the new classes exist but no HTML consumes them; UI is unchanged.

**Files:**
- Modify: `packages/admin-api/public/styles.css` (append)

- [ ] **Step 1: Append the Live tab CSS block**

Open `packages/admin-api/public/styles.css`. Scroll to the end — the last block is `.nova-capability-indicator.is-on` from the Agents tab bite. Append:

```css

/* ── Live tab ──────────────────────────────────────────────────────────── */
.nova-live-wrap { min-height: 400px; }
.nova-live-svg {
  width: 100%;
  height: min(calc(100vh - 240px), 640px);
  display: block;
  user-select: none;
}

.nova-live-ring {
  fill: none;
  stroke: rgba(255, 255, 255, 0.08);
  stroke-width: 1;
  stroke-dasharray: 4 6;
}

.nova-live-sun { filter: drop-shadow(0 0 18px rgba(245, 166, 35, 0.55)); }
.nova-live-sun-label {
  fill: #000;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 1.5px;
  pointer-events: none;
  text-transform: uppercase;
}

.nova-live-planet-group { cursor: pointer; }
.nova-live-planet-group a { text-decoration: none; }
.nova-live-planet {
  transition: filter 0.15s ease;
}
.nova-live-planet-group:hover .nova-live-planet {
  filter: brightness(1.25);
}

.nova-live-label {
  fill: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11px;
  pointer-events: none;
  transition: fill 0.15s ease;
}
.nova-live-planet-group:hover .nova-live-label {
  fill: var(--text);
}

@media (max-width: 640px) {
  .nova-live-label { display: none; }
}

.nova-live-demo-line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5;
  stroke-dasharray: 5 5;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.3s ease;
}
.nova-live-demo-line.is-active {
  opacity: 1;
  animation: nova-live-demo-fade 1.5s ease-out forwards;
}
@keyframes nova-live-demo-fade {
  0%   { opacity: 1; stroke-dashoffset: 0; }
  100% { opacity: 0; stroke-dashoffset: -40; }
}
@media (prefers-reduced-motion: reduce) {
  .nova-live-demo-line.is-active {
    animation: none;
    opacity: 1;
  }
}

.nova-live-empty-sun {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: radial-gradient(circle at 30% 30%, #ffe08a, #f5a623);
  box-shadow: 0 0 24px rgba(245, 166, 35, 0.4);
  margin: 24px auto 0;
}
```

- [ ] **Step 2: Verify UI is unchanged**

Refresh `http://localhost:3005`. Walk Galaxies, Agents, Live placeholder, Audit placeholder, galaxy detail, modals. Everything identical to post-Agents-bite state. Live tab still shows the "Coming soon" placeholder.

- [ ] **Step 3: Commit**

```bash
git add packages/admin-api/public/styles.css
git commit -m "feat(admin-ui): add CSS for Live tab solar system

Additive block only — no HTML consumes these classes yet.
.nova-live-svg scales to viewport. .nova-live-ring is a dashed
orbital path. .nova-live-planet-group hosts each agent with a hover
brighten. .nova-live-demo-line uses a keyframe fade that respects
prefers-reduced-motion. .nova-live-empty-sun is the no-agents state."
```

---

## Task 2: Add Live tab data layer and animation ticker

**Why:** Adds the Alpine state, the `livePlanets` reactive getter, `triggerDemoLine`, the rAF ticker, and the three `routeLoad` / `handleSseAgent` / `init` extensions. After this task, visiting `#/live` triggers `loadAllAgents()` and starts the rAF loop, but the Live template still renders the placeholder so there's no visible change.

**Files:**
- Modify: `packages/admin-api/public/js/app.js` (six edits in sequence)

- [ ] **Step 1: Add four new state properties**

Find the block of state inserted in the Agents-tab bite (after `sse: null,`):

```js
    toasts: [],
    sse: null,
    allAgents: [],
    allAgentsLoading: false,
    allAgentsError: null,
    sidebarCollapsed: readSidebarState(),
```

Add four new properties between `allAgentsError: null,` and `sidebarCollapsed`:

```js
    toasts: [],
    sse: null,
    allAgents: [],
    allAgentsLoading: false,
    allAgentsError: null,
    rotationDeg: 0,
    demoLineActive: false,
    demoLinePath: '',
    hoverGalaxy: null,
    sidebarCollapsed: readSidebarState(),
```

- [ ] **Step 2: Add the `livePlanets` computed getter**

Scroll to the `galaxySlug(tenantId)` method (added in the Agents-tab bite). Its closing brace is just before `async createGalaxy(form)`. Add the getter immediately after `galaxySlug`:

```js
    galaxySlug(tenantId) {
      const match = this.galaxies.find(g => g.id === tenantId || g.slug === tenantId);
      return match?.slug || tenantId;
    },

    get livePlanets() {
      const agents = this.allAgents;
      if (!agents || agents.length === 0) return [];
      const cx = 400, cy = 300, ringR = 220, labelOffset = 10 + 14;
      const byGalaxy = new Map();
      for (const a of agents) {
        const slug = this.galaxySlug(a.tenantId);
        if (!byGalaxy.has(slug)) byGalaxy.set(slug, []);
        byGalaxy.get(slug).push(a);
      }
      const galaxyKeys = [...byGalaxy.keys()].sort();
      const G = galaxyKeys.length;
      const gap = 10;
      const usable = 360 - G * gap;
      const arcWidth = usable / G;
      const result = [];
      for (let i = 0; i < G; i++) {
        const slug = galaxyKeys[i];
        const arr = byGalaxy.get(slug);
        const startAngle = i * (arcWidth + gap);
        for (let j = 0; j < arr.length; j++) {
          const a = arr[j];
          const baseAngle = startAngle + arcWidth * (j + 0.5) / arr.length;
          const theta = (baseAngle + this.rotationDeg) * Math.PI / 180;
          const colors = slugColor(slug);
          result.push({
            agentId: a.agentId,
            name: a.name,
            galaxySlug: slug,
            x: cx + ringR * Math.cos(theta),
            y: cy + ringR * Math.sin(theta),
            labelX: cx + (ringR + labelOffset) * Math.cos(theta),
            labelY: cy + (ringR + labelOffset) * Math.sin(theta) + 4,
            colorLight: colors.light,
            colorDark: colors.dark,
          });
        }
      }
      return result;
    },

    async createGalaxy(form) {
```

The `slugColor` function is already imported from `./utils.js` at the top of the file — no new import needed.

- [ ] **Step 3: Add `startLiveTicker`, `stopLiveTicker`, and `triggerDemoLine` methods**

Scroll to `humanizeTtl,` at the end of the returned object (around line 170). Add three methods just before it, and also keep `planetStyle` untouched:

Current ending of the object:

```js
    planetStyle(slug) {
      const c = slugColor(slug || 'x');
      return `--planet-light:${c.light};--planet-dark:${c.dark};--planet-glow:${c.glow}`;
    },
    humanizeTtl,
  };
};
```

Add three methods between `planetStyle` and `humanizeTtl`:

```js
    planetStyle(slug) {
      const c = slugColor(slug || 'x');
      return `--planet-light:${c.light};--planet-dark:${c.dark};--planet-glow:${c.glow}`;
    },

    startLiveTicker() {
      if (this._liveRaf) return;
      const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (prefersReduced) return;
      let lastTime = performance.now();
      const degPerSec = 360 / 90;
      const tick = (now) => {
        if (this.activeTab !== 'live') {
          this._liveRaf = null;
          return;
        }
        const dt = (now - lastTime) / 1000;
        lastTime = now;
        this.rotationDeg = (this.rotationDeg + degPerSec * dt) % 360;
        this._liveRaf = requestAnimationFrame(tick);
      };
      this._liveRaf = requestAnimationFrame(tick);
    },

    stopLiveTicker() {
      if (this._liveRaf) {
        cancelAnimationFrame(this._liveRaf);
        this._liveRaf = null;
      }
    },

    triggerDemoLine() {
      const planets = this.livePlanets;
      if (planets.length < 2) return;
      if (this._demoTimeout) clearTimeout(this._demoTimeout);
      const a = planets[Math.floor(Math.random() * planets.length)];
      let b;
      do { b = planets[Math.floor(Math.random() * planets.length)]; } while (b.agentId === a.agentId);
      this.demoLinePath = `M ${a.x} ${a.y} Q 400 300 ${b.x} ${b.y}`;
      this.demoLineActive = false;
      requestAnimationFrame(() => { this.demoLineActive = true; });
      this._demoTimeout = setTimeout(() => {
        this.demoLineActive = false;
        this.demoLinePath = '';
        this._demoTimeout = null;
      }, 1600);
    },

    humanizeTtl,
  };
};
```

- [ ] **Step 4: Extend `routeLoad` to handle `#/live`**

Find the current `routeLoad()` (with the agents case added last bite):

```js
    async routeLoad() {
      if (!this.token) return;
      if (this.route.name === 'home')   await this.loadGalaxies();
      if (this.route.name === 'galaxy') await this.loadGalaxy(this.route.slug);
      if (this.route.name === 'agents') await this.loadAllAgents();
    },
```

Add the `live` branch (reuses `loadAllAgents`):

```js
    async routeLoad() {
      if (!this.token) return;
      if (this.route.name === 'home')   await this.loadGalaxies();
      if (this.route.name === 'galaxy') await this.loadGalaxy(this.route.slug);
      if (this.route.name === 'agents') await this.loadAllAgents();
      if (this.route.name === 'live')   await this.loadAllAgents();
    },
```

- [ ] **Step 5: Extend `handleSseAgent` to refresh on Live tab**

Find the current `handleSseAgent`:

```js
    handleSseAgent(ev) {
      try {
        const msg = JSON.parse(ev.data);
        if (this.activeTab === 'agents') {
          this.loadAllAgents();
          return;
        }
        if (!this.currentGalaxy) return;
        const galaxyId = this.currentGalaxy.id;
        if (msg.tenantId && (msg.tenantId === galaxyId || msg.tenantId === this.currentGalaxy.slug)) {
          this.loadGalaxy(this.route.slug);
        }
      } catch {}
    },
```

Change the `activeTab === 'agents'` check to include `'live'`:

```js
    handleSseAgent(ev) {
      try {
        const msg = JSON.parse(ev.data);
        if (this.activeTab === 'agents' || this.activeTab === 'live') {
          this.loadAllAgents();
          return;
        }
        if (!this.currentGalaxy) return;
        const galaxyId = this.currentGalaxy.id;
        if (msg.tenantId && (msg.tenantId === galaxyId || msg.tenantId === this.currentGalaxy.slug)) {
          this.loadGalaxy(this.route.slug);
        }
      } catch {}
    },
```

- [ ] **Step 6: Extend `init` to start/stop the ticker**

Find the current `init()`:

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
      });
      if (this.token) { this.routeLoad(); this.connectSse(); }
    },
```

Replace with this version that manages the ticker lifecycle:

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

- [ ] **Step 7: Verify the data layer works**

Refresh `http://localhost:3005`, log in, click the Live tab in the sidebar.

Open DevTools → Console:

```js
Alpine.$data(document.querySelector('[x-data]')).livePlanets.length
```

Expected: matches the number of active agents (2 on the current dev instance).

```js
Alpine.$data(document.querySelector('[x-data]')).livePlanets[0]
```

Expected: object with `agentId`, `name`, `galaxySlug`, `x`, `y`, `labelX`, `labelY`, `colorLight`, `colorDark`.

```js
Alpine.$data(document.querySelector('[x-data]')).rotationDeg
```

Run it twice with a 1-second gap. Expected: the number should have advanced by ~4° (one revolution per 90s). If the number isn't changing, the rAF loop didn't start — check `init` was extended correctly, or that `prefers-reduced-motion` isn't emulated.

The tab itself still shows the "Coming soon." placeholder — that's expected until Task 3.

- [ ] **Step 8: Run tests**

```bash
cd packages/admin-api && npm test
```

Expected: `Tests  11 passed (11)`.

- [ ] **Step 9: Commit**

```bash
git add packages/admin-api/public/js/app.js
git commit -m "feat(admin-ui): add Live tab data layer and animation ticker

New state: rotationDeg, demoLineActive, demoLinePath, hoverGalaxy.
New getter livePlanets groups agents by galaxy into arcs on a single
orbital ring, computing per-planet (x, y, labelX, labelY) positions
each frame from rotationDeg. New methods: startLiveTicker (rAF loop
at 360deg per 90s, respects prefers-reduced-motion and self-cancels
when the Live tab is no longer active), stopLiveTicker,
triggerDemoLine (picks two random planets and arms a quadratic
Bezier path + fade animation with a 1.6s cleanup timer).
routeLoad and handleSseAgent extended for #/live. init now starts
the ticker on entry and hashchange when route.name === 'live',
stops it otherwise. No template consumes this state yet — the HTML
wiring lands in the next task."
```

---

## Task 3: Replace the Live placeholder with the SVG solar system

**Why:** The visible change. Swaps the placeholder template for the SVG structure that consumes the state added in Task 2.

**Files:**
- Modify: `packages/admin-api/public/index.html` (replace one block)

- [ ] **Step 1: Replace the Live placeholder template**

Find the current Live placeholder block in `index.html` (added in the shell layout bite):

```html
      <!-- PLACEHOLDER: Live -->
      <template x-if="route.name === 'live'">
        <div class="nova-placeholder">
          <div class="nova-eyebrow">◉ LIVE</div>
          <h1 class="nova-display" style="font-size:32px;margin:8px 0 6px">Coming soon.</h1>
          <p class="nova-subtitle">Solar-system visualization. Planets orbit a star; dotted lines light up as A2A conversations flow, streamed from <code>/admin/events</code>.</p>
        </div>
      </template>
```

Replace with the real view:

```html
      <!-- LIVE -->
      <template x-if="route.name === 'live'">
        <div class="nova-live-wrap">
          <div class="nova-row" style="justify-content:space-between;margin-bottom:24px;align-items:flex-start">
            <div>
              <div class="nova-eyebrow">◉ LIVE</div>
              <h1 class="nova-display" style="font-size:40px;margin:6px 0">Live</h1>
              <p class="nova-subtitle" x-text="`${allAgents.length} ${allAgents.length === 1 ? 'planet' : 'planets'} orbiting Nova`"></p>
            </div>
            <button class="nova-input" style="width:auto;padding:8px 14px;font-size:12px"
                    @click="triggerDemoLine()" :disabled="allAgents.length < 2">
              Demo conversation
            </button>
          </div>

          <div x-show="allAgentsLoading" class="nova-glass" style="text-align:center;color:var(--text-secondary)">
            Loading agents…
          </div>

          <div x-show="!allAgentsLoading && allAgents.length === 0" class="nova-glass" style="text-align:center;color:var(--text-secondary)">
            <div class="nova-live-empty-sun"></div>
            <p style="margin-top:16px">No planets orbiting yet. Approve a pending planet in a galaxy to see it here.</p>
          </div>

          <svg x-show="!allAgentsLoading && allAgents.length > 0"
               class="nova-live-svg"
               viewBox="0 0 800 600"
               preserveAspectRatio="xMidYMid meet"
               role="img"
               aria-label="Solar-system visualization of active agents">
            <defs>
              <radialGradient id="nova-sun-gradient" cx="30%" cy="30%">
                <stop offset="0%" stop-color="#ffe08a" />
                <stop offset="100%" stop-color="#f5a623" />
              </radialGradient>
              <template x-for="p in livePlanets" :key="p.agentId">
                <radialGradient :id="`planet-${p.agentId}`" cx="30%" cy="30%">
                  <stop offset="0%" :stop-color="p.colorLight" />
                  <stop offset="100%" :stop-color="p.colorDark" />
                </radialGradient>
              </template>
            </defs>

            <circle class="nova-live-ring" cx="400" cy="300" r="220" />

            <path class="nova-live-demo-line" :class="demoLineActive && 'is-active'" :d="demoLinePath" />

            <g class="nova-live-sun">
              <circle cx="400" cy="300" r="24" fill="url(#nova-sun-gradient)" />
              <text x="400" y="303" class="nova-live-sun-label" text-anchor="middle">NOVA</text>
            </g>

            <template x-for="p in livePlanets" :key="p.agentId">
              <a :href="`#/galaxy/${encodeURIComponent(p.galaxySlug)}`">
                <g class="nova-live-planet-group">
                  <circle class="nova-live-planet"
                          :cx="p.x" :cy="p.y" r="10"
                          :fill="`url(#planet-${p.agentId})`" />
                  <text class="nova-live-label" :x="p.labelX" :y="p.labelY" text-anchor="middle"
                        x-text="p.name"></text>
                  <title x-text="`${p.agentId} — ${p.galaxySlug}`"></title>
                </g>
              </a>
            </template>
          </svg>
        </div>
      </template>
```

Notes on what changed:
- Comment label `PLACEHOLDER: Live` → `LIVE`
- Header: eyebrow, bigger display title, subtitle with live planet count, Demo button inline on the right
- Empty state with the static amber "empty sun" disc + explanation
- `<svg>` element with viewBox 800×600 for orbital scene
- `<defs>` holds the sun gradient + one `radialGradient` per planet, keyed by agentId
- Ring, demo line, sun, then the planet group (each is a clickable `<a>` wrapping `<g>` that holds the circle, label, and hover tooltip)

- [ ] **Step 2: Visually verify in the browser**

Refresh and click Live in the sidebar. Expect:

- Header row: amber `◉ LIVE` eyebrow, gradient "Live" display title, subtitle showing "N planets orbiting Nova". Demo button on the top-right.
- SVG below: amber sun with "NOVA" text at center, dashed orbital ring, planets at their computed arc positions, labels outside the ring.
- Over the next ~30 seconds: the whole arrangement rotates slowly (4°/sec). Labels stay upright. Each agent card's hover brightens its planet + label, and the tooltip (native SVG `<title>`) shows `agentId — galaxySlug`.
- Click a planet: the URL becomes `#/galaxy/<that agent's galaxy slug>` and galaxy detail renders. Back-link or Galaxies sidebar item returns.

- [ ] **Step 3: Verify the Demo button**

Return to `#/live`. Click `Demo conversation`. A dashed amber arc draws between two random planets, curving through the sun, fading out over ~1.5s. Click again — new endpoints. With fewer than 2 active agents, the button is disabled.

- [ ] **Step 4: Verify planet color consistency**

Open Galaxies tab, note the planet orb color for a galaxy. Open Live tab. Every planet belonging to that galaxy should be the same color as the Galaxies-tab orb. Same consistency check used on the Agents tab.

- [ ] **Step 5: Verify reduced motion**

DevTools → Rendering → emulate `prefers-reduced-motion: reduce`. Refresh the Live tab. Orbit rotation should stop (planets render at their initial arc positions). Click Demo — the line appears at full opacity and disappears after 1.6s without the fade keyframe. Disable the emulation.

- [ ] **Step 6: Verify narrow-width responsiveness**

Shrink the browser window below ~640px width. Labels should disappear; planets-only view remains. Ring shrinks via the SVG viewBox. Restore the window.

- [ ] **Step 7: Verify tab-leave stops the ticker**

On `#/live`, open DevTools → Performance → start a recording, wait 2 seconds, stop. You should see the JS "Animation Frame Fired" calls at ~60 Hz. Now navigate to `#/agents`, start a new recording, wait 2 seconds, stop. The `Animation Frame Fired` line should be absent (the rAF loop self-cancelled). This confirms CPU stays at zero when the user is elsewhere.

(If you don't want to Performance-trace, a simpler check: `Alpine.$data(document.querySelector('[x-data]'))._liveRaf` should be `null` when on any tab other than Live.)

- [ ] **Step 8: Run tests**

```bash
cd packages/admin-api && npm test
```

Expected: 11/11 passing.

- [ ] **Step 9: Commit**

```bash
git add packages/admin-api/public/index.html
git commit -m "feat(admin-ui): replace Live placeholder with real solar system

Nova sun at center, dashed orbital ring, planets rendered as SVG
circles with per-planet radial gradients keyed by galaxy color.
Planets click-through to their galaxy detail. Native SVG <title>
provides hover tooltip (agentId + galaxy slug). Demo button draws a
stubbed dashed amber arc between two random planets through the sun
— sets up the visual language the Live-2 real conversation lines
will reuse. Empty state shows a quiet sun with no-planets copy."
```

---

## Task 4: Final sweep + container rebuild

**Why:** Confirm nothing stale was left. Since this bite has no backend change, a container rebuild isn't strictly required — but the static file bundle in the running container will be stale. A rebuild keeps the container in sync with `main`.

**Files:** No code changes expected unless Step 1 surfaces an issue.

- [ ] **Step 1: Grep sweep**

From the repo root:

```bash
rg "nova-live-" packages/admin-api/public
```

Expected: every `nova-live-*` class appears in both `styles.css` (definition) and `index.html` (usage). Class list: `nova-live-wrap`, `nova-live-svg`, `nova-live-ring`, `nova-live-sun`, `nova-live-sun-label`, `nova-live-planet-group`, `nova-live-planet`, `nova-live-label`, `nova-live-demo-line`, `nova-live-empty-sun`.

Then:

```bash
rg -n "Coming soon" packages/admin-api/public/index.html
```

Expected: **1 match** — only the Audit placeholder remains. If 2 or more, the Live replacement didn't apply cleanly.

- [ ] **Step 2: Full visual walk**

One final walk-through of every view:

- Login screen (no sidebar, centered)
- Galaxies (list + planet colors + gradient title)
- Galaxy detail (pending/active planets, approve modal)
- Agents (grid, skill chips, capability indicators, card click → galaxy)
- **Live (new solar system):** sun renders, planets orbit slowly, labels upright, hover brightens, click → galaxy, Demo button animates a line, empty state works
- Audit (still placeholder — "Coming soon")
- Sidebar collapse persists
- Every modal still works
- Toasts fire on success/error

- [ ] **Step 3: Run tests**

```bash
cd packages/admin-api && npm test
```

Expected: 11/11 passing.

- [ ] **Step 4: If Steps 1–3 surfaced any fixes, commit them**

```bash
git add packages/admin-api/
git commit -m "fix(admin-ui): cleanup after Live tab sweep"
```

If no fixes, skip this commit.

- [ ] **Step 5: Rebuild the container**

After merge to main, rebuild so the deployed container matches. Even though this bite has no backend change, the static file bundle baked into the image is stale.

```bash
docker-compose up -d --build admin-api
```

Wait for `Container nova-admin-api-1  Started`. Give ~5 seconds for the container to boot.

- [ ] **Step 6: Verify the container serves the new Live view**

```bash
# Styles served
curl -s http://localhost:3005/styles.css | grep -c "nova-live-"
# Expected: 10 or more

# HTML served
curl -s http://localhost:3005/ | grep -c "nova-live-svg\|Demo conversation\|planets orbiting Nova"
# Expected: 2 or more

# The existing /admin/agents route still works
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3005/admin/agents \
  -H "Authorization: Bearer my-secure-admin-token-12345"
# Expected: 200
```

- [ ] **Step 7: Final browser check against the container**

Visit `http://localhost:3005`, log in, click Live, watch the orbit for a few seconds, click Demo once. If the visual matches what you saw during dev, the deploy is clean.

---

## Self-review

**Spec coverage** — every requirement traces to a task:

- SVG structure + Nova sun + ring + planets + labels + demo line → Task 3
- CSS for all new classes → Task 1
- Alpine state (`rotationDeg`, `demoLineActive`, `demoLinePath`, `hoverGalaxy`) → Task 2 Step 1
- `livePlanets` computed getter with galaxy-arc distribution → Task 2 Step 2
- `startLiveTicker` (rAF, reduced-motion guard, self-cancel on tab change) → Task 2 Step 3
- `stopLiveTicker` → Task 2 Step 3
- `triggerDemoLine` (quadratic Bezier, 1.6s cleanup with clearTimeout for re-clicks) → Task 2 Step 3
- `routeLoad` extension for `#/live` → Task 2 Step 4
- `handleSseAgent` extension for Live tab refresh → Task 2 Step 5
- `init` extension (start/stop ticker on hashchange) → Task 2 Step 6
- Empty state sun + copy → Task 3 HTML + Task 1 CSS
- Reduced motion guards (rAF self-disable + CSS fade override) → Task 2 Step 3 + Task 1 CSS
- Narrow-width labels hide → Task 1 CSS media query
- Click-planet → galaxy → Task 3 HTML (anchor href)
- Container rebuild → Task 4 Step 5
- Verification procedure → Task 4

**Placeholder scan** — no TBD/TODO/"implement later". Every code block has concrete content. Verification steps have specific commands or console snippets.

**Type consistency** — state names (`rotationDeg`, `demoLineActive`, `demoLinePath`, `hoverGalaxy`, `_liveRaf`, `_demoTimeout`) and methods (`livePlanets`, `startLiveTicker`, `stopLiveTicker`, `triggerDemoLine`) are spelled identically across all tasks. CSS class names (`nova-live-svg`, `nova-live-ring`, `nova-live-sun`, `nova-live-sun-label`, `nova-live-planet-group`, `nova-live-planet`, `nova-live-label`, `nova-live-demo-line`, `nova-live-empty-sun`, `nova-live-wrap`) match between Task 1 and Task 3.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-18-admin-ui-live-tab.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
