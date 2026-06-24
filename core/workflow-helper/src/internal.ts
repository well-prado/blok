/**
 * `@blokjs/helper/internal` — advanced / non-author-facing API.
 *
 * The Zod schemas, step-shape type-guards, trigger validation machinery, and
 * `$` proxy internals live here. The author-facing surface (`workflow`, `$`,
 * `branch`, `forEach`, `loop`, `switchOn`, `tryCatch`, `eq`) stays on the main
 * entry — these are implementation details that tooling occasionally needs but
 * workflow/node authors never import.
 *
 * Nothing inside this monorepo imports these via `@blokjs/helper`; this subpath
 * exists so the eventual surface shrink on the main entry (P3) doesn't hard-break
 * any external consumer that depends on the validation schemas — they move here.
 */

export * from "./types/StepOpts";
export * from "./types/TriggerOpts";
export * from "./types/WorkflowOpts";
export * from "./proxy/$";
