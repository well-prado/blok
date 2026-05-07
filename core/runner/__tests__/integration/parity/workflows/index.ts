/**
 * Canonical parity workflow battery.
 *
 * One entry per workflow file. The matrix iterates over this list and runs
 * each workflow against every available SDK. Adding a new canonical case
 * is a single import + push to this array — no harness changes.
 */

import { errorPathsBattery } from "./error-paths";
import { largeVarsWorkflow } from "./large-vars";
import { smallPayloadWorkflow } from "./small-payload";
import type { CanonicalWorkflow } from "./types";

export const CANONICAL_WORKFLOWS: ReadonlyArray<CanonicalWorkflow> = [
	smallPayloadWorkflow,
	largeVarsWorkflow,
	...errorPathsBattery,
];

export type { CanonicalWorkflow } from "./types";
export { asBlokError, buildParityContext } from "./types";
