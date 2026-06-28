import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Metafile, build } from "esbuild";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../..");

interface BundleResult {
	code: string;
	inputs: string[];
}

const forbiddenDslInputs = [
	{ label: "@grpc/grpc-js", pattern: /(^|\/)node_modules\/@grpc\/grpc-js\// },
	{ label: "@opentelemetry", pattern: /(^|\/)node_modules\/@opentelemetry\// },
	{ label: "better-sqlite3", pattern: /(^|\/)node_modules\/better-sqlite3\// },
	{ label: "pg", pattern: /(^|\/)node_modules\/pg\// },
	{ label: "GrpcRuntimeAdapter", pattern: /core\/runner\/dist\/adapters\/grpc\/GrpcRuntimeAdapter\.js$/ },
];

const runtimeRunnerInputs = [
	/core\/runner\/dist\/Configuration\.js$/,
	/core\/runner\/dist\/Runner\.js$/,
	/core\/runner\/dist\/adapters\/grpc\/GrpcRuntimeAdapter\.js$/,
];

async function bundleFixture(name: string, contents: string, format: "esm" | "cjs" = "esm"): Promise<BundleResult> {
	const result = await build({
		stdin: {
			contents,
			resolveDir: REPO_ROOT,
			sourcefile: `${name}.${format === "cjs" ? "cjs" : "mjs"}`,
			loader: "ts",
		},
		bundle: true,
		format,
		platform: "node",
		write: false,
		metafile: true,
		treeShaking: true,
		logLevel: "silent",
	});

	return {
		code: result.outputFiles[0]?.text ?? "",
		inputs: normalizeInputs(result.metafile),
	};
}

function normalizeInputs(metafile: Metafile): string[] {
	return Object.keys(metafile.inputs)
		.map((input) => {
			const absolute = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
			return path.relative(REPO_ROOT, absolute).replace(/\\/g, "/");
		})
		.sort();
}

function matchingInputs(inputs: readonly string[], patterns: readonly RegExp[]): string[] {
	return inputs.filter((input) => patterns.some((pattern) => pattern.test(input)));
}

function forbiddenInputs(inputs: readonly string[]): string[] {
	return inputs.filter((input) => forbiddenDslInputs.some(({ pattern }) => pattern.test(input)));
}

describe("@blokjs/core bundle boundaries", () => {
	it("keeps the @blokjs/core/dsl ESM workflow surface free of runtime/grpc/otel/db modules", async () => {
		const bundle = await bundleFixture(
			"dsl-esm",
			`
				import { workflow, $, branch, forEach } from "@blokjs/core/dsl";
				console.log(workflow, $, branch, forEach);
			`,
		);

		expect(bundle.code).toContain("workflowCallback");
		expect(
			forbiddenInputs(bundle.inputs),
			`Forbidden modules reached from @blokjs/core/dsl:\n${forbiddenInputs(bundle.inputs).join("\n")}`,
		).toEqual([]);
	});

	it("keeps CJS interop consumers of @blokjs/core/dsl on the same light graph", async () => {
		const bundle = await bundleFixture(
			"dsl-cjs",
			`
				const dsl = require("@blokjs/core/dsl");
				console.log(dsl.workflow, dsl.$, dsl.branch, dsl.forEach);
			`,
			"cjs",
		);

		expect(bundle.code).toContain("workflowCallback");
		expect(
			forbiddenInputs(bundle.inputs),
			`Forbidden modules reached from CJS @blokjs/core/dsl:\n${forbiddenInputs(bundle.inputs).join("\n")}`,
		).toEqual([]);
	});

	it("does not bridge runtime through a trigger type-only consumer", async () => {
		const bundle = await bundleFixture(
			"dsl-trigger-type",
			`
				import type { CronTriggerOpts } from "@blokjs/trigger-cron";
				import { workflow, $, branch, forEach } from "@blokjs/core/dsl";
				const _opts = null as CronTriggerOpts | null;
				console.log(workflow, $, branch, forEach, _opts);
			`,
		);

		expect(
			forbiddenInputs(bundle.inputs),
			`Forbidden modules reached with trigger type-only import:\n${forbiddenInputs(bundle.inputs).join("\n")}`,
		).toEqual([]);
	});

	it("makes the runtime subpath visibly include the runner graph", async () => {
		const bundle = await bundleFixture(
			"runtime",
			`
				import { Configuration, Runner } from "@blokjs/core/runtime";
				console.log(Configuration, Runner);
			`,
		);

		expect(matchingInputs(bundle.inputs, runtimeRunnerInputs)).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/core\/runner\/dist\/Configuration\.js$/),
				expect.stringMatching(/core\/runner\/dist\/Runner\.js$/),
				expect.stringMatching(/core\/runner\/dist\/adapters\/grpc\/GrpcRuntimeAdapter\.js$/),
			]),
		);
	});

	it("keeps defineNode on @blokjs/core without pulling grpc/db adapters", async () => {
		const bundle = await bundleFixture(
			"define-node",
			`
				import { defineNode } from "@blokjs/core";
				console.log(defineNode);
			`,
		);

		expect(bundle.inputs).toEqual(
			expect.arrayContaining([expect.stringMatching(/core\/runner\/dist\/defineNode\.js$/)]),
		);
		expect(
			bundle.inputs.filter((input) =>
				[
					/(^|\/)node_modules\/@grpc\/grpc-js\//,
					/(^|\/)node_modules\/better-sqlite3\//,
					/(^|\/)node_modules\/pg\//,
					/core\/runner\/dist\/adapters\/grpc\/GrpcRuntimeAdapter\.js$/,
				].some((pattern) => pattern.test(input)),
			),
		).toEqual([]);
	});
});
