# Admin UI palette refresh — first bite

**Status:** design approved 2026-04-18
**Scope:** CSS-only token + ornament refresh of `packages/admin-api/public`
**Next bites (not this work):** shell layout with sidebar/tabs, new Agents detail tab, Live solar-system tab

## Motivation

Nova's admin UI currently leans into a maximalist cosmic aesthetic — animated nebula drift, twinkling stars, conic-gradient spotlights, pulsing glowing CTAs, purple/cyan/pink gradients. It works at the current scope (a single centered column with galaxies and planets), but doesn't scale to the surfaces we intend to add next: an Agents detail tab, a Live solar-system view of A2A conversations, and whatever else earns its keep.

We're adopting the RUBRIC toolkit's calmer, workshop-dark aesthetic (pure black chrome, minimal borders, one accent) as the foundation going forward, with cosmic identity preserved on signature moments — page titles and primary CTAs — rather than spread across every surface.

This first bite is strictly a palette + ornament refresh. No layout changes, no new views, no TypeScript. It exists so the second bite (shell layout) starts on a calmer foundation that won't fight with RUBRIC's chrome patterns.

## Scope

**In scope**
- Replace the design tokens in `packages/admin-api/public/styles.css`
- Remove three cosmic animations (nebula drift, twinkling stars, CTA pulse)
- Delete one ornament component wholesale (`.nova-spotlight` rotating conic gradient)
- Dial down the nebula background gradient from ~45% opacity to 8%, re-tinted around the new amber primary
- Swap display and mono font stacks to Outfit + JetBrains Mono
- Evaluate the per-galaxy color generator (`slugColor()` in `public/js/utils.js`, consumed by `planetStyle()` in `public/js/app.js`) against the new chrome — see the "Planet colors" section below
- Visually verify every existing view (login, galaxies list, galaxy detail, all four modals, toast stack, scrolling ticker)

**Out of scope**
- Shell layout: no sidebar, no topbar, no tab system this bite
- New views: Agents detail, Live solar-system, etc.
- Any change to `index.html` structure, routing, Alpine data, or API
- Automated visual-regression tests (no prior infra; adding it is a separate decision)
- Self-hosted web fonts (first bite uses Google Fonts; follow-up can self-host if CSP requires)

## Design tokens

All existing CSS custom properties on `:root` are replaced. Anywhere the old tokens were referenced, the rule migrates to the new token.

```
/* chrome */
--bg:             #000
--surface:        #0a0a0a
--border:         #1a1a1a
--border-hover:   #333
--text:           #fff
--text-secondary: #888
--text-muted:     #555

/* brand — primary accent */
--accent:         #f5a623

/* status */
--status-active:  #50e3c2
--status-recent:  #a78bfa
--status-idle:    #333
--status-error:   #e00

/* typography */
--font-display:   'Outfit', -apple-system, BlinkMacSystemFont, 'Inter', sans-serif
--font-mono:      'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace
```

**Tokens removed:** `--space-0`, `--space-1`, `--nebula-purple`, `--nebula-violet`, `--plasma-cyan`, `--plasma-blue`, `--signal-ok`, `--signal-warn`, `--signal-danger`, `--ink-bright`, `--ink`, `--ink-muted`, `--ink-faint`, `--glass-bg`, `--glass-border`.

**Mapping for rules that referenced old tokens**

| Old token | New token |
|---|---|
| `--space-1` (body bg) | `--bg` |
| `--ink-bright`, `--ink` | `--text` |
| `--ink-muted` | `--text-secondary` |
| `--ink-faint` | `--text-muted` |
| `--glass-bg` | `--surface` |
| `--glass-border` | `--border` |
| `--plasma-cyan` (eyebrow, label, focus border, `.nova-pill-pending`) | `--accent` for eyebrows/labels/focus; `--status-recent` for the pending pill |
| `--nebula-purple`, `--nebula-violet` | removed — not referenced anywhere in current CSS |
| `--signal-ok` (`.nova-pill-active`) | `--status-active` |
| `--signal-warn` (used only for the "ONE-TIME TOKEN" eyebrow in the invite-reveal modal, `index.html:239`) | `--status-error` — semantically it's a "don't-lose-this" warning, red reads more correctly than amber-as-primary |
| `--signal-danger` (error pill, input error border, `.nova-error`) | `--status-error` |

## Ornaments — delete vs keep

**Delete wholesale**
- `@keyframes nova-drift` and the `.nova-surface::before` animation property
- `@keyframes nova-twinkle` and the entire `.nova-surface::after` block (twinkling stars)
- `@keyframes nova-pulse` and the `.nova-cta` animation property
- `@keyframes nova-spin` and the entire `.nova-spotlight::before` block
- The `.nova-spotlight` rule itself (the login input wrapper just uses `.nova-input` with its focus state)

**Keep (in calmed form)**
- The nebula radial-gradient on `.nova-surface::before`: stays, but static (no `animation:` declared), opacity reduced, gradient stops re-tinted around `rgba(245, 166, 35, x)` for subtle ambient warmth
- The `.nova-cta` `box-shadow`: static, amber-tinted — keeps the "signature moment" feel without the pulse
- The `.nova-display` gradient text: gradient updated to `linear-gradient(135deg, #fff 0%, #f5a623 60%, #fff 100%)`
- The `.nova-input.is-error` shake keyframe: keep (it's feedback, not ornament)
- The ticker `@keyframes nova-scroll-x`: keep (carries live info — galaxy and pending counts)

## Component changes

| Component | Change |
|---|---|
| `body` background | `#000` via `--bg` |
| `.nova-surface::before` | Static amber-tinted gradient at 8% opacity |
| `.nova-surface::after` | Removed |
| `.nova-glass` | `background: var(--surface)`, `border: 1px solid var(--border)`, drop `backdrop-filter` (flat surface, not glass) |
| `.nova-cta` | `background: var(--accent)`, `color: #000`, animation removed, static box-shadow |
| `.nova-eyebrow`, `.nova-label` | `color: var(--accent)` |
| `.nova-input` | `background: var(--surface)`, `border: 1px solid var(--border)`, `:focus border: var(--accent)` |
| `.nova-planet` | Body unchanged (see "Planet colors" below) |
| `.nova-pill-pending` | Was plasma-cyan; now violet — `--status-recent` |
| `.nova-pill-active` | Was soft green `#4ade80`; now `--status-active` `#50e3c2` (slightly more teal) |
| `.nova-pill-danger` | Was soft red `#f87171`; now `--status-error` `#e00` (harder red) |
| `.nova-input.is-error` | `border-color: var(--status-error)` (shake keyframe kept) |
| `.nova-error` | `color: var(--status-error)` |
| Invite-reveal "one-time token" eyebrow (inline style in `index.html:239`) | Inline `color:var(--signal-warn)` → `color:var(--status-error)` |
| `.nova-modal` | Flat `background: var(--surface)`, `border: 1px solid var(--border)`, drop the `radial-gradient` from-top-right |
| `.nova-spotlight` | Rule deleted; login input is a plain `.nova-input` |
| `.nova-display` | `font-family: var(--font-display)`, gradient updated as above |
| `.nova-mono` | `font-family: var(--font-mono)` |
| `.nova-toast` | `background: var(--surface)`, borders keyed to `--status-error` / `--status-active` |
| Kinetic ticker (inline styles in `index.html`) | Uses existing variables; no change needed, but the inline `rgba(0,0,0,0.6)` overlay stays |

## Planet colors

`slugColor(slug)` in `public/js/utils.js` hashes the slug (FNV-1a) to a hue 0–360, then returns `hsl(hue, 85%, 65%)` for light, `hsl(hue, 70%, 25%)` for dark, and the `rgb(…, 0.4)` equivalent for glow. `planetStyle()` in `public/js/app.js` wraps this as CSS custom properties for `.nova-planet`.

This is a full-hue rotation, not a discrete palette. Every galaxy gets a unique hue; some land on amber, some on violet, some on blue, some on pink.

**Decision:** leave `slugColor` untouched this bite. Against the new `#000` chrome + single amber accent, full-spectrum planets remain visually distinguishable (which is the point of per-galaxy color as identity) without clashing the way they did against the busy purple/pink nebula. Revisit if the result feels noisy once the accent settles.

Saturation / lightness may also warrant a light desaturation pass later (e.g. `85%` → `60%` saturation) so planets sit more quietly alongside amber chrome. Not doing it this bite — see it in context first.

## Fonts

The HTML `<head>` currently has no font link. Add the same Google Fonts import RUBRIC uses:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

The existing CSP (`default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'`) does not allow `fonts.googleapis.com` or `fonts.gstatic.com`. The CSP must be extended:

```
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com;
```

`style-src` is already declared, so the update adds the `https://fonts.googleapis.com` origin there and adds a new `font-src` directive.

If the CSP extension is undesirable, the alternative is to self-host the font files — out of scope for this bite.

## Verification

No automated tests for this UI exist and none are added this bite. Verification is manual.

1. From repo root, run whatever dev command serves `admin-api` locally (`docker-compose up admin-api` or the equivalent — consult `packages/admin-api/package.json` scripts when implementing).
2. Open `http://localhost:<admin-port>/` and walk through every view:
   - Login screen — token input focused and errored states
   - Galaxies list with and without galaxies
   - Galaxy detail with pending and active planets
   - `+ New galaxy` modal (validation errors included)
   - `+ Issue invite` modal
   - Invite reveal modal (QR renders on `#050814` → now `#000` background; the QR `colorLight` must be updated to `#000`)
   - Approve planet modal
   - Toast stack (trigger a success and an error)
3. Toggle system `prefers-reduced-motion` on — verify the remaining animations (ticker, error-input shake) still respect it.
4. Check in at least one light-background environment (screen-share, projector) that accent contrast holds.
5. Visually confirm every old token has a new token — search the repo for the removed names (`grep -r --include='*.css' --include='*.html' --include='*.js' 'plasma-cyan\|nebula-\|ink-\|glass-\|signal-\|space-0\|space-1'`) and resolve every hit. Expected: zero hits after the change.

## QR color fix

The invite-reveal modal's QR generator takes `colorLight: '#050814'` (the old body background). When the background moves to `#000`, pass `colorLight: '#000'` instead. This is a one-line change in `index.html` where `new QRCode(...)` is invoked.

## Risks and decisions deferred

- **Third-party font load.** Adding Google Fonts introduces a network dependency at page-load and widens the CSP. Accepted for the first bite for simplicity; a follow-up bite can self-host the woff2 files if that trade-off sours.
- **Shell layout not in this bite.** Result: the UI will look calmer but structurally unchanged (still a single centered column). That's intentional — we validate the palette before we commit to restructuring the shell.
- **No component screenshot tests.** A change this visually broad would benefit from Playwright visual-regression, but Nova has no such harness today. Adding one is its own bite; for now, the two human eyes check.
- **Planet colors look the same.** Since `slugColor` is untouched this bite, existing galaxies keep their current hues. Only the surrounding chrome changes. That's intentional — we want to see planet colors against the new background before deciding whether to desaturate them.

## Files expected to change

- `packages/admin-api/public/styles.css` — bulk of the work (token `:root`, chrome surfaces, component selectors, ornament keyframes deleted)
- `packages/admin-api/public/index.html` — add Google Fonts `<link>` tags, update CSP meta tag to allow the font origins, update QR `colorLight` from `#050814` to `#000`, remove `.nova-spotlight` wrapper around the login input, update inline `color:var(--signal-warn)` on the one-time-token eyebrow
- `packages/admin-api/public/js/utils.js` — no changes this bite (see "Planet colors")
- `packages/admin-api/public/js/app.js` — no changes this bite

Approximate size: 231-line CSS file rewritten, ~10 HTML edits, zero JS changes.
