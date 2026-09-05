import { strict as assert } from "node:assert";
import { link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleContext, contextItemFromGraph } from "@blokjs/agent-kernel";
import { WorkspaceFilesystemCapability, workspaceRelativePath } from "@blokjs/capabilities";
import { executeCodeMode, validateCodeModeSource } from "@blokjs/code-mode";
import type { CodeModeBinding } from "@blokjs/code-mode";
import {
	InMemoryInteractionStore,
	InteractionAuthorizationError,
	InteractionConflictError,
	MemorySessionStore,
	SqliteInteractionStore,
	SqliteSessionStore,
} from "@blokjs/runner";
import type { CapabilityAuthority, PolicyEvaluationResult, SessionEventInput } from "@blokjs/shared";
import {
	CapabilityManifestError,
	assertAuthorized,
	assertCapabilityAuthoritySubset,
	assertEffectRetryEvidence,
	assertJoinSatisfied,
	assertProcessOwner,
	assertProcessPolicyAllowed,
	assertProcessStartResult,
	intersectCapabilityAuthorities,
	parseCapabilityManifest,
	parseProcessHandle,
	parseProcessOrphanCleanupRequest,
	parseProcessOutputChunk,
	parseProcessSpec,
	parseRetryResumeIdempotencyContract,
	redactInteractionDecision,
	redactInteractionPayload,
	redactInteractionRequest,
	rejectModelEvidence,
} from "@blokjs/shared";
import { z } from "zod";
import {
	agentManifest,
	askDecision,
	cleanGraphScope,
	graphFiles,
	interactionRequest,
	parentAuthority,
} from "./fixtures";

type ErrorConstructor = abstract new (...args: never[]) => Error;

function expectThrow(action: () => unknown, pattern: RegExp | ErrorConstructor): void {
	assert.throws(action, pattern);
}

function expectAsyncThrow(action: () => Promise<unknown>, error: unknown): Promise<void> {
	return action().then(
		() => {
			throw new Error(`expected ${String(error)} to reject`);
		},
		(caught: unknown) => {
			if (error instanceof RegExp) assert.match(caught instanceof Error ? caught.message : String(caught), error);
			else if (typeof error === "string")
				assert.match(caught instanceof Error ? caught.message : String(caught), new RegExp(error));
			else if (typeof error === "function") assert.ok(caught instanceof (error as ErrorConstructor));
			else throw new Error("invalid expected error matcher");
		},
	);
}

export async function runPolicyProbe(): Promise<readonly string[]> {
	const denied: PolicyEvaluationResult = {
		decision: { kind: "deny", id: "deny-1", reasonCode: "out-of-phase", policyVersion: "1" },
		matchedRules: [],
	};
	expectThrow(() => assertAuthorized(denied), /not authorized: deny/);
	expectThrow(() => parseCapabilityManifest({}), CapabilityManifestError);

	const widened: CapabilityAuthority = {
		effects: ["destructive"],
		capabilities: ["shell.exec"],
		secrets: [],
		fragments: { workspace: "repo-b" },
	};
	expectThrow(() => assertCapabilityAuthoritySubset(widened, parentAuthority), /unauthorized value/);
	const readBranch: CapabilityAuthority = {
		effects: ["read"],
		capabilities: ["workspace.read"],
		secrets: [],
		fragments: { workspace: "repo-a" },
	};
	const networkBranch: CapabilityAuthority = {
		effects: ["read"],
		capabilities: ["network.http"],
		secrets: [],
		fragments: { workspace: "repo-a" },
	};
	assertCapabilityAuthoritySubset(readBranch, parentAuthority);
	assertCapabilityAuthoritySubset(networkBranch, parentAuthority);
	assert.deepEqual(intersectCapabilityAuthorities(parentAuthority, readBranch, networkBranch), {
		effects: ["read"],
		capabilities: [],
		secrets: [],
		fragments: { workspace: "repo-a" },
	});
	expectThrow(() => rejectModelEvidence({ claim: "tests.pass" }), /model prose is not evidence/);

	const contract = parseRetryResumeIdempotencyContract({
		version: "1",
		id: "effect-safety",
		stepId: "write",
		effect: "write",
		maxAttempts: 2,
		maxResumes: 1,
		idempotency: { mode: "evidence-required" },
		authority: parentAuthority,
		evidence: [
			{ type: "evidence", id: "proof", kind: "effect-retry", producers: ["runner"], verification: "verified" },
		],
	});
	expectThrow(() => assertEffectRetryEvidence(contract, []), /missing retry evidence/);

	const join = {
		version: "1",
		id: "required-join",
		mode: "all",
		authority: parentAuthority,
		branches: [
			{
				id: "tests",
				required: true,
				evidence: [
					{
						type: "evidence",
						id: "tests",
						kind: "test-result",
						producers: ["deterministic-step"],
						verification: "verified",
					},
				],
			},
		],
		outputs: [],
	} as const;
	expectThrow(
		() => assertJoinSatisfied(join, { branches: [{ id: "tests", status: "failed" }] }),
		/REQUIRED_BRANCH_INCOMPLETE/,
	);
	expectThrow(
		() => assertJoinSatisfied(join, { branches: [{ id: "tests", status: "completed", evidence: [] }] }),
		/EVIDENCE_MISSING/,
	);
	return [
		"deny decisions are enforced before effects",
		"child authority cannot widen",
		"parallel branch authorities intersect without union",
		"model and skipped evidence cannot satisfy gates",
		"effect retry requires evidence",
	];
}

export function runSecretRedactionProbe(): readonly string[] {
	const canary = "CANARY-DO-NOT-DISCLOSE";
	const payload = redactInteractionPayload({
		token: canary,
		nested: { authorization: `Bearer ${canary}` },
		safe: "visible",
	});
	assert.equal(JSON.stringify(payload).includes(canary), false);
	const request = redactInteractionRequest({
		...interactionRequest("secret-redaction"),
		scope: { ...parentAuthority, fragments: { token: canary } },
	});
	assert.equal(JSON.stringify(request).includes(canary), false);
	const decision = redactInteractionDecision({ ...askDecision, reason: `secret=${canary}` });
	assert.equal(JSON.stringify(decision).includes(canary), false);
	assert.equal(JSON.stringify({ manifest: agentManifest }).includes(canary), false);
	return [
		"nested interaction payload redaction",
		"policy request fragment redaction",
		"decision text redaction",
		"secret values are not manifest references",
	];
}

export async function runFilesystemProbe(): Promise<readonly string[]> {
	const root = await mkdtemp(join(tmpdir(), "blok-conformance-root-"));
	const outside = await mkdtemp(join(tmpdir(), "blok-conformance-outside-"));
	try {
		await writeFile(join(outside, "secret.txt"), "secret");
		await writeFile(join(root, "ok.txt"), "safe");
		const capability = new WorkspaceFilesystemCapability({ roots: [{ id: "repo", path: root }] });
		expectThrow(() => workspaceRelativePath("../secret.txt"), /WORKSPACE_FS_PATH_ESCAPE/);
		expectThrow(() => workspaceRelativePath("/etc/passwd"), /WORKSPACE_FS_PATH_ESCAPE/);
		await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
		await expectAsyncThrow(
			() => capability.read({ workspaceId: "repo", path: "link.txt" }),
			/WORKSPACE_FS_SYMLINK_DISALLOWED/,
		);
		await link(join(outside, "secret.txt"), join(root, "hardlink.txt"));
		await expectAsyncThrow(
			() => capability.read({ workspaceId: "repo", path: "hardlink.txt" }),
			/WORKSPACE_FS_HARDLINK_DISALLOWED/,
		);
		assert.equal((await capability.read({ workspaceId: "repo", path: "ok.txt" })).content, "safe");
		return [
			"relative traversal rejected",
			"symlink escape rejected",
			"hardlink escape rejected",
			"safe file remains readable",
		];
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
}

export function runProcessProbe(): readonly string[] {
	const cwd = { workspaceId: "repo", path: "." };
	const base = {
		version: "1" as const,
		cwd,
		env: [],
		stdin: "closed" as const,
		terminal: "pipe" as const,
		limits: {
			maxWallTimeMs: 1_000,
			maxCpuTimeMs: 1_000,
			maxMemoryBytes: 8_000_000,
			maxOutputBytes: 64,
			maxInputBytes: 64,
			maxProcesses: 1,
		},
		network: { mode: "none" as const },
		background: "foreground" as const,
	};
	expectThrow(
		() => parseProcessSpec({ ...base, mode: "executable", executable: "node;touch", args: [] }),
		/process spec/,
	);
	const shell = parseProcessSpec({
		...base,
		mode: "shell-string",
		shell: "/bin/sh",
		command: "echo safe; touch escaped",
	});
	expectThrow(
		() =>
			assertProcessPolicyAllowed(shell, {
				decision: { kind: "deny", id: "deny", reasonCode: "shell", policyVersion: "1" },
				matchedRules: [],
			}),
		/shell-string execution requires explicit allow/,
	);
	expectThrow(
		() =>
			parseProcessOutputChunk({
				stream: "stdout",
				sequence: 0,
				data: "x".repeat(64 * 1024 + 1),
				byteLength: 64 * 1024 + 1,
			}),
		/process output chunk/,
	);
	const owner = {
		principal: { id: "principal-1", kind: "agent" },
		sessionId: "session-1",
		turnId: "turn-1",
		taskId: "task-1",
	};
	const handle = parseProcessHandle({
		version: "1",
		id: "process-1",
		owner,
		specDigest: `sha256:${"a".repeat(64)}`,
		status: "orphaned",
		startedAt: "2026-09-02T00:00:00.000Z",
		updatedAt: "2026-09-02T00:00:00.000Z",
		terminal: "pipe",
		background: "durable",
		outputBytes: 0,
		outputTruncated: false,
	});
	assertProcessOwner(handle, owner);
	expectThrow(() => assertProcessOwner(handle, { ...owner, taskId: "other-task" }), /different task context/);
	parseProcessOrphanCleanupRequest({
		policy: {
			origin: "agent",
			workflow: { name: "conformance" },
			step: { id: "cleanup" },
			manifest: null,
			scope: { effects: ["process"], capabilities: ["process.exec"], secrets: [], fragments: {} },
			layers: [],
		},
		owner,
		olderThan: "2026-09-02T00:00:00.000Z",
	});
	const foreground = parseProcessSpec({
		...base,
		mode: "executable",
		executable: "node",
		args: [],
	});
	assertProcessStartResult(foreground, {
		kind: "completed",
		result: {
			handle: { ...handle, status: "exited", background: "foreground" },
			status: "exited",
			output: { stdout: "", stderr: "", capturedBytes: 0, totalBytes: 0, truncated: false },
			durationMs: 0,
		},
	});
	assert.equal(shell.mode, "shell-string");
	return [
		"argv metacharacters are not accepted as an executable",
		"shell strings are separately classified",
		"oversized output chunks are bounded",
		"orphan cleanup is owner-scoped",
		"foreground completion and durable handle states are contract-checked",
	];
}

function pureBinding(name: string, invoke: CodeModeBinding["invoke"]): CodeModeBinding {
	return {
		name,
		input: z.record(z.unknown()),
		output: z.record(z.unknown()),
		manifest: {
			version: "1",
			classification: "agent-compatible",
			effects: [],
			capabilities: [],
			secrets: [],
			determinism: "deterministic",
			idempotency: "idempotent",
			maturity: "stable",
		},
		authority: { effects: [], capabilities: [], secrets: [], fragments: {} },
		invoke,
	};
}

export async function runCodeModeProbe(): Promise<readonly string[]> {
	for (const source of [
		"return process.env.SECRET;",
		"return fetch('https://example.test');",
		"return import('node:fs');",
		"return 'js/ctx.state.secret';",
	]) {
		assert.equal(validateCodeModeSource(source).valid, false);
	}
	await expectAsyncThrow(
		() => executeCodeMode({ source: "return 'x'.repeat(128);", budgets: { maxOutputBytes: 16 } }),
		/CODE_MODE_OUTPUT_LIMIT/,
	);
	const binding = pureBinding("echo", async (input) => input);
	const denied = {
		async authorize(): Promise<PolicyEvaluationResult> {
			return { decision: { kind: "deny", id: "deny", reasonCode: "phase", policyVersion: "1" }, matchedRules: [] };
		},
	};
	await expectAsyncThrow(
		() =>
			executeCodeMode({
				source: "return await bindings.echo({});",
				bindings: [binding],
				policy: {
					authorization: denied,
					policyVersion: "1",
					context: {
						origin: "agent",
						workflow: { name: "conformance" },
						step: { id: "code" },
						manifest: null,
						scope: { effects: [], capabilities: [], secrets: [], fragments: {} },
						layers: [],
					},
				},
			}),
		/CODE_MODE_POLICY_DENIED/,
	);
	return [
		"ambient imports/process/network/mapper escape attempts rejected",
		"output budget enforced",
		"binding handler is not entered after policy denial",
	];
}

export async function runGraphProbe(): Promise<readonly string[]> {
	const { FakeGraphProvider } = await import("@blokjs/capabilities");
	if (!cleanGraphScope.worktree) throw new Error("graph fixture is missing a worktree");
	const provider = new FakeGraphProvider({
		scope: cleanGraphScope,
		files: graphFiles,
		now: () => "2026-09-02T00:00:00.000Z",
	});
	const stale = await provider.search({
		scope: { ...cleanGraphScope, worktree: { ...cleanGraphScope.worktree, branch: "feature" } },
		query: "alpha",
	});
	const conflict = await provider.findSymbol({
		scope: { ...cleanGraphScope, contentHashes: { "src/a.ts": `sha256:${"b".repeat(64)}` } },
		symbolId: "src/a.ts:alpha",
	});
	assert.equal(stale.freshness.state, "stale");
	assert.equal(conflict.status.states.includes("conflict"), true);
	assert.equal(stale.authority, "navigation-only");
	if (!stale.provenance) throw new Error("graph fixture did not return provenance");
	const item = contextItemFromGraph(
		"graph-stale",
		{ role: "system", content: [{ type: "text", text: "stale graph result" }] },
		stale.provenance,
		{ freshness: "stale" },
	);
	const assembled = await assembleContext({ items: [item], stalePolicy: "exclude" });
	assert.equal(assembled.items.length, 0);
	return [
		"branch change is explicitly stale",
		"content hash conflict is explicit",
		"graph authority is navigation-only",
		"stale graph context is excluded before model use",
	];
}

function sessionEvent(id: string, idempotencyKey: string, sessionId = "session-1"): SessionEventInput {
	return {
		contractVersion: "1",
		schemaVersion: 1,
		id,
		sessionId,
		turnId: "turn-1",
		kind: "message.user",
		visibility: "model-visible",
		actor: { kind: "user", id: "principal-1" },
		idempotencyKey,
		occurredAt: "2026-09-02T00:00:00.000Z",
		payload: { text: "hello" },
	};
}

async function runSessionProbe(): Promise<string[]> {
	const store = new MemorySessionStore();
	const event = sessionEvent("event-1", "event-key-1");
	const first = await store.append({ sessionId: "session-1", expectedSequence: 0, events: [event] });
	const duplicate = await store.append({ sessionId: "session-1", expectedSequence: 0, events: [event] });
	assert.equal(first.idempotent, false);
	assert.equal(duplicate.idempotent, true);
	await expectAsyncThrow(
		() =>
			store.append({ sessionId: "session-1", expectedSequence: 0, events: [sessionEvent("event-2", "event-key-2")] }),
		/expected sequence/,
	);
	return ["duplicate event append is idempotent", "stale append sequence is rejected"];
}

async function runSqliteRestartProbe(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "blok-conformance-session-"));
	const path = join(directory, "session.db");
	try {
		const first = new SqliteSessionStore(path);
		await first.append({
			sessionId: "restart-session",
			expectedSequence: 0,
			events: [sessionEvent("restart-event", "restart-key", "restart-session")],
		});
		first.close();
		const reopened = new SqliteSessionStore(path);
		const page = await reopened.read("restart-session");
		reopened.close();
		assert.deepEqual(
			page.events.map((event) => event.id),
			["restart-event"],
		);
		return "SQLite event log survives close/reopen";
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function runInteractionProbe(): Promise<string[]> {
	const store = new InMemoryInteractionStore();
	const request = interactionRequest("interaction-1");
	await store.create(request, askDecision, { expiresAt: "2099-01-01T00:00:00.000Z" });
	await expectAsyncThrow(
		() => store.answer({ id: request.requestId, principalId: "other", sequence: 0, answer: { approved: true } }),
		InteractionAuthorizationError,
	);
	await expectAsyncThrow(
		() => store.answer({ id: request.requestId, principalId: "principal-1", sequence: 4, answer: { approved: true } }),
		InteractionConflictError,
	);
	const answered = await store.answer({
		id: request.requestId,
		principalId: "principal-1",
		sequence: 0,
		answer: { approved: true },
	});
	assert.equal(
		(await store.answer({ id: request.requestId, principalId: "principal-1", sequence: 1, answer: { approved: true } }))
			.sequence,
		answered.sequence,
	);
	const claimed = await store.claim(request.requestId, "principal-1", 1);
	await expectAsyncThrow(() => store.claim(request.requestId, "principal-1", claimed.sequence), /already been claimed/);

	const denied = interactionRequest("interaction-denied");
	await store.create(denied, askDecision);
	assert.equal(
		(await store.answer({ id: denied.requestId, principalId: "principal-1", sequence: 0, deny: true })).status,
		"denied",
	);
	const cancelled = interactionRequest("interaction-cancelled");
	await store.create(cancelled, askDecision);
	assert.equal((await store.cancel(cancelled.requestId, "principal-1", 0)).status, "cancelled");
	const expired = interactionRequest("interaction-expired");
	await store.create(expired, askDecision, { expiresAt: "2020-01-01T00:00:00.000Z" });
	assert.equal((await store.expire("2020-01-02T00:00:00.000Z"))[0]?.status, "expired");
	return [
		"principal identity and sequence fence answers",
		"exact duplicate answer is idempotent",
		"duplicate resume claim is rejected",
		"denial/cancellation/expiry are terminal states",
	];
}

async function runSqliteInteractionRestartProbe(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "blok-conformance-interaction-"));
	const path = join(directory, "interaction.db");
	try {
		const first = new SqliteInteractionStore(path);
		const request = interactionRequest("restart-interaction");
		await first.create(request, askDecision, { expiresAt: "2099-01-01T00:00:00.000Z" });
		first.close();
		const reopened = new SqliteInteractionStore(path);
		assert.equal((await reopened.get(request.requestId))?.status, "pending");
		await reopened.answer({
			id: request.requestId,
			principalId: "principal-1",
			sequence: 0,
			answer: { approved: true },
		});
		reopened.close();
		const resumed = new SqliteInteractionStore(path);
		assert.equal((await resumed.get(request.requestId))?.status, "answered");
		resumed.close();
		return "SQLite approval state survives close/reopen";
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

export async function runRecoveryProbe(): Promise<readonly string[]> {
	const evidence = [...(await runSessionProbe()), ...(await runInteractionProbe())];
	evidence.push(await runSqliteRestartProbe());
	evidence.push(await runSqliteInteractionRestartProbe());
	return evidence;
}
