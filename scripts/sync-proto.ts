#!/usr/bin/env bun
/**
 * Single source of truth for the gRPC runtime contract.
 *
 * `proto/blok/runtime/v1/runtime.proto` is canonical. Every SDK + the runner's
 * adapter keep a copy at their own path (their build/codegen reads it from
 * there — rust/java/csharp regenerate at build, go/python/ruby commit generated
 * code). Hand-copying drifted historically; this script makes the copies a
 * mechanical projection of the canonical file.
 *
 *   bun scripts/sync-proto.ts          # copy canonical → all consumers
 *   bun scripts/sync-proto.ts --check  # fail (exit 1) if any copy drifts
 *
 * The --check form runs in CI (integration.yml) so a manual edit to any copy —
 * the exact rot that silently breaks one runtime — fails the PR.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CANONICAL = "proto/blok/runtime/v1/runtime.proto";

// Every consumer's copy of the runtime proto. Paths are where each build/codegen
// expects it (java nests under src/main/proto; the runner under its adapter).
const CONSUMERS = [
	"core/runner/src/adapters/grpc/proto/blok/runtime/v1/runtime.proto",
	"sdks/go/proto/blok/runtime/v1/runtime.proto",
	"sdks/rust/proto/blok/runtime/v1/runtime.proto",
	"sdks/java/src/main/proto/blok/runtime/v1/runtime.proto",
	"sdks/csharp/proto/blok/runtime/v1/runtime.proto",
	"sdks/python3/proto/blok/runtime/v1/runtime.proto",
	"sdks/ruby/proto/blok/runtime/v1/runtime.proto",
	"sdks/php/proto/blok/runtime/v1/runtime.proto",
];

const check = process.argv.includes("--check");
const canonical = readFileSync(join(ROOT, CANONICAL), "utf8");

const drifted: string[] = [];
for (const rel of CONSUMERS) {
	const abs = join(ROOT, rel);
	if (check) {
		const current = existsSync(abs) ? readFileSync(abs, "utf8") : null;
		if (current !== canonical) drifted.push(rel);
	} else {
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, canonical);
		console.log(`  synced ${rel}`);
	}
}

if (check) {
	if (drifted.length > 0) {
		console.error(`Proto drift: ${drifted.length} copy(ies) differ from ${CANONICAL}:`);
		for (const d of drifted) console.error(`  ✗ ${d}`);
		console.error(`\nFix: edit ${CANONICAL} only, then run \`bun run proto:sync\`.`);
		process.exit(1);
	}
	console.log(`Proto in sync: ${CONSUMERS.length} copies match ${CANONICAL}.`);
} else {
	console.log(`Synced ${CONSUMERS.length} copies from ${CANONICAL}.`);
}
