# Admin UI Palette Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap Nova's admin UI from its current purple/cyan/pink maximalist cosmic aesthetic to RUBRIC's black chrome with amber (#f5a623) as the sole brand accent, strip three cosmic animations, and keep gradient display text + subtle CTA glow on signature moments — without changing layout, routing, or any JS logic.

**Architecture:** Static admin UI served from `packages/admin-api/public/`. Three files touched: `styles.css` (full rewrite of the 231-line stylesheet), `index.html` (six surgical edits: CSP meta, font links, `.nova-spotlight` removal, QR `colorLight`, one-time-token eyebrow color). No JS changes. No new dependencies. No new tests (no existing visual-regression harness; verification is manual per the spec).

**Tech Stack:** Vanilla CSS with custom properties, Alpine.js-based HTML, admin-api Express server serving the static bundle. Google Fonts (Outfit + JetBrains Mono) loaded via CDN, which requires a CSP widening.

**Spec:** `docs/superpowers/specs/2026-04-18-admin-ui-palette-refresh-design.md`

---

## Dev loop — running the admin UI locally

Before starting any task, confirm you can see the current UI. From the repo root:

```bash
# Start the full stack (redis + all Nova services)
docker-compose up admin-api

# Or for a faster iteration loop, run admin-api directly against a local Redis:
cd packages/admin-api
npm run dev
```

The admin UI is served at `http://localhost:3005`. You'll need an `ADMIN_TOKEN` value (set in env or `.env` — check repo root for the `ADMIN_TOKEN=…` variable or ask the operator). Paste it into the login input to authenticate.

After every task, refresh the browser and walk through:
- Login screen
- Galaxies list (at least one galaxy, or see "No galaxies yet" empty state)
- Galaxy detail with pending + active planets
- `+ New galaxy` modal
- `+ Issue invite` modal (and its post-submit invite-reveal modal with QR)
- `Approve` modal
- Toast stack (triggered by success/error of any of the above)
- Kinetic ticker at the top of the authenticated view

The static files are served as-is — no build step — so saving a file + refreshing is enough to see the change.

---

## Task 1: Add Google Fonts link + widen CSP

**Why:** RUBRIC's aesthetic depends on `Outfit` (display) and `JetBrains Mono` (monospace). The HTML has no font link today, and the current CSP doesn't permit loading from `fonts.googleapis.com` or `fonts.gstatic.com`. This task is non-breaking on its own — the CSS that uses these fonts lands in Task 2.

**Files:**
- Modify: `packages/admin-api/public/index.html:6` (CSP meta)
- Modify: `packages/admin-api/public/index.html:7-9` (insert font links below `<title>`)

- [ ] **Step 1: Update the CSP meta tag to allow Google Fonts origins**

Open `packages/admin-api/public/index.html` and find line 6:

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:">
```

Replace with:

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:">
```

Two changes: `style-src` gains `https://fonts.googleapis.com`; a new `font-src` directive is added. Everything else is identical.

- [ ] **Step 2: Add the Google Fonts `<link>` tags**

In the same file, find line 7 (currently `<title>Nova Admin</title>`). Insert three new lines immediately after the `<title>`:

```html
  <title>Nova Admin</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css">
```

The existing `<link rel="stylesheet" href="/styles.css">` line stays in place — we're inserting *before* it so Google Fonts load first.

- [ ] **Step 3: Verify in the browser**

Refresh `http://localhost:3005` in your browser. Open DevTools → Network tab → filter "font" or "Font". You should see:
- `https://fonts.googleapis.com/css2?family=Outfit…` → 200 OK
- Several `.woff2` files from `fonts.gstatic.com` → 200 OK

Open DevTools → Console. There should be **zero** `Refused to load … Content Security Policy` errors. If you see any, the CSP edit in Step 1 was wrong — re-check.

The UI will still look the same (purple/cyan) because we haven't changed the CSS yet. This is expected.

- [ ] **Step 4: Commit**

```bash
git add packages/admin-api/public/index.html
git commit -m "chore(admin-ui): add Outfit + JetBrains Mono fonts, widen CSP"
```

---

## Task 2: Rewrite styles.css with new tokens and calmed ornament

**Why:** This is the main visual change. Replaces the 231-line stylesheet wholesale: new `:root` tokens, all component selectors migrated, `@keyframes nova-drift` / `nova-twinkle` / `nova-pulse` / `nova-spin` deleted, `.nova-surface::after` (twinkling stars) deleted, `.nova-spotlight` deleted, backdrop-filter dropped from flat surfaces.

**Files:**
- Modify: `packages/admin-api/public/styles.css` (full replacement)

- [ ] **Step 1: Replace the entire contents of `styles.css`**

The new file, in its entirety:

```css
:root {
  /* chrome */
  --bg:             #000;
  --surface:        #0a0a0a;
  --border:         #1a1a1a;
  --border-hover:   #333;
  --text:           #fff;
  --text-secondary: #888;
  --text-muted:     #555;

  /* brand — primary accent */
  --accent:         #f5a623;

  /* status */
  --status-active:  #50e3c2;
  --status-recent:  #a78bfa;
  --status-idle:    #333;
  --status-error:   #e00;

  /* typography */
  --font-display:   'Outfit', -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
  --font-mono:      'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace;
}

* { box-sizing: border-box; }

html, body { margin: 0; padding: 0; min-height: 100vh; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-display);
  font-size: 14px;
  line-height: 1.5;
  overflow-x: hidden;
}

/* ── Ambient background (static, amber-tinted, 8% opacity) ─────────────── */
.nova-surface { position: relative; }
.nova-surface::before {
  content: '';
  position: fixed;
  inset: -20%;
  pointer-events: none;
  z-index: -1;
  background:
    radial-gradient(ellipse 60% 50% at 20% 30%, rgba(245, 166, 35, 0.08), transparent 60%),
    radial-gradient(ellipse 50% 40% at 80% 70%, rgba(245, 166, 35, 0.05), transparent 60%);
  filter: blur(40px);
}

/* ── Layout ────────────────────────────────────────────────────────────── */
.nova-shell { max-width: 1100px; margin: 0 auto; padding: 52px 32px 32px; position: relative; }
.nova-row   { display: flex; align-items: center; gap: 12px; }
.nova-stack { display: flex; flex-direction: column; gap: 12px; }

/* ── Typography ────────────────────────────────────────────────────────── */
.nova-display {
  font-size: 48px; font-weight: 200; line-height: 1; letter-spacing: -1.5px;
  font-family: var(--font-display);
  background: linear-gradient(135deg, #fff 0%, var(--accent) 60%, #fff 100%);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
  filter: drop-shadow(0 0 24px rgba(245, 166, 35, 0.25));
}
.nova-eyebrow {
  font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase;
  color: var(--accent); font-weight: 700;
}
.nova-subtitle { color: var(--text-secondary); font-size: 14px; }
.nova-mono { font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); }

/* ── Card (flat surface, no longer glass) ──────────────────────────────── */
.nova-glass {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
}

/* ── CTA (static amber glow, no pulse) ─────────────────────────────────── */
.nova-cta {
  background: var(--accent);
  color: #000; border: none; cursor: pointer;
  border-radius: 10px; padding: 12px 22px;
  font-size: 14px; font-weight: 600; letter-spacing: 0.3px;
  display: inline-flex; align-items: center; gap: 8px;
  box-shadow: 0 0 32px rgba(245, 166, 35, 0.35);
  font-family: inherit;
}
.nova-cta[disabled] { opacity: 0.5; cursor: not-allowed; box-shadow: none; }

/* ── Planet (colors supplied per-galaxy via CSS custom properties) ─────── */
.nova-planet {
  width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0;
  background: radial-gradient(circle at 30% 30%, var(--planet-light, var(--accent)), var(--planet-dark, #7a4e00));
  box-shadow: 0 0 16px var(--planet-glow, rgba(245, 166, 35, 0.3));
}
.nova-planet-lg { width: 56px; height: 56px; }

/* ── Pill ──────────────────────────────────────────────────────────────── */
.nova-pill {
  display: inline-block; padding: 4px 10px; border-radius: 6px;
  font-size: 10px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase;
  border: 1px solid currentColor;
}
.nova-pill-pending { color: var(--status-recent); background: rgba(167, 139, 250, 0.1); }
.nova-pill-active  { color: var(--status-active); background: rgba(80, 227, 194, 0.1); }
.nova-pill-danger  { color: var(--status-error);  background: rgba(238, 0, 0, 0.1); }

/* ── Form controls ─────────────────────────────────────────────────────── */
.nova-input {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 11px 14px;
  color: var(--text);
  font-size: 14px;
  font-family: inherit;
}
.nova-input:focus { outline: none; border-color: var(--accent); }
.nova-input.is-error { border-color: var(--status-error); animation: nova-shake 0.4s ease-out; }
@keyframes nova-shake {
  0%, 100% { transform: translateX(0); }
  25%      { transform: translateX(-6px); }
  75%      { transform: translateX(6px); }
}
@media (prefers-reduced-motion: reduce) {
  .nova-input.is-error { animation: none; }
}
.nova-label {
  display: block; margin-bottom: 6px;
  font-size: 10px; letter-spacing: 2px; text-transform: uppercase;
  color: var(--accent); font-weight: 600;
}
.nova-error { color: var(--status-error); font-size: 12px; margin-top: 4px; }

/* ── Modal ─────────────────────────────────────────────────────────────── */
.nova-modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.75); backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  z-index: 100; padding: 32px;
}
.nova-modal {
  max-width: 520px; width: 100%;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px; padding: 28px;
  max-height: calc(100vh - 64px); overflow-y: auto;
}

/* ── Toast ─────────────────────────────────────────────────────────────── */
.nova-toast-stack {
  position: fixed; bottom: 24px; right: 24px;
  display: flex; flex-direction: column; gap: 8px;
  z-index: 200;
}
.nova-toast {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px; padding: 12px 16px;
  color: var(--text); font-size: 13px;
  min-width: 240px; max-width: 360px;
}
.nova-toast.is-err { border-color: var(--status-error); }
.nova-toast.is-ok  { border-color: var(--status-active); }

/* ── Ticker ────────────────────────────────────────────────────────────── */
@keyframes nova-scroll-x {
  from { transform: translateX(0); }
  to   { transform: translateX(-50%); }
}
@media (prefers-reduced-motion: reduce) {
  [style*="nova-scroll-x"] > div { animation: none !important; }
}
```

Note what's different from the original:
- `:root` tokens fully renamed — `--bg`/`--surface`/`--border`/`--text*`/`--accent`/`--status-*`
- `.nova-surface::after` (twinkling stars) **removed**
- `@keyframes nova-drift`, `nova-twinkle`, `nova-pulse`, `nova-spin` **all removed**
- `.nova-spotlight` and `.nova-spotlight::before` **removed** (the login input no longer wraps in this)
- `.nova-glass`: `backdrop-filter` removed (surface is flat)
- `.nova-cta`: linear-gradient background replaced with solid `var(--accent)`, text color flipped to `#000`, static `box-shadow` (no pulse animation)
- `.nova-modal`: radial-gradient from-top-right replaced with flat `var(--surface)`
- `.nova-toast`: `backdrop-filter` removed, borders now use `--status-error` / `--status-active` (simpler than the old inline rgba values)
- `.nova-pill-pending`: was `--plasma-cyan`, now `--status-recent` (violet)
- `.nova-display`: gradient updated to white→amber→white; drop-shadow is now amber-tinted
- Typography cascade: `.nova-display` explicitly sets `font-family: var(--font-display)` so Outfit wins

- [ ] **Step 2: Visually verify in the browser**

Refresh `http://localhost:3005`. The transformation should be immediately obvious — from a purple/pink/cyan cosmic vibe to a black-and-amber workshop. Walk through the login + authenticated views listed in "Dev loop" above.

Things to confirm:
- Background is `#000` with very subtle amber ambient glow (barely visible; that's intentional)
- No twinkling stars
- No drifting/scaling nebula motion
- `+ New galaxy` button is solid amber with a soft static glow, text is black, and does **not** pulse
- Eyebrow labels (e.g. `◉ NOVA · ADMIN`) are amber
- "Enter the console." and galaxy name titles use a white→amber→white gradient in the Outfit font
- Agent DID strings and slugs render in JetBrains Mono
- The "pending" pill on unapproved planets reads violet, not cyan
- The login input loses its rotating conic spotlight border (it's just a plain input now)
- Cards (`.nova-glass`) are a flat `#0a0a0a` rectangle with a thin `#1a1a1a` border — no glass blur

Known intermediate defect: the "◉ ONE-TIME TOKEN" eyebrow in the invite-reveal modal (right above the QR code) will render colorless — it still references the removed `var(--signal-warn)` inline. This is fixed in Task 3.

- [ ] **Step 3: Commit**

```bash
git add packages/admin-api/public/styles.css
git commit -m "refactor(admin-ui): swap to RUBRIC palette, strip cosmic animations

Tokens renamed to RUBRIC's chrome/surface/border/text/accent/status
scheme. Amber (#f5a623) becomes the sole brand accent; status palette
uses green/violet/red/grey. Deletes nova-drift, nova-twinkle,
nova-pulse, nova-spin keyframes, the twinkling-stars pseudo-element,
and the .nova-spotlight rotating conic border. Flat surfaces replace
backdrop-filter glass. Gradient display text and a static amber CTA
glow survive as signature moments."
```

---

## Task 3: Surgical HTML edits

**Why:** Three inline references in `index.html` still point at old state: the login input wraps in `.nova-spotlight` (no-op now, but confusing), an eyebrow still inlines `color:var(--signal-warn)` (undefined after Task 2), and the QR code generator asks for `colorLight: '#050814'` which is the old body background — should be `#000` now so it blends into the modal.

**Files:**
- Modify: `packages/admin-api/public/index.html:34-37` (remove `.nova-spotlight` wrapper around the login input)
- Modify: `packages/admin-api/public/index.html:238` (change QR `colorLight` from `'#050814'` to `'#000'`)
- Modify: `packages/admin-api/public/index.html:239` (change inline `color:var(--signal-warn)` to `color:var(--status-error)`)

- [ ] **Step 1: Remove the `.nova-spotlight` wrapper from the login input**

In `index.html`, find lines 34–37:

```html
        <div class="nova-spotlight" style="border-radius:10px">
          <input id="admintok" class="nova-input" :class="loginError ? 'is-error' : ''"
                 type="password" autocomplete="off" x-model="loginValue" required>
        </div>
```

Replace with:

```html
        <input id="admintok" class="nova-input" :class="loginError ? 'is-error' : ''"
               type="password" autocomplete="off" x-model="loginValue" required>
```

The `<div class="nova-spotlight">` wrapper and its closing `</div>` are gone. The input keeps all its Alpine bindings untouched.

- [ ] **Step 2: Update the QR code `colorLight`**

Find line 238 (inside the invite-reveal modal `x-init`):

```html
          <div class="nova-modal" x-data="{ copied: false }" x-init="$nextTick(() => { const el = $refs.qr; el.innerHTML=''; new QRCode(el, { text: revealedInvite.token, width: 180, height: 180, colorDark: '#fff', colorLight: '#050814' }); })">
```

Change `colorLight: '#050814'` to `colorLight: '#000'` — that single token, nothing else on the line:

```html
          <div class="nova-modal" x-data="{ copied: false }" x-init="$nextTick(() => { const el = $refs.qr; el.innerHTML=''; new QRCode(el, { text: revealedInvite.token, width: 180, height: 180, colorDark: '#fff', colorLight: '#000' }); })">
```

- [ ] **Step 3: Change the one-time-token eyebrow color**

Find line 239 (immediately below the QR line):

```html
            <div class="nova-eyebrow" style="color:var(--signal-warn)">◉ ONE-TIME TOKEN</div>
```

Replace with:

```html
            <div class="nova-eyebrow" style="color:var(--status-error)">◉ ONE-TIME TOKEN</div>
```

- [ ] **Step 4: Verify in the browser**

Refresh. Test each edit:

1. **Login input** — on the login screen, the input should look like a normal `.nova-input`: flat `#0a0a0a` background, `#1a1a1a` border. On focus, border turns amber. Before this step it was identical (the `.nova-spotlight` rule was already removed in Task 2), but the wrapper `<div>` is now also gone from the DOM.

2. **QR code + one-time-token eyebrow** — log in, navigate to a galaxy, click `+ Issue invite`, fill the form, click `Issue invite`. The reveal modal appears with a QR code. Confirm:
   - The `◉ ONE-TIME TOKEN` eyebrow renders in **red** (was colorless after Task 2).
   - The QR code background is **black** (was a dark-purple `#050814` before Task 2 — the hardcoded color mismatched the modal background and looked like a weird rectangle). The QR should now blend into the modal seamlessly.

- [ ] **Step 5: Commit**

```bash
git add packages/admin-api/public/index.html
git commit -m "refactor(admin-ui): remove .nova-spotlight wrapper and update inline colors

Drops the now-unused .nova-spotlight wrapper around the login input,
repoints the one-time-token eyebrow from --signal-warn to --status-error
(warn was removed), and updates the QR generator's colorLight from
#050814 to #000 to match the new body background."
```

---

## Task 4: Final sweep — confirm no stale token references, walk every view, test reduced-motion

**Why:** The old tokens (`--plasma-cyan`, `--nebula-*`, `--ink-*`, `--glass-*`, `--signal-*`, `--space-0/1`) should have zero references left. A grep confirms the migration is complete. Walking each view one last time catches any visual regression.

**Files:** No file changes. This is verification only.

- [ ] **Step 1: Grep for stale token references**

From the repo root, run:

```bash
rg --type-add 'web:*.{css,html,js}' --type web 'plasma-cyan|plasma-blue|nebula-purple|nebula-violet|signal-ok|signal-warn|signal-danger|ink-bright|ink-muted|ink-faint|glass-bg|glass-border|space-0|space-1' packages/admin-api/public
```

Expected output: **nothing**. If this command prints any matches, each one is a missed migration — fix it before continuing. Common misses would be inline styles in `index.html` that weren't touched in Task 3 or leftover rules in `styles.css`.

The only line in `styles.css` that still contains `space` is the comment `/* chrome */` etc. — those are fine because the regex won't match them.

- [ ] **Step 2: Walk every view in the browser**

Refresh and hit each view listed in "Dev loop" above. For each, confirm:

- Login screen: black background, amber eyebrow, Outfit font on "Enter the console.", JetBrains Mono nowhere yet (no mono content on this screen), CTA is amber with static glow, input is flat.
- Galaxies list: white→amber→white gradient on "Galaxies", per-galaxy planets each show their hashed hue (unchanged — `slugColor` was not touched), amber `+ New galaxy` CTA at the bottom.
- Galaxy detail: breadcrumb mono text `← All galaxies` in `#888`, title gradient on galaxy name, planets, section headings (`Pending planets`, `Active planets`, `Invites`), pills: pending=violet, active=green, rejected=red.
- Every modal (`+ New galaxy`, `+ Issue invite`, invite reveal with QR, approve planet): flat `#0a0a0a` background, thin `#1a1a1a` border, amber eyebrow (one-time-token eyebrow is red).
- Toast stack: trigger success (e.g. approve a pending planet) and error (e.g. create galaxy with an already-used slug) — the success toast border should be `#50e3c2` green, the error toast border should be `#e00` red.

- [ ] **Step 3: Test `prefers-reduced-motion`**

In DevTools, open the Command palette (Cmd/Ctrl + Shift + P on macOS/Linux, Cmd/Ctrl + Shift + P on Firefox) and run "Emulate CSS prefers-reduced-motion: reduce".

- The ticker should **stop** scrolling at the top of the authenticated view (the `@media (prefers-reduced-motion: reduce) { [style*="nova-scroll-x"] > div { animation: none !important; } }` rule catches it).
- The error-input shake should no longer animate — trigger it by leaving the login token empty and submitting.
- Nothing else animates, because we deleted the other animations. The test is really just confirming we didn't accidentally break the reduced-motion guards.

Disable the emulation before proceeding.

- [ ] **Step 4: Contrast spot-check (light-environment readability)**

This is a brief sanity check. Maximize the browser window and increase screen brightness to simulate a screen-share or projector. Confirm:

- Amber CTA is still legible (black text on amber).
- Amber eyebrows are legible (small amber uppercase on black).
- The gradient title's amber midpoint doesn't wash out.

If any of these fail on a bright display, that's follow-up work — not blocking for this bite. Log a note in the PR description.

- [ ] **Step 5: Final commit if any fixes were required**

If Steps 1–4 surfaced any small fixes (e.g. a stale `var(--plasma-cyan)` hiding in an inline style you missed), commit them with:

```bash
git add packages/admin-api/public/
git commit -m "fix(admin-ui): clean up stale token references post-palette-refresh"
```

If Steps 1–4 produced no fixes, skip the commit — the plan is done.

---

## Self-review

I ran this checklist against the spec before handing off:

**Spec coverage** — every spec section maps to a task:
- Design tokens → Task 2 Step 1 (the `:root` block in the new CSS)
- Token mapping table → Task 2 Step 1 (all rules migrated) + Task 3 (inline eyebrow)
- Ornaments delete/keep → Task 2 Step 1 (`nova-drift`/`nova-twinkle`/`nova-pulse`/`nova-spin` deleted; `.nova-surface::after` deleted; `.nova-spotlight` deleted; nebula calmed; CTA glow static; display gradient kept; shake kept; ticker keyframe kept)
- Component changes table → Task 2 Step 1
- Planet colors → untouched by design (spec says leave `slugColor` alone this bite)
- Fonts + CSP → Task 1
- QR color fix → Task 3 Step 2
- Invite-reveal eyebrow → Task 3 Step 3
- `.nova-spotlight` removal → Task 3 Step 1
- Verification procedure → Task 4
- Files expected to change → Tasks 1–3 cover `index.html` and `styles.css`; spec says `js/utils.js` and `js/app.js` are untouched, and this plan respects that

**Placeholder scan** — no TBD/TODO. Every code block shows the actual code. Commit messages are concrete. File paths are exact.

**Type consistency** — no types to cross-check (this is CSS/HTML only). Variable names (`--accent`, `--status-*`, etc.) are consistent between Tasks 2 and 3.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-18-admin-ui-palette-refresh.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
