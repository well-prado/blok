import { describe, expect, it } from "vitest";
import {
	CapabilityContractError,
	assertGitOperationAllowed,
	assertProcessOwner,
	assertProcessPolicyAllowed,
	assertProcessStartResult,
	gitCapabilityScope,
	parseGitDiffEvidence,
	parseGitDirtyState,
	parseGitWorktreeCreateRequest,
	parseProcessCancellationRequest,
	parseProcessHandle,
	parseProcessOrphanCleanupRequest,
	parseProcessOutput,
	parseProcessOutputChunk,
	parseProcessResult,
	parseProcessSpec,
	processCapabilityId,
	processCapabilityScope,
} from "../../src/index";

const hash = `sha256:${"a".repeat(64)}`;
const owner = {
	principal: { id: "agent-1", kind: "agent" },
	sessionId: "session-1",
	turnId: "turn-1",
	taskId: "task-1",
};
const cwd = { workspaceId: "workspace-1", path: "worktree" };
const limits = {
	maxWallTimeMs: 10_000,
	maxCpuTimeMs: 5_000,
	maxMemoryBytes: 64 * 1024 * 1024,
	maxOutputBytes: 1_024,
	maxInputBytes: 1_024,
	maxProcesses: 2,
};
const executable = {
	version: "1" as const,
	mode: "executable" as const,
	executable: "node",
	args: ["-e", "console.log('; literal argument')"],
	cwd,
	env: [{ name: "CI", source: "host" as const, reference: "CI" }],
	stdin: "closed" as const,
	terminal: "pipe" as const,
	limits,
	network: { mode: "none" as const },
	background: "foreground" as const,
};

function policy(kind: "allow" | "ask" | "require-sandbox") {
	return {
		decision: { kind, id: "decision-1", reasonCode: "test", policyVersion: "1" },
		matchedRules: [],
	};
}

describe("H3 Git and process capability contracts", () => {
	it("keeps executable arguments structured, including shell metacharacters as literals", () => {
		const parsed = parseProcessSpec(executable);
		expect(parsed.mode).toBe("executable");
		expect(parsed.args[1]).toContain("literal argument");
		expect(processCapabilityId(parsed)).toBe("process.exec");
	});

	it("normalizes bounded process defaults and derives network/secret effects", () => {
		const defaults = parseProcessSpec({
			version: "1",
			mode: "executable",
			executable: "node",
			args: [],
			cwd,
		});
		expect(defaults.limits.maxOutputBytes).toBe(4 * 1024 * 1024);
		expect(defaults.network).toEqual({ mode: "none" });
		const parsed = parseProcessSpec({
			...executable,
			env: [{ name: "TOKEN", source: "secret", reference: "github.token" }],
			network: { mode: "allowlist", destinations: [{ protocol: "tcp", host: "api.example.com", port: 443 }] },
			terminal: "pty",
			background: "durable",
		});
		expect(parsed.limits.maxOutputBytes).toBe(limits.maxOutputBytes);
		expect(processCapabilityId(parsed)).toBe("process.pty");
		expect(processCapabilityScope(parsed)).toMatchObject({
			effects: ["network", "process", "streaming"],
			capabilities: ["process.pty"],
			secrets: ["github.token"],
		});
	});

	it("classifies shell strings separately and requires an explicit allow decision", () => {
		const shell = parseProcessSpec({ ...executable, mode: "shell-string", shell: "/bin/sh", command: "echo ok" });
		expect(processCapabilityId(shell)).toBe("shell.exec");
		expect(() => assertProcessPolicyAllowed(shell, policy("ask"))).toThrow(/explicit allow/);
		expect(() => assertProcessPolicyAllowed(shell, policy("require-sandbox"))).toThrow(/explicit allow/);
		expect(() => assertProcessPolicyAllowed(shell, policy("allow"))).not.toThrow();
	});

	it("rejects path escape, duplicate environment bindings, and NUL injection", () => {
		expect(() => parseProcessSpec({ ...executable, cwd: { workspaceId: "workspace-1", path: "../outside" } })).toThrow(
			CapabilityContractError,
		);
		expect(() => parseProcessSpec({ ...executable, env: [...executable.env, executable.env[0]] })).toThrow(
			/duplicate environment/,
		);
		expect(() => parseProcessSpec({ ...executable, args: ["ok\0bad"] })).toThrow(CapabilityContractError);
	});

	it("bounds output chunks by UTF-8 bytes and keeps handle ownership durable", () => {
		expect(() => parseProcessOutputChunk({ stream: "stdout", sequence: 0, data: "x", byteLength: 2 })).toThrow(
			/byteLength/,
		);
		expect(() =>
			parseProcessOutputChunk({ stream: "stdout", sequence: 0, data: "x".repeat(65 * 1024), byteLength: 65 * 1024 }),
		).toThrow(CapabilityContractError);
		expect(() =>
			parseProcessOutput({ stdout: "ok", stderr: "", capturedBytes: 0, totalBytes: 2, truncated: false }),
		).toThrow(/capturedBytes/);
		const handle = parseProcessHandle({
			version: "1",
			id: "process-1",
			owner,
			specDigest: hash,
			status: "running",
			startedAt: "2026-09-02T12:00:00.000Z",
			updatedAt: "2026-09-02T12:00:00.000Z",
			terminal: "pty",
			background: "durable",
			outputBytes: 0,
			outputTruncated: false,
		});
		expect(() => assertProcessOwner(handle, { ...owner, taskId: "other-task" })).toThrow(/different task/);
		expect(() => assertProcessOwner(handle, owner)).not.toThrow();
		expect(() =>
			assertProcessStartResult({ ...executable, terminal: "pty", background: "durable" }, { kind: "started", handle }),
		).not.toThrow();
		expect(() => assertProcessStartResult(executable, { kind: "started", handle })).toThrow(/foreground/);
		expect(() =>
			parseProcessResult({
				handle: { ...handle, status: "exited" },
				status: "exited",
				output: { stdout: "ok", stderr: "", capturedBytes: 2, totalBytes: 2, truncated: false },
				durationMs: 10,
			}),
		).not.toThrow();
		expect(() =>
			parseProcessResult({
				handle,
				status: "exited",
				output: { stdout: "ok", stderr: "", capturedBytes: 2, totalBytes: 2, truncated: false },
				durationMs: 10,
			}),
		).toThrow(/match result status/);
	});

	it("validates cancellation and orphan cleanup timestamps", () => {
		const base = {
			policy: {},
			owner,
			handle: {
				version: "1",
				id: "process-1",
				owner,
				specDigest: hash,
				status: "running",
				startedAt: "2026-09-02T12:00:00.000Z",
				updatedAt: "2026-09-02T12:00:00.000Z",
				terminal: "pipe",
				background: "durable",
				outputBytes: 0,
				outputTruncated: false,
			},
		};
		expect(parseProcessCancellationRequest({ ...base, reason: "timeout", gracePeriodMs: 100 }).gracePeriodMs).toBe(100);
		expect(
			parseProcessOrphanCleanupRequest({ policy: {}, owner, olderThan: "2026-09-02T12:00:00.000Z" }).olderThan,
		).toContain("12:00");
		expect(() => parseProcessOrphanCleanupRequest({ policy: {}, owner, olderThan: "yesterday" })).toThrow(
			CapabilityContractError,
		);
	});

	it("requires dirty identities to name changed paths and includes file hashes in diff evidence", () => {
		const dirty = { status: "dirty" as const, fingerprint: hash, changedPaths: ["src/index.ts"] };
		expect(parseGitDirtyState(dirty)).toEqual(dirty);
		expect(() => parseGitDirtyState({ ...dirty, changedPaths: [] })).toThrow(/changed paths/);
		expect(() => parseGitDirtyState({ ...dirty, status: "clean", changedPaths: ["src/index.ts"] })).toThrow(
			/clean state/,
		);
		const repository = {
			repository: { provider: "git", id: "repo-1", revision: "main" },
			checkout: { workspaceId: "workspace-1", path: "checkout" },
			head: { commit: "abc1234", ref: "main" },
			dirty,
			owner,
		};
		const worktree = {
			version: "1" as const,
			id: "worktree-1",
			repository,
			path: cwd,
			branch: "codex/task-1",
			base: { commit: "abc1234", ref: "main" },
			head: { commit: "def5678", ref: "codex/task-1" },
			sourceDirty: dirty,
			owner,
			status: "active" as const,
			createdAt: "2026-09-02T12:00:00.000Z",
		};
		const evidence = parseGitDiffEvidence({
			version: "1",
			repository: repository.repository,
			worktree,
			base: worktree.base,
			head: worktree.head,
			dirty,
			files: [{ path: "src/index.ts", status: "modified", contentHash: hash }],
			evidenceHash: hash,
			capturedAt: "2026-09-02T12:00:00.000Z",
		});
		expect(evidence.files[0].contentHash).toBe(hash);
		expect(
			parseGitWorktreeCreateRequest({
				policy: {},
				owner,
				repository,
				base: repository.head,
				branch: "codex/task-1",
				preserveSourceChanges: true,
			}).preserveSourceChanges,
		).toBe(true);
		expect(() =>
			parseGitWorktreeCreateRequest({
				policy: {},
				owner,
				repository,
				base: repository.head,
				branch: "codex/task-1",
				preserveSourceChanges: false,
			}),
		).toThrow(CapabilityContractError);
	});

	it("denies destructive Git operations and scopes safe lifecycle operations", () => {
		expect(() => assertGitOperationAllowed("repository.reset")).toThrow(/destructive git operation/);
		expect(() => assertGitOperationAllowed("repository.inspect")).not.toThrow();
		expect(gitCapabilityScope("worktree.create")).toMatchObject({
			effects: ["read", "write"],
			capabilities: ["git.worktree.create"],
		});
	});
});
