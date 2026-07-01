import { describe, expect, it } from "vitest";
import { generateTriggerEntryFile } from "../../../src/commands/create/project";

/**
 * Regression (#643): a `--triggers grpc` scaffold used to hit the generic
 * `generateTriggerEntryFile` fallback (`console.log("grpc trigger not yet
 * implemented")`), so `blokctl dev` never booted a gRPC server. The scaffold
 * now boots @blokjs/trigger-grpc's GrpcServer with the project's own
 * Nodes/Workflows injected (the package was refactored to accept them).
 */
describe("grpc trigger scaffold (#643)", () => {
	it("generateTriggerEntryFile('grpc') boots GrpcServer with injected nodes + workflows", () => {
		const out = generateTriggerEntryFile("grpc");
		expect(out).not.toContain("not yet implemented");
		expect(out).toContain('import { GrpcServer } from "@blokjs/trigger-grpc"');
		expect(out).toContain('import nodes from "../../Nodes"');
		expect(out).toContain('import workflows from "../../Workflows"');
		expect(out).toContain("new GrpcServer({ host, port, nodes, workflows }).start()");
		expect(out).toContain('if (process.env.DISABLE_TRIGGER_RUN !== "true")');
	});

	it("reads GRPC_PORT/GRPC_HOST, falling back through PORT", () => {
		const out = generateTriggerEntryFile("grpc");
		expect(out).toContain("process.env.GRPC_PORT || process.env.PORT");
		expect(out).toContain("process.env.GRPC_HOST");
	});
});
