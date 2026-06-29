/**
 * #359 — a generated `runtimeNode` stub (from `blokctl nodes sync`, #358)
 * resolves through the REAL inference + resolution path to the correct runtime
 * adapter, AND its `use` ref / typing matches what the manifest carries.
 *
 * Two halves, both anchored to production code (no re-implemented dispatch):
 *
 * 1. RESOLUTION — feed a generated stub's `use` ref (`runtime.<kind>:<name>`)
 *    through `normalizeWorkflow` (the same `inferStepType` path a loaded
 *    workflow takes) and assert the step's inferred `type` is `runtime.<kind>`;
 *    then resolve that step through the REAL `Configuration.nodeResolver` →
 *    `runtimeResolver`, which dispatches to a uniquely-tagged mock adapter in
 *    `RuntimeRegistry`. The resolved `RuntimeAdapterNode` mirrors the adapter's
 *    `transport` + `runtime`, so a per-test sentinel proves the RIGHT adapter
 *    was selected (not just "some adapter"). Reuses the #352 `TestConfiguration`
 *    harness shape (exposes the protected `nodeResolver`).
 *
 * 2. TYPING — assert the `syncNodes` generator output (`generateRuntimeStubs`):
 *    a node WITH a JSON schema yields a typed `runtimeNode<{...}, {...}>(...)`
 *    factory; a NULL-schema node yields `runtimeNode<unknown, unknown>(...)`.
 *    Plus the manifest-edge cases the issue calls out (collision across two
 *    runtimes, empty manifest, byte-stable regeneration).
 *
 * MUTATION GUARD: drop the `runtime.` prefix in `inferStepType`, or break the
 * `runtimeResolver` kind-derivation / the `unknown` null-schema fallback, and a
 * row here fails.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The `blokctl` CLI package isn't linked into core/runner's node_modules — reach
// the generator by relative path, mirroring how the #352 net imports the corpus.
import type { NodeEntry } from "../../../../packages/cli/src/commands/nodes/listNodes.ts";
import { generateRuntimeStubs } from "../../../../packages/cli/src/commands/nodes/syncNodes.ts";
import Configuration from "../../src/Configuration";
import type RunnerNode from "../../src/RunnerNode";
import { RuntimeRegistry } from "../../src/RuntimeRegistry";
import type { ExecutionResult, RuntimeAdapter, RuntimeKind } from "../../src/adapters/RuntimeAdapter";
import { normalizeWorkflow } from "../../src/workflow/WorkflowNormalizer";

// Same shape as the #352 regression net: expose the protected resolver chain
// without re-implementing dispatch. `nodeResolver` routes `type: "runtime.*"`
// → `runtimeResolver` exactly as a loaded workflow does.
class TestConfiguration extends Configuration {
	public resolve(node: RunnerNode): Promise<RunnerNode> {
		return this.nodeResolver(node);
	}
}

const ok: ExecutionResult = { success: true, data: { ok: true }, errors: null };

/**
 * A minimal adapter tagged with the sentinel `transport: "http"` — a value the
 * auto-provisioned `GrpcRuntimeAdapter` NEVER carries (it's always `"grpc"`).
 * The resolved `RuntimeAdapterNode` mirrors `adapter.transport`, so seeing
 * `"http"` on the resolved node proves the resolver dispatched to THIS mock and
 * not the default gRPC adapter `Configuration` would otherwise build.
 */
function makeMock(kind: RuntimeKind): RuntimeAdapter {
	return { kind, transport: "http", execute: async () => ok } as unknown as RuntimeAdapter;
}

/** Normalize a one-step workflow whose `use` is the generated stub ref, then
 * hand the normalized step to the real resolver. */
async function resolveStubRef(config: TestConfiguration, ref: string): Promise<RunnerNode> {
	const wf = normalizeWorkflow({
		name: "stub-resolves",
		steps: [{ id: "call", use: ref }],
	});
	const step = wf.steps[0] as unknown as RunnerNode;
	return config.resolve(step);
}

/**
 * Pre-seed the registry with sentinel mocks for the given kinds, THEN construct
 * Configuration. `initializeRuntimeRegistry` guards every kind with
 * `if (registry.has(kind)) continue`, so a pre-registered mock is the intended
 * override seam — Configuration won't clobber it with a real gRPC adapter (which
 * would need a live SDK). Returns the wired-up config.
 */
function configWithMocks(...kinds: RuntimeKind[]): TestConfiguration {
	RuntimeRegistry.getInstance().clear();
	for (const kind of kinds) RuntimeRegistry.getInstance().register(makeMock(kind));
	return new TestConfiguration();
}

describe("generated runtimeNode stub resolves via runtimeResolver (#359)", () => {
	beforeEach(() => {
		RuntimeRegistry.getInstance().clear();
	});

	afterEach(() => {
		RuntimeRegistry.getInstance().clear();
	});

	describe("resolution through the real inference + resolution path", () => {
		it("infers `runtime.<kind>` from the stub's `use` ref (inferStepType)", () => {
			const wf = normalizeWorkflow({
				name: "infer",
				steps: [{ id: "call", use: "runtime.python3:foo" }],
			});
			// The `use` ref alone — no explicit `type` — drives the type. This is the
			// contract #358 promised: the stub's ref is consistent with inferStepType.
			expect(wf.steps[0].type).toBe("runtime.python3");
			expect(wf.steps[0].node).toBe("runtime.python3:foo");
		});

		it("resolves `runtime.python3:foo` to the python3 adapter", async () => {
			const config = configWithMocks("python3");

			const resolved = await resolveStubRef(config, "runtime.python3:foo");

			expect(resolved).toBeDefined();
			expect(resolved.type).toBe("runtime.python3");
			// RuntimeAdapterNode mirrors the chosen adapter — `runtime` + the
			// sentinel `transport` together prove the resolver reached THIS python3
			// mock, not the default gRPC adapter.
			expect(resolved.runtime).toBe("python3");
			expect((resolved as RunnerNode & { transport?: string }).transport).toBe("http");
		});

		it("routes a different kind to its OWN registered adapter (no cross-talk)", async () => {
			// Both kinds carry the sentinel transport; the discriminator is `runtime`.
			// The `go` stub must land on the `go` mock, the python3 stub on python3.
			const config = configWithMocks("python3", "go");

			const py = await resolveStubRef(config, "runtime.python3:foo");
			const go = await resolveStubRef(config, "runtime.go:bar");

			expect(py.runtime).toBe("python3");
			expect((py as RunnerNode & { transport?: string }).transport).toBe("http");
			expect(go.runtime).toBe("go");
			expect((go as RunnerNode & { transport?: string }).transport).toBe("http");
		});

		it("THROWS on a `runtime.<kind>` the dispatch map doesn't know (negative)", async () => {
			// `nodeResolver` only routes the supported `runtime.*` kinds (Configuration
			// .nodeTypes()). An unsupported kind has no resolver entry — the dispatch
			// throws rather than silently building a stub. Guards the prefix→kind map.
			const config = configWithMocks("python3");
			await expect(resolveStubRef(config, "runtime.cobol:nope")).rejects.toThrow(/Node type runtime\.cobol not found/);
		});
	});

	describe("generator output: typed handle vs unknown fallback (matches manifest)", () => {
		const ref = (kind: string, name: string): string => `${kind}:${name}`;

		it("a node WITH a JSON schema yields a typed runtimeNode<In, Out>", () => {
			const manifest: NodeEntry[] = [
				{
					name: "ask",
					ref: ref("runtime.python3", "ask"),
					runtime: "python3",
					inputSchema: {
						type: "object",
						properties: { prompt: { type: "string" } },
						required: ["prompt"],
					},
					outputSchema: {
						type: "object",
						properties: { answer: { type: "string" } },
						required: ["answer"],
					},
				},
			];
			const file = generateRuntimeStubs(manifest).get("python3.ts");
			expect(file).toBeDefined();
			// Typed both sides; carries the canonical resolvable ref.
			expect(file).toContain('runtimeNode<{ prompt: string }, { answer: string }>("ask", "runtime.python3:ask")');
			// NOT the unknown fallback.
			expect(file).not.toContain("runtimeNode<unknown, unknown>");
		});

		it("a NULL-schema node yields the marked runtimeNode<unknown, unknown> fallback", () => {
			const manifest: NodeEntry[] = [
				{
					name: "opaque",
					ref: ref("runtime.go", "opaque"),
					runtime: "go",
					inputSchema: null,
					outputSchema: null,
				},
			];
			const file = generateRuntimeStubs(manifest).get("go.ts");
			expect(file).toBeDefined();
			expect(file).toContain('runtimeNode<unknown, unknown>("opaque", "runtime.go:opaque")');
		});

		it("the SAME node typed vs null-schema differ ONLY in the type params", () => {
			const typed = generateRuntimeStubs([
				{
					name: "x",
					ref: ref("runtime.go", "x"),
					runtime: "go",
					inputSchema: { type: "object", properties: { a: { type: "number" } }, required: ["a"] },
					outputSchema: { type: "string" },
				},
			]).get("go.ts");
			const untyped = generateRuntimeStubs([
				{ name: "x", ref: ref("runtime.go", "x"), runtime: "go", inputSchema: null, outputSchema: null },
			]).get("go.ts");

			expect(typed).toContain("runtimeNode<{ a: number }, string>");
			expect(untyped).toContain("runtimeNode<unknown, unknown>");
			// Both point at the same resolvable ref — only the typing differs.
			expect(typed).toContain('"runtime.go:x"');
			expect(untyped).toContain('"runtime.go:x"');
		});
	});

	describe("manifest edge cases", () => {
		it("empty manifest → no stub files", () => {
			expect(generateRuntimeStubs([]).size).toBe(0);
		});

		it("module nodes are NOT stubbed (imported directly)", () => {
			const files = generateRuntimeStubs([
				{
					name: "@blokjs/audit-log",
					ref: "@blokjs/audit-log",
					runtime: "module",
					inputSchema: null,
					outputSchema: null,
				},
			]);
			expect(files.size).toBe(0);
		});

		it("same node name across two runtimes → one stub per runtime, each with its own ref", () => {
			const files = generateRuntimeStubs([
				{ name: "echo", ref: "runtime.go:echo", runtime: "go", inputSchema: null, outputSchema: null },
				{ name: "echo", ref: "runtime.python3:echo", runtime: "python3", inputSchema: null, outputSchema: null },
			]);
			expect([...files.keys()].sort()).toEqual(["go.ts", "python3.ts"]);
			expect(files.get("go.ts")).toContain('"runtime.go:echo"');
			expect(files.get("python3.ts")).toContain('"runtime.python3:echo"');
		});

		it("regeneration is byte-stable (idempotent — no spurious diffs)", () => {
			const manifest: NodeEntry[] = [
				{ name: "b", ref: "runtime.go:b", runtime: "go", inputSchema: { type: "string" }, outputSchema: null },
				{ name: "a", ref: "runtime.go:a", runtime: "go", inputSchema: null, outputSchema: null },
			];
			const first = generateRuntimeStubs(manifest).get("go.ts");
			const second = generateRuntimeStubs([...manifest].reverse()).get("go.ts");
			// Same bytes regardless of input order — entries are sorted by name.
			expect(second).toBe(first);
		});
	});

	describe("round-trip: a typed stub's ref resolves to its runtime adapter", () => {
		it("the ref the generator emits is the ref runtimeResolver accepts", async () => {
			const config = configWithMocks("python3");

			// 1. Generate the stub from a manifest.
			const file = generateRuntimeStubs([
				{
					name: "ask",
					ref: "runtime.python3:ask",
					runtime: "python3",
					inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
					outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
				},
			]).get("python3.ts");

			// 2. Extract the ref the generator wrote into the factory call.
			const m = file?.match(/runtimeNode<[^>]*>\([^,]+,\s*"([^"]+)"\)/);
			const emittedRef = m?.[1];
			expect(emittedRef).toBe("runtime.python3:ask");

			// 3. That exact ref must resolve through the real path to the mock adapter.
			const resolved = await resolveStubRef(config, emittedRef as string);
			expect(resolved.runtime).toBe("python3");
			expect((resolved as RunnerNode & { transport?: string }).transport).toBe("http");
		});
	});
});
