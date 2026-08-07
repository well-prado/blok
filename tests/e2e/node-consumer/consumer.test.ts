/**
 * The downstream-consumer acceptance test for #687.
 *
 * Runs under vitest on Node — NOT Bun — against the packed `@blokjs/*`
 * tarballs, with an empty `vitest.config.ts`. Every import below goes through
 * Node's native ESM loader, so an extensionless relative specifier anywhere in
 * the dependency graph fails this file with `ERR_MODULE_NOT_FOUND`.
 *
 * Keep it trivial. It is a packaging probe, not a feature test — the real DSL
 * and harness coverage lives in the monorepo.
 */
import { spawnSync } from "node:child_process";
import { http, defineNode, step, workflow } from "@blokjs/core";
import { NodeTestHarness, runNode, runWorkflow } from "@blokjs/core/testing";
import { Runner } from "@blokjs/runner";
import { z } from "zod";
import { describe, expect, it } from "./test-runner";

const greet = defineNode({
	name: "greet",
	description: "Greets whoever is passed in.",
	input: z.object({ who: z.string() }),
	output: z.object({ message: z.string() }),
	execute: (_ctx, input) => ({ message: `hello ${input.who}` }),
});

describe("@blokjs packages load under Node's ESM loader", () => {
	it("exposes the authoring surface, the harness, and the engine", () => {
		expect(typeof workflow).toBe("function");
		expect(typeof step).toBe("function");
		expect(typeof http.post).toBe("function");
		expect(typeof NodeTestHarness).toBe("function");
		expect(typeof runNode).toBe("function");
		expect(typeof runWorkflow).toBe("function");
		expect(typeof Runner).toBe("function");
	});

	/**
	 * #688 — importing any published entrypoint must do NO filesystem work.
	 *
	 * The probe blocks `.proto` reads, imports all three entrypoints, and then
	 * proves the block actually bites by asking for the gRPC service on purpose.
	 * A future top-level `loadSync` fails on the import, not on the assertion.
	 */
	it("performs no top-level filesystem work on import", () => {
		const probe = `
			import fs from "node:fs";
			const real = fs.readFileSync;
			fs.readFileSync = (p, ...rest) => {
				if (typeof p === "string" && p.endsWith(".proto")) throw new Error("PROTO_READ");
				return real(p, ...rest);
			};
			await import("@blokjs/core");
			await import("@blokjs/core/testing");
			await import("@blokjs/runner");
			let guarded = false;
			try {
				const codec = await import("@blokjs/runner/adapters/grpc/GrpcCodec");
				codec.getNodeRuntimeService();
			} catch (error) {
				guarded = /PROTO_READ/.test(String(error));
			}
			console.log(JSON.stringify({ guarded }));
		`;
		const result = spawnSync("node", ["--input-type=module", "-e", probe], { encoding: "utf8" });

		expect(result.stderr).not.toMatch(/PROTO_READ/);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toEqual({ guarded: true });
	});

	it("runs a node through the published test harness", async () => {
		const harness = new NodeTestHarness(greet);
		const result = await harness.execute({ who: "node" });
		expect(result.success).toBe(true);
		expect(result.data).toEqual({ message: "hello node" });
	});
});
