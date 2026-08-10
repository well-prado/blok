import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HONO_NODE_SERVER_RANGE, generateCronServerFile } from "../../../src/commands/create/project.js";

/**
 * #741 — the fast-lane half of the `@hono/node-server` gate.
 *
 * `tests/e2e/scaffold-smoke/combos.sh` proves the real thing (npm actually
 * installs every trigger combination), but it costs a full CI job. This is the
 * second-of-runtime drift guard for the same invariant: the range the scaffold
 * INJECTS for sse/websocket must equal the range the trigger packages depend on
 * and the range the http template pins via `overrides`.
 *
 * When they drifted (`^1.19.9` injected vs `^2.0.11` overridden), npm refused
 * every `http+sse` / `http+websocket` scaffold with
 * `EOVERRIDE — Override for @hono/node-server@^1.19.9 conflicts with direct
 * dependency`. bun installed it happily, which is why it survived to a release.
 */
const REPO_ROOT = resolve(__dirname, "../../../../..");

function manifest(pkgDir: string): Record<string, Record<string, string> | undefined> {
	return JSON.parse(readFileSync(join(REPO_ROOT, pkgDir, "package.json"), "utf8"));
}

describe("@hono/node-server pin (#741)", () => {
	// Every package that declares the dep at all. A new one that picks a
	// different major fails here rather than in a user's `npm install`.
	for (const pkgDir of ["triggers/http", "triggers/sse", "triggers/mcp", "triggers/webhook"]) {
		it(`${pkgDir} declares the same range the scaffold injects`, () => {
			const pkg = manifest(pkgDir);
			const declared = pkg.dependencies?.["@hono/node-server"] ?? pkg.devDependencies?.["@hono/node-server"];
			expect(declared, `${pkgDir} no longer declares @hono/node-server — drop it from this list`).toBe(
				HONO_NODE_SERVER_RANGE,
			);
		});
	}

	it("the http template's overrides pin matches too (npm EOVERRIDE guard)", () => {
		const pkg = manifest("triggers/http");
		expect(pkg.overrides?.["@hono/node-server"]).toBe(HONO_NODE_SERVER_RANGE);
	});

	it("the generated CronServer types nodes as NodeBase, not BlokService", () => {
		// Same #741 batch: `Record<string, BlokService<unknown>>` is narrower than
		// the `Record<string, NodeBase>` the generated Nodes.ts exports, so every
		// scaffold with a cron/pubsub/worker trigger failed its own `tsc`.
		const out = generateCronServerFile();
		expect(out).toContain('protected nodes: Record<string, import("@blokjs/shared").NodeBase> = nodes;');
		expect(out).not.toContain("BlokService");
	});
});
