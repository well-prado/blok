# ADR 0011: Defer Studio `@blokjs/helper` Validation Import

## Status

Accepted for M1 planning.

## Context

S1 proposed adding `@blokjs/helper` to Studio and importing
`validateWorkflow()` directly so Studio could validate workflow JSON in the
browser. Studio has no `@blokjs/helper` dependency today, so the bundle impact
had to be measured before committing that path.

`@blokjs/helper` does not yet export `validateWorkflow()`. The probe used the
equivalent current validation graph: `WorkflowV2Schema.safeParse()` from
`@blokjs/helper/internal`, imported by Studio and called from `main.tsx` so
Rollup could not tree-shake it away.

## Measurement

Build command for both runs:

```sh
bun run --filter @blokjs/studio build
```

Size script summed all built JS/CSS files in `apps/studio/dist/assets` and
gzipped each file with Node's `zlib.gzipSync`.

| Build | Raw JS/CSS bytes | Gzip JS/CSS bytes | Main JS chunk |
| --- | ---: | ---: | --- |
| Baseline | 1,360,117 | 384,307 | `index-CnFqCRQe.js`: 440,845 raw / 125,090 gzip |
| Helper validation probe | 1,451,289 | 408,844 | `index-lf-iJYEV.js`: 532,017 raw / 149,627 gzip |
| Delta | +91,172 | +24,537 | +91,172 raw / +24,537 gzip |

The variant transformed 2,639 modules versus 2,623 baseline and tripped Vite's
500 kB chunk warning for the main bundle. The built chunk contained the schema
validation graph and the probe call, confirming the import was retained.

## Decision

Do not add `@blokjs/helper` to Studio in S1 for client-side workflow
validation.

S1 should still ship the shared `validateWorkflow()` surface for `blokctl`, the
registry publish gate, MCP/schema tooling, and other non-browser consumers.
Studio adoption moves to S4 and should use a runner/server validation endpoint
instead of importing the Zod schema graph into the browser bundle.

## Rationale

- A 24.5 kB gzip increase is too large for a validation path that is not needed
  on the first Studio screen.
- The main chunk crosses Vite's 500 kB warning, making every Studio load pay for
  a feature that belongs to edit/save flows.
- Zod is not already in Studio, so there is no near-zero transitive-dependency
  win.
- The recursive workflow schema graph is retained by the import; tree-shaking
  does not make this cheap.
- A server-side endpoint keeps Studio aligned with the runner's accepted
  semantics without shipping the whole validation graph to browsers.

## Consequences

- S1 remains useful: the validator ships for CLI, registry, and AI tooling.
- S4 owns Studio validation transport and UX.
- The S4 endpoint is real work, but it is the right layer because Studio write
  paths are already S4's responsibility.
- No Studio package dependency change is made now.
