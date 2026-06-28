/**
 * Guard the `@blokjs/runner/dsl` tree-shaking boundary.
 *
 * `@blokjs/core`'s light `.` entry re-exports from `./dsl`, which must NOT pull
 * the runner's heavy graph (grpc / otel SDK+exporters / better-sqlite3 / the
 * tracing+monitoring subsystems). If someone re-points dsl.ts at `./index` (the
 * heavy barrel) the win silently regresses — this walks the source-level import
 * closure of dsl.ts and fails if any heavy module becomes reachable.
 *
 * `@opentelemetry/api` is allowed: it's the light no-op tracer API that the node
 * base class (Blok) imports; it carries no native bindings, grpc, or SDK.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../src");

const HEAVY = [
	/@grpc\//,
	/better-sqlite3/,
	/@opentelemetry\/(sdk|exporter|resources|semantic-conventions)/,
	/\badapters\/grpc\b/,
	/\/tracing\//,
	/\/monitoring\//,
];

/** BFS the relative-import closure of a source file within src/. */
function closure(entry: string): { files: Set<string>; offenders: string[] } {
	const files = new Set<string>();
	const offenders: string[] = [];
	const queue = [entry];
	while (queue.length) {
		const file = queue.pop() as string;
		if (files.has(file)) continue;
		files.add(file);
		let src: string;
		try {
			src = readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		for (const m of src.matchAll(/from\s+"([^"]+)"/g)) {
			const spec = m[1];
			if (HEAVY.some((re) => re.test(spec))) offenders.push(`${file.replace(SRC, "")} -> ${spec}`);
			if (spec.startsWith(".")) queue.push(`${resolve(dirname(file), spec)}.ts`);
			// bare @blokjs/* (helper=zod-only, shared=no internal deps) are clean leaves; don't recurse.
		}
	}
	return { files, offenders };
}

describe("@blokjs/runner/dsl tree-shaking boundary", () => {
	it("the DSL closure pulls no grpc / otel-SDK / sqlite / tracing graph", () => {
		const { files, offenders } = closure(resolve(SRC, "dsl.ts"));
		expect(offenders, `heavy imports reachable from dsl.ts:\n${offenders.join("\n")}`).toEqual([]);
		// Sanity: the closure is small (DSL modules only), not the whole runner.
		expect(files.size).toBeLessThan(15);
	});
});
