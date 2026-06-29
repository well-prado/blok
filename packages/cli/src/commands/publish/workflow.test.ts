import { describe, expect, it } from "vitest";
import { assertPublishableWorkflow } from "./workflow";

/**
 * #385 — the JSON IR is the registry publish/install unit, so `blokctl publish`
 * validates it before the POST (the client-side admission gate). v1 and v2 both
 * pass; a malformed / not-a-workflow object is a hard reject.
 */
const validV2 = {
	name: "auth-check",
	version: "1.0.0",
	trigger: { http: { method: "GET", path: "/x" } },
	steps: [{ id: "check", use: "@blokjs/respond" }],
};

describe("assertPublishableWorkflow (#385) — IR admission gate before publish", () => {
	it("passes a valid v2 workflow", () => {
		expect(() => assertPublishableWorkflow(validV2, "auth-check")).not.toThrow();
	});

	it("rejects a non-object (malformed IR)", () => {
		expect(() => assertPublishableWorkflow(null, "bad")).toThrow(/failed validation/);
	});

	it("rejects an object with no steps array (not a workflow)", () => {
		expect(() => assertPublishableWorkflow({ name: "x", version: "1.0.0" }, "x")).toThrow(/failed validation/);
	});

	it("names the workflow in the error so the operator knows which file is bad", () => {
		expect(() => assertPublishableWorkflow({}, "myflow")).toThrow(/"myflow"/);
	});
});
