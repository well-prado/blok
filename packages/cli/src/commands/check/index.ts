import type { OptionValues } from "commander";
import color from "picocolors";
import { readProjectConfig, validateProjectRuntimes } from "../../services/runtime-setup.js";
import { checkWorkflowRefs, formatRefReport, loadCatalog } from "./refs.js";

/**
 * blokctl check — Validate runtime version requirements AND workflow
 * step-output references (#691).
 *
 * Designed for CI integration:
 *   - Exit code 0: all checks passed
 *   - Exit code 1: one or more checks failed
 *
 * `--json` prints one machine-readable object instead of the human report.
 */
export async function checkProject(opts: OptionValues) {
	const currentPath = process.cwd();
	const json = opts.json === true;

	const config = readProjectConfig(currentPath);
	if (!config) {
		console.error("  No .blok/config.json found. Run this from a Blok project directory.");
		process.exit(1);
	}

	const results = await validateProjectRuntimes(currentPath);
	const runtimeFailures = results.filter((r) => !r.satisfied);

	let catalog: Awaited<ReturnType<typeof loadCatalog>> = null;
	let catalogError: string | undefined;
	try {
		catalog = await loadCatalog({ nodes: opts.nodes as string | undefined, url: opts.url as string | undefined });
	} catch (err) {
		catalogError = (err as Error).message;
	}
	const refs = await checkWorkflowRefs(currentPath, catalog);

	if (json) {
		console.log(
			JSON.stringify(
				{
					ok: runtimeFailures.length === 0 && refs.errorCount === 0 && catalogError === undefined,
					runtimes: results,
					catalogError,
					workflowRefs: {
						workflowCount: refs.workflowCount,
						errorCount: refs.errorCount,
						warningCount: refs.warningCount,
						uncheckedStepCount: refs.uncheckedStepCount,
						schemaless: refs.schemaless,
						workflows: refs.reports.filter((r) => r.diagnostics.length > 0),
					},
				},
				null,
				2,
			),
		);
		process.exit(runtimeFailures.length > 0 || refs.errorCount > 0 || catalogError !== undefined ? 1 : 0);
	}

	console.log(`\n  ${color.bold("Blok Runtime Version Check")}`);
	console.log("  ──────────────────────────\n");

	if (results.length === 0) {
		console.log("  No runtime version constraints configured.");
		console.log("  Runtime versions will be pinned automatically on next project creation.\n");
	} else {
		console.log(`  ${color.bold("Project runtimes")} (.blok/config.json):`);
		for (const r of results) {
			if (r.satisfied) {
				console.log(`    ${color.green("✓")} ${r.label}  ${r.found} (requires ${r.required})`);
			} else {
				console.log(`    ${color.red("✗")} ${r.label}  ${r.found || "not installed"} (requires ${r.required})`);
			}
		}
		console.log();
		for (const f of runtimeFailures) {
			console.log(f.message);
			console.log();
		}
	}

	console.log(`  ${color.bold("Workflow references")}`);
	console.log("  ───────────────────\n");
	if (catalogError) {
		console.log(`  ${color.red("✗")} could not load the node catalog: ${catalogError}\n`);
	}
	console.log(formatRefReport(refs, currentPath));
	console.log();

	const failed = runtimeFailures.length + refs.errorCount + (catalogError ? 1 : 0);
	if (failed > 0) {
		console.log(`  ${color.red(`${failed} check${failed > 1 ? "s" : ""} failed.`)}\n`);
		process.exit(1);
	}

	console.log(`  ${color.green("All checks passed.")}\n`);
	process.exit(0);
}
