# Vision deck — source

Regenerable source for [`../Blok-Platform-Vision.pdf`](../Blok-Platform-Vision.pdf), a 22-slide founder briefing on the platform vision with before/after code on every spec.

- `slides.json` — the 12 spec slides (headline, before/after snippet, why, compat), extracted from `S1–S12`.
- `build-deck.js` — generates `deck.html` (design system + static slides + the 12 spec slides; code is syntax-highlighted at build time).
- `render.js` — prints `deck.html` → `deck.pdf` via headless Chromium.

## Regenerate

```bash
npm init -y && npm i playwright highlight.js
npx playwright install chromium
node build-deck.js     # → deck.html
node render.js         # → deck.pdf  (+ preview.png)
```

Slide content tracks the specs — re-run the extraction (the `vision-deck-content` workflow) and overwrite `slides.json` when `S1–S12` change. The PDF bakes in the icons + highlighting, so it needs no network to view.
