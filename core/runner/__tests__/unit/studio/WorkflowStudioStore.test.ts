import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	readWorkflowDefinition,
	readWorkflowStudioConfig,
	writeWorkflowDefinition,
	writeWorkflowStudioConfig,
} from "../../../src/studio/WorkflowStudioStore";
import { normalizeWorkflow } from "../../../src/workflow/WorkflowNormalizer";

describe("WorkflowStudioStore", () => {
	let projectRoot: string;
	let outsideRoot: string;
	let sourcePath: string;

	const config = (x = 10) => ({
		schemaVersion: 1 as const,
		workflow: "order-intake",
		nodes: { validate: { x, y: 20 } },
	});

	beforeEach(async () => {
		projectRoot = await mkdtemp(join(tmpdir(), "blok-studio-project-"));
		outsideRoot = await mkdtemp(join(tmpdir(), "blok-studio-outside-"));
		sourcePath = join(projectRoot, "order-intake.ts");
		await writeFile(sourcePath, "export default {};\n");
	});

	afterEach(async () => {
		await Promise.all([
			rm(projectRoot, { recursive: true, force: true }),
			rm(outsideRoot, { recursive: true, force: true }),
		]);
	});

	it("creates, reads, and updates the sibling sidecar with etags", async () => {
		const created = await writeWorkflowStudioConfig(sourcePath, projectRoot, "order-intake", config(), null);
		const sidecarPath = join(projectRoot, "order-intake.studio.json");

		expect(created.etag).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.parse(await readFile(sidecarPath, "utf8"))).toMatchObject(config());
		expect(await readWorkflowStudioConfig(sourcePath, projectRoot, "order-intake")).toEqual(created);

		const updated = await writeWorkflowStudioConfig(sourcePath, projectRoot, "order-intake", config(30), created.etag);
		expect(updated.config?.nodes.validate.x).toBe(30);
		expect(updated.etag).not.toBe(created.etag);
	});

	it("rejects a stale etag without modifying the file", async () => {
		await writeWorkflowStudioConfig(sourcePath, projectRoot, "order-intake", config(), null);
		const sidecarPath = join(projectRoot, "order-intake.studio.json");
		const before = await readFile(sidecarPath, "utf8");

		await expect(
			writeWorkflowStudioConfig(sourcePath, projectRoot, "order-intake", config(99), "stale"),
		).rejects.toMatchObject({ statusCode: 409, code: "stale_etag" });
		expect(await readFile(sidecarPath, "utf8")).toBe(before);
	});

	it("rejects traversal, outside-root sources, and symlinks that escape the project", async () => {
		const outsideSource = join(outsideRoot, "outside.ts");
		await writeFile(outsideSource, "export default {};\n");
		const traversingPath = join(projectRoot, "nested", "..", "..", basename(outsideRoot), "outside.ts");
		const linkedSource = join(projectRoot, "linked.ts");
		await symlink(outsideSource, linkedSource);

		for (const unsafePath of [outsideSource, traversingPath, linkedSource]) {
			await expect(readWorkflowStudioConfig(unsafePath, projectRoot, "order-intake")).rejects.toMatchObject({
				statusCode: 403,
			});
		}
	});

	it("does not follow a sidecar symlink", async () => {
		const outsideTarget = join(outsideRoot, "target.json");
		await writeFile(outsideTarget, JSON.stringify(config()));
		await symlink(outsideTarget, join(projectRoot, "order-intake.studio.json"));

		await expect(readWorkflowStudioConfig(sourcePath, projectRoot, "order-intake")).rejects.toMatchObject({
			statusCode: 403,
			code: "sidecar_symlink",
		});
		await expect(
			writeWorkflowStudioConfig(sourcePath, projectRoot, "order-intake", config(99), null),
		).rejects.toMatchObject({ statusCode: 403, code: "sidecar_symlink" });
		expect(JSON.parse(await readFile(outsideTarget, "utf8"))).toEqual(config());
	});

	it("rejects a source path that is not a file", async () => {
		const directorySource = join(projectRoot, "directory.ts");
		await mkdir(directorySource);
		await expect(readWorkflowStudioConfig(directorySource, projectRoot, "order-intake")).rejects.toMatchObject({
			statusCode: 409,
			code: "non_file_source",
		});
	});

	it("validates before writing and preserves the last valid file", async () => {
		await writeWorkflowStudioConfig(sourcePath, projectRoot, "order-intake", config(), null);
		const sidecarPath = join(projectRoot, "order-intake.studio.json");
		const before = await readFile(sidecarPath, "utf8");

		await expect(
			writeWorkflowStudioConfig(
				sourcePath,
				projectRoot,
				"order-intake",
				{ ...config(), nodes: { validate: { x: Number.POSITIVE_INFINITY, y: 0 } } },
				null,
			),
		).rejects.toMatchObject({ statusCode: 400, code: "invalid_config" });
		expect(await readFile(sidecarPath, "utf8")).toBe(before);
	});
});

// Studio deploy guard — `writeWorkflowDefinition(..., dryRun: true)` runs the
// same normalizer validation + etag conflict check as a real save but never
// writes, so the UI can show "workflow broken" before the user hits deploy.
describe("writeWorkflowDefinition dry-run", () => {
	let projectRoot: string;
	let definitionPath: string;

	const validate = (raw: unknown, path: string) => void normalizeWorkflow(raw, path);

	const validDefinition = (path = "/orders") => ({
		name: "order-intake",
		version: "1.0.0",
		trigger: { http: { method: "POST", path } },
		steps: [{ id: "validate", use: "@blokjs/respond", inputs: {} }],
	});

	const brokenDefinition = () => ({
		name: "order-intake",
		version: "1.0.0",
		trigger: { http: { method: "POST", path: "/orders" } },
		steps: [
			{ id: "dup", use: "@blokjs/respond", inputs: {} },
			{ id: "dup", use: "@blokjs/respond", inputs: {} },
		],
	});

	beforeEach(async () => {
		projectRoot = await mkdtemp(join(tmpdir(), "blok-studio-definition-"));
		definitionPath = join(projectRoot, "order-intake.json");
		await writeFile(definitionPath, `${JSON.stringify(validDefinition(), null, "\t")}\n`);
	});

	afterEach(async () => {
		await rm(projectRoot, { recursive: true, force: true });
	});

	it("valid definition: resolves with the current etag and leaves the file untouched", async () => {
		const baseline = await readWorkflowDefinition(definitionPath, projectRoot);
		const before = await readFile(definitionPath, "utf8");
		const beforeMtime = (await stat(definitionPath)).mtimeMs;

		const result = await writeWorkflowDefinition(
			definitionPath,
			projectRoot,
			"order-intake",
			validDefinition("/orders-v2"),
			baseline.etag,
			validate,
			true,
		);

		expect(result.etag).toBe(baseline.etag);
		expect(await readFile(definitionPath, "utf8")).toBe(before);
		expect((await stat(definitionPath)).mtimeMs).toBe(beforeMtime);

		// A real save with the same input DOES change the file — proves the
		// dry-run truly skipped the write rather than the input being a no-op.
		const saved = await writeWorkflowDefinition(
			definitionPath,
			projectRoot,
			"order-intake",
			validDefinition("/orders-v2"),
			baseline.etag,
			validate,
		);
		expect(saved.etag).not.toBe(baseline.etag);
	});

	it("broken definition (duplicate step ids): rejects with the same error a real save would throw, file unchanged", async () => {
		const baseline = await readWorkflowDefinition(definitionPath, projectRoot);
		const before = await readFile(definitionPath, "utf8");

		const dryRunError = await writeWorkflowDefinition(
			definitionPath,
			projectRoot,
			"order-intake",
			brokenDefinition(),
			baseline.etag,
			validate,
			true,
		).catch((e) => e);
		const realSaveError = await writeWorkflowDefinition(
			definitionPath,
			projectRoot,
			"order-intake",
			brokenDefinition(),
			baseline.etag,
			validate,
		).catch((e) => e);

		expect(dryRunError).toMatchObject({ statusCode: 400, code: "invalid_definition" });
		expect(realSaveError).toMatchObject({ statusCode: 400, code: "invalid_definition" });
		expect(await readFile(definitionPath, "utf8")).toBe(before);
	});

	it("stale baseEtag: rejects 409 in dry-run too, file unchanged", async () => {
		const before = await readFile(definitionPath, "utf8");

		await expect(
			writeWorkflowDefinition(
				definitionPath,
				projectRoot,
				"order-intake",
				validDefinition("/orders-v2"),
				"stale-etag",
				validate,
				true,
			),
		).rejects.toMatchObject({ statusCode: 409, code: "stale_etag" });
		expect(await readFile(definitionPath, "utf8")).toBe(before);
	});
});
