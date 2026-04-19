# Admin UI Live tab — solar system (Live-1)

**Status:** design approved 2026-04-18
**Scope:** Replace the Live placeholder with a rotating solar-system visualization of active agents. All data is real; no task events yet.
**Prior bites:**
- `2026-04-18-admin-ui-palette-refresh-design.md` — palette (merged)
- `2026-04-18-admin-ui-shell-layout-design.md` — shell (merged)
- `2026-04-18-admin-ui-agents-tab-design.md` — Agents tab (merged)

**Next bite (Live-2, not this work):** publish `TaskLifecycleEvent` to `TASK_LIFECYCLE_CHANNEL` from `agent-connector`, extend the event shape with destination fields, and wire real A2A conversations into dotted lines on the solar system.

## Motivation

The user's north-star picture for the Live tab: "planets revolving around a star in a solar system, with dotted lines whenever an agent is talking to another." This bite delivers the visual frame — rotating solar system, real agents as planets colored by galaxy — without committing backend work. A demo button previews the conversation-line treatment. Live-2 will wire real events.

Scoping this bite to frontend only keeps risk low. Live-2's design decisions (event shape, dedup, rate limiting) are easier to make after we've seen the visualization in motion with real agents.

## Scope

**In scope**
- New inline SVG solar-system inside the Live `<template x-if="route.name === 'live'">` block
- Nova sun at center with "NOVA" label and static amber glow
- Single dashed orbital ring
- Planets = active agents, arranged in galaxy-grouped arcs on the ring
- Per-planet color from existing `slugColor(galaxy.slug)` via the same planet gradient treatment as elsewhere
- Per-planet label (agent name, mono grey, always visible at rest, brightens on hover) positioned just outside the orbit so it stays upright as the ring rotates
- requestAnimationFrame-driven rotation updating an Alpine-reactive `rotationDeg` (not CSS keyframe — we need labels to stay upright, which requires per-frame position computation)
- Click a planet → navigates to that agent's galaxy via `#/galaxy/<slug>`
- Hover a planet → brightness increase + SVG `<title>` tooltip showing agentId and galaxy slug
- "Demo conversation" button top-right that draws a dashed amber path from one random planet to another, fading out over ~1.5s
- Empty state: sun renders with "No planets orbiting yet" text
- Responsive: ring radius scales with container width, labels hide below ~500px container width
- Reduced-motion: orbital rotation disabled; demo line animation disabled (line appears then disappears without fade)
- Reuse existing `allAgents` state + `loadAllAgents()` method (shared with the Agents tab); extend `routeLoad()` and `handleSseAgent` so Live tab populates the same way

**Out of scope**
- Real task-lifecycle events — no publisher exists and won't be added this bite (Live-2)
- Extending `TaskLifecycleEvent` shape with destination fields (Live-2)
- Multiple simultaneous conversation lines overlapping (Live-2 concern; demo line is single and transient)
- Click-the-sun interaction — no-op this bite
- Per-planet detail popover / drawer (Agents tab is the detail surface; click navigates there)
- Multi-sun constellation layout, concentric-ring layout, or per-galaxy sub-systems (brainstorming picked option D: single sun, single ring, galaxy arcs)
- Mobile polish beyond "doesn't break" at narrow widths
- Automated tests (matches prior bites — no visual-regression harness exists and adding one is out of scope)

## Layout and geometry

Container is the `.nova-main` tab area. SVG viewBox spans the visible width; aspect ratio roughly square. Target height: `min(calc(100vh - 200px), 700px)`.

**Key dimensions (SVG coordinate system, viewBox `0 0 800 600`):**
- `cx = 400, cy = 300` — center
- `ringRadius = 220` (target) — scales down proportionally on narrow viewports via CSS `viewBox` preserveAspectRatio
- `sunRadius = 24`
- `planetRadius = 10`
- `labelGap = 14` — distance from planet center to label text anchor

**Agent → orbital angle algorithm.** Given `galaxies` (array) and `allAgents` (array of agents with `tenantId`):

1. Build `byGalaxy`: for each active agent, resolve `galaxySlug(a.tenantId)` → group agents by slug, preserving the order they appear in `allAgents`.
2. Sort galaxy keys alphabetically (stable ordering across renders).
3. Let `G` = number of galaxies with at least one active agent, `A` = total active agents.
4. If `A === 0`, emit no planets (empty state).
5. Inter-galaxy gap = `10°` per galaxy boundary → total gap = `G × 10°`.
6. Usable span = `360° − (G × 10°)`.
7. Per-galaxy arc width = `usable ÷ G`.
8. Within each galaxy arc: distribute agents evenly. For galaxy `i` with `n_i` agents, each agent `j` sits at:
   - `startAngle_i = i × (arcWidth + 10°)` (starting at 0°, walking clockwise)
   - `agentAngle_ij = startAngle_i + (arcWidth × (j + 0.5) ÷ n_i)`
9. Position at rotation time `t`:
   - `θ = agentAngle_ij + rotationDeg`  (rotationDeg is the shared state advanced every frame)
   - `x = cx + ringRadius × cos(θ × π / 180)`
   - `y = cy + ringRadius × sin(θ × π / 180)`
10. Label position: same `θ`, but at radius `ringRadius + labelGap + planetRadius`. Text-anchor is `middle` if θ is near top or bottom; `start`/`end` depending on horizontal side (left/right of sun). Simpler: always `text-anchor: middle` and offset label vertically.

**Simplification chosen:** all labels use `text-anchor: middle`, positioned at `(labelX, labelY)` where `labelX = cx + (ringRadius + planetRadius + 14) × cos(θ)` and `labelY = cy + (ringRadius + planetRadius + 14) × sin(θ) + 4` (the `+4` aligns optical baseline). Good enough for `≤30` agents; readability degrades gracefully past that.

## SVG structure

Inside the Live template, replace the placeholder with:

```html
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
      <!-- Orbital ring -->
      <circle class="nova-live-ring" cx="400" cy="300" r="220" />

      <!-- Demo conversation line -->
      <path class="nova-live-demo-line" :class="demoLineActive && 'is-active'" :d="demoLinePath" />

      <!-- Nova sun -->
      <g class="nova-live-sun">
        <circle cx="400" cy="300" r="24" fill="url(#nova-sun-gradient)" />
        <text x="400" y="303" class="nova-live-sun-label" text-anchor="middle">NOVA</text>
      </g>

      <!-- Planets (positions recomputed each frame by Alpine reactive state) -->
      <template x-for="p in livePlanets" :key="p.agentId">
        <a :href="`#/galaxy/${encodeURIComponent(p.galaxySlug)}`">
          <g class="nova-live-planet-group" :class="p.galaxySlug === hoverGalaxy && 'is-highlighted'">
            <circle class="nova-live-planet"
                    :cx="p.x" :cy="p.y" r="10"
                    :fill="`url(#planet-${p.agentId})`" />
            <text class="nova-live-label" :x="p.labelX" :y="p.labelY" text-anchor="middle"
                  x-text="p.name"></text>
            <title x-text="`${p.agentId} — ${p.galaxySlug}`"></title>
          </g>
        </a>
      </template>

      <!-- Per-planet gradient defs, generated reactively -->
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
    </svg>
  </div>
</template>
```

Notes:
- Ring and sun are static SVG elements. The sun has a drop-shadow via CSS for the glow.
- The rotating ring is simulated by Alpine recomputing planet positions each frame — we don't rotate a `<g>`. This is what keeps labels upright.
- `livePlanets` is a computed getter returning `[{agentId, name, galaxySlug, x, y, labelX, labelY, colorLight, colorDark}]`. Changes every animation frame via the `rotationDeg` dependency.
- `demoLinePath` is a reactive SVG path string — computed when `triggerDemoLine()` runs, cleared after the fade.
- `hoverGalaxy` is set on `mouseenter`/`mouseleave` of each planet group, used to dim other galaxies visually.

## CSS additions

Append to `styles.css`:

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

/* Hide labels at narrow widths */
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

## JavaScript additions

`packages/admin-api/public/js/app.js` — four additions plus one extension.

**1. New state (add near `allAgents`, after the Agents-tab state block added in the previous bite):**

```js
    rotationDeg: 0,
    demoLineActive: false,
    demoLinePath: '',
    hoverGalaxy: null,
```

**2. Extend `routeLoad` to trigger a load on `#/live`:**

Current (after the Agents-tab bite):

```js
    async routeLoad() {
      if (!this.token) return;
      if (this.route.name === 'home')   await this.loadGalaxies();
      if (this.route.name === 'galaxy') await this.loadGalaxy(this.route.slug);
      if (this.route.name === 'agents') await this.loadAllAgents();
    },
```

Add the `live` branch:

```js
    async routeLoad() {
      if (!this.token) return;
      if (this.route.name === 'home')   await this.loadGalaxies();
      if (this.route.name === 'galaxy') await this.loadGalaxy(this.route.slug);
      if (this.route.name === 'agents') await this.loadAllAgents();
      if (this.route.name === 'live')   await this.loadAllAgents();
    },
```

Deliberately reuses `loadAllAgents` — same data for both tabs.

**3. Extend `handleSseAgent` to refresh on the Live tab:**

Current:

```js
    handleSseAgent(ev) {
      try {
        const msg = JSON.parse(ev.data);
        if (this.activeTab === 'agents') {
          this.loadAllAgents();
          return;
        }
        if (!this.currentGalaxy) return;
        ...
      } catch {}
    },
```

Extend the tab check to include `'live'`:

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

**4. Add `livePlanets` computed getter and rAF ticker:**

Add alongside other methods in the Alpine object:

```js
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

    startLiveTicker() {
      if (this._liveRaf) return;
      const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (prefersReduced) return;
      let lastTime = performance.now();
      const degPerSec = 360 / 90; // one revolution per 90 seconds
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
      // Quadratic Bezier through the center of the sun for a gentle curve
      this.demoLinePath = `M ${a.x} ${a.y} Q 400 300 ${b.x} ${b.y}`;
      this.demoLineActive = false;
      // Force a reflow so re-adding the class restarts the animation
      requestAnimationFrame(() => { this.demoLineActive = true; });
      this._demoTimeout = setTimeout(() => {
        this.demoLineActive = false;
        this.demoLinePath = '';
        this._demoTimeout = null;
      }, 1600);
    },
```

`startLiveTicker` needs imports: `slugColor` is already imported from `utils.js` at the top of `app.js`.

**5. Start/stop the ticker when the Live tab activates/deactivates.**

The cleanest trigger is inside `init()` — add a `$watch` on `activeTab`. Current `init`:

```js
    init() {
      onUnauthorized(() => { ... });
      window.addEventListener('hashchange', () => {
        this.route = parseRoute();
        this.routeLoad();
      });
      if (this.token) { this.routeLoad(); this.connectSse(); }
    },
```

Extend with a tab watcher — but Alpine's `$watch` is only available in components, not here. Alternative: call `startLiveTicker`/`stopLiveTicker` from the existing `hashchange` handler:

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

This ensures the rAF loop only runs when `#/live` is the active route. `startLiveTicker` also self-cancels if `activeTab` isn't `'live'` (belt + braces for tab-change races).

## Data flow

- User clicks `Live` in sidebar → hash becomes `#/live` → `hashchange` → `parseRoute()` → `route.name = 'live'` → `routeLoad()` fires `loadAllAgents()` (reusing Agents tab's endpoint) → `init`'s extended handler sees `route.name === 'live'` and calls `startLiveTicker()`
- Alpine renders `livePlanets` computed getter → SVG planet positions computed from `rotationDeg` + `allAgents` + `galaxies`
- Each rAF tick advances `rotationDeg` by `(360/90 * dt) deg/sec` → Alpine recomputes `livePlanets` → SVG `cx`/`cy`/`labelX`/`labelY` update → planets visually orbit
- User leaves Live tab → `hashchange` fires again, `route.name !== 'live'` → `stopLiveTicker()` cancels the rAF loop → no more CPU spent
- SSE `agent` event arrives while Live tab active → `handleSseAgent` calls `loadAllAgents()` → `allAgents` updates → next frame's `livePlanets` re-derives positions automatically (new agent drops in at its computed arc, a removed agent disappears)
- User clicks `Demo conversation` → `triggerDemoLine()` picks two random planets, sets `demoLinePath` to a quadratic Bezier through the sun, flips `demoLineActive` after a frame (so CSS animation restarts even on repeated clicks), clears after 1.6s
- User clicks a planet → `<a>` href navigates to `#/galaxy/<slug>` → existing galaxy detail flow
- User enables `prefers-reduced-motion` → `startLiveTicker()` detects via matchMedia and bails out early → planets render at their base positions (no rotation); `.is-active` demo-line still renders but CSS media-query disables its fade animation → line shows steadily for the full 1.6s then clears

## Responsive behavior

- SVG uses `viewBox="0 0 800 600"` with `preserveAspectRatio="xMidYMid meet"` — natural scaling
- Container height: `height: min(calc(100vh - 240px), 640px)`
- Below 640px container width: labels hide via `@media (max-width: 640px) { .nova-live-label { display: none; } }`
- Planet density scales with `G` (galaxies) and `A` (agents) — the per-arc distribution handles any count; readability degrades gracefully past ~30 total agents (labels will overlap). Not designing for huge scale this bite.

## Reduced motion

- `startLiveTicker` checks `matchMedia('(prefers-reduced-motion: reduce)').matches` and bails if true. Planets render at their initial arc positions (`rotationDeg = 0`), no motion.
- `.nova-live-demo-line` has a media-query override that disables the fade keyframe. The line simply appears at full opacity and disappears when `demoLineActive` clears.

## Verification

Manual. Walk these with the container rebuilt:

1. Navigate to `#/live`. Sun renders at center with "NOVA" text, amber glow, no pulse. Orbital ring visible as a faint dashed circle.
2. Planets render on the ring. Count matches the Agents tab count. Each planet's color matches its galaxy color on Galaxies and Agents tabs. Agents of the same galaxy cluster together in an arc.
3. Watch for ~30 seconds. The whole ring slowly rotates (one revolution per 90s = 4°/sec). Planets move but labels stay upright and readable.
4. Hover a planet. Planet brightens, label brightens to white. Hover tooltip shows `agentId — galaxySlug`.
5. Click a planet. URL becomes `#/galaxy/<slug>`. Galaxy detail renders.
6. Return to `#/live`. Click `Demo conversation`. A dashed amber arc draws from one random planet to another, curves through the sun, fades out over ~1.5s. Click repeatedly — each click picks new random endpoints.
7. In DevTools → Rendering, emulate `prefers-reduced-motion: reduce`. Refresh. Planets render at rest (no rotation). Click `Demo conversation` — line appears at full opacity, persists briefly, disappears (no fade animation).
8. In DevTools → Network, throttle to "Offline" while on Live tab. Navigate away and back to `#/live`. Loading state shows. Restore connectivity and refresh — planets render.
9. Shrink browser width below ~640px. Labels disappear; planet-only view remains functional. Ring shrinks via viewBox.
10. Navigate to `#/agents`, wait a few seconds, navigate back to `#/live`. Planets are at their base positions (the ticker was stopped during the away period; `rotationDeg` keeps its last value but the new ticker starts fresh — small visual jump is acceptable).
11. Empty state: block `/admin/agents` in DevTools, refresh. Error panel shows. Unblock, refresh. Planets return. If a freshly-initialized Nova has zero agents, the Live tab shows the sun-only empty state with "No planets orbiting yet."
12. Tests still pass: `cd packages/admin-api && npm test` → 11/11.
13. Grep: `rg "nova-live-" packages/admin-api/public` should show matches in both `styles.css` and `index.html`. Demo button uses `.nova-input` (no custom class).

## Files expected to change

- `packages/admin-api/public/index.html` — replace the Live `<template x-if="route.name === 'live'">` block with the SVG structure (roughly 60 lines instead of 7)
- `packages/admin-api/public/styles.css` — append the Live tab CSS block (~60 lines)
- `packages/admin-api/public/js/app.js` — add four state properties, one getter, three methods (`startLiveTicker`, `stopLiveTicker`, `triggerDemoLine`), extend `routeLoad`, extend `handleSseAgent`, extend `init` (~80 lines added)

No backend changes. No new dependencies. No new files.

## Risks and decisions deferred

- **Label overlap at scale.** Past ~30 agents, labels will collide. Acceptable for typical operator load; if it becomes a problem, mitigations are label rotation, tier-sensitive radius, or a detail-on-hover-only mode. Revisit when real instances hit that density.
- **Request animation frame vs CSS keyframes.** rAF costs ~60 function calls per second and an Alpine reactive recomputation each frame. For ≤30 planets this is trivial (<1ms per frame). A CSS-keyframe-rotated `<g>` would be cheaper but wouldn't let us keep labels upright. Accept the cost for label clarity.
- **Rotation speed (90s/rev).** Chosen to feel calm. If users find it distracting or stale, adjust the `degPerSec` constant. Keep the option of a user-controlled toggle in mind for Live-2.
- **Demo line geometry.** Quadratic Bezier through the sun is visually pleasant but may not match the eventual real-conversation treatment (which might prefer a straight dashed line, or a sweep). The demo's purpose is to prove the treatment works — final line geometry is a Live-2 decision.
- **No simultaneous demo lines.** One demo click clobbers the previous. Real conversations (Live-2) will need a rolling set of concurrent lines with per-line fade timers. Explicitly out of scope here.
- **No backend this bite.** The Live-2 design will need to decide: should `publishTaskEvent` in `task-queue` also publish a summary to `TASK_LIFECYCLE_CHANNEL`, or should `agent-connector` be the sole publisher? Either works; agent-connector owns the task state machine, which makes it the natural publisher. Defer the decision until Live-2 starts.
- **Tab-pause rAF.** The ticker stops when the Live tab is not active but continues when the browser tab is backgrounded. `requestAnimationFrame` naturally pauses when the document is hidden (browsers suspend rAF in background tabs), so idle CPU cost in a hidden tab is zero. No additional `visibilitychange` handling needed.
