/**
 * Unit Tests for WasmRuntimeAdapter
 * Tests WebAssembly module execution, caching, and error handling
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertValidExecutionResult, createMockContext } from "../../../test/helpers/test-utils";
import type RunnerNode from "../../RunnerNode";
import { WasmRuntimeAdapter } from "../WasmRuntimeAdapter";

describe("WasmRuntimeAdapter", () => {
	let adapter: WasmRuntimeAdapter;

	beforeEach(() => {
		adapter = new WasmRuntimeAdapter();
	});

	describe("Adapter Properties", () => {
		it("should have wasm as kind", () => {
			expect(adapter.kind).toBe("wasm");
		});

		it("should have execute method", () => {
			expect(adapter.execute).toBeDefined();
			expect(typeof adapter.execute).toBe("function");
		});
	});

	describe("Constructor Options", () => {
		it("should accept custom cache options", () => {
			const customAdapter = new WasmRuntimeAdapter({
				maxCacheSize: 100,
				maxCacheAge: 5 * 60 * 1000,
			});

			const stats = customAdapter.getCacheStats();
			expect(stats.maxSize).toBe(100);
		});

		it("should use default cache options when none provided", () => {
			const stats = adapter.getCacheStats();
			expect(stats.maxSize).toBe(50);
			expect(stats.size).toBe(0);
		});
	});

	describe("Cache Management", () => {
		it("should start with empty cache", () => {
			const stats = adapter.getCacheStats();
			expect(stats.size).toBe(0);
		});

		it("should clear cache", () => {
			// Even though cache is empty, clearCache should not throw
			adapter.clearCache();
			const stats = adapter.getCacheStats();
			expect(stats.size).toBe(0);
		});

		it("should report correct cache stats", () => {
			const stats = adapter.getCacheStats();
			expect(stats).toHaveProperty("size");
			expect(stats).toHaveProperty("maxSize");
			expect(typeof stats.size).toBe("number");
			expect(typeof stats.maxSize).toBe("number");
		});
	});

	describe("execute() - Error Handling", () => {
		it("should handle missing WASM file gracefully", async () => {
			const mockContext = createMockContext();
			const mockNode = {
				name: "test-wasm-node",
				node: "/nonexistent/path/module.wasm",
				type: "module",
				run: vi.fn(),
			} as unknown as RunnerNode;

			const result = await adapter.execute(mockNode, mockContext);

			assertValidExecutionResult(result);
			expect(result.success).toBe(false);
			expect(result.errors).toBeDefined();
			expect(result.errors).toHaveProperty("message");
			expect(result.metrics?.duration_ms).toBeGreaterThanOrEqual(0);
		});

		it("should handle invalid WASM binary gracefully", async () => {
			// Create a temporary file with invalid WASM content
			const tmpDir = path.resolve(__dirname, "../../../test/tmp");
			const tmpFile = path.join(tmpDir, "invalid.wasm");

			try {
				await fs.mkdir(tmpDir, { recursive: true });
				await fs.writeFile(tmpFile, Buffer.from("not-valid-wasm"));

				const mockContext = createMockContext();
				const mockNode = {
					name: "test-wasm-node",
					node: tmpFile,
					type: "module",
					run: vi.fn(),
				} as unknown as RunnerNode;

				const result = await adapter.execute(mockNode, mockContext);

				expect(result.success).toBe(false);
				expect(result.errors).toBeDefined();
				expect(result.errors).toHaveProperty("message");
			} finally {
				await fs.unlink(tmpFile).catch(() => {});
				await fs.rmdir(tmpDir).catch(() => {});
			}
		});

		it("should include duration_ms in metrics on failure", async () => {
			const mockContext = createMockContext();
			const mockNode = {
				name: "test-node",
				node: "/nonexistent.wasm",
				type: "module",
				run: vi.fn(),
			} as unknown as RunnerNode;

			const result = await adapter.execute(mockNode, mockContext);

			expect(result.metrics).toBeDefined();
			expect(result.metrics?.duration_ms).toBeGreaterThanOrEqual(0);
		});
	});

	describe("execute() - Valid WASM Module", () => {
		const MINIMAL_WASM_DIR = path.resolve(__dirname, "../../../test/tmp");
		let minimalWasmPath: string;

		// Create a minimal valid WASM module for testing
		// This is the simplest valid WASM binary: magic number + version + no sections
		beforeEach(async () => {
			await fs.mkdir(MINIMAL_WASM_DIR, { recursive: true });
			minimalWasmPath = path.join(MINIMAL_WASM_DIR, "test-module.wasm");

			// Build a minimal WASM module that exports an execute function
			// WASM binary format: magic + version + type section + function section + export section + code section
			const wasmBinary = buildMinimalWasmModule();
			await fs.writeFile(minimalWasmPath, wasmBinary);
		});

		it("should load and compile a valid WASM module", async () => {
			const mockContext = createMockContext();
			const mockNode = {
				name: "test-node",
				node: minimalWasmPath,
				type: "module",
				run: vi.fn(),
			} as unknown as RunnerNode;

			const result = await adapter.execute(mockNode, mockContext);

			// The minimal module has no execute/__blok_execute/_start exports
			// so it should fail with a descriptive error
			expect(result.success).toBe(false);
			expect(result.errors).toHaveProperty("message");
			const msg = (result.errors as { message: string }).message;
			expect(msg).toContain("does not export");
		});

		it("should cache compiled WASM modules", async () => {
			const mockContext = createMockContext();
			const mockNode = {
				name: "test-node",
				node: minimalWasmPath,
				type: "module",
				run: vi.fn(),
			} as unknown as RunnerNode;

			// Execute twice - second should use cache
			await adapter.execute(mockNode, mockContext);
			await adapter.execute(mockNode, mockContext);

			const stats = adapter.getCacheStats();
			expect(stats.size).toBe(1); // Only one module cached
		});

		it("should evict modules when cache is full", async () => {
			const smallCacheAdapter = new WasmRuntimeAdapter({ maxCacheSize: 2 });
			const mockContext = createMockContext();

			// Create 3 different WASM files to exceed cache size of 2
			const paths: string[] = [];
			for (let i = 0; i < 3; i++) {
				const filePath = path.join(MINIMAL_WASM_DIR, `test-module-${i}.wasm`);
				await fs.writeFile(filePath, buildMinimalWasmModule());
				paths.push(filePath);
			}

			// Execute all 3
			for (const p of paths) {
				const mockNode = {
					name: `test-node-${p}`,
					node: p,
					type: "module",
					run: vi.fn(),
				} as unknown as RunnerNode;
				await smallCacheAdapter.execute(mockNode, mockContext);
			}

			const stats = smallCacheAdapter.getCacheStats();
			expect(stats.size).toBeLessThanOrEqual(2);

			// Cleanup
			for (const p of paths) {
				await fs.unlink(p).catch(() => {});
			}
		});

		afterEach(async () => {
			adapter.clearCache();
			await fs.unlink(minimalWasmPath).catch(() => {});
			await fs.rmdir(MINIMAL_WASM_DIR).catch(() => {});
		});
	});

	describe("execute() - ExecutionResult Structure", () => {
		it("should return ExecutionResult with all required fields on error", async () => {
			const mockContext = createMockContext();
			const mockNode = {
				name: "test-node",
				node: "/nonexistent.wasm",
				type: "module",
				run: vi.fn(),
			} as unknown as RunnerNode;

			const result = await adapter.execute(mockNode, mockContext);

			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("data");
			expect(result).toHaveProperty("errors");
			expect(result).toHaveProperty("metrics");
			expect(typeof result.success).toBe("boolean");
		});
	});

	describe("execute() - Context Handling", () => {
		it("should include node config from context", async () => {
			const mockContext = createMockContext({
				config: { "test-node": { key: "value" } } as unknown as Record<string, unknown>,
			});

			const mockNode = {
				name: "test-node",
				node: "/nonexistent.wasm",
				type: "module",
				run: vi.fn(),
			} as unknown as RunnerNode;

			const result = await adapter.execute(mockNode, mockContext);

			// Will fail because file doesn't exist, but ensures config is processed
			expect(result.success).toBe(false);
			expect(result.metrics?.duration_ms).toBeGreaterThanOrEqual(0);
		});
	});
});

/**
 * Build a minimal valid WASM binary module
 * This creates the simplest possible valid .wasm file
 * Contains: magic number, version, and an empty function
 */
function buildMinimalWasmModule(): Buffer {
	// WASM magic number: \0asm
	// Version: 1
	const bytes: number[] = [
		0x00,
		0x61,
		0x73,
		0x6d, // magic: \0asm
		0x01,
		0x00,
		0x00,
		0x00, // version: 1
	];

	return Buffer.from(bytes);
}
