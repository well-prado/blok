import fs from "node:fs";
import path from "node:path";
import { normalizeJavaScriptRuntime } from "@blokjs/shared";
import color from "picocolors";
import type { OptionValues } from "../../services/commander.js";
import { RuntimeCommandError, readConfigSafe, reportRuntimeError, resolveProjectRoot } from "./shared.js";

/**
 * `blokctl runtime use <node|bun|deno>` — select the project's JavaScript
 * execution target without touching sidecar runtime entries or package-manager
 * policy. The runner remains responsible for refusing a target whose adapter is
 * not installed; this command only changes the declared project selection.
 */
export async function runtimeUse(kindArg: string, options: OptionValues): Promise<void> {
	try {
		const root = resolveProjectRoot(options.directory);
		const input = kindArg.trim();
		let runtime: ReturnType<typeof normalizeJavaScriptRuntime>;
		try {
			runtime = normalizeJavaScriptRuntime(input);
		} catch {
			throw new RuntimeCommandError(`Unknown JavaScript runtime "${input}". Supported targets: node, bun, deno.`);
		}

		const config = readConfigSafe(root);
		const nextConfig = { ...config, runtime: runtime.runtime };
		const configPath = path.join(root, ".blok", "config.json");
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);

		if (runtime.diagnostic) {
			console.warn(`[blok] ${runtime.diagnostic.message}`);
		}
		if (options.json) {
			console.log(JSON.stringify({ runtime: runtime.runtime, packageManager: config.packageManager ?? null }));
			return;
		}

		pNote(
			`JavaScript target: ${runtime.runtime}${
				runtime.runtime === "node" ? "" : " (execution worker availability is checked when the project boots)"
			}`,
		);
	} catch (err) {
		reportRuntimeError(err);
	}
}

function pNote(message: string): void {
	console.log(color.green(`✓ ${message}`));
}
