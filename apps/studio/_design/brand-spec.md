# Blok · Brand Spec (Studio Redesign)

> Captured: 2026-04-29
> Sources: `docs/assets/logo/{light,dark}.svg`, `apps/studio/src/app.css`, `apps/studio/public/favicon.svg`
> Completeness: **partial** — logo + status palette are real; brand color is real; everything else is being defined here for the first time.

## Core asset audit (real)

### Logo (one file each, fixed colors)

- **Wordmark, dark backgrounds:** `docs/assets/logo/dark.svg` — green icon `#2BCD71`, white type
- **Wordmark, light backgrounds:** `docs/assets/logo/light.svg` — green icon `#2BCD71`, black type
- Wordmark structure: 4 rotated squares (left + right pair around a stacked center cube) + "BLOK" type. The icon is the recognizable mark; the wordmark adds it.
- **No isolated icon-only file exists** — for app chrome (favicon, sidebar collapsed state) the icon needs to be sliced out. Action: extract just the three-glyph icon (paths 1–3 in either SVG) into `docs/assets/logo/mark.svg`.

### Studio's current favicon (BROKEN)

`apps/studio/public/favicon.svg` is a **foreign placeholder**: zinc background, blue 4-square grid, cyan plus-stroke. Has no relation to the Blok logo. Action: replace with the real `mark.svg` slice on a `--bg-canvas` rounded-rect.

### Status palette (real, keep)

From `apps/studio/src/app.css:5-16`:

| Token | Hex | Usage |
|---|---|---|
| `--color-status-pending` | `#71717a` (zinc-500) | not yet started |
| `--color-status-running` | `#3b82f6` (blue-500) | in flight — pulse animation |
| `--color-status-completed` | `#22c55e` (green-500) | success |
| `--color-status-failed` | `#ef4444` (red-500) | error |
| `--color-status-cancelled` | `#a855f7` (purple-500) | user cancelled |
| `--color-status-skipped` | `#6b7280` (gray-500) | conditional skip |
| `--color-log-debug` | `#71717a` | log level |
| `--color-log-info` | `#3b82f6` | log level |
| `--color-log-warn` | `#f59e0b` (amber-500) | log level |
| `--color-log-error` | `#ef4444` | log level |

These tokens are battle-tested across the app and consumed correctly. **Keep them.** The redesign's only adjustment: tighten `--color-status-completed` from raw `#22c55e` toward the brand green `#2BCD71` so success states share the brand DNA instead of a generic Tailwind green.

## Redesign palette (Direction A · Linear-grade Operator)

Built from the real brand color outward. Two surfaces (canvas + raised) on a near-black, **one** warm accent (Blok green), status palette unchanged.

```css
:root {
  /* Brand */
  --blok-green-500: #2BCD71;     /* logo, primary CTA, focus ring, brand chip */
  --blok-green-600: #22A85B;     /* pressed/hover */
  --blok-green-100: #C7F1DA;     /* subtle bg tint, success badges on light */

  /* Surfaces — 4-step neutral ladder */
  --bg-canvas:   #0B0B0D;        /* outermost, slightly cooler than zinc-950 */
  --bg-raised:   #111113;        /* cards, run rows  (matches existing zinc-925) */
  --bg-overlay:  #18181B;        /* inspector pane, modals (zinc-900) */
  --bg-hover:    #1F1F23;        /* hover tier */

  /* Ink */
  --ink-1: #F4F4F5;              /* primary text (zinc-100) */
  --ink-2: #A1A1AA;              /* secondary (zinc-400) */
  --ink-3: #52525B;              /* tertiary, captions (zinc-600) */

  /* Borders + dividers */
  --hairline:    rgba(244,244,245,0.06);  /* default */
  --hairline-2:  rgba(244,244,245,0.10);  /* emphasized */

  /* Focus + selection (brand-tinted) */
  --focus-ring:  rgba(43,205,113,0.45);
  --selected-bg: rgba(43,205,113,0.08);
}
```

### Why this works

- The brand green stays *one accent only* — it does not compete with the status palette. Running runs are still blue; completed ones still green (status), but the **brand green** is reserved for: logo lockup, primary CTA, focus ring, the active env chip, the "fresh data" pulse on the live-feed badge.
- 4-step surface ladder gives the app real depth in dark mode without leaning on shadows (which look bad on dark UI).
- Status colors are unchanged so today's habits don't break.

## Typography

- **Display (numerals + hero metrics):** **Newsreader** italic, weight 400 — used only on the dashboard headline number, the run-detail title-card duration, and the metrics page big numbers. Adds a "this number was set, not just printed" feeling. Single concession to Direction C — A is otherwise sans-only.
- **Body / UI:** the system stack already in `app.css` (system-ui → SF Pro / Segoe UI / Roboto). Keep — switching to a custom sans for body buys little and costs the FOUT tax.
- **Code / IDs / durations:** **JetBrains Mono** (already specified at `app.css:79`). Keep.

## Iconography

- **Lucide React** is already the icon set (verified in audit). Keep, but apply two rules:
  1. **No icon without a label** in primary nav, primary CTAs, or empty states — every icon in those positions has its text twin (Linear/trigger.dev convention). Tooltips are not enough.
  2. **No decorative icons in dense rows** (run list, log lines, trace nodes) — only status / runtime-kind glyphs. The current sidebar pattern (icon + label) is correct; extend it instead of adding more.

## Motion

Existing keyframes in `app.css:35-75` (pulse-dot 1.5s, grow-bar 2s alt, slide-in 0.25s) are good. Add two:

- **Status flip:** when a node transitions running→completed via SSE, fade its row from `--color-status-running` to `--color-status-completed` over 320 ms with `cubic-bezier(0.2, 0.8, 0.2, 1)`. Currently the swap is instant — disorienting on fast runs.
- **Live-feed brand pulse:** the dashboard "Live · 3 active" pill pulses `--blok-green-500 → --blok-green-600` at 2 s while the SSE channel is healthy. Stops on disconnect. This is the only place the brand color *moves*.

## Forbidden zones (anti-AI-slop)

- ❌ No purple gradient anywhere. The accidental purple from `--color-status-cancelled` is fine; avoid using purple for any other surface.
- ❌ No emoji as icon (Lucide-only).
- ❌ No card with left-edge color border accent.
- ❌ No SVG-illustrated empty states drawn from imagination — empty states get a tasteful inline gray block + one line of copy + one CTA.
- ❌ No "neon" accent variants of the brand green — `#2BCD71` only, no `#3FFFA0` glow versions.
- ❌ No background gradient on the canvas. Flat surfaces, depth via the 4-step neutral ladder.

## Vibe keywords (3–5)

`operator-grade · quiet-confident · keyboard-first · dense-but-legible · Blok-green-as-signature`

## Asset to-do for implementation

- [ ] Slice `mark.svg` (icon-only) out of `dark.svg`
- [ ] Replace `apps/studio/public/favicon.svg` with the real mark on `--bg-canvas`
- [ ] Add Newsreader (Google Fonts, `wght@400;500&style=italic`) to Studio's index.html — display only, italic 400, fallback `Georgia, serif`
- [ ] Migrate the 4-step surface ladder + brand color into `app.css @theme` block alongside the existing status tokens — do not delete status tokens
- [ ] Tighten `--color-status-completed` to `#2BCD71` (one-character delta — `#22c55e` → `#2BCD71`) so the on-brand green shows up on every successful run automatically
