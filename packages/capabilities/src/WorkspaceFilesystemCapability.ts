import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, realpathSync, statSync, watch as watchPath } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open, readdir, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import {
	type CapabilityAuthority,
	type CapabilityEffect,
	type CapabilityManifestV1,
	type PolicyEvaluationResult,
	type PolicyRequest,
	intersectCapabilityAuthorities,
	parseCapabilityAuthority,
} from "@blokjs/shared";
import type {
	WorkspaceArtifact,
	WorkspaceFileMetadata,
	WorkspaceFilesystemLimits,
	WorkspaceFilesystemOperation,
	WorkspaceFilesystemOptions,
	WorkspaceFilesystemPolicyRequest,
	WorkspaceListInput,
	WorkspaceListResult,
	WorkspaceMetadataInput,
	WorkspacePatchInput,
	WorkspaceReadInput,
	WorkspaceReadResult,
	WorkspaceRoot,
	WorkspaceSearchInput,
	WorkspaceSearchMatch,
	WorkspaceSearchResult,
	WorkspaceTextPatch,
	WorkspaceWatchEvent,
	WorkspaceWatchInput,
	WorkspaceWriteInput,
	WorkspaceWriteResult,
} from "./contracts";
import {
	WORKSPACE_FILESYSTEM_MAX_DURATION_MS,
	WORKSPACE_FILESYSTEM_MAX_LINES,
	WORKSPACE_FILESYSTEM_MAX_LIST_FILES,
	WORKSPACE_FILESYSTEM_MAX_PATH_LENGTH,
	WORKSPACE_FILESYSTEM_MAX_QUERY_LENGTH,
	WORKSPACE_FILESYSTEM_MAX_READ_BYTES,
	WORKSPACE_FILESYSTEM_MAX_SEARCH_BYTES,
	WORKSPACE_FILESYSTEM_MAX_SEARCH_FILES,
	WORKSPACE_FILESYSTEM_MAX_SEARCH_MATCHES,
	WORKSPACE_FILESYSTEM_MAX_WATCH_DEBOUNCE_MS,
	WORKSPACE_FILESYSTEM_MAX_WATCH_EVENTS,
	WORKSPACE_FILESYSTEM_MAX_WRITE_BYTES,
} from "./contracts";
import { WorkspaceFilesystemError } from "./errors";

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const O_NOFOLLOW = (constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;
const CHUNK_SIZE = 64 * 1024;

const OPERATION_CAPABILITIES: Record<WorkspaceFilesystemOperation, string> = {
	metadata: "fs.workspace.metadata",
	list: "fs.workspace.list",
	read: "fs.workspace.read",
	search: "fs.workspace.search",
	write: "fs.workspace.write",
	patch: "fs.workspace.write",
	watch: "fs.workspace.watch",
};

const OPERATION_EFFECTS: Record<WorkspaceFilesystemOperation, CapabilityEffect[]> = {
	metadata: ["filesystem", "read"],
	list: ["filesystem", "read"],
	read: ["filesystem", "read"],
	search: ["filesystem", "read"],
	write: ["filesystem", "write"],
	patch: ["filesystem", "write"],
	watch: ["filesystem", "read", "streaming"],
};

const DEFAULT_LIMITS: Required<WorkspaceFilesystemLimits> = {
	maxReadBytes: WORKSPACE_FILESYSTEM_MAX_READ_BYTES,
	maxWriteBytes: WORKSPACE_FILESYSTEM_MAX_WRITE_BYTES,
	maxListFiles: WORKSPACE_FILESYSTEM_MAX_LIST_FILES,
	maxSearchFiles: WORKSPACE_FILESYSTEM_MAX_SEARCH_FILES,
	maxSearchMatches: WORKSPACE_FILESYSTEM_MAX_SEARCH_MATCHES,
	maxSearchBytes: WORKSPACE_FILESYSTEM_MAX_SEARCH_BYTES,
	maxLines: WORKSPACE_FILESYSTEM_MAX_LINES,
	maxWatchEvents: WORKSPACE_FILESYSTEM_MAX_WATCH_EVENTS,
	maxDurationMs: WORKSPACE_FILESYSTEM_MAX_DURATION_MS,
};

type ResolvedPath = {
	readonly root: WorkspaceRoot;
	readonly relativePath: string;
	readonly absolutePath: string;
};

type SecureFile = {
	readonly stats: Stats;
	readonly bytes: Uint8Array;
};

function fsCode(error: unknown): string | undefined {
	if (error !== null && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		return typeof code === "string" ? code : undefined;
	}
	return undefined;
}

function isWorkspaceError(error: unknown): error is WorkspaceFilesystemError {
	return error instanceof WorkspaceFilesystemError;
}

function now(): string {
	return new Date().toISOString();
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number, label: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
		throw new WorkspaceFilesystemError("WORKSPACE_FS_SIZE_LIMIT", `${label} exceeds the hard capability bound`);
	return value;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new WorkspaceFilesystemError("WORKSPACE_FS_CANCELLED");
}

function canonicalRelativePath(value: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > WORKSPACE_FILESYSTEM_MAX_PATH_LENGTH)
		throw new WorkspaceFilesystemError("WORKSPACE_FS_INVALID_PATH");
	if (value.includes("\0")) throw new WorkspaceFilesystemError("WORKSPACE_FS_INVALID_PATH");
	const portable = value.replaceAll("\\", "/");
	if (portable.startsWith("/") || isAbsolute(value) || win32.isAbsolute(value) || /^[A-Za-z]:/.test(value))
		throw new WorkspaceFilesystemError("WORKSPACE_FS_PATH_ESCAPE");
	if (portable.startsWith("//") || portable.startsWith("\\\\"))
		throw new WorkspaceFilesystemError("WORKSPACE_FS_PATH_ESCAPE");
	const parts = portable.split("/");
	if (parts.some((part) => part === "..")) throw new WorkspaceFilesystemError("WORKSPACE_FS_PATH_ESCAPE");
	if (parts.some((part) => WINDOWS_DEVICE_NAME.test(part)))
		throw new WorkspaceFilesystemError("WORKSPACE_FS_INVALID_PATH");
	const normalized = parts.filter((part) => part.length > 0 && part !== ".").join("/");
	return normalized || ".";
}

function capabilityManifest(
	operation: WorkspaceFilesystemOperation,
	limits: Required<WorkspaceFilesystemLimits>,
): CapabilityManifestV1 {
	return {
		version: "1",
		classification: "agent-compatible",
		effects: [...new Set(OPERATION_EFFECTS[operation])].sort() as CapabilityEffect[],
		capabilities: [OPERATION_CAPABILITIES[operation]],
		secrets: [],
		determinism: "external",
		idempotency: operation === "write" || operation === "patch" ? "conditionally-idempotent" : "idempotent",
		maturity: "stable",
		resources: {
			maxDurationMs: limits.maxDurationMs,
			maxInputBytes: operation === "write" || operation === "patch" ? limits.maxWriteBytes : limits.maxReadBytes,
			maxOutputBytes: operation === "search" ? limits.maxSearchBytes : limits.maxReadBytes,
			maxConcurrency: 1,
		},
	};
}

export function workspaceFilesystemManifest(
	operation: WorkspaceFilesystemOperation,
	limits: WorkspaceFilesystemLimits = {},
): CapabilityManifestV1 {
	const effective = { ...DEFAULT_LIMITS, ...limits };
	return capabilityManifest(operation, effective);
}

export function workspaceFilesystemAuthority(
	operation: WorkspaceFilesystemOperation,
	workspaceId?: string,
): CapabilityAuthority {
	return parseCapabilityAuthority({
		effects: OPERATION_EFFECTS[operation],
		capabilities: [OPERATION_CAPABILITIES[operation]],
		secrets: [],
		fragments: workspaceId === undefined ? {} : { workspace: workspaceId },
	});
}

export function workspaceRelativePath(value: string): string {
	return canonicalRelativePath(value);
}

function mediaType(path: string): string | undefined {
	const extension = extname(path).toLowerCase();
	const types: Record<string, string> = {
		".js": "text/javascript",
		".jsx": "text/javascript",
		".ts": "text/typescript",
		".tsx": "text/typescript",
		".json": "application/json",
		".md": "text/markdown",
		".txt": "text/plain",
		".css": "text/css",
		".html": "text/html",
		".yml": "application/yaml",
		".yaml": "application/yaml",
	};
	return types[extension];
}

function artifactId(workspaceId: string, path: string): string {
	return `workspace-file-${createHash("sha256").update(`${workspaceId}\0${path}`).digest("hex")}`;
}

function asBytes(content: string | Uint8Array): Uint8Array {
	return typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
}

function digest(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function errorForFs(error: unknown, operation: string, relativePath: string): WorkspaceFilesystemError {
	if (isWorkspaceError(error)) return error;
	const code = fsCode(error);
	if (code === "ENOENT")
		return new WorkspaceFilesystemError("WORKSPACE_FS_NOT_FOUND", undefined, { operation, relativePath });
	if (code === "EACCES" || code === "EPERM")
		return new WorkspaceFilesystemError("WORKSPACE_FS_PERMISSION_DENIED", undefined, { operation, relativePath });
	if (code === "ELOOP") return new WorkspaceFilesystemError("WORKSPACE_FS_SYMLINK_DISALLOWED");
	return new WorkspaceFilesystemError("WORKSPACE_FS_INVALID_TARGET", undefined, { operation, relativePath });
}

function validateRoot(input: { id: string; path: string }): WorkspaceRoot {
	if (!IDENTIFIER.test(input.id) || typeof input.path !== "string" || !isAbsolute(input.path))
		throw new WorkspaceFilesystemError("WORKSPACE_FS_INVALID_ROOT");
	try {
		const path = realpathSync(input.path);
		if (!statSync(path).isDirectory()) throw new Error("not a directory");
		return Object.freeze({ id: input.id, path });
	} catch {
		throw new WorkspaceFilesystemError("WORKSPACE_FS_INVALID_ROOT");
	}
}

function validateLimits(limits: WorkspaceFilesystemLimits | undefined): Required<WorkspaceFilesystemLimits> {
	const value = { ...DEFAULT_LIMITS, ...limits };
	return {
		maxReadBytes: boundedLimit(
			value.maxReadBytes,
			DEFAULT_LIMITS.maxReadBytes,
			WORKSPACE_FILESYSTEM_MAX_READ_BYTES,
			"maxReadBytes",
		),
		maxWriteBytes: boundedLimit(
			value.maxWriteBytes,
			DEFAULT_LIMITS.maxWriteBytes,
			WORKSPACE_FILESYSTEM_MAX_WRITE_BYTES,
			"maxWriteBytes",
		),
		maxListFiles: boundedLimit(
			value.maxListFiles,
			DEFAULT_LIMITS.maxListFiles,
			WORKSPACE_FILESYSTEM_MAX_LIST_FILES,
			"maxListFiles",
		),
		maxSearchFiles: boundedLimit(
			value.maxSearchFiles,
			DEFAULT_LIMITS.maxSearchFiles,
			WORKSPACE_FILESYSTEM_MAX_SEARCH_FILES,
			"maxSearchFiles",
		),
		maxSearchMatches: boundedLimit(
			value.maxSearchMatches,
			DEFAULT_LIMITS.maxSearchMatches,
			WORKSPACE_FILESYSTEM_MAX_SEARCH_MATCHES,
			"maxSearchMatches",
		),
		maxSearchBytes: boundedLimit(
			value.maxSearchBytes,
			DEFAULT_LIMITS.maxSearchBytes,
			WORKSPACE_FILESYSTEM_MAX_SEARCH_BYTES,
			"maxSearchBytes",
		),
		maxLines: boundedLimit(value.maxLines, DEFAULT_LIMITS.maxLines, WORKSPACE_FILESYSTEM_MAX_LINES, "maxLines"),
		maxWatchEvents: boundedLimit(
			value.maxWatchEvents,
			DEFAULT_LIMITS.maxWatchEvents,
			WORKSPACE_FILESYSTEM_MAX_WATCH_EVENTS,
			"maxWatchEvents",
		),
		maxDurationMs: boundedLimit(
			value.maxDurationMs,
			DEFAULT_LIMITS.maxDurationMs,
			WORKSPACE_FILESYSTEM_MAX_DURATION_MS,
			"maxDurationMs",
		),
	};
}

async function readHandle(
	handle: FileHandle,
	size: number,
	signal: AbortSignal | undefined,
	maxBytes: number,
): Promise<Uint8Array> {
	if (!Number.isSafeInteger(size) || size > maxBytes) throw new WorkspaceFilesystemError("WORKSPACE_FS_SIZE_LIMIT");
	const output = new Uint8Array(size);
	let offset = 0;
	while (offset < size) {
		throwIfCancelled(signal);
		const length = Math.min(CHUNK_SIZE, size - offset);
		const result = await handle.read(output, offset, length, offset);
		if (result.bytesRead === 0) break;
		offset += result.bytesRead;
	}
	return output.slice(0, offset);
}

class EventQueue<T> {
	private readonly values: T[] = [];
	private readonly waiters: Array<(value: T | undefined) => void> = [];
	private ended = false;

	push(value: T): void {
		if (this.ended) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter(value);
		else this.values.push(value);
	}

	end(): void {
		this.ended = true;
		for (const waiter of this.waiters.splice(0)) waiter(undefined);
	}

	next(): Promise<T | undefined> {
		const value = this.values.shift();
		if (value !== undefined) return Promise.resolve(value);
		if (this.ended) return Promise.resolve(undefined);
		return new Promise((resolveValue) => this.waiters.push(resolveValue));
	}
}

export class WorkspaceFilesystemCapability {
	readonly roots: readonly WorkspaceRoot[];
	readonly limits: Required<WorkspaceFilesystemLimits>;
	private readonly rootById: ReadonlyMap<string, WorkspaceRoot>;
	private readonly options: WorkspaceFilesystemOptions;

	constructor(options: WorkspaceFilesystemOptions) {
		if (options.roots.length === 0) throw new WorkspaceFilesystemError("WORKSPACE_FS_INVALID_ROOT");
		const roots = options.roots.map(validateRoot);
		if (new Set(roots.map((root) => root.id)).size !== roots.length)
			throw new WorkspaceFilesystemError("WORKSPACE_FS_INVALID_ROOT");
		this.roots = Object.freeze(roots);
		this.rootById = new Map(roots.map((root) => [root.id, root] as const));
		this.limits = validateLimits(options.limits);
		this.options = options;
	}

	metadata(input: WorkspaceMetadataInput): Promise<WorkspaceFileMetadata> {
		return this.run("metadata", input, async (target) => this.metadataInternal(target, input.signal));
	}

	list(input: WorkspaceListInput): Promise<WorkspaceListResult> {
		return this.run("list", input, async (target) => {
			const maxFiles = boundedLimit(input.maxFiles, this.limits.maxListFiles, this.limits.maxListFiles, "maxFiles");
			const maxBytes = boundedLimit(input.maxBytes, this.limits.maxSearchBytes, this.limits.maxSearchBytes, "maxBytes");
			const rootStat = await this.secureStat(target, input.signal);
			if (!rootStat.isDirectory()) throw new WorkspaceFilesystemError("WORKSPACE_FS_INVALID_TARGET");
			const entries: WorkspaceFileMetadata[] = [];
			let bytesScanned = 0;
			let truncated = false;
			const visit = async (directory: string): Promise<void> => {
				const children = await readdir(directory, { withFileTypes: true });
				for (const child of children) {
					throwIfCancelled(input.signal);
					if (entries.length >= maxFiles) {
						truncated = true;
						return;
					}
					const absolute = join(directory, child.name);
					const path = this.pathFromAbsolute(target.root, absolute);
					const childTarget = this.resolveTarget(target.root.id, path, false);
					const childInfo = await this.secureStat(childTarget, input.signal);
					if (bytesScanned + childInfo.size > maxBytes) {
						truncated = true;
						return;
					}
					bytesScanned += childInfo.size;
					const metadata = await this.metadataInternal(childTarget, input.signal);
					entries.push(metadata);
					if (input.recursive && metadata.kind === "directory") await visit(absolute);
				}
			};
			await visit(target.absolutePath);
			return { workspaceId: target.root.id, path: target.relativePath, entries, bytesScanned, truncated };
		});
	}

	read(input: WorkspaceReadInput): Promise<WorkspaceReadResult> {
		return this.run("read", input, async (target) => {
			const maxBytes = boundedLimit(input.maxBytes, this.limits.maxReadBytes, this.limits.maxReadBytes, "maxBytes");
			const maxLines = boundedLimit(input.maxLines, this.limits.maxLines, this.limits.maxLines, "maxLines");
			const secure = await this.readSecure(target, input.signal, maxBytes);
			const version = digest(secure.bytes);
			const artifact = this.makeArtifact(target, secure.stats.size, version);
			const encoding = input.encoding ?? "utf8";
			let content: string | Uint8Array;
			if (encoding === "bytes") content = secure.bytes;
			else if (encoding === "base64") content = Buffer.from(secure.bytes).toString("base64");
			else {
				if (secure.bytes.includes(0)) throw new WorkspaceFilesystemError("WORKSPACE_FS_BINARY_FILE");
				let text: string;
				try {
					text = new TextDecoder("utf-8", { fatal: true }).decode(secure.bytes);
				} catch {
					throw new WorkspaceFilesystemError("WORKSPACE_FS_INVALID_ENCODING");
				}
				content = this.selectLines(text, input.startLine, input.endLine, maxLines);
			}
			return {
				workspaceId: target.root.id,
				path: target.relativePath,
				encoding,
				bytes: secure.bytes,
				content,
				sizeBytes: secure.stats.size,
				version,
				artifact,
			};
		});
	}

	search(input: WorkspaceSearchInput): Promise<WorkspaceSearchResult> {
		return this.run("search", input, async (target) => {
			if (input.query.length === 0 || input.query.length > WORKSPACE_FILESYSTEM_MAX_QUERY_LENGTH)
				throw new WorkspaceFilesystemError("WORKSPACE_FS_QUERY_INVALID");
			let expression: RegExp | undefined;
			if (input.regex) {
				try {
					expression = new RegExp(input.query, input.caseSensitive ? "g" : "gi");
				} catch {
					throw new WorkspaceFilesystemError("WORKSPACE_FS_QUERY_INVALID");
				}
			}
			const maxFiles = boundedLimit(input.maxFiles, this.limits.maxSearchFiles, this.limits.maxSearchFiles, "maxFiles");
			const maxMatches = boundedLimit(
				input.maxMatches,
				this.limits.maxSearchMatches,
				this.limits.maxSearchMatches,
				"maxMatches",
			);
			const maxBytes = boundedLimit(input.maxBytes, this.limits.maxSearchBytes, this.limits.maxSearchBytes, "maxBytes");
			const maxLines = boundedLimit(input.maxLines, this.limits.maxLines, this.limits.maxLines, "maxLines");
			const matches: WorkspaceSearchMatch[] = [];
			let filesScanned = 0;
			let bytesScanned = 0;
			let truncated = false;
			const visit = async (absolute: string): Promise<void> => {
				throwIfCancelled(input.signal);
				const current = this.resolveTarget(target.root.id, this.pathFromAbsolute(target.root, absolute), false);
				const info = await this.secureStat(current, input.signal);
				if (info.isDirectory()) {
					for (const child of await readdir(absolute, { withFileTypes: true })) {
						if (filesScanned >= maxFiles || matches.length >= maxMatches) {
							truncated = true;
							return;
						}
						await visit(join(absolute, child.name));
					}
					return;
				}
				if (!info.isFile()) return;
				filesScanned += 1;
				if (bytesScanned + info.size > maxBytes) {
					truncated = true;
					return;
				}
				const fileTarget = this.resolveTarget(target.root.id, this.pathFromAbsolute(target.root, absolute), false);
				const secure = await this.readSecure(
					fileTarget,
					input.signal,
					Math.min(maxBytes - bytesScanned, this.limits.maxReadBytes),
				);
				bytesScanned += secure.bytes.byteLength;
				if (secure.bytes.includes(0)) return;
				let text: string;
				try {
					text = new TextDecoder("utf-8", { fatal: true }).decode(secure.bytes);
				} catch {
					return;
				}
				const lines = text.split(/\r?\n/).slice(0, maxLines);
				if (text.split(/\r?\n/).length > maxLines) truncated = true;
				const path = fileTarget.relativePath;
				const version = digest(secure.bytes);
				const artifact = this.makeArtifact(fileTarget, secure.stats.size, version);
				for (let index = 0; index < lines.length; index++) {
					throwIfCancelled(input.signal);
					const line = lines[index];
					if (expression) {
						expression.lastIndex = 0;
						let match = expression.exec(line);
						while (match !== null) {
							if (matches.length >= maxMatches) {
								truncated = true;
								return;
							}
							matches.push({ path, line: index + 1, column: match.index + 1, text: line, artifact });
							if (match[0].length === 0) expression.lastIndex += 1;
							match = expression.exec(line);
						}
					} else {
						const haystack = input.caseSensitive ? line : line.toLocaleLowerCase();
						const needle = input.caseSensitive ? input.query : input.query.toLocaleLowerCase();
						let offset = haystack.indexOf(needle);
						while (offset !== -1) {
							if (matches.length >= maxMatches) {
								truncated = true;
								return;
							}
							matches.push({ path, line: index + 1, column: offset + 1, text: line, artifact });
							offset = haystack.indexOf(needle, offset + Math.max(needle.length, 1));
						}
					}
				}
			};
			await visit(target.absolutePath);
			return { workspaceId: target.root.id, root: target.relativePath, matches, filesScanned, bytesScanned, truncated };
		});
	}

	write(input: WorkspaceWriteInput): Promise<WorkspaceWriteResult> {
		return this.run("write", input, (target) => this.writeInternal(target, input, "write"), true);
	}

	patch(input: WorkspacePatchInput): Promise<WorkspaceWriteResult> {
		return this.run("patch", input, async (target) => {
			const secure = await this.readSecure(target, input.signal, this.limits.maxReadBytes);
			if (secure.bytes.includes(0)) throw new WorkspaceFilesystemError("WORKSPACE_FS_BINARY_FILE");
			let original: string;
			try {
				original = new TextDecoder("utf-8", { fatal: true }).decode(secure.bytes);
			} catch {
				throw new WorkspaceFilesystemError("WORKSPACE_FS_INVALID_ENCODING");
			}
			const content = applyPatches(original, input.patches);
			return this.writeInternal(target, { ...input, content, expectedVersion: input.expectedVersion }, "patch");
		});
	}

	async *watch(input: WorkspaceWatchInput): AsyncIterable<WorkspaceWatchEvent> {
		const target = this.resolveInput(input);
		await this.authorize("watch", target, input.signal);
		const debounceMs = Math.min(input.debounceMs ?? 25, WORKSPACE_FILESYSTEM_MAX_WATCH_DEBOUNCE_MS);
		const maxEvents = boundedLimit(
			input.maxEvents,
			this.limits.maxWatchEvents,
			this.limits.maxWatchEvents,
			"maxEvents",
		);
		const queue = new EventQueue<WorkspaceWatchEvent>();
		const watchers: Array<{ close(): void }> = [];
		const timers = new Map<string, ReturnType<typeof setTimeout>>();
		let eventCount = 0;
		let closed = false;
		let failure: WorkspaceFilesystemError | undefined;
		const watchedDirectory = target.absolutePath;
		const isDirectory = await this.secureStat(target, input.signal).then((value) => value.isDirectory());
		throwIfCancelled(input.signal);
		const parent = isDirectory ? watchedDirectory : dirname(watchedDirectory);
		const filter = (absolute: string): boolean => {
			const candidate = resolve(absolute);
			const rel = relative(isDirectory ? watchedDirectory : target.absolutePath, candidate);
			if (!isDirectory) return rel === "";
			return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
		};
		const finish = (error?: WorkspaceFilesystemError): void => {
			if (closed) return;
			closed = true;
			failure = error;
			queue.end();
			for (const timer of timers.values()) clearTimeout(timer);
			for (const watcher of watchers) watcher.close();
		};
		const emit = (watchDirectory: string, eventType: "rename" | "change", filename: string | Buffer | null): void => {
			if (closed || filename === null) return;
			const absolute = join(watchDirectory, filename.toString());
			if (!filter(absolute)) return;
			const path = this.pathFromAbsolute(target.root, absolute);
			const oldTimer = timers.get(path);
			if (oldTimer) clearTimeout(oldTimer);
			timers.set(
				path,
				setTimeout(() => {
					timers.delete(path);
					if (eventCount >= maxEvents) {
						queue.push({ type: "overflow", workspaceId: target.root.id, requiresRescan: true, observedAt: now() });
						finish();
						return;
					}
					eventCount += 1;
					void this.watchEvent(target.root.id, path, eventType)
						.then((event) => queue.push(event))
						.catch((error: unknown) => finish(errorForFs(error, "watch", path)));
				}, debounceMs),
			);
		};
		const directories =
			isDirectory && input.recursive && process.platform === "linux"
				? await this.directoriesForWatch(watchedDirectory, input.signal)
				: [parent];
		for (const directory of directories) {
			const watcher = watchPath(directory, { persistent: false }, (eventType, filename) =>
				emit(directory, eventType, filename),
			);
			watchers.push(watcher);
		}
		const abort = (): void => finish(new WorkspaceFilesystemError("WORKSPACE_FS_CANCELLED"));
		input.signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(
			() => finish(new WorkspaceFilesystemError("WORKSPACE_FS_TIME_LIMIT")),
			this.duration(input.maxDurationMs),
		);
		try {
			while (true) {
				const event = await queue.next();
				if (event === undefined) break;
				yield event;
				if (event.type === "overflow") break;
			}
			if (failure) throw failure;
		} finally {
			clearTimeout(timer);
			input.signal?.removeEventListener("abort", abort);
			finish();
		}
	}

	private async run<T>(
		operation: WorkspaceFilesystemOperation,
		input: { workspaceId: string; path: string; signal?: AbortSignal; maxDurationMs?: number },
		callback: (target: ResolvedPath) => Promise<T>,
		allowMissing = false,
	): Promise<T> {
		const target = this.resolveInput(input, allowMissing);
		await this.authorize(operation, target, input.signal);
		throwIfCancelled(input.signal);
		const duration = this.duration(input.maxDurationMs);
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timeout = setTimeout(() => reject(new WorkspaceFilesystemError("WORKSPACE_FS_TIME_LIMIT")), duration);
		});
		try {
			return await Promise.race([callback(target), deadline]);
		} catch (error) {
			throw errorForFs(error, operation, target.relativePath);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	private duration(requested: number | undefined): number {
		return boundedLimit(requested, this.limits.maxDurationMs, this.limits.maxDurationMs, "maxDurationMs");
	}

	private resolveInput(input: { workspaceId: string; path: string }, allowMissing = false): ResolvedPath {
		return this.resolveTarget(input.workspaceId, canonicalRelativePath(input.path), allowMissing);
	}

	private resolveTarget(workspaceId: string, path: string, allowMissing: boolean): ResolvedPath {
		const root = this.rootById.get(workspaceId);
		if (!root) throw new WorkspaceFilesystemError("WORKSPACE_FS_INVALID_ROOT");
		const relativePath = canonicalRelativePath(path);
		const absolutePath = resolve(root.path, ...(relativePath === "." ? [] : relativePath.split("/")));
		const outside = relative(root.path, absolutePath);
		if (outside === ".." || outside.startsWith(`..${resolve("/")}`) || isAbsolute(outside))
			throw new WorkspaceFilesystemError("WORKSPACE_FS_PATH_ESCAPE");
		const parts = relativePath === "." ? [] : relativePath.split("/");
		let current = root.path;
		for (let index = 0; index < parts.length; index++) {
			current = join(current, parts[index]);
			try {
				const info = lstatSync(current);
				if (info.isSymbolicLink()) throw new WorkspaceFilesystemError("WORKSPACE_FS_SYMLINK_DISALLOWED");
				if (!info.isDirectory() && index < parts.length - 1)
					throw new WorkspaceFilesystemError("WORKSPACE_FS_INVALID_TARGET");
			} catch (error) {
				if (isWorkspaceError(error)) throw error;
				if (fsCode(error) === "ENOENT" && allowMissing && index === parts.length - 1) break;
				throw errorForFs(error, "resolve", relativePath);
			}
		}
		return { root, relativePath, absolutePath };
	}

	private pathFromAbsolute(root: WorkspaceRoot, absolute: string): string {
		const value = relative(root.path, resolve(absolute));
		if (value === "" || value === ".") return ".";
		return canonicalRelativePath(value);
	}

	private async authorize(
		operation: WorkspaceFilesystemOperation,
		target: ResolvedPath,
		signal: AbortSignal | undefined,
	): Promise<void> {
		const policy = this.options.policy;
		if (!policy) return;
		throwIfCancelled(signal);
		const requested = workspaceFilesystemAuthority(operation, target.root.id);
		const scope = policy.authority ? intersectCapabilityAuthorities(policy.authority, requested) : requested;
		if (!this.scopeAllows(operation, scope)) throw new WorkspaceFilesystemError("WORKSPACE_FS_POLICY_DENIED");
		const request: WorkspaceFilesystemPolicyRequest = {
			requestId: randomUUID(),
			origin: "agent",
			principal: policy.principal,
			session: policy.session,
			turn: policy.turn,
			workflow: policy.workflow,
			step: policy.step,
			manifest: capabilityManifest(operation, this.limits),
			scope,
			layers: policy.layers,
			signal,
			capability: "workspace-filesystem",
			operation,
			workspaceId: target.root.id,
			relativePath: target.relativePath,
		};
		let result: PolicyEvaluationResult;
		try {
			result = await policy.provider.evaluate(request as PolicyRequest);
		} catch {
			throw new WorkspaceFilesystemError("WORKSPACE_FS_POLICY_INVALID");
		}
		if (!result?.decision || result.decision.policyVersion !== policy.policyVersion)
			throw new WorkspaceFilesystemError("WORKSPACE_FS_POLICY_INVALID");
		if (result.scope && !this.scopeAllows(operation, result.scope))
			throw new WorkspaceFilesystemError("WORKSPACE_FS_POLICY_DENIED");
		if (result.decision.kind !== "allow") throw new WorkspaceFilesystemError("WORKSPACE_FS_POLICY_DENIED");
	}

	private scopeAllows(operation: WorkspaceFilesystemOperation, scope: CapabilityAuthority): boolean {
		return (
			scope.capabilities.includes(OPERATION_CAPABILITIES[operation]) &&
			OPERATION_EFFECTS[operation].every((effect) => scope.effects.includes(effect))
		);
	}

	private async secureStat(target: ResolvedPath, signal: AbortSignal | undefined): Promise<Stats> {
		throwIfCancelled(signal);
		try {
			const info = await lstat(target.absolutePath);
			if (info.isSymbolicLink()) throw new WorkspaceFilesystemError("WORKSPACE_FS_SYMLINK_DISALLOWED");
			if (!info.isFile() && !info.isDirectory())
				throw new WorkspaceFilesystemError("WORKSPACE_FS_SPECIAL_FILE_DISALLOWED");
			return info;
		} catch (error) {
			throw errorForFs(error, "stat", target.relativePath);
		}
	}

	private async readSecure(
		target: ResolvedPath,
		signal: AbortSignal | undefined,
		maxBytes: number,
	): Promise<SecureFile> {
		let handle: FileHandle | undefined;
		try {
			throwIfCancelled(signal);
			const before = await lstat(target.absolutePath);
			if (before.isSymbolicLink()) throw new WorkspaceFilesystemError("WORKSPACE_FS_SYMLINK_DISALLOWED");
			if (!before.isFile()) {
				if (before.isDirectory()) throw new WorkspaceFilesystemError("WORKSPACE_FS_INVALID_TARGET");
				throw new WorkspaceFilesystemError("WORKSPACE_FS_SPECIAL_FILE_DISALLOWED");
			}
			if (before.nlink > 1) throw new WorkspaceFilesystemError("WORKSPACE_FS_HARDLINK_DISALLOWED");
			handle = await open(target.absolutePath, constants.O_RDONLY | O_NOFOLLOW);
			const after = await handle.stat();
			if (!after.isFile() || after.nlink > 1 || (before.ino && after.ino && before.ino !== after.ino))
				throw new WorkspaceFilesystemError(
					after.nlink > 1 ? "WORKSPACE_FS_HARDLINK_DISALLOWED" : "WORKSPACE_FS_SYMLINK_DISALLOWED",
				);
			const bytes = await readHandle(handle, after.size, signal, maxBytes);
			return { stats: after, bytes };
		} catch (error) {
			if (handle) await handle.close().catch(() => undefined);
			throw errorForFs(error, "read", target.relativePath);
		} finally {
			if (handle) await handle.close().catch(() => undefined);
		}
	}

	private async metadataInternal(
		target: ResolvedPath,
		signal: AbortSignal | undefined,
	): Promise<WorkspaceFileMetadata> {
		const info = await this.secureStat(target, signal);
		const result: WorkspaceFileMetadata = {
			path: target.relativePath,
			kind: info.isDirectory() ? "directory" : "file",
			sizeBytes: info.size,
			modifiedAt: new Date(info.mtimeMs).toISOString(),
			...(mediaType(target.relativePath) ? { mediaType: mediaType(target.relativePath) } : {}),
		};
		if (info.isFile()) {
			if (info.size > this.limits.maxReadBytes) {
				const version = this.statVersion(info);
				return { ...result, version, artifact: this.makeArtifact(target, info.size, version) };
			}
			const secure = await this.readSecure(target, signal, this.limits.maxReadBytes);
			const version = digest(secure.bytes);
			return { ...result, version, artifact: this.makeArtifact(target, info.size, version) };
		}
		return result;
	}

	private statVersion(info: Stats): string {
		return `stat:${info.size}:${Math.floor(info.mtimeMs)}:${info.ino}`;
	}

	private makeArtifact(target: ResolvedPath, sizeBytes: number, version: string): WorkspaceArtifact {
		const artifact: WorkspaceArtifact = {
			artifact: { id: artifactId(target.root.id, target.relativePath), kind: "workspace-file" },
			version,
			digest: version,
			workspaceId: target.root.id,
			relativePath: target.relativePath,
			sizeBytes,
			observedAt: now(),
			...(this.options.provenance ? { provenance: this.options.provenance } : {}),
		};
		return Object.freeze(artifact);
	}

	private selectLines(text: string, startLine = 1, endLine?: number, maxLines = this.limits.maxLines): string {
		if (
			!Number.isSafeInteger(startLine) ||
			startLine < 1 ||
			(endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < startLine))
		)
			throw new WorkspaceFilesystemError("WORKSPACE_FS_INVALID_PATH");
		const lines = text.split(/\r?\n/);
		const selected = lines.slice(startLine - 1, endLine);
		if (selected.length > maxLines) throw new WorkspaceFilesystemError("WORKSPACE_FS_LINE_LIMIT");
		return selected.join("\n");
	}

	private async writeInternal(
		target: ResolvedPath,
		input: WorkspaceWriteInput | (WorkspacePatchInput & { readonly content: string }),
		operation: "write" | "patch",
	): Promise<WorkspaceWriteResult> {
		throwIfCancelled(input.signal);
		const startedAt = performance.now();
		const bytes = asBytes(input.content);
		const maxBytes = boundedLimit(input.maxBytes, this.limits.maxWriteBytes, this.limits.maxWriteBytes, "maxBytes");
		if (bytes.byteLength > maxBytes) throw new WorkspaceFilesystemError("WORKSPACE_FS_SIZE_LIMIT");
		let existing: Stats | undefined;
		try {
			existing = await lstat(target.absolutePath);
			if (existing.isSymbolicLink()) throw new WorkspaceFilesystemError("WORKSPACE_FS_SYMLINK_DISALLOWED");
			if (!existing.isFile())
				throw new WorkspaceFilesystemError(
					existing.isDirectory() ? "WORKSPACE_FS_INVALID_TARGET" : "WORKSPACE_FS_SPECIAL_FILE_DISALLOWED",
				);
			if (existing.nlink > 1) throw new WorkspaceFilesystemError("WORKSPACE_FS_HARDLINK_DISALLOWED");
		} catch (error) {
			if (fsCode(error) !== "ENOENT" || isWorkspaceError(error))
				throw errorForFs(error, operation, target.relativePath);
		}
		if (existing && input.expectedVersion === undefined)
			throw new WorkspaceFilesystemError("WORKSPACE_FS_VERSION_REQUIRED");
		if (input.expectedVersion !== undefined) {
			if (!existing) throw new WorkspaceFilesystemError("WORKSPACE_FS_VERSION_CONFLICT");
			const currentVersion =
				existing.size > this.limits.maxReadBytes
					? this.statVersion(existing)
					: digest((await this.readSecure(target, input.signal, this.limits.maxReadBytes)).bytes);
			if (currentVersion !== input.expectedVersion) throw new WorkspaceFilesystemError("WORKSPACE_FS_VERSION_CONFLICT");
		}
		const parent = dirname(target.absolutePath);
		const parentTarget = this.resolveTarget(target.root.id, this.pathFromAbsolute(target.root, parent), false);
		const parentInfo = await this.secureStat(parentTarget, input.signal);
		if (!parentInfo.isDirectory()) throw new WorkspaceFilesystemError("WORKSPACE_FS_INVALID_TARGET");
		const temporary = join(parent, `.${target.absolutePath.split(/[\\/]/).at(-1) ?? "file"}.blok-${randomUUID()}.tmp`);
		let temporaryHandle: FileHandle | undefined;
		try {
			temporaryHandle = await open(temporary, "wx");
			await temporaryHandle.writeFile(bytes);
			await temporaryHandle.sync();
			await temporaryHandle.close();
			temporaryHandle = undefined;
			throwIfCancelled(input.signal);
			if (performance.now() - startedAt > this.duration(input.maxDurationMs))
				throw new WorkspaceFilesystemError("WORKSPACE_FS_TIME_LIMIT");
			if (existing) {
				const latest = await lstat(target.absolutePath);
				if (latest.isSymbolicLink() || !latest.isFile() || latest.nlink > 1)
					throw new WorkspaceFilesystemError("WORKSPACE_FS_VERSION_CONFLICT");
				const latestVersion =
					latest.size > this.limits.maxReadBytes
						? this.statVersion(latest)
						: digest((await this.readSecure(target, input.signal, this.limits.maxReadBytes)).bytes);
				if (input.expectedVersion !== undefined && latestVersion !== input.expectedVersion)
					throw new WorkspaceFilesystemError("WORKSPACE_FS_VERSION_CONFLICT");
			} else {
				try {
					await lstat(target.absolutePath);
					throw new WorkspaceFilesystemError("WORKSPACE_FS_VERSION_CONFLICT");
				} catch (error) {
					if (isWorkspaceError(error)) throw error;
					if (fsCode(error) !== "ENOENT") throw errorForFs(error, operation, target.relativePath);
				}
			}
			await rename(temporary, target.absolutePath);
		} catch (error) {
			if (temporaryHandle) await temporaryHandle.close().catch(() => undefined);
			await rm(temporary, { force: true }).catch(() => undefined);
			if (isWorkspaceError(error)) throw error;
			if (fsCode(error) === "EPERM" || fsCode(error) === "EEXIST")
				throw new WorkspaceFilesystemError("WORKSPACE_FS_ATOMIC_REPLACE_UNSUPPORTED");
			throw errorForFs(error, operation, target.relativePath);
		}
		const version = digest(bytes);
		return {
			workspaceId: target.root.id,
			path: target.relativePath,
			created: !existing,
			bytesWritten: bytes.byteLength,
			version,
			artifact: this.makeArtifact(target, bytes.byteLength, version),
		};
	}

	private async directoriesForWatch(directory: string, signal: AbortSignal | undefined): Promise<string[]> {
		const directories = [directory];
		for (let index = 0; index < directories.length && directories.length < this.limits.maxListFiles; index++) {
			throwIfCancelled(signal);
			for (const child of await readdir(directories[index], { withFileTypes: true })) {
				if (directories.length >= this.limits.maxListFiles) break;
				if (child.isSymbolicLink() || !child.isDirectory()) continue;
				directories.push(join(directories[index], child.name));
			}
		}
		return directories;
	}

	private async watchEvent(
		workspaceId: string,
		path: string,
		eventType: "rename" | "change",
	): Promise<WorkspaceWatchEvent> {
		const target = this.resolveTarget(workspaceId, path, true);
		try {
			const info = await this.secureStat(target, undefined);
			if (info.isFile()) {
				if (info.size > this.limits.maxReadBytes) {
					const version = this.statVersion(info);
					return {
						type: eventType === "rename" ? "created" : "changed",
						workspaceId,
						path,
						version,
						artifact: this.makeArtifact(target, info.size, version),
						requiresRescan: false,
						observedAt: now(),
					};
				}
				const secure = await this.readSecure(target, undefined, this.limits.maxReadBytes);
				const version = digest(secure.bytes);
				return {
					type: eventType === "rename" ? "created" : "changed",
					workspaceId,
					path,
					version,
					artifact: this.makeArtifact(target, info.size, version),
					requiresRescan: false,
					observedAt: now(),
				};
			}
		} catch (error) {
			if (!isWorkspaceError(error) || error.code !== "WORKSPACE_FS_NOT_FOUND") throw error;
		}
		return { type: "deleted", workspaceId, path, requiresRescan: false, observedAt: now() };
	}
}

function applyPatches(source: string, patches: readonly WorkspaceTextPatch[]): string {
	const ordered = [...patches].sort((left, right) => left.start - right.start);
	let cursor = 0;
	let output = "";
	for (const patch of ordered) {
		if (
			!Number.isSafeInteger(patch.start) ||
			!Number.isSafeInteger(patch.end) ||
			patch.start < cursor ||
			patch.end < patch.start ||
			patch.end > source.length
		)
			throw new WorkspaceFilesystemError("WORKSPACE_FS_PATCH_INVALID");
		output += source.slice(cursor, patch.start) + patch.replacement;
		cursor = patch.end;
	}
	return output + source.slice(cursor);
}
