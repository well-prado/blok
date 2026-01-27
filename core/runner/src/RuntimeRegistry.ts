import type { RuntimeAdapter, RuntimeKind } from "./adapters/RuntimeAdapter";

/**
 * RuntimeRegistry is a singleton that manages all runtime adapters
 *
 * Usage:
 * ```typescript
 * const registry = RuntimeRegistry.getInstance();
 * registry.register(new NodeJsRuntimeAdapter());
 * registry.register(new Python3RuntimeAdapter());
 *
 * const adapter = registry.get("nodejs");
 * const result = await adapter.execute(node, ctx);
 * ```
 */
export class RuntimeRegistry {
	private static instance: RuntimeRegistry;
	private adapters: Map<RuntimeKind, RuntimeAdapter>;

	private constructor() {
		this.adapters = new Map<RuntimeKind, RuntimeAdapter>();
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
	 * Clear all registered adapters (useful for testing)
	 */
	public clear(): void {
		this.adapters.clear();
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
