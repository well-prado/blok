import type { ModelAdapter, ModelStreamChunk } from "@blokjs/agent-kernel";
import type { WorkspaceWriteResult } from "@blokjs/capabilities";
import type { CodeModeGeneratedSurface } from "@blokjs/code-mode";
import { HarnessControlPlaneClient } from "@blokjs/control-plane";
import { InMemoryInteractionStore, MemorySessionStore } from "@blokjs/runner";
import type {
	GitDiffEvidence,
	GitRepositoryIdentity,
	GitWorktreeIdentity,
	PolicyEvaluationResult,
	PolicyProvider,
	ProcessResult,
	ProcessStartResult,
	SessionEventInput,
	SessionJsonValue,
} from "@blokjs/shared";
import type {
	AuthoritativeSourceReader,
	GitCapability,
	GraphProvider,
	ProcessCapability,
	ProcessSpec,
} from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import {
	type CodingHarnessPorts,
	CodingHarnessRuntime,
	type CodingHarnessTaskInput,
	DesktopCodingHarnessClient,
	startCodingHarnessServer,
	stateFromEvents,
} from "./vertical-slice";

const digest = `sha256:${"a".repeat(64)}`;
const repository: GitRepositoryIdentity = {
	repository: { provider: "git", id: "repo-1" },
	checkout: { workspaceId: "source", path: "." },
	head: { commit: "abcdef1", ref: "main" },
	dirty: { status: "clean", fingerprint: digest, changedPaths: [] },
	owner: { principal: { id: "task-1", kind: "desktop-task" }, sessionId: "session-1", taskId: "task-1" },
};

const worktree: GitWorktreeIdentity = {
	version: "1",
	id: "worktree-1",
	repository,
	path: { workspaceId: "task-worktree", path: "." },
	branch: "codex/task-1",
	base: repository.head,
	head: repository.head,
	sourceDirty: repository.dirty,
	owner: repository.owner,
	status: "active",
	createdAt: "2026-09-05T12:00:00.000Z",
};

const processHandle = {
	version: "1" as const,
	id: "process-1",
	owner: repository.owner,
	specDigest: digest,
	status: "exited" as const,
	startedAt: "2026-09-05T12:00:00.000Z",
	updatedAt: "2026-09-05T12:00:00.000Z",
	pid: 42,
	terminal: "pipe" as const,
	background: "foreground" as const,
	outputBytes: 9,
	outputTruncated: false,
};

const processResult: ProcessResult = {
	handle: processHandle,
	status: "exited",
	exitCode: 0,
	output: { stdout: "9 passed", stderr: "", capturedBytes: 8, totalBytes: 8, truncated: false },
	durationMs: 12,
};

function sessionCreated(sessionId: string): SessionEventInput {
	return {
		contractVersion: "1",
		schemaVersion: 1,
		id: `${sessionId}:created`,
		sessionId,
		kind: "session.created",
		visibility: "operational",
		actor: { kind: "user", id: "desktop" },
		occurredAt: "2026-09-05T12:00:00.000Z",
		payload: { sessionId },
	};
}

function testSpec(cwd = worktree.path): ProcessSpec {
	return {
		version: "1",
		mode: "executable",
		executable: "bun",
		args: ["test", "src/app.test.ts"],
		cwd,
		env: [],
		stdin: "closed",
		terminal: "pipe",
		limits: {
			maxWallTimeMs: 120_000,
			maxCpuTimeMs: 60_000,
			maxMemoryBytes: 512 * 1024 * 1024,
			maxOutputBytes: 4 * 1024 * 1024,
			maxInputBytes: 1024,
			maxProcesses: 1,
		},
		network: { mode: "none" },
		background: "foreground",
	};
}

function sourceReader(reads: string[]): AuthoritativeSourceReader {
	return {
		async read(input) {
			reads.push(input.path);
			return {
				scope: input.scope,
				path: input.path,
				contentHash: digest,
				commit: repository.head.commit,
				bytes: 28,
				content: "export const greeting = 'hello';",
			};
		},
	};
}

function gitCapability(calls: string[]): GitCapability {
	const diff: GitDiffEvidence = {
		version: "1",
		repository: repository.repository,
		worktree,
		base: worktree.base,
		head: worktree.head,
		dirty: worktree.sourceDirty,
		files: [{ path: "src/app.ts", status: "modified", contentHash: digest, sizeBytes: 28 }],
		evidenceHash: digest,
		capturedAt: "2026-09-05T12:00:00.000Z",
	};
	return {
		async inspectRepository() {
			calls.push("inspect");
			return repository;
		},
		async createWorktree() {
			calls.push("worktree");
			return worktree;
		},
		async inspectWorktree() {
			calls.push("inspect-worktree");
			return worktree;
		},
		async diff() {
			calls.push("diff");
			return diff;
		},
		async cleanup() {
			calls.push("cleanup");
			return { ...worktree, status: "cleaned", cleanedAt: "2026-09-05T12:00:00.000Z" };
		},
	};
}

function graphProvider(): GraphProvider {
	const staleFreshness = {
		state: "stale" as const,
		checkedAt: "2026-09-05T12:00:00.000Z",
		indexedCommit: "0000001",
		observedCommit: repository.head.commit,
		reason: "branch changed",
	};
	const status = { primary: "stale" as const, states: ["stale" as const], complete: false };
	const response = <T>(items: readonly T[] = []) => ({
		version: "1" as const,
		authority: "navigation-only" as const,
		items,
		status,
		freshness: staleFreshness,
		errors: [],
	});
	return {
		id: "tetrix",
		version: "tetrix-1",
		async search() {
			return response();
		},
		async findSymbol() {
			return response();
		},
		async relations() {
			return response();
		},
		async impact() {
			return response();
		},
		async freshness() {
			return response();
		},
		async index() {
			return {
				version: "1" as const,
				authority: "navigation-only" as const,
				indexedFiles: [],
				skippedFiles: [],
				status,
				freshness: staleFreshness,
				errors: [],
			};
		},
	};
}

function policyProvider(decisions: string[]): PolicyProvider {
	return {
		async evaluate(request): Promise<PolicyEvaluationResult> {
			decisions.push(`${request.step.id}:${request.scope.capabilities[0]}`);
			return {
				decision: {
					kind: "allow",
					id: `allow-${request.step.id}`,
					reasonCode: "test-allow",
					policyVersion: "desktop-v1",
				},
				matchedRules: [{ layer: "phase", ruleId: "test-allow", effect: "allow" }],
			};
		},
	};
}

function processCapability(calls: string[]): ProcessCapability {
	return {
		async start(request): Promise<ProcessStartResult> {
			calls.push(`process:${request.spec.cwd.workspaceId}`);
			return {
				kind: "completed",
				result: { ...processResult, handle: { ...processResult.handle, owner: request.owner } },
			};
		},
		async inspect() {
			return processHandle;
		},
		async *readOutput() {
			yield { stream: "stdout" as const, sequence: 1, data: "9 passed", byteLength: 8 };
		},
		async cancel() {
			return processHandle;
		},
		async cleanupOrphans() {
			return [];
		},
	};
}

function codeModeSurface(phase: "planning" | "review", stableName: string): CodeModeGeneratedSurface {
	return {
		contractVersion: "1",
		catalogVersion: "catalog-1",
		phase,
		bindings: [
			{
				stableName,
				descriptor: {
					contractVersion: "1",
					kind: "capability",
					id: stableName,
					version: "1.0.0",
					name: stableName,
					description: "test binding",
					inputSchema: { type: "object" },
					outputSchema: { type: "string" },
					outputKind: "scalar",
					effects: [],
					capabilities: [],
					maturity: "stable",
					phases: [phase],
					implementationOnly: false,
				},
				invoke: async () => "binding result",
			},
		],
		unavailable: [],
		declarations: `const ${stableName} = ...;`,
		prompt: "",
		truncated: false,
		cacheKey: `${phase}:${stableName}`,
	};
}

async function setup() {
	const sessionStore = new MemorySessionStore();
	await sessionStore.append({ sessionId: "session-1", expectedSequence: 0, events: [sessionCreated("session-1")] });
	const interactionStore = new InMemoryInteractionStore();
	const gitCalls: string[] = [];
	const processCalls: string[] = [];
	const reads: string[] = [];
	const decisions: string[] = [];
	const writes: WorkspaceWriteResult[] = [];
	const ports: CodingHarnessPorts = {
		sessionStore,
		interactionStore,
		git: gitCapability(gitCalls),
		graph: graphProvider(),
		source: sourceReader(reads),
		process: processCapability(processCalls),
		policy: policyProvider(decisions),
		testSpec: () => testSpec(),
		implement: async ({ worktree: target }) => {
			const write = {
				workspaceId: target.path.workspaceId,
				path: "src/app.ts",
				created: false,
				bytesWritten: 28,
				version: digest,
				artifact: { artifact: { id: "app", kind: "source" }, version: digest, digest },
			} as WorkspaceWriteResult;
			writes.push(write);
			return { writes: [write], artifact: { path: write.path, version: write.version } };
		},
	};
	const runtime = new CodingHarnessRuntime(ports);
	return { runtime, ports, sessionStore, interactionStore, gitCalls, processCalls, reads, decisions, writes };
}

const task = {
	taskId: "task-1",
	objective: "update the greeting",
	repository,
	sourcePaths: ["src/app.ts"],
} satisfies CodingHarnessTaskInput;

describe("desktop coding harness vertical slice", () => {
	it("keeps planning read-only, persists approval, confines writes, and uses trusted test evidence", async () => {
		const fixture = await setup();
		const controller = new AbortController();
		const execution = fixture.runtime.executeWorkflow({
			sessionId: "session-1",
			workflowRunId: "workflow-1",
			workflowName: "strict-coding-reference",
			input: task as unknown as SessionJsonValue,
			signal: controller.signal,
		});

		let approvalId: string | undefined;
		for (let attempt = 0; attempt < 40 && !approvalId; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			const events = (await fixture.sessionStore.read("session-1", { afterSequence: 0, limit: 256 })).events;
			approvalId = events.find((event) => event.kind === "approval.requested")?.interactionId;
		}
		expect(approvalId).toBeDefined();
		expect(fixture.gitCalls).toEqual(["inspect"]);
		expect(fixture.processCalls).toEqual([]);
		expect(fixture.reads).toEqual(["src/app.ts"]);

		const pending = await fixture.interactionStore.get(approvalId as string);
		expect(pending?.status).toBe("pending");
		await fixture.interactionStore.answer({
			id: approvalId as string,
			principalId: "task-1",
			sequence: 0,
			answer: { approved: true },
		});
		await expect(execution).resolves.toMatchObject({ output: { phase: "complete" } });

		const events = (await fixture.sessionStore.read("session-1", { afterSequence: 0, limit: 256 })).events;
		const state = stateFromEvents("session-1", task, events);
		expect(state.phase).toBe("complete");
		expect(state.graphFallback?.paths).toEqual(["src/app.ts"]);
		expect(state.evidence).toMatchObject({ producer: "trusted-process", status: "passed" });
		expect(state.diff).toMatchObject({ files: [{ path: "src/app.ts" }] });
		expect(fixture.gitCalls).toEqual(["inspect", "worktree", "diff"]);
		expect(fixture.processCalls).toEqual(["process:task-worktree"]);
		expect(fixture.writes).toHaveLength(1);
		expect(fixture.writes[0]?.workspaceId).toBe("task-worktree");
	});

	it("reconstructs an answered approval after the in-memory execution is restarted", async () => {
		const fixture = await setup();
		const first = new AbortController();
		const interrupted = fixture.runtime.executeWorkflow({
			sessionId: "session-1",
			workflowRunId: "workflow-1",
			workflowName: "strict-coding-reference",
			input: task as unknown as SessionJsonValue,
			signal: first.signal,
		});
		await fixture.sessionStore.append({
			sessionId: "session-1",
			expectedSequence: (await fixture.sessionStore.fold("session-1")).lastSequence,
			events: [
				{
					contractVersion: "1",
					schemaVersion: 1,
					id: "workflow-1:request",
					sessionId: "session-1",
					kind: "workflow.run.started",
					visibility: "operational",
					actor: { kind: "user", id: "desktop" },
					occurredAt: "2026-09-05T12:00:00.000Z",
					payload: {
						workflowRunId: "workflow-1",
						workflowName: "strict-coding-reference",
						input: task as unknown as SessionJsonValue,
					},
				},
			],
		});
		let approvalId: string | undefined;
		for (let attempt = 0; attempt < 40 && !approvalId; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			const events = (await fixture.sessionStore.read("session-1", { afterSequence: 0, limit: 256 })).events;
			approvalId = events.find((event) => event.kind === "approval.requested")?.interactionId;
		}
		first.abort();
		await expect(interrupted).rejects.toThrow("approval cancelled");
		await fixture.interactionStore.answer({
			id: approvalId as string,
			principalId: "task-1",
			sequence: 0,
			answer: { approved: true },
		});

		const restarted = new CodingHarnessRuntime({
			...(await setup()).ports,
			sessionStore: fixture.sessionStore,
			interactionStore: fixture.interactionStore,
		});
		await expect(restarted.recoverSession("session-1")).resolves.toBeUndefined();
		const events = (await fixture.sessionStore.read("session-1", { afterSequence: 0, limit: 256 })).events;
		expect(
			events.some(
				(event) =>
					event.kind === "workflow.run.completed" && (event.payload as Record<string, unknown>).phase === "complete",
			),
		).toBe(true);
	});

	it("rejects a test command that points outside the task worktree", async () => {
		const fixture = await setup();
		const runtime = new CodingHarnessRuntime({
			...(await setup()).ports,
			sessionStore: fixture.sessionStore,
			interactionStore: fixture.interactionStore,
			testSpec: () => testSpec({ workspaceId: "source", path: "." }),
		});
		const execution = runtime.executeWorkflow({
			sessionId: "session-1",
			workflowRunId: "workflow-1",
			workflowName: "strict-coding-reference",
			input: task as unknown as SessionJsonValue,
			signal: new AbortController().signal,
		});
		let approvalId: string | undefined;
		for (let attempt = 0; attempt < 40 && !approvalId; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			const events = (await fixture.sessionStore.read("session-1", { afterSequence: 0, limit: 256 })).events;
			approvalId = events.find((event) => event.kind === "approval.requested")?.interactionId;
		}
		await fixture.interactionStore.answer({
			id: approvalId as string,
			principalId: "task-1",
			sequence: 0,
			answer: { approved: true },
		});
		await expect(execution).rejects.toThrow("test process cwd must be the task worktree");
	});

	it("runs headlessly through the authenticated control-plane client", async () => {
		const fixture = await setup();
		const harness = await startCodingHarnessServer({ ...fixture.ports, token: "desktop-test-token" });
		const client = new HarnessControlPlaneClient({ endpoint: harness.server, principalId: "task-1" });
		try {
			const run = await new DesktopCodingHarnessClient(client).run(task, {
				onApproval: async ({ sessionId, interactionId, sequence }) => {
					await client.answerInteraction(sessionId, {
						interactionId,
						sequence,
						answer: { approved: true },
					});
				},
			});
			expect(run.state.phase).toBe("complete");
			expect(run.state.evidence?.status).toBe("passed");
			expect(run.events.some((event) => event.kind === "approval.requested")).toBe(true);
		} finally {
			client.close();
			await harness.server.stop();
		}
	}, 30_000);

	it("scopes internally constructed model requests to each Code Mode phase", async () => {
		const fixture = await setup();
		const toolsByRequest: string[][] = [];
		const modelAdapter: ModelAdapter = {
			name: "test-model",
			async *stream(request): AsyncIterable<ModelStreamChunk> {
				toolsByRequest.push(request.tools.map((tool) => tool.name));
				yield { kind: "text-delta", index: 0, text: "model result" };
				yield { kind: "finish", index: 1, reason: "stop" };
			},
		};
		const runtime = new CodingHarnessRuntime({
			...fixture.ports,
			modelAdapter,
			codeModeSurfaces: {
				planning: codeModeSurface("planning", "planning.read"),
				review: codeModeSurface("review", "review.diff"),
			},
		});
		const execution = runtime.executeWorkflow({
			sessionId: "session-1",
			workflowRunId: "workflow-1",
			workflowName: "strict-coding-reference",
			input: task as unknown as SessionJsonValue,
			signal: new AbortController().signal,
		});
		let approvalId: string | undefined;
		for (let attempt = 0; attempt < 40 && !approvalId; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			const events = (await fixture.sessionStore.read("session-1", { afterSequence: 0, limit: 256 })).events;
			approvalId = events.find((event) => event.kind === "approval.requested")?.interactionId;
		}
		await fixture.interactionStore.answer({
			id: approvalId as string,
			principalId: "task-1",
			sequence: 0,
			answer: { approved: true },
		});
		await expect(execution).resolves.toMatchObject({ output: { phase: "complete" } });
		expect(toolsByRequest).toEqual([["planning.read"], ["review.diff"]]);
	});

	it("does not execute a shell-string test command", async () => {
		const fixture = await setup();
		const runtime = new CodingHarnessRuntime({
			...fixture.ports,
			testSpec: () => ({ ...testSpec(), mode: "shell-string", shell: "sh", command: "bun test" }),
		});
		const execution = runtime.executeWorkflow({
			sessionId: "session-1",
			workflowRunId: "workflow-1",
			workflowName: "strict-coding-reference",
			input: task as unknown as SessionJsonValue,
			signal: new AbortController().signal,
		});
		let approvalId: string | undefined;
		for (let attempt = 0; attempt < 40 && !approvalId; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			const events = (await fixture.sessionStore.read("session-1", { afterSequence: 0, limit: 256 })).events;
			approvalId = events.find((event) => event.kind === "approval.requested")?.interactionId;
		}
		await fixture.interactionStore.answer({
			id: approvalId as string,
			principalId: "task-1",
			sequence: 0,
			answer: { approved: true },
		});
		await expect(execution).rejects.toThrow("structured executable process specs");
		expect(fixture.processCalls).toEqual([]);
	});
});
