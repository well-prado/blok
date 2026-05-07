/**
 * Regression test for the file-based-routing body-cache bug found
 * during PR-50 production-readiness validation.
 *
 * Symptom (pre-fix): a workflow with a TS-module step whose `inputs`
 * referenced `js/...` expressions (e.g. `data: $.req.body`) cached
 * the FIRST request's resolved value forever. Subsequent requests
 * with different bodies got the first body.
 *
 * Root cause: `Configuration.init` assigned `preloaded` directly to
 * `this.workflow` without cloning. `NodeBase.blueprintMapper` then
 * mutated step.inputs in place via `replaceObjectStrings`, baking
 * the resolved value into the shared route-table workflow object.
 *
 * Fix: deep-clone `preloaded` before normalize. Each request now
 * gets a fresh copy whose mutations don't bleed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Configuration from "../Configuration";

describe("Configuration · preloaded workflow is deep-cloned per init (PR-50 regression)", () => {
	let cfg: Configuration;

	beforeEach(() => {
		cfg = new Configuration();
	});

	afterEach(() => {
		// nothing to clean up — Configuration is a per-test instance
	});

	it("does NOT mutate the caller's preloaded workflow object across inits", async () => {
		// Use a wait step — no node-registry resolution needed, just a
		// stub. Keeps the test isolated from globalOptions.nodes.
		const preloaded = {
			name: "preloaded-test",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [{ id: "wait1", wait: { for: "1s" } }],
		};
		const before = JSON.stringify(preloaded);

		// Two separate inits — simulate two requests sharing the same
		// preloaded reference.
		await cfg.init("preloaded-test", undefined, preloaded);
		await cfg.init("preloaded-test", undefined, preloaded);

		const after = JSON.stringify(preloaded);
		expect(after).toBe(before);
	});

	it("`cfg.workflow` is a distinct object reference from `preloaded`", async () => {
		const preloaded = {
			name: "preloaded-test-2",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/y" } },
			steps: [{ id: "wait2", wait: { for: 0 } }],
		};
		await cfg.init("preloaded-test-2", undefined, preloaded);
		expect(cfg.workflow).not.toBe(preloaded);
	});

	it("two inits produce distinct workflow object references (no shared mutation surface)", async () => {
		const preloaded = {
			name: "preloaded-test-3",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/z" } },
			steps: [{ id: "wait3", wait: { until: "2099-01-01T00:00:00Z" } }],
		};
		await cfg.init("preloaded-test-3", undefined, preloaded);
		const wf1 = cfg.workflow;
		await cfg.init("preloaded-test-3", undefined, preloaded);
		const wf2 = cfg.workflow;
		expect(wf1).not.toBe(wf2);
	});
});
