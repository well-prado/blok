import type { RuntimeAdapter, RuntimeKind } from "./adapters/RuntimeAdapter";

/**
 * RuntimeRegistry is a singleton that manages all runtime adapters
 *
 * Usage:
 * ```typescript
 * const registry = RuntimeRegistry.getInstance();
 * registry.register(new NodeJsRuntimeAdapter());
 * registry.register(new GrpcRuntimeAdapter({ kind: "python3", host: "localhost", port: 9107 }));
 *
 * const adapter = registry.get("nodejs");
 * const result = await adapter.execute(node, ctx);
 * ```
 */
export class RuntimeRegistry {
	private static instance: RuntimeRegistry;
	private adapters: Map<RuntimeKind, RuntimeAdapter>;
	private versions: Map<RuntimeKind, string>;

	private constructor() {
		this.adapters = new Map<RuntimeKind, RuntimeAdapter>();
		this.versions = new Map<RuntimeKind, string>();
	}

	/**
	 * Get the singleton instance of RuntimeRegistry
	 */
	public static getInstance(): RuntimeRegistry {
		if (!RuntimeRegistry.instance) {
			RuntimeRegistry.instance = new RuntimeRegistry();
		}
		return RuntimeRegistry.instance;
	}

	/**
	 * Register a runtime adapter
	 *
	 * @param adapter - The runtime adapter to register
	 * @throws Error if adapter with same kind is already registered
	 */
	public register(adapter: RuntimeAdapter): void {
		if (this.adapters.has(adapter.kind)) {
			throw new Error(`Runtime adapter for '${adapter.kind}' is already registered`);
		}
		this.adapters.set(adapter.kind, adapter);
	}

	/**
	 * Get a runtime adapter by kind
	 *
	 * @param kind - The runtime kind (nodejs, python3, go, etc.)
	 * @returns The runtime adapter for the specified kind
	 * @throws Error if no adapter is registered for the specified kind
	 */
	public get(kind: RuntimeKind): RuntimeAdapter {
		const adapter = this.adapters.get(kind);
		if (!adapter) {
			throw new Error(
				`No runtime adapter registered for '${kind}'. Available runtimes: ${Array.from(this.adapters.keys()).join(", ")}`,
			);
		}
		return adapter;
	}

	/**
	 * Check if a runtime adapter is registered
	 *
	 * @param kind - The runtime kind to check
	 * @returns true if adapter is registered, false otherwise
	 */
	public has(kind: RuntimeKind): boolean {
		return this.adapters.has(kind);
	}

	/**
	 * Get all registered runtime kinds
	 *
	 * @returns Array of registered runtime kinds
	 */
	public getRegisteredKinds(): RuntimeKind[] {
		return Array.from(this.adapters.keys());
	}

	/**
	 * v0.7 — every registered adapter, for the node catalog (`GET /__blok/nodes`)
	 * which calls `adapter.listNodes()` on each to enumerate runtime nodes.
	 *
	 * @returns Array of `{ kind, adapter }` for all registered runtimes
	 */
	public getAll(): { kind: RuntimeKind; adapter: RuntimeAdapter }[] {
		return Array.from(this.adapters.entries()).map(([kind, adapter]) => ({ kind, adapter }));
	}

	/**
	 * Set the detected version for a runtime kind.
	 *
	 * @param kind - The runtime kind
	 * @param version - The detected version string (e.g. "3.12.0")
	 */
	public setVersion(kind: RuntimeKind, version: string): void {
		this.versions.set(kind, version);
	}

	/**
	 * Get the detected version for a runtime kind.
	 *
	 * @param kind - The runtime kind
	 * @returns The version string, or undefined if not known
	 */
	public getVersion(kind: RuntimeKind): string | undefined {
		return this.versions.get(kind);
	}

	/**
	 * Get all known runtime versions.
	 *
	 * @returns Map of runtime kind to version string
	 */
	public getVersions(): Map<RuntimeKind, string> {
		return new Map(this.versions);
	}

	/**
	 * Clear all registered adapters and versions (useful for testing)
	 */
	public clear(): void {
		this.adapters.clear();
		this.versions.clear();
	}

	/**
	 * Replace an existing adapter (useful for testing or hot-reload)
	 *
	 * @param adapter - The runtime adapter to replace
	 */
	public replace(adapter: RuntimeAdapter): void {
		this.adapters.set(adapter.kind, adapter);
	}
}
