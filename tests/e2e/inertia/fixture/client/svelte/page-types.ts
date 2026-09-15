/**
 * `Home`'s props, read off the generated page contract — the scenario-19 gate.
 *
 * Scenario 19 renames `home:` in `src/workflows/home.ts` and expects the
 * client's `bunx tsc --noEmit` to fail. `tsc` never opens a `.svelte` file, so
 * for the Svelte cell the binding has to live in TypeScript; `Home.svelte`
 * types its `$props()` with THIS type, so the gate holds the page's real prop
 * type rather than a decoy. (`svelte-check` would cover the component itself —
 * the scaffold's `typecheck` script is plain `tsc`.)
 *
 * It indexes `Pages` rather than `PageProps<"Home">` on purpose: `PageProps`
 * unions in the app-wide shared props, whose open index signature answers
 * `unknown` for any name at all, so a renamed prop would sail through it.
 * `Pages["Home"]` is the exact contract the workflow declared.
 */
import type { Pages } from "@blokjs/inertia-client";

export type HomeProps = { home: Pages["Home"]["home"] };
