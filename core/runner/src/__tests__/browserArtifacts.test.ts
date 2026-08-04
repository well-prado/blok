import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlokError } from "@blokjs/shared";
import { afterEach, describe, expect, it } from "vitest";
import { RunTracker } from "../tracing/RunTracker";
import { SqliteRunStore } from "../tracing/SqliteRunStore";

let directory: string | undefined;

afterEach(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
	directory = undefined;
});

describe("browser artifact persistence", () => {
	it("round-trips node-linked artifacts and assertion expected/actual details", () => {
		directory = mkdtempSync(join(tmpdir(), "blok-browser-artifacts-"));
		const path = join(directory, "runs.db");
		const store = new SqliteRunStore(path);
		const tracker = new RunTracker(10, store);
		const run = tracker.startRun({
			workflowName: "browser-test",
			workflowPath: "test.ts",
			triggerType: "manual",
			triggerSummary: "test",
			nodeCount: 1,
		});
		const node = tracker.startNode(run.id, { nodeName: "assert", nodeType: "module", depth: 0, stepIndex: 0 });
		tracker.recordNodeArtifact(node.id, {
			id: "artifact_test",
			runId: run.id,
			nodeRunId: node.id,
			kind: "screenshot",
			name: "assert-failure",
			mimeType: "image/png",
			size: 3,
			createdAt: 1,
			url: `/__blok/runs/${run.id}/artifacts/artifact_test`,
		});
		tracker.failNode(
			node.id,
			BlokError.validation({
				code: "BROWSER_ASSERTION_FAILED",
				message: "Browser assertion failed",
				details: { expected: "Expected", actual: "Actual" },
			}),
		);
		store.close();

		const reopened = new SqliteRunStore(path);
		const persisted = reopened.getNodeRun(node.id);
		expect(persisted?.artifacts?.[0]).toMatchObject({ id: "artifact_test", nodeRunId: node.id });
		expect(persisted?.error?.details).toEqual({ expected: "Expected", actual: "Actual" });
		reopened.close();
	});
});
