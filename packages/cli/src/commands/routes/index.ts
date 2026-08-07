import { spawn } from "node:child_process";
import color from "picocolors";
import { type OptionValues, program, trackCommandExecution } from "../../services/commander.js";
import { readProjectConfig } from "../../services/runtime-setup.js";

/**
 * blokctl routes (#693) — print the boot-time HTTP route table offline, for
 * CI and AI agents that need "what's registered" without starting a server.
 *
 * Reuses the real trigger's own route-building code (`HttpTrigger.listen()`
 * short-circuits on `BLOK_ROUTES_ONLY=1` before booting metrics/tracing/the
 * HTTP server) instead of a second scanning implementation — one source of
 * truth for "what routes exist", matching the trigger exactly, including
 * any project-local customization of the scaffolded runner files.
 *
 * Exit code: 0 when at least one route is registered, 1 otherwise (or when
 * no HTTP trigger is configured) — a plain CI gate.
 */
export async function routesCommand(opts: OptionValues) {
	const currentPath = (opts.directory as string) || process.cwd();
	const config = readProjectConfig(currentPath);
	if (!config) {
		console.error("  No .blok/config.json found. Run this from a Blok project directory.");
		process.exitCode = 1;
		return;
	}

	const triggers = config.triggers ? Object.values(config.triggers) : [];
	const httpTrigger = triggers.find((t) => t.kind === "http");

	let cmd: string;
	let args: string[];
	if (httpTrigger) {
		[cmd, ...args] = httpTrigger.startCmd.split(" ");
	} else if (triggers.length === 0) {
		// Legacy single-trigger project (no `.blok/config.json` triggers map) —
		// assume the default HTTP entrypoint, same fallback `blokctl dev` uses.
		cmd = "bun";
		args = ["run", "src/index.ts"];
	} else {
		console.error("  No HTTP trigger configured in this project (.blok/config.json) — nothing to route.");
		process.exitCode = 1;
		return;
	}

	console.log(`\n  ${color.bold("Blok route table")}`);
	console.log("  ─────────────────\n");

	const exitCode = await new Promise<number>((resolve) => {
		const child = spawn(cmd, args, {
			cwd: currentPath,
			stdio: "inherit",
			env: { ...process.env, BLOK_ROUTES_ONLY: "1", BLOK_ROUTE_TABLE: "true" },
		});
		child.on("exit", (code) => resolve(code ?? 1));
		child.on("error", () => resolve(1));
	});

	process.exitCode = exitCode;
}

program
	.command("routes")
	.description("Print the boot-time HTTP route table without starting the server (CI/agent friendly)")
	.option("-d, --directory [value]", "Project directory", process.cwd())
	.action(async (options: OptionValues) => {
		await trackCommandExecution({
			command: "routes",
			args: options,
			execution: async () => {
				await routesCommand(options);
			},
		});
	});
