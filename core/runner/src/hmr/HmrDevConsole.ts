/**
 * HMR Dev Console - Formatted developer-friendly output for hot reload events.
 *
 * Subscribes to HotReloadManager events and prints timestamped,
 * color-coded messages to the console during development.
 */

import type { HMREvent } from "./FileWatcher";
import type { HotReloadManager, HotReloadStats } from "./HotReloadManager";

export class HmrDevConsole {
	constructor(private hmr: HotReloadManager) {
		this.hmr.on("ready", (info: { watchedPaths: string[] }) => {
			console.log("\n  [HMR] Hot reload active");
			console.log(`  Watching ${info.watchedPaths.length} director${info.watchedPaths.length === 1 ? "y" : "ies"}`);
			for (const p of info.watchedPaths) {
				console.log(`    - ${p}`);
			}
			console.log("");
		});

		this.hmr.on("reload", (event: HMREvent) => {
			const timestamp = new Date().toLocaleTimeString();
			const label = this.formatEventType(event.type);
			console.log(`  [HMR] [${timestamp}] ${label}: ${event.relativePath}`);
		});

		this.hmr.on("reload-error", ({ event, error }: { event: HMREvent; error: Error }) => {
			const timestamp = new Date().toLocaleTimeString();
			console.error(`  [HMR] [${timestamp}] ERROR ${event.relativePath}: ${error.message}`);
		});

		this.hmr.on("disabled", ({ reason }: { reason: string }) => {
			console.error(`\n  [HMR] DISABLED: ${reason}\n`);
		});
	}

	printStats(): void {
		const stats: HotReloadStats = this.hmr.getStats();
		const uptime = Math.round(stats.uptime / 1000);
		console.log("\n  [HMR] Stats:");
		console.log(`    Total reloads: ${stats.totalReloads}`);
		console.log(`    Nodes: ${stats.nodeReloads} | Workflows: ${stats.workflowReloads} | Triggers: ${stats.triggerReloads}`);
		console.log(`    Errors: ${stats.errors}`);
		console.log(`    Uptime: ${uptime}s\n`);
	}

	private formatEventType(type: string): string {
		const [category, action] = type.split(":");
		return `${category} ${action}`;
	}
}
