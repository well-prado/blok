/**
 * Importing the engine must not touch the filesystem (#688).
 *
 * `GrpcCodec` used to `loadSync()` `runtime.proto` at module top level, and it
 * sits on the import chain of `@blokjs/core/testing` (WorkflowTestRunner →
 * Configuration → GrpcRuntimeAdapter → here). Every consumer unit test paid for
 * a proto parse it never used, and any environment where the `.proto` is not
 * where `import.meta.url` says it is — bundled, sandboxed, relocated dist —
 * failed at import with no gRPC anywhere in sight.
 *
 * The probe runs in a CHILD process so the module graph is cold, and it is
 * self-validating: it asserts the `.proto` read is blocked when something DOES
 * ask for it, so a guard that silently stopped working cannot pass this test.
 *
 * The PUBLISHED entrypoints (`@blokjs/core`, `@blokjs/core/testing`,
 * `@blokjs/runner`) get the same probe against real installed tarballs under
 * Node in `tests/e2e/node-consumer`.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RUNNER_SRC = join(dirname(fileURLToPath(import.meta.url)), "../../src");

const probe = `
import fs from "node:fs";
const real = fs.readFileSync;
fs.readFileSync = (p, ...rest) => {
	if (typeof p === "string" && p.endsWith(".proto")) throw new Error("PROTO_READ");
	return real(p, ...rest);
};

// The exact chain from the report: testing barrel → WorkflowTestRunner →
// Configuration → GrpcRuntimeAdapter → GrpcCodec.
await import(${JSON.stringify(`${RUNNER_SRC}/testing/index.ts`)});
await import(${JSON.stringify(`${RUNNER_SRC}/Configuration.ts`)});

// The guard must actually bite — otherwise the imports above proved nothing.
let guarded = false;
try {
	const codec = await import(${JSON.stringify(`${RUNNER_SRC}/adapters/grpc/GrpcCodec.ts`)});
	codec.getNodeRuntimeService();
} catch (error) {
	guarded = /PROTO_READ/.test(String(error));
}
console.log(JSON.stringify({ imported: true, guarded }));
`;

describe("import side effects", () => {
	it("loads @blokjs/runner and its testing surface without reading any .proto", () => {
		const result = spawnSync("bun", ["-e", probe], { encoding: "utf8" });

		expect(result.stderr, "importing the engine performed filesystem work at module top level").not.toMatch(
			/PROTO_READ/,
		);
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toEqual({ imported: true, guarded: true });
	});
});
