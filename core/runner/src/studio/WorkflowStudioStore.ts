import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { type WorkflowStudioConfigV1, parseWorkflowStudioConfig, workflowStudioPath } from "./WorkflowStudioConfig";

export class WorkflowStudioStoreError extends Error {
	constructor(
		message: string,
		readonly statusCode: number,
		readonly code: string,
	) {
		super(message);
		this.name = "WorkflowStudioStoreError";
	}
}

export interface WorkflowStudioStoreResult {
	config: WorkflowStudioConfigV1 | null;
	etag: string | null;
	sourcePath: string;
}

// ponytail: process-local queue; use OS file locks if multiple runners ever author the same project.
const writeQueues = new Map<string, Promise<void>>();

function etag(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function assertInsideProject(projectRoot: string, candidate: string): void {
	const rel = relative(projectRoot, candidate);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new WorkflowStudioStoreError("Workflow source is outside the project root.", 403, "outside_project_root");
	}
}

async function resolvePaths(
	sourcePath: string,
	projectRoot: string,
): Promise<{
	sourcePath: string;
	studioPath: string;
}> {
	try {
		const root = await realpath(projectRoot);
		const source = await realpath(sourcePath);
		assertInsideProject(root, source);
		if (!(await stat(source)).isFile()) {
			throw new WorkflowStudioStoreError("Workflow source is not a file.", 409, "non_file_source");
		}
		const studioPath = workflowStudioPath(source);
		assertInsideProject(root, await realpath(dirname(studioPath)));
		return { sourcePath: source, studioPath };
	} catch (error) {
		if (error instanceof WorkflowStudioStoreError) throw error;
		throw new WorkflowStudioStoreError("Workflow source cannot be safely resolved.", 403, "unsafe_source_path");
	}
}

async function readSidecar(studioPath: string): Promise<{ content: string; etag: string } | null> {
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		file = await open(studioPath, constants.O_RDONLY | constants.O_NOFOLLOW);
		const content = await file.readFile("utf8");
		return { content, etag: etag(content) };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return null;
		if (code === "ELOOP") {
			throw new WorkflowStudioStoreError("Workflow Studio sidecar cannot be a symlink.", 403, "sidecar_symlink");
		}
		if (code === "EISDIR") {
			throw new WorkflowStudioStoreError("Workflow Studio sidecar is not a file.", 422, "invalid_sidecar");
		}
		throw error;
	} finally {
		await file?.close();
	}
}

async function serializeWrite<T>(key: string, write: () => Promise<T>): Promise<T> {
	const previous = writeQueues.get(key) ?? Promise.resolve();
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => gate);
	writeQueues.set(key, tail);
	await previous;
	try {
		return await write();
	} finally {
		release();
		if (writeQueues.get(key) === tail) writeQueues.delete(key);
	}
}

export async function readWorkflowStudioConfig(
	sourcePath: string,
	projectRoot: string,
	workflowName: string,
): Promise<WorkflowStudioStoreResult> {
	const paths = await resolvePaths(sourcePath, projectRoot);
	const stored = await readSidecar(paths.studioPath);
	if (!stored) return { config: null, etag: null, sourcePath: paths.sourcePath };

	try {
		return {
			config: parseWorkflowStudioConfig(JSON.parse(stored.content), workflowName),
			etag: stored.etag,
			sourcePath: paths.sourcePath,
		};
	} catch (error) {
		throw new WorkflowStudioStoreError(
			`Workflow Studio sidecar is invalid: ${(error as Error).message}`,
			422,
			"invalid_sidecar",
		);
	}
}

export interface WorkflowDefinitionStoreResult {
	definition: Record<string, unknown>;
	etag: string;
	sourcePath: string;
}

function assertJsonSource(sourcePath: string): void {
	if (!sourcePath.endsWith(".json")) {
		throw new WorkflowStudioStoreError(
			"Only JSON workflow definitions can be saved from Studio. Edit the TypeScript source directly.",
			409,
			"definition_not_json",
		);
	}
}

/** Read the workflow definition FILE (not the registry copy) with its etag — the authoring baseline. */
export async function readWorkflowDefinition(
	sourcePath: string,
	projectRoot: string,
): Promise<WorkflowDefinitionStoreResult> {
	assertJsonSource(sourcePath);
	const paths = await resolvePaths(sourcePath, projectRoot);
	const stored = await readSidecar(paths.sourcePath);
	if (!stored) {
		throw new WorkflowStudioStoreError("Workflow definition file no longer exists.", 409, "missing_definition");
	}
	try {
		return {
			definition: JSON.parse(stored.content) as Record<string, unknown>,
			etag: stored.etag,
			sourcePath: paths.sourcePath,
		};
	} catch (error) {
		throw new WorkflowStudioStoreError(
			`Workflow definition file is not valid JSON: ${(error as Error).message}`,
			422,
			"invalid_definition_file",
		);
	}
}

/**
 * Phase 5.4 — atomically save a v2 JSON workflow definition. `validate` runs
 * the runner's own load-time checks (normalizer: schema shape, duplicate step
 * ids, set_var, forEach collisions) so Studio can never persist a definition
 * the runner would refuse to boot.
 */
export async function writeWorkflowDefinition(
	sourcePath: string,
	projectRoot: string,
	workflowName: string,
	input: unknown,
	baseEtag: string | null,
	validate: (raw: unknown, sourcePath: string) => void,
): Promise<WorkflowDefinitionStoreResult> {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new WorkflowStudioStoreError("Workflow definition must be a JSON object.", 400, "invalid_definition");
	}
	const definition = input as Record<string, unknown>;
	if (definition.name !== workflowName) {
		throw new WorkflowStudioStoreError(
			`Workflow definition name must stay "${workflowName}" — renaming the workflow is not supported from Studio.`,
			400,
			"definition_name_mismatch",
		);
	}
	assertJsonSource(sourcePath);
	const paths = await resolvePaths(sourcePath, projectRoot);
	try {
		validate(definition, paths.sourcePath);
	} catch (error) {
		throw new WorkflowStudioStoreError(
			`Workflow definition failed validation: ${(error as Error).message}`,
			400,
			"invalid_definition",
		);
	}

	return serializeWrite(paths.sourcePath, async () => {
		const stored = await readSidecar(paths.sourcePath);
		if ((stored?.etag ?? null) !== baseEtag) {
			throw new WorkflowStudioStoreError("Workflow definition changed since it was loaded.", 409, "stale_etag");
		}

		// Tabs + trailing newline — matches the repo's Biome JSON style.
		const content = `${JSON.stringify(definition, null, "\t")}\n`;
		const tempPath = `${paths.sourcePath}.${randomUUID()}.tmp`;
		let temp: Awaited<ReturnType<typeof open>> | undefined;
		try {
			temp = await open(tempPath, "wx", 0o600);
			await temp.writeFile(content, "utf8");
			await temp.sync();
			await temp.close();
			temp = undefined;
			await rename(tempPath, paths.sourcePath);
		} finally {
			await temp?.close();
			await unlink(tempPath).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}

		return { definition, etag: etag(content), sourcePath: paths.sourcePath };
	});
}

export async function writeWorkflowStudioConfig(
	sourcePath: string,
	projectRoot: string,
	workflowName: string,
	input: unknown,
	baseEtag: string | null,
): Promise<WorkflowStudioStoreResult> {
	let config: WorkflowStudioConfigV1;
	try {
		config = parseWorkflowStudioConfig(input, workflowName);
	} catch (error) {
		throw new WorkflowStudioStoreError(
			`Workflow Studio config is invalid: ${(error as Error).message}`,
			400,
			"invalid_config",
		);
	}

	const paths = await resolvePaths(sourcePath, projectRoot);
	return serializeWrite(paths.studioPath, async () => {
		const stored = await readSidecar(paths.studioPath);
		if ((stored?.etag ?? null) !== baseEtag) {
			throw new WorkflowStudioStoreError("Workflow Studio config changed since it was loaded.", 409, "stale_etag");
		}

		const content = `${JSON.stringify(config, null, 2)}\n`;
		const tempPath = `${paths.studioPath}.${randomUUID()}.tmp`;
		let temp: Awaited<ReturnType<typeof open>> | undefined;
		try {
			temp = await open(tempPath, "wx", 0o600);
			await temp.writeFile(content, "utf8");
			await temp.sync();
			await temp.close();
			temp = undefined;
			await rename(tempPath, paths.studioPath);
		} finally {
			await temp?.close();
			await unlink(tempPath).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}

		return { config, etag: etag(content), sourcePath: paths.sourcePath };
	});
}
