import type { OptionValues } from "commander";
import color from "picocolors";
import { readProjectConfig, validateProjectRuntimes } from "../../services/runtime-setup.js";

/**
 * blokctl check — Validate runtime version requirements.
 *
 * Checks all configured runtime versions against their constraints
 * and reports pass/fail for each. Designed for CI integration:
 *   - Exit code 0: all checks passed
 *   - Exit code 1: one or more checks failed
 */
export async function checkProject(_opts: OptionValues) {
	const currentPath = process.cwd();

	const config = readProjectConfig(currentPath);
	if (!config) {
		console.error("  No .blok/config.json found. Run this from a Blok project directory.");
		process.exit(1);
	}

	console.log(`\n  ${color.bold("Blok Runtime Version Check")}`);
	console.log("  ──────────────────────────\n");

	const results = await validateProjectRuntimes(currentPath);

	if (results.length === 0) {
		console.log("  No runtime version constraints configured.");
		console.log("  Runtime versions will be pinned automatically on next project creation.\n");
		process.exit(0);
	}

	// Display project runtime results
	console.log(`  ${color.bold("Project runtimes")} (.blok/config.json):`);

	for (const r of results) {
		if (r.satisfied) {
			console.log(`    ${color.green("✓")} ${r.label}  ${r.found} (requires ${r.required})`);
		} else {
			console.log(`    ${color.red("✗")} ${r.label}  ${r.found || "not installed"} (requires ${r.required})`);
		}
	}

	console.log();

	const failures = results.filter((r) => !r.satisfied);

	if (failures.length > 0) {
		// Print detailed fix instructions for each failure
		for (const f of failures) {
			console.log(f.message);
			console.log();
		}
		console.log(`  ${color.red(`${failures.length} check${failures.length > 1 ? "s" : ""} failed.`)}\n`);
		process.exit(1);
	}

	console.log(`  ${color.green("All checks passed.")}\n`);
	process.exit(0);
}
