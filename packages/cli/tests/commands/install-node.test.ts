import { describe, expect, it } from "vitest";
import { nodeInstallHint } from "../../src/commands/install/node.js";

describe("install node redirect", () => {
	it("points users at direct imports instead of Nodes.ts patching", () => {
		expect(nodeInstallHint("stripeCharge", "@acme/stripe-charge")).toContain(
			'import stripeCharge from "@acme/stripe-charge";',
		);
		expect(nodeInstallHint("stripeCharge", "@acme/stripe-charge")).toContain('step("id", stripeCharge, inputs)');
		expect(nodeInstallHint("stripeCharge", "@acme/stripe-charge")).toContain("Nodes.ts registration is deprecated");
	});
});
