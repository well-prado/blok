import type { Context } from "@blokjs/shared";
import type RunnerNode from "../RunnerNode";
import type { ExecutionResult, RuntimeAdapter } from "./RuntimeAdapter";

/**
 * WasmModuleCache caches compiled WebAssembly modules to avoid
 * re-compilation on subsequent executions.
 */
interface CachedModule {
	module: WebAssembly.Module;
	lastUsed: number;
}

/**
 * WasmRuntimeAdapter executes WebAssembly modules as Blok nodes
 *
 * This adapter provides:
 * - Direct WASM execution via WebAssembly API (built-in to Node.js/Bun)
 * - Module caching for fast subsequent executions
 * - Serialized context passing via WASM memory
 * - Support for WASI-compatible modules
 * - Support for both file-based (.wasm) and pre-compiled modules
 *
 * WASM modules must export an `execute` function that:
 * - Takes a pointer to a JSON string input
 * - Returns a pointer to a JSON string output
 *
 * Or export `__blok_execute` which receives/returns via host functions:
 * - `__blok_get_input()` → returns JSON input pointer
 * - `__blok_set_output(ptr, len)` → sets JSON output
 */
export class WasmRuntimeAdapter implements RuntimeAdapter {
	public readonly kind = "wasm" as const;
	public readonly transport = "module" as const;

	private moduleCache = new Map<string, CachedModule>();
	private maxCacheSize: number;

	constructor(options?: { maxCacheSize?: number; maxCacheAge?: number }) {
		this.maxCacheSize = options?.maxCacheSize ?? 50;
	}

	/**
	 * Execute a WASM module as a Blok node
	 *
	 * @param node - The node to execute (node.node should be path to .wasm file or module name)
	 * @param ctx - The workflow execution context
	 * @returns Promise that resolves to ExecutionResult
	 */
	async execute(node: RunnerNode, ctx: Context): Promise<ExecutionResult> {
		const startTime = performance.now();

		try {
			const modulePath = node.node || node.name;
			const wasmModule = await this.loadModule(modulePath);

			// Prepare input as JSON string
			const nodeConfig = ctx.config ? (ctx.config as Record<string, unknown>)[node.name] : {};
			const input = JSON.stringify({
				node: {
					name: node.node || node.name,
					type: node.type,
					config: nodeConfig || {},
				},
				context: {
					id: ctx.id,
					workflow_name: ctx.workflow_name,
					request: {
						body: ctx.request.body,
						headers: ctx.request.headers,
						params: ctx.request.params,
						query: ctx.request.query,
					},
					response: ctx.response,
					vars: ctx.vars,
				},
			});

			// Execute WASM module
			const output = await this.executeModule(wasmModule, input);

			const duration_ms = performance.now() - startTime;

			// Parse output
			let result: ExecutionResult;
			try {
				const parsed = JSON.parse(output);
				result = {
					success: parsed.success ?? true,
					data: parsed.data ?? parsed,
					errors: parsed.errors || parsed.error || null,
					metrics: {
						duration_ms,
						memory_bytes: this.getModuleMemoryUsage(wasmModule),
					},
				};
			} catch {
				// Raw output (non-JSON)
				result = {
					success: true,
					data: output,
					errors: null,
					metrics: {
						duration_ms,
					},
				};
			}

			return result;
		} catch (error: unknown) {
			const duration_ms = performance.now() - startTime;

			return {
				success: false,
				data: null,
				errors: {
					message: (error as Error).message,
					stack: (error as Error).stack,
					name: (error as Error).name,
				},
				metrics: {
					duration_ms,
				},
			};
		}
	}

	/**
	 * Load a WASM module (from cache or file)
	 */
	private async loadModule(modulePath: string): Promise<WebAssembly.Module> {
		// Check cache
		const cached = this.moduleCache.get(modulePath);
		if (cached) {
			cached.lastUsed = Date.now();
			return cached.module;
		}

		// Load from file
		const fs = await import("node:fs/promises");
		const wasmBytes = await fs.readFile(modulePath);
		const module = await WebAssembly.compile(wasmBytes);

		// Cache the compiled module
		this.cacheModule(modulePath, module);

		return module;
	}

	/**
	 * Execute a compiled WASM module with input
	 */
	private async executeModule(module: WebAssembly.Module, input: string): Promise<string> {
		// Create memory for the module
		const memory = new WebAssembly.Memory({ initial: 10, maximum: 100 }); // 640KB - 6.4MB

		// Host functions for the WASM module to call
		let outputBuffer = "";

		const importObject: WebAssembly.Imports = {
			env: {
				memory,
				// Allow WASM to log to console
				console_log: (ptr: number, len: number) => {
					const bytes = new Uint8Array(memory.buffer, ptr, len);
					const text = new TextDecoder().decode(bytes);
					console.log("[WASM]", text);
				},
				// Allow WASM to set output
				__blok_set_output: (ptr: number, len: number) => {
					const bytes = new Uint8Array(memory.buffer, ptr, len);
					outputBuffer = new TextDecoder().decode(bytes);
				},
				// Allow WASM to get the input length
				__blok_input_len: () => {
					return new TextEncoder().encode(input).length;
				},
				// Allow WASM to read input into a buffer
				__blok_read_input: (ptr: number) => {
					const encoded = new TextEncoder().encode(input);
					const view = new Uint8Array(memory.buffer, ptr, encoded.length);
					view.set(encoded);
				},
			},
			wasi_snapshot_preview1: {
				// Minimal WASI stubs for compatibility
				fd_write: () => 0,
				fd_read: () => 0,
				fd_close: () => 0,
				fd_seek: () => 0,
				proc_exit: () => {
					/* no-op */
				},
				environ_get: () => 0,
				environ_sizes_get: () => 0,
				clock_time_get: () => 0,
				args_get: () => 0,
				args_sizes_get: () => 0,
			},
		};

		// Instantiate module
		const instance = await WebAssembly.instantiate(module, importObject);
		const exports = instance.exports;

		// Try different execution strategies

		// Strategy 1: __blok_execute (Blok-native WASM interface)
		if (typeof exports.__blok_execute === "function") {
			(exports.__blok_execute as CallableFunction)();
			return outputBuffer || '{"success": true, "data": null}';
		}

		// Strategy 2: execute(ptr, len) → ptr
		if (typeof exports.execute === "function") {
			const alloc = exports.alloc as CallableFunction | undefined;
			const dealloc = exports.dealloc as CallableFunction | undefined;

			if (alloc) {
				// Module provides its own allocator
				const encoded = new TextEncoder().encode(input);
				const inputPtr = alloc(encoded.length) as number;
				const inputView = new Uint8Array(memory.buffer, inputPtr, encoded.length);
				inputView.set(encoded);

				const resultPtr = (exports.execute as CallableFunction)(inputPtr, encoded.length) as number;

				if (dealloc) {
					dealloc(inputPtr, encoded.length);
				}

				// Read result from memory (null-terminated string)
				const resultView = new Uint8Array(memory.buffer, resultPtr);
				let end = 0;
				while (end < resultView.length && resultView[end] !== 0) end++;
				return new TextDecoder().decode(resultView.slice(0, end));
			}

			// No allocator - just call execute
			const result = (exports.execute as CallableFunction)();
			if (typeof result === "number") {
				// Result is a pointer to a string
				const resultView = new Uint8Array(memory.buffer, result);
				let end = 0;
				while (end < resultView.length && resultView[end] !== 0) end++;
				return new TextDecoder().decode(resultView.slice(0, end));
			}
			return outputBuffer || String(result);
		}

		// Strategy 3: _start (WASI module)
		if (typeof exports._start === "function") {
			(exports._start as CallableFunction)();
			return outputBuffer || '{"success": true, "data": null}';
		}

		throw new Error("WASM module does not export execute, __blok_execute, or _start");
	}

	/**
	 * Get approximate memory usage of a WASM module instance
	 */
	private getModuleMemoryUsage(module: WebAssembly.Module): number {
		// Estimate based on module sections
		try {
			const customSections = WebAssembly.Module.customSections(module, "name");
			return customSections.reduce((sum, section) => sum + section.byteLength, 0);
		} catch {
			return 0;
		}
	}

	/**
	 * Cache a compiled WASM module
	 */
	private cacheModule(path: string, module: WebAssembly.Module): void {
		// Evict old entries if cache is full
		if (this.moduleCache.size >= this.maxCacheSize) {
			this.evictOldest();
		}

		this.moduleCache.set(path, {
			module,
			lastUsed: Date.now(),
		});
	}

	/**
	 * Evict the oldest cached module
	 */
	private evictOldest(): void {
		let oldestKey: string | null = null;
		let oldestTime = Number.POSITIVE_INFINITY;

		for (const [key, value] of this.moduleCache) {
			if (value.lastUsed < oldestTime) {
				oldestTime = value.lastUsed;
				oldestKey = key;
			}
		}

		if (oldestKey) {
			this.moduleCache.delete(oldestKey);
		}
	}

	/**
	 * Clear the module cache
	 */
	clearCache(): void {
		this.moduleCache.clear();
	}

	/**
	 * Get cache statistics
	 */
	getCacheStats(): { size: number; maxSize: number } {
		return {
			size: this.moduleCache.size,
			maxSize: this.maxCacheSize,
		};
	}
}
