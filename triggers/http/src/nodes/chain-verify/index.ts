import { defineNode } from "@blok/runner";
import type { Context } from "@blok/shared";
import { z } from "zod";

type ChainEntry = { language: string; order: number; timestamp?: string };

/**
 * ChainVerify node — final step of the cross-runtime chain test.
 *
 * Reads ctx.vars directly (populated by RuntimeAdapterNode for each SDK step
 * and by chain-init for the init step) to produce a verification report
 * confirming all runtimes executed correctly.
 */
export default defineNode({
	name: "chain-verify",
	description: "Verifies that all runtimes executed correctly in a cross-runtime chain test",

	input: z.object({}),

	output: z.object({
		status: z.enum(["PASS", "FAIL"]),
		summary: z.object({
			totalRuntimes: z.number(),
			chainLength: z.number(),
			allRuntimesInChain: z.boolean(),
			allRuntimesInVars: z.boolean(),
			origin: z.string(),
		}),
		chain: z.array(
			z.object({
				language: z.string(),
				order: z.number(),
				timestamp: z.string().optional(),
			}),
		),
		verification: z.record(
			z.object({
				inChain: z.boolean(),
				inVars: z.boolean(),
				chainOrder: z.number().nullable(),
				stepName: z.string(),
			}),
		),
		vars: z.record(z.unknown()),
	}),

	async execute(ctx: Context, _input) {
		const vars = (ctx.vars ?? {}) as Record<string, unknown>;

		// Step name → runtime language mapping
		const stepToRuntime: Record<string, string> = {
			init: "nodejs",
			go: "go",
			rust: "rust",
			java: "java",
			csharp: "csharp",
			php: "php",
			ruby: "ruby",
			python: "python3",
		};

		const expectedRuntimes = Object.values(stepToRuntime);

		// Find the longest chain from any step's vars (the last step should have all entries)
		let finalChain: ChainEntry[] = [];
		let origin = "unknown";

		for (const stepName of Object.keys(stepToRuntime)) {
			const stepVars = vars[stepName] as Record<string, unknown> | undefined;
			if (!stepVars) continue;

			const stepChain = (stepVars.chain ?? []) as ChainEntry[];
			if (stepChain.length > finalChain.length) {
				finalChain = stepChain;
			}
			if (stepVars.origin && typeof stepVars.origin === "string") {
				origin = stepVars.origin;
			}
		}

		// Verify each runtime appears in the chain and in vars
		const chainLanguages = finalChain.map((entry) => entry.language);

		const verification: Record<
			string,
			{
				inChain: boolean;
				inVars: boolean;
				chainOrder: number | null;
				stepName: string;
			}
		> = {};

		for (const [stepName, runtime] of Object.entries(stepToRuntime)) {
			const chainIndex = chainLanguages.indexOf(runtime);
			const stepVars = vars[stepName] as Record<string, unknown> | undefined;

			verification[runtime] = {
				inChain: chainIndex >= 0,
				inVars: stepVars !== undefined,
				chainOrder: chainIndex >= 0 ? chainIndex + 1 : null,
				stepName,
			};
		}

		const allInChain = Object.values(verification).every((v) => v.inChain);
		const allInVars = Object.values(verification).every((v) => v.inVars);

		return {
			status: (allInChain && allInVars ? "PASS" : "FAIL") as "PASS" | "FAIL",
			summary: {
				totalRuntimes: expectedRuntimes.length,
				chainLength: finalChain.length,
				allRuntimesInChain: allInChain,
				allRuntimesInVars: allInVars,
				origin,
			},
			chain: finalChain,
			verification,
			vars,
		};
	},
});
