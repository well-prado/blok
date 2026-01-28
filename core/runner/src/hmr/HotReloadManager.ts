/**
 * Hot Reload Manager for Blok Framework
 *
 * Orchestrates hot module replacement across the framework:
 * - Node hot-reload: Invalidates module cache and re-imports changed nodes
 * - Workflow hot-reload: Re-reads workflow JSON/TS and reinitializes Configuration
 * - Trigger hot-reload: Signals triggers to reload their workflow registrations
 *
 * Integrates with RuntimeRegistry.replace() for runtime adapter hot-swapping.
 */

import { EventEmitter } from "node:events";
import { FileWatcher, type FileWatcherConfig, type HMREvent } from "./FileWatcher";

export interface HotReloadStats {
	totalReloads: number;
	nodeReloads: number;
	workflowReloads: number;
	triggerReloads: number;
	errors: number;
	lastReload: number | null;
	lastError: string | null;
	uptime: number;
}

export type ReloadHandler = (event: HMREvent) => Promise<void> | void;

export interface HotReloadManagerConfig extends FileWatcherConfig {
	/** Enable/disable hot reload (default: true in dev, false in prod) */
	enabled?: boolean;
	/** Maximum consecutive errors before disabling hot-reload */
	maxConsecutiveErrors?: number;
	/** Cooldown between reloads of the same file in ms (default: 1000) */
	cooldownMs?: number;
}

export class HotReloadManager extends EventEmitter {
	private fileWatcher: FileWatcher;
	private config: HotReloadManagerConfig;
	private stats: HotReloadStats;
	private startTime: number;
	private consecutiveErrors = 0;
	private disabled = false;
	private cooldowns: Map<string, number> = new Map();

	/** User-registered handlers for specific event types */
	private nodeChangeHandlers: ReloadHandler[] = [];
	private workflowChangeHandlers: ReloadHandler[] = [];
	private triggerChangeHandlers: ReloadHandler[] = [];

	constructor(config: HotReloadManagerConfig = {}) {
		super();
		this.config = {
			enabled: process.env.NODE_ENV !== "production",
			maxConsecutiveErrors: 5,
			cooldownMs: 1000,
			...config,
		};
		this.startTime = Date.now();
		this.stats = {
			totalReloads: 0,
			nodeReloads: 0,
			workflowReloads: 0,
			triggerReloads: 0,
			errors: 0,
			lastReload: null,
			lastError: null,
			uptime: 0,
		};
		this.fileWatcher = new FileWatcher(this.config);
	}

	/**
	 * Start the hot reload system
	 */
	async start(): Promise<void> {
		if (!this.config.enabled) {
			this.emit("log", "[HMR] Hot reload is disabled (production mode)");
			return;
		}

		this.fileWatcher.on("change", (event: HMREvent) => this.handleChange(event));
		this.fileWatcher.on("error", (err: { path: string; error: Error }) => {
			this.emit("error", err);
		});
		this.fileWatcher.on("log", (msg: string) => this.emit("log", msg));
		this.fileWatcher.on("ready", (info: { watchedPaths: string[] }) => {
			this.emit("ready", info);
			this.emit("log", `[HMR] Hot reload active, watching ${info.watchedPaths.length} directories`);
		});

		await this.fileWatcher.start();
	}

	/**
	 * Stop the hot reload system
	 */
	async stop(): Promise<void> {
		await this.fileWatcher.stop();
		this.cooldowns.clear();
		this.emit("log", "[HMR] Hot reload stopped");
	}

	/**
	 * Register a handler for node changes
	 */
	onNodeChange(handler: ReloadHandler): void {
		this.nodeChangeHandlers.push(handler);
	}

	/**
	 * Register a handler for workflow changes
	 */
	onWorkflowChange(handler: ReloadHandler): void {
		this.workflowChangeHandlers.push(handler);
	}

	/**
	 * Register a handler for trigger changes
	 */
	onTriggerChange(handler: ReloadHandler): void {
		this.triggerChangeHandlers.push(handler);
	}

	/**
	 * Get current stats
	 */
	getStats(): HotReloadStats {
		return {
			...this.stats,
			uptime: Date.now() - this.startTime,
		};
	}

	/**
	 * Invalidate a module from Node.js require cache
	 */
	invalidateModule(modulePath: string): boolean {
		try {
			// Clear from require cache
			const resolved = require.resolve(modulePath);
			if (require.cache[resolved]) {
				delete require.cache[resolved];
				return true;
			}
			return false;
		} catch {
			return false;
		}
	}

	/**
	 * Invalidate all modules matching a pattern
	 */
	invalidateModules(pattern: string | RegExp): number {
		let count = 0;
		const regex = typeof pattern === "string" ? new RegExp(pattern) : pattern;

		for (const key of Object.keys(require.cache)) {
			if (regex.test(key)) {
				delete require.cache[key];
				count++;
			}
		}
		return count;
	}

	private async handleChange(event: HMREvent): Promise<void> {
		if (this.disabled) return;

		// Check cooldown
		const lastReload = this.cooldowns.get(event.filePath);
		if (lastReload && Date.now() - lastReload < (this.config.cooldownMs || 1000)) {
			return;
		}
		this.cooldowns.set(event.filePath, Date.now());

		try {
			const category = event.type.split(":")[0] as "node" | "workflow" | "trigger";
			let handlers: ReloadHandler[];

			switch (category) {
				case "node":
					handlers = this.nodeChangeHandlers;
					// Invalidate module cache for the changed node
					this.invalidateModule(event.filePath);
					this.stats.nodeReloads++;
					break;
				case "workflow":
					handlers = this.workflowChangeHandlers;
					this.stats.workflowReloads++;
					break;
				case "trigger":
					handlers = this.triggerChangeHandlers;
					this.stats.triggerReloads++;
					break;
				default:
					return;
			}

			// Execute all registered handlers
			for (const handler of handlers) {
				await handler(event);
			}

			this.stats.totalReloads++;
			this.stats.lastReload = Date.now();
			this.consecutiveErrors = 0;

			this.emit("reload", event);
			this.emit("log", `[HMR] ${event.type}: ${event.relativePath} reloaded successfully`);
		} catch (err) {
			this.stats.errors++;
			this.consecutiveErrors++;
			this.stats.lastError = err instanceof Error ? err.message : String(err);

			this.emit("reload-error", { event, error: err });
			this.emit("log", `[HMR] Error reloading ${event.relativePath}: ${this.stats.lastError}`);

			if (this.consecutiveErrors >= (this.config.maxConsecutiveErrors || 5)) {
				this.disabled = true;
				this.emit("disabled", {
					reason: `Too many consecutive errors (${this.consecutiveErrors})`,
				});
				this.emit(
					"log",
					`[HMR] Hot reload disabled after ${this.consecutiveErrors} consecutive errors`,
				);
			}
		}
	}
}
