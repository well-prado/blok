import type { Context } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import Configuration from "../src/Configuration";
import NodeMap from "../src/NodeMap";
import type RunnerNode from "../src/RunnerNode";
import { RuntimeRegistry } from "../src/RuntimeRegistry";
import { defineNode } from "../src/defineNode";
import type GlobalOptions from "../src/types/GlobalOptions";
import { createMockContext } from "../test/helpers/test-utils";

const portableNode = defineNode({
	name: "portable-runtime-fixture",
	input: z.object({ value: z.string() }),
	output: z.object({ value: z.string() }),
	execute: async (_ctx, input) => input,
});

class TestConfiguration extends Configuration {
	setNodes(nodes: NodeMap): void {
		this.globalOptions = { nodes } as GlobalOptions;
	}

	resolve(node: RunnerNode): Promise<RunnerNode> {
		return this.runtimeResolver(node);
	}
}

function context(): Context {
	return createMockContext({
		config: { run: { inputs: { value: "portable" } } },
	});
}

async function resolveStep(kind: "nodejs" | "bun" | "deno"): Promise<RunnerNode> {
	const nodes = new NodeMap();
	nodes.addNode(portableNode.name, portableNode);
	const config = new TestConfiguration();
	config.setNodes(nodes);
	const step = {
		name: "run",
		node: portableNode.name,
		type: `runtime.${kind}`,
	} as RunnerNode;
	return config.resolve(step);
}

async function execute(kind: "nodejs" | "bun"): Promise<unknown> {
	return (await resolveStep(kind)).run(context());
}

describe("JavaScript runtime resolution", () => {
	beforeEach(() => {
		RuntimeRegistry.getInstance().clear();
		// Keep the background health probe out of the test process; the gRPC
		// adapters registered for the out-of-process targets would otherwise
		// leak timers.
		vi.stubEnv("BLOK_GRPC_HEALTH_INTERVAL_MS", "0");
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("executes a registered portable node through runtime.nodejs", async () => {
		await expect(execute("nodejs")).resolves.toMatchObject({ success: true, data: { value: "portable" } });
	});

	it("executes runtime.bun in-process on a Bun host", async () => {
		vi.stubGlobal("Bun", {});
		await expect(execute("bun")).resolves.toMatchObject({ success: true, data: { value: "portable" } });
	});

	it("routes runtime.bun to the persistent worker when the host is not Bun", async () => {
		const step = await resolveStep("bun");
		expect((step as unknown as { transport: string }).transport).toBe("grpc");
		expect(RuntimeRegistry.getInstance().get("bun").endpoint).toBe("localhost:10013");
	});

	it("routes runtime.nodejs to the persistent worker when the host is not Node.js", async () => {
		vi.stubGlobal("Bun", {});
		const step = await resolveStep("nodejs");
		expect((step as unknown as { transport: string }).transport).toBe("grpc");
		expect(RuntimeRegistry.getInstance().get("nodejs").endpoint).toBe("localhost:10012");
	});

	it("always routes runtime.deno to the persistent worker", async () => {
		const step = await resolveStep("deno");
		expect((step as unknown as { transport: string }).transport).toBe("grpc");
		expect(RuntimeRegistry.getInstance().get("deno").endpoint).toBe("localhost:10014");
	});

	it("honours a per-kind port override without touching the other targets", async () => {
		vi.stubEnv("RUNTIME_DENO_GRPC_PORT", "20014");
		await resolveStep("deno");
		expect(RuntimeRegistry.getInstance().get("deno").endpoint).toBe("localhost:20014");
		expect(RuntimeRegistry.getInstance().get("bun").endpoint).toBe("localhost:10013");
	});

	it("fails closed with worker remediation when the worker is unreachable", async () => {
		const step = await resolveStep("deno");
		const result = (await step.run(context())) as { success: boolean; error: { message: string } | null };
		expect(result.success).toBe(false);
		// No silent fallback to Node.js: the step fails, naming the worker.
		expect(result.error?.message ?? "").not.toContain("portable");
	});
});
