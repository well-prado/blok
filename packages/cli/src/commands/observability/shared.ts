/**
 * Shared helpers for the `blokctl observability` command group. Reuses the
 * generic project-locating helpers from the runtime command group (they aren't
 * runtime-specific) and adds an observability-flavoured error + reporter.
 */

import * as p from "@clack/prompts";
import color from "picocolors";
// resolveProjectRoot + readConfigSafe are generic "find + read a Blok project"
// helpers that happen to live in the runtime command dir. Reuse, don't fork.
import { RuntimeCommandError, readConfigSafe, readFrameworkTag, resolveProjectRoot } from "../runtime/shared.js";

export { readConfigSafe, resolveProjectRoot };

export class ObservabilityCommandError extends Error {}

/** Best-effort framework version (e.g. "0.6.19") for the module's drift stamp. */
export function readFrameworkVersion(projectRoot: string): string | undefined {
	try {
		return readFrameworkTag(projectRoot)?.replace(/^v/, "");
	} catch {
		return undefined;
	}
}

/**
 * Print a friendly terminal message for a failed `observability` command and set
 * a non-zero exit code. Operational errors — our own `ObservabilityCommandError`
 * and the reused `RuntimeCommandError` (thrown by `resolveProjectRoot` /
 * `readConfigSafe`) — are shown plainly; anything else is an unexpected error.
 */
export function reportObservabilityError(err: unknown): void {
	if (err instanceof ObservabilityCommandError || err instanceof RuntimeCommandError) {
		p.cancel(err.message);
	} else {
		p.cancel(color.red(`Unexpected error: ${(err as Error)?.message ?? String(err)}`));
	}
	process.exitCode = 1;
}
