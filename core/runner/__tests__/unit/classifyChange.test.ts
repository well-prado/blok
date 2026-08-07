/**
 * #692 — the dev-loop contract table, asserted row by row.
 *
 * This is the executable copy of the table in `docs/d/cli/dev.mdx`. Both
 * halves of the dev loop — the in-process `FileWatcher` and `blokctl dev`'s
 * restart watcher — route through `classifyChange`, so a change to the table
 * that isn't reflected here (or vice versa) fails the build rather than
 * silently letting the two watchers disagree.
 */

import { describe, expect, it } from "vitest";
import { classifyChange } from "../../src/hmr/classifyChange";

const roots = {
	workflowPaths: ["/app/workflows", "/app/src/workflows"],
	nodePaths: ["/app/src/nodes"],
	triggerPaths: ["/app/src/triggers"],
	runtimePaths: ["/app/runtimes/python3"],
};

describe("classifyChange — docs/d/cli/dev.mdx contract table", () => {
	const table: Array<[string, string, "hot" | "restart" | "regen" | "ignore"]> = [
		["workflow JSON", "/app/workflows/json/orders.json", "hot"],
		["workflow TS", "/app/src/workflows/orders.ts", "hot"],
		["node source", "/app/src/nodes/charge/index.ts", "hot"],
		["node helper", "/app/src/nodes/charge/util.js", "hot"],
		["trigger entrypoint", "/app/src/triggers/http/index.ts", "restart"],
		[".env", "/app/.env", "restart"],
		[".env.local", "/app/.env.local", "restart"],
		[".env.production", "/app/.env.production", "restart"],
		["project config", "/app/.blok/config.json", "restart"],
		["sidecar node source", "/app/runtimes/python3/nodes/score.py", "regen"],
		["generated stub", "/app/nodes-gen/runtime-go.ts", "ignore"],
		["generated runtime scaffold", "/app/.blok/runtimes/python3/server.py", "ignore"],
		["build output", "/app/src/nodes/charge/dist/index.js", "ignore"],
		["dependency", "/app/node_modules/left-pad/index.js", "ignore"],
		["type declaration", "/app/src/nodes/charge/index.d.ts", "ignore"],
		["test file", "/app/src/nodes/charge/index.test.ts", "ignore"],
		["test directory", "/app/src/nodes/__tests__/charge.ts", "ignore"],
		["unrelated file", "/app/README.md", "ignore"],
		["unwatched source", "/app/scripts/seed.ts", "ignore"],
	];

	for (const [label, file, expected] of table) {
		it(`${label} → ${expected}`, () => {
			expect(classifyChange(file, roots).action).toBe(expected);
		});
	}

	it("always explains itself — every classification carries a non-empty reason", () => {
		for (const [, file] of table) {
			expect(classifyChange(file, roots).reason.length).toBeGreaterThan(0);
		}
	});

	it("classifies nothing as hot when no roots are configured", () => {
		// The pre-#692 failure mode: WORKFLOWS_PATH / NODES_PATH unset meant the
		// watcher ran over zero directories and silently hot-reloaded nothing.
		// TriggerBase.resolveHmrRoots is what stops that; this asserts the
		// classifier itself makes the empty case obvious rather than permissive.
		expect(classifyChange("/app/workflows/json/orders.json", {}).action).toBe("ignore");
		// …but the restart class never depends on roots being configured.
		expect(classifyChange("/app/.env", {}).action).toBe("restart");
	});

	it("normalizes Windows separators", () => {
		expect(classifyChange("C:\\app\\workflows\\json\\o.json", { workflowPaths: ["C:\\app\\workflows"] }).action).toBe(
			"hot",
		);
	});

	it("does not treat a sibling directory with a shared prefix as inside a root", () => {
		expect(classifyChange("/app/workflows-archive/old.json", { workflowPaths: ["/app/workflows"] }).action).toBe(
			"ignore",
		);
	});
});
