/**
 * Hot Module Replacement (HMR) System for Blok
 *
 * Provides file-watching and hot-reload capabilities for development:
 * - FileWatcher: Low-level file system monitoring with debouncing
 * - HotReloadManager: High-level orchestrator for node/workflow/trigger reloads
 *
 * @example
 * ```typescript
 * import { HotReloadManager } from "@nanoservice-ts/runner";
 *
 * const hmr = new HotReloadManager({
 *   nodePaths: ["./src/nodes"],
 *   workflowPaths: ["./workflows"],
 *   triggerPaths: ["./src/triggers"],
 *   verbose: true,
 * });
 *
 * // Register reload handlers
 * hmr.onNodeChange(async (event) => {
 *   console.log(`Node changed: ${event.relativePath}`);
 *   // Re-register node in NodeMap
 *   const mod = await import(event.filePath);
 *   nodeMap.addNode(event.relativePath, mod.default);
 * });
 *
 * hmr.onWorkflowChange(async (event) => {
 *   console.log(`Workflow changed: ${event.relativePath}`);
 *   // Workflow will be re-read on next request via Configuration.init()
 * });
 *
 * await hmr.start();
 * ```
 */

export { FileWatcher } from "./FileWatcher";
export type { FileWatcherConfig, HMREvent, HMREventType } from "./FileWatcher";

export { HotReloadManager } from "./HotReloadManager";
export type { HotReloadManagerConfig, HotReloadStats, ReloadHandler } from "./HotReloadManager";

export { HmrDevConsole } from "./HmrDevConsole";
