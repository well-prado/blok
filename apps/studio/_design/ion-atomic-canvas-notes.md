# ION / ATOMIC canvas research notes

Source: Tetrix MCP index of `deskree-inc/atomic-canvas` (newer redesign, reactflow v11) and
`deskree-inc/ion-editor` (older generation of the same codebase). Gathered 2026-08-06 to inform
the BLOK Studio canvas redesign. The BuildShip-style mockups in the founder's design folder
remain the primary visual spec; these notes capture ATOMIC's interaction mechanics.

## Visual system (ATOMIC generation)

- 3-step elevation ramp: canvas `#1a1a1a` with `#262626` dot grid → panels `#1a1a1a`/`#111111` → node cards `#3b3b3b`, `rounded-lg`, no border.
- ONE accent color everywhere: `#5278ff` for hovered/selected edges, the selected-node inset outline (`outline outline-2 outline-offset-[-2px]`), arrowheads, active sockets. (Ported to BLOK as blue-400.)
- Category color applied to the node TITLE TEXT only (database orange, deskree blue, infra green, integrations violet, utility white, trigger yellow) — ATOMIC deliberately dropped ion-editor's colored header bands. Color moves from surfaces to text.
- Skipped/stopped nodes: whole card `opacity-40` + floating caption above the card ("Node skipped"); downstream-of-stop edges go dashed.

## Node card anatomy

NodeHeader (step-name small + node-title large, colored; right icon strip: Debug / Skip / Stop-after / Edit pencil, all tooltipped) → NodeInputs (collapsible schema accordions: `property* | Type` rows; hovering a row shows the LIVE configured value in a tooltip; collapse state persisted per node) → NodeOutputs footer (`Output … Type: Object`). Double-click anywhere = open config drawer.

## Connection mechanics (the interaction gold)

1. **Edge midpoint dot → "+" button on hover** (EdgeLabelRenderer): permanent midpoint dot on every edge; hover swaps to a "+" that opens the node library and splices the picked node between source and target. Their single most product-defining interaction.
2. **Drag-from-socket onto empty canvas opens the node library**, then creates node + edge at the drop point (`onConnectEnd` + one-shot zustand listener the library resolves).
3. Sockets: 6px white-ringed circles that nudge 3px outward on hover; source handles tooltip "Click and drag to add Node"; targets `isConnectableStart={false}`; an input already connected refuses a second edge; per-branch handles rendered inline on each if/else condition row.
4. Select edge + Delete removes it; container configs (if-else/forEach arrays) are patched in sync.
5. Dashed ghost "Add Node" placeholder nodes auto-spawn after container branches.

## Camera & chrome

- Drawer-open choreography: `setCenter(x, y, { zoom: 1.2, duration: 800 })`, previous viewport saved and restored on close. ALL camera moves animate at 800ms.
- Custom controls: Reset-layout (re-runs ELK), Recenter-on-trigger, zoom ± with a live percentage readout (0.4–1.0 mapped to 0–100%). No MiniMap anywhere.
- Onboarding: bottom-right panel with a 6-GIF micro-tutorial carousel + "Don't show"/"Remind me later".
- Console: resizable bottom drawer — Output / Logs / Errors / Debug / Monitoring (per-node cost + perf) / Terminal tabs. Debug icon on a node header jumps to and expands that node's console entry.

## Ported to BLOK so far (2026-08-06 visual pass)

Selected-node blue inset outline; hollow ports; dashed control-flow cards; config rows on cards
(BuildShip flavor of "schema-as-card-body"); edge arrowheads; canvas-first default tab.
Edge midpoint "+" → palette splice (2026-08-06). Drag-from-socket → palette with drop-position
node creation via `onConnectEnd` (2026-08-06): source sockets only (`isConnectableStart={false}`
on targets), drop pins `step.ui.{x,y}` at the cursor, trigger-origin drops insert at the start.
Skip / Stop header toggles (2026-08-06): flip `active: false` / `stop: true` on the raw step —
the engine already honored both in `RunnerSteps.runSteps` (skip continues past, stop halts
BEFORE the step). Skipped card dims + dashes; stop card gets an amber dashed outline and its
immediate outgoing edges dash.

## Next candidates (ranked)

1. Drawer-open camera choreography for the inputs editor (setCenter + viewport restore).
2. Zoom-percentage controls + Recenter-on-trigger.
3. Hover tooltip on config rows showing full values.
4. Onboarding micro-tutorial panel.

## BuildShip deploy-bar reference (buildship.com/n8n, captured 2026-08-06)

The embedded editor screenshot on the page shows their canvas chrome:

- Top bar, left: segmented mode tabs `Build | Connect | Preview` — active segment is a
  lighter pill, inactive segments dim text on the dark bar.
- Top bar, center: the workflow title, small and quiet.
- Top bar, right cluster (in order): `▷ Test` as a dark ghost button with a subtle
  border; version-history and share icon buttons; then `🚀 Ship` — the ONLY filled
  accent control on the whole bar. Compact pill (rounded-md, ~24px tall), accent fill
  (their indigo; ours should stay blok-green for brand), rocket icon + label.
- Ship = deploy. Test = run without deploying. The visual hierarchy IS the message:
  running is routine (ghost), shipping is the commitment (filled accent).
- Right drawer "Test" panel: `Form | JSON` toggle for the input, a filled accent
  `▷ Test Flow` button, then a `Result` section with the JSON output inline. Escape
  hatches (copy, expand) as small icons on the result block.

Translation for BLOK Studio: keep the toolbar ghost-dark (current zinc idiom), make
Deploy the single filled blok-green pill with a rocket icon, demote Run to a ghost
button beside it, and surface the deploy guard state ON the Deploy button (amber dot =
undeployed changes, red + disabled = validation failing, spinner while deploying).
