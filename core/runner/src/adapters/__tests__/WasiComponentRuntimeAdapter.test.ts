import type { Context, WasiComponentExecutionRequest, WasiComponentReadiness } from "@blokjs/shared";
import { ErrorCategory } from "@blokjs/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockContext, createMockRunnerNode } from "../../../test/helpers/test-utils";
import type RunnerNode from "../../RunnerNode";
import { type WasiComponentHost, WasiComponentRuntimeAdapter } from "../WasiComponentRuntimeAdapter";

const manifest = {
	version: "1" as const,
	runtime: "runtime.wasi" as const,
	artifact: {
		uri: "./components/greet.wasm",
		digest: `sha256:${"a".repeat(64)}`,
		mediaType: "application/wasm-component" as const,
	},
	world: { package: "blok:runtime" as const, world: "blok-node" as const, version: "1.0.0" },
	wasiVersion: "0.2" as const,
	componentModelVersion: "0.2" as const,
	exportName: "execute",
	node: { name: "typed-greet" },
	capabilityManifest: {
		version: "1" as const,
		classification: "agent-compatible" as const,
		effects: [],
		capabilities: [],
		secrets: [],
		determinism: "deterministic" as const,
		idempotency: "idempotent" as const,
		maturity: "stable" as const,
	},
	limits: { maxDurationMs: 1_000 },
};

function host(overrides: Partial<WasiComponentHost> = {}): WasiComponentHost {
	return {
		endpoint: "127.0.0.1:10008",
		readiness: vi.fn<() => Promise<WasiComponentReadiness>>().mockResolvedValue({
			status: "ready",
			contractVersion: "1",
		}),
		execute: vi.fn().mockResolvedValue({
			contractVersion: "1",
			success: true,
			output: { greeting: "hello" },
			logs: [{ level: "info", message: "component ran" }],
		}),
		...overrides,
	};
}

function node(overrides: Partial<RunnerNode> = {}): RunnerNode {
	return createMockRunnerNode({
		name: "typed-greet",
		node: "typed-greet",
		type: "runtime.wasi",
		runtime: "wasi",
		wasiComponent: manifest,
		...overrides,
	});
}

describe("WasiComponentRuntimeAdapter", () => {
	afterEach(() => vi.restoreAllMocks());

	it("has a distinct runtime identity and reports an absent host as unavailable", async () => {
		const adapter = new WasiComponentRuntimeAdapter();

		expect(adapter.kind).toBe("wasi");
		expect(adapter.transport).toBe("grpc");
		expect(await adapter.readiness()).toMatchObject({ status: "unavailable", contractVersion: "1" });
	});

	it("fails closed when no host is configured", async () => {
		const result = await new WasiComponentRuntimeAdapter().execute(node(), createMockContext());

		expect(result.success).toBe(false);
		expect(result.errors).toMatchObject({ errorCode: "WASI_COMPONENT_HOST_NOT_CONFIGURED" });
	});

	it("validates the manifest, capability approval, and typed response at the boundary", async () => {
		const runtimeHost = host();
		const context = createMockContext({ config: { "typed-greet": { inputs: { name: "Ada" } } } });
		const result = await new WasiComponentRuntimeAdapter({ host: runtimeHost }).execute(node(), context);

		expect(result).toMatchObject({ success: true, data: { greeting: "hello" }, logs: ["[info] component ran"] });
		expect(vi.mocked(runtimeHost.execute)).toHaveBeenCalledWith(
			expect.objectContaining({
				contractVersion: "1",
				componentDigest: manifest.artifact.digest,
				exportName: "execute",
				input: { name: "Ada" },
			}),
			expect.any(AbortSignal),
		);
	});

	it("denies undeclared host authority before calling the host", async () => {
		const runtimeHost = host();
		const component = {
			...manifest,
			capabilityManifest: { ...manifest.capabilityManifest, capabilities: ["wasi.net.connect"] },
		};
		const result = await new WasiComponentRuntimeAdapter({ host: runtimeHost }).execute(
			node({ wasiComponent: component }),
			createMockContext(),
		);

		expect(result.success).toBe(false);
		expect(result.errors).toMatchObject({
			errorCode: "WASI_COMPONENT_CAPABILITY_DENIED",
			category: ErrorCategory.PERMISSION,
		});
		expect(runtimeHost.execute).not.toHaveBeenCalled();
	});

	it("does not admit work while the host is draining", async () => {
		const runtimeHost = host({
			readiness: vi.fn().mockResolvedValue({ status: "draining", contractVersion: "1" }),
		});
		const result = await new WasiComponentRuntimeAdapter({ host: runtimeHost }).execute(node(), createMockContext());

		expect(result.errors).toMatchObject({
			errorCode: "WASI_COMPONENT_HOST_NOT_READY",
			category: ErrorCategory.DEPENDENCY,
		});
		expect(runtimeHost.execute).not.toHaveBeenCalled();
	});

	it("maps a structured component error without changing its stable category", async () => {
		const runtimeHost = host({
			execute: vi.fn().mockResolvedValue({
				contractVersion: "1",
				success: false,
				output: null,
				logs: [],
				error: { code: "WASI_INPUT_INVALID", category: "VALIDATION", message: "bad input", retryable: false },
			}),
		});
		const result = await new WasiComponentRuntimeAdapter({ host: runtimeHost }).execute(node(), createMockContext());

		expect(result.success).toBe(false);
		expect(result.errors).toMatchObject({ errorCode: "WASI_INPUT_INVALID", category: ErrorCategory.VALIDATION });
	});

	it("propagates cancellation to the host and returns a cancellation error", async () => {
		const controller = new AbortController();
		const runtimeHost = host({
			execute: vi.fn(
				(_request: WasiComponentExecutionRequest, signal: AbortSignal) =>
					new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(new Error("host observed cancellation")), { once: true });
					}),
			),
		});
		const context: Context = createMockContext({ signal: controller.signal });
		const pending = new WasiComponentRuntimeAdapter({ host: runtimeHost }).execute(node(), context);
		await Promise.resolve();
		await Promise.resolve();
		expect(runtimeHost.execute).toHaveBeenCalledOnce();
		controller.abort();
		const result = await pending;

		expect(result.errors).toMatchObject({ errorCode: "WASI_COMPONENT_CANCELLED", category: ErrorCategory.CANCELLED });
	});

	it("closes the underlying host during lifecycle shutdown", async () => {
		const close = vi.fn();
		const adapter = new WasiComponentRuntimeAdapter({ host: host({ close }) });

		await adapter.close();
		expect(close).toHaveBeenCalledOnce();
	});
});
