/**
 * File Watcher for Hot Module Replacement (HMR)
 *
 * Watches file system for changes in nodes, workflows, and triggers,
 * then emits reload events for the appropriate components.
 *
 * Uses Node.js fs.watch with debouncing to avoid duplicate events.
 */

import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { EventEmitter } from "node:events";

export type HMREventType = "node:change" | "node:add" | "node:remove" | "workflow:change" | "workflow:add" | "workflow:remove" | "trigger:change" | "config:change";

export interface HMREvent {
	type: HMREventType;
	filePath: string;
	relativePath: string;
	timestamp: number;
}

export interface FileWatcherConfig {
	/** Directories containing node source files */
	nodePaths?: string[];
	/** Directories containing workflow JSON/TS files */
	workflowPaths?: string[];
	/** Directories containing trigger source files */
	triggerPaths?: string[];
	/** File extensions to watch (default: [".ts", ".js", ".json"]) */
	extensions?: string[];
	/** Debounce interval in ms (default: 250) */
	debounceMs?: number;
	/** Patterns to ignore (default: ["node_modules", "dist", ".git"]) */
	ignorePatterns?: string[];
	/** Enable verbose logging */
	verbose?: boolean;
}

const DEFAULT_CONFIG: Required<FileWatcherConfig> = {
	nodePaths: [],
	workflowPaths: [],
	triggerPaths: [],
	extensions: [".ts", ".js", ".json"],
	debounceMs: 250,
	ignorePatterns: ["node_modules", "dist", ".git", "__tests__", ".d.ts"],
	verbose: false,
};

export class FileWatcher extends EventEmitter {
	private config: Required<FileWatcherConfig>;
	private watchers: Map<string, FSWatcher> = new Map();
	private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
	private knownFiles: Set<string> = new Set();
	private running = false;

	constructor(config: FileWatcherConfig = {}) {
		super();
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Start watching all configured directories
	 */
	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;

		const allPaths = [
			...this.config.nodePaths.map((p) => ({ path: p, category: "node" as const })),
			...this.config.workflowPaths.map((p) => ({ path: p, category: "workflow" as const })),
			...this.config.triggerPaths.map((p) => ({ path: p, category: "trigger" as const })),
		];

		for (const { path, category } of allPaths) {
			await this.watchDirectory(path, category);
		}

		this.emit("ready", { watchedPaths: allPaths.map((p) => p.path) });
	}

	/**
	 * Stop all watchers and clean up
	 */
	async stop(): Promise<void> {
		this.running = false;

		for (const [path, watcher] of this.watchers) {
			watcher.close();
		}
		this.watchers.clear();

		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();

		this.knownFiles.clear();
		this.removeAllListeners();
	}

	/**
	 * Get current watcher status
	 */
	getStatus(): { running: boolean; watchedDirectories: number; knownFiles: number } {
		return {
			running: this.running,
			watchedDirectories: this.watchers.size,
			knownFiles: this.knownFiles.size,
		};
	}

	private async watchDirectory(dirPath: string, category: "node" | "workflow" | "trigger"): Promise<void> {
		try {
			// Index existing files
			await this.indexDirectory(dirPath);

			// Create recursive watcher
			const watcher = watch(dirPath, { recursive: true }, (eventType, filename) => {
				if (!filename) return;
				const fullPath = join(dirPath, filename);
				this.handleFsEvent(eventType, fullPath, dirPath, category);
			});

			watcher.on("error", (err) => {
				this.emit("error", { path: dirPath, error: err });
			});

			this.watchers.set(dirPath, watcher);

			if (this.config.verbose) {
				this.emit("log", `Watching ${category} directory: ${dirPath}`);
			}
		} catch (err) {
			this.emit("error", { path: dirPath, error: err });
		}
	}

	private async indexDirectory(dirPath: string): Promise<void> {
		try {
			const entries = await readdir(dirPath, { recursive: true });

			for (const entry of entries) {
				const fullPath = join(dirPath, entry.toString());

				if (this.shouldIgnore(fullPath)) continue;
				if (!this.isWatchedExtension(fullPath)) continue;

				try {
					const stats = await stat(fullPath);
					if (stats.isFile()) {
						this.knownFiles.add(fullPath);
					}
				} catch {
					// File may have been deleted between readdir and stat
				}
			}
		} catch {
			// Directory may not exist yet
		}
	}

	private handleFsEvent(
		eventType: string,
		filePath: string,
		baseDir: string,
		category: "node" | "workflow" | "trigger",
	): void {
		if (this.shouldIgnore(filePath)) return;
		if (!this.isWatchedExtension(filePath)) return;

		// Debounce to avoid duplicate events
		const existing = this.debounceTimers.get(filePath);
		if (existing) {
			clearTimeout(existing);
		}

		this.debounceTimers.set(
			filePath,
			setTimeout(async () => {
				this.debounceTimers.delete(filePath);
				await this.processChange(filePath, baseDir, category);
			}, this.config.debounceMs),
		);
	}

	private async processChange(
		filePath: string,
		baseDir: string,
		category: "node" | "workflow" | "trigger",
	): Promise<void> {
		const relativePath = relative(baseDir, filePath);
		let eventType: HMREventType;

		try {
			const stats = await stat(filePath);
			if (stats.isFile()) {
				if (this.knownFiles.has(filePath)) {
					eventType = `${category}:change` as HMREventType;
				} else {
					this.knownFiles.add(filePath);
					eventType = `${category}:add` as HMREventType;
				}
			} else {
				return;
			}
		} catch {
			// File was deleted
			if (this.knownFiles.has(filePath)) {
				this.knownFiles.delete(filePath);
				eventType = `${category}:remove` as HMREventType;
			} else {
				return;
			}
		}

		const event: HMREvent = {
			type: eventType,
			filePath,
			relativePath,
			timestamp: Date.now(),
		};

		this.emit("change", event);
		this.emit(eventType, event);

		if (this.config.verbose) {
			this.emit("log", `[HMR] ${eventType}: ${relativePath}`);
		}
	}

	private shouldIgnore(filePath: string): boolean {
		return this.config.ignorePatterns.some((pattern) => filePath.includes(pattern));
	}

	private isWatchedExtension(filePath: string): boolean {
		const ext = extname(filePath);
		return this.config.extensions.includes(ext);
	}
}
