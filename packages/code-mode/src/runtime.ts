import type { Worker } from "node:worker_threads";
import {
	CapabilityAuthorityError,
	CapabilityContractError,
	CapabilityManifestError,
	SessionJsonValueSchema,
	assertAuthorized,
	assertCapabilityAuthoritySubset,
	intersectCapabilityAuthorities,
	parseCapabilityAuthority,
	parseCapabilityManifest,
} from "@blokjs/shared";
import type {
	CapabilityAuthority,
	CapabilityAuthorizationPort,
	CapabilityManifestV1,
	PolicyContext,
	PolicyEvaluationResult,
	SessionJsonValue,
} from "@blokjs/shared";
import {
	CODE_MODE_CLEANUP_TIMEOUT_MS,
	CODE_MODE_DEFAULT_MAX_CALLS,
	CODE_MODE_DEFAULT_MAX_NESTING,
	CODE_MODE_DEFAULT_MAX_PARALLELISM,
	CODE_MODE_DEFAULT_MEMORY_BYTES,
	CODE_MODE_DEFAULT_WALL_TIME_MS,
	CODE_MODE_MAX_CALLS,
	CODE_MODE_MAX_INPUT_BYTES,
	CODE_MODE_MAX_LOG_ENTRIES,
	CODE_MODE_MAX_MEMORY_BYTES,
	CODE_MODE_MAX_NESTING,
	CODE_MODE_MAX_OUTPUT_BYTES,
	CODE_MODE_MAX_PARALLELISM,
	CODE_MODE_MAX_SOURCE_BYTES,
	CODE_MODE_MAX_WALL_TIME_MS,
	CODE_MODE_MIN_MEMORY_BYTES,
	type CodeModeBinding,
	type CodeModeBindingCallContext,
	type CodeModeBudgets,
	type CodeModeExecutionOptions,
	type CodeModeExecutionResult,
	type CodeModeLogEntry,
} from "./contracts";
import { CODE_MODE_ERROR_CODES, CodeModeError, type CodeModeErrorCode } from "./errors";
import { validateCodeModeSource } from "./validator";

type WorkerStartMessage = {
	type: "start";
	source: string;
	input: SessionJsonValue;
	bindingNames: readonly string[];
	filename: string;
};

type WorkerCallMessage = { readonly type: "call"; readonly id: string; readonly name: string; readonly input: unknown };
type WorkerLogMessage = { readonly type: "log" | "emit"; readonly value: unknown };
type WorkerResultMessage = { readonly type: "result"; readonly output: unknown };
type WorkerErrorMessage = { readonly type: "error"; readonly code?: string };
type WorkerMessage = WorkerCallMessage | WorkerLogMessage | WorkerResultMessage | WorkerErrorMessage;

type WorkerCallResultMessage =
	| { readonly type: "call-result"; readonly id: string; readonly ok: true; readonly value: SessionJsonValue }
	| { readonly type: "call-result"; readonly id: string; readonly ok: false; readonly code: string };

type RuntimeBudgets = {
	readonly maxWallTimeMs: number;
	readonly maxMemoryBytes: number;
	readonly maxOutputBytes: number;
	readonly maxCalls: number;
	readonly maxNesting: number;
	readonly maxParallelism: number;
};

type RuntimeState = {
	readonly options: CodeModeExecutionOptions;
	readonly budgets: RuntimeBudgets;
	readonly bindings: ReadonlyMap<string, CodeModeBinding>;
	readonly policyContext?: PolicyContext;
	readonly authorization?: CapabilityAuthorizationPort;
	readonly controller: AbortController;
	readonly worker: Worker;
	readonly logs: CodeModeLogEntry[];
	readonly emissions: SessionJsonValue[];
	settled: boolean;
	calls: number;
	activeCalls: number;
	peakParallelism: number;
	outputBytes: number;
	timer?: ReturnType<typeof setTimeout>;
	relay?: () => void;
};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
const MAX_CLEANUP_WAIT_MS = CODE_MODE_CLEANUP_TIMEOUT_MS;

/* This source is trusted package code. Model source is sent as data and is
 * compiled inside the worker's separate vm context below. */
const WORKER_SOURCE = String.raw`
"use strict";
import { parentPort } from "node:worker_threads";
import * as vm from "node:vm";
const pending = new Map();
let started = false;
let nextCallId = 0;

function freeze(value, seen) {
  if (value === null || typeof value !== "object") return value;
  const objects = seen || new Set();
  if (objects.has(value)) return value;
  objects.add(value);
  for (const child of Object.values(value)) freeze(child, objects);
  return Object.freeze(value);
}

function call(name, input) {
  const id = String(++nextCallId);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      parentPort.postMessage({ type: "call", id, name, input });
    } catch {
      pending.delete(id);
      reject(new Error("CODE_MODE_RUNTIME_ERROR"));
    }
  });
}

function settle(message) {
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.ok) waiter.resolve(message.value);
  else waiter.reject(new Error(message.code));
}

async function start(message) {
  if (started) return;
  started = true;
  try {
    const bindingObject = {};
    for (const name of message.bindingNames) {
      Object.defineProperty(bindingObject, name, {
        enumerable: true,
        value: (input) => call(name, input),
      });
    }
    Object.freeze(bindingObject);
    const sandbox = Object.freeze({
      input: freeze(message.input),
      bindings: bindingObject,
      log: (value) => parentPort.postMessage({ type: "log", value }),
      emit: (value) => parentPort.postMessage({ type: "emit", value }),
    });
    const context = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });
    const script = new vm.Script(
      "(async function __blokCodeMode(input, bindings, log, emit) {\n\"use strict\";\n" + message.source + "\n})",
	      { filename: message.filename },
    );
    const run = script.runInContext(context, { displayErrors: false });
    const output = await run(context.input, context.bindings, context.log, context.emit);
    parentPort.postMessage({ type: "result", output });
  } catch (error) {
    const message = error && typeof error.message === "string" ? error.message : "";
    const code = message.startsWith("CODE_MODE_") ? message : undefined;
    parentPort.postMessage({ type: "error", ...(code ? { code } : {}) });
  }
}

parentPort.on("message", (message) => {
  if (message && message.type === "start") void start(message);
  else if (message && message.type === "call-result") settle(message);
});
`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorCode(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	return typeof value.code === "string" ? value.code : undefined;
}

function byteLength(value: SessionJsonValue): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function parseJson(value: unknown, label: string): SessionJsonValue {
	const parsed = SessionJsonValueSchema.safeParse(value);
	if (!parsed.success) throw new CodeModeError("CODE_MODE_INVALID_CONTRACT", `${label} is not bounded JSON`);
	return parsed.data;
}

function positiveBound(value: number | undefined, fallback: number, maximum: number, label: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
		throw new CodeModeError("CODE_MODE_INVALID_CONTRACT", `${label} exceeds the Code Mode bound`);
	return value;
}

function budgetsFor(value: CodeModeBudgets | undefined): RuntimeBudgets {
	const maxWallTimeMs = positiveBound(
		value?.maxWallTimeMs,
		CODE_MODE_DEFAULT_WALL_TIME_MS,
		CODE_MODE_MAX_WALL_TIME_MS,
		"maxWallTimeMs",
	);
	const maxMemoryBytes = positiveBound(
		value?.maxMemoryBytes,
		CODE_MODE_DEFAULT_MEMORY_BYTES,
		CODE_MODE_MAX_MEMORY_BYTES,
		"maxMemoryBytes",
	);
	if (maxMemoryBytes < CODE_MODE_MIN_MEMORY_BYTES)
		throw new CodeModeError("CODE_MODE_INVALID_CONTRACT", "maxMemoryBytes is below the worker minimum");
	const maxOutputBytes = positiveBound(
		value?.maxOutputBytes,
		CODE_MODE_MAX_OUTPUT_BYTES,
		CODE_MODE_MAX_OUTPUT_BYTES,
		"maxOutputBytes",
	);
	const maxCalls = positiveBound(value?.maxCalls, CODE_MODE_DEFAULT_MAX_CALLS, CODE_MODE_MAX_CALLS, "maxCalls");
	const maxNesting = positiveBound(
		value?.maxNesting,
		CODE_MODE_DEFAULT_MAX_NESTING,
		CODE_MODE_MAX_NESTING,
		"maxNesting",
	);
	const maxParallelism = positiveBound(
		value?.maxParallelism,
		CODE_MODE_DEFAULT_MAX_PARALLELISM,
		CODE_MODE_MAX_PARALLELISM,
		"maxParallelism",
	);
	return { maxWallTimeMs, maxMemoryBytes, maxOutputBytes, maxCalls, maxNesting, maxParallelism };
}

function authorityForManifest(manifest: CapabilityManifestV1): CapabilityAuthority {
	return {
		effects: [...manifest.effects],
		capabilities: [...manifest.capabilities],
		secrets: [...manifest.secrets],
		fragments: {},
	};
}

function sortedEqual(left: readonly string[], right: readonly string[]): boolean {
	return [...left].sort().join("\0") === [...right].sort().join("\0");
}

function prepareBindings(bindings: readonly CodeModeBinding[]): ReadonlyMap<string, CodeModeBinding> {
	const map = new Map<string, CodeModeBinding>();
	for (const binding of bindings) {
		if (!IDENTIFIER.test(binding.name) || map.has(binding.name))
			throw new CodeModeError("CODE_MODE_BINDING_REJECTED", "binding names must be unique JavaScript identifiers");
		let manifest: CapabilityManifestV1;
		let authority: CapabilityAuthority;
		try {
			manifest = parseCapabilityManifest(binding.manifest);
			authority = parseCapabilityAuthority(binding.authority);
		} catch (error) {
			if (error instanceof CapabilityManifestError || error instanceof CapabilityAuthorityError)
				throw new CodeModeError("CODE_MODE_BINDING_REJECTED", "binding metadata is invalid");
			throw error;
		}
		if (manifest.classification !== "agent-compatible")
			throw new CodeModeError("CODE_MODE_BINDING_REJECTED", "binding is not agent-compatible");
		if (manifest.secrets.length > 0 || authority.secrets.length > 0 || manifest.effects.includes("secret"))
			throw new CodeModeError("CODE_MODE_BINDING_REJECTED", "secret access is unavailable in Code Mode");
		const required = authorityForManifest(manifest);
		if (
			!sortedEqual(authority.effects, required.effects) ||
			!sortedEqual(authority.capabilities, required.capabilities)
		)
			throw new CodeModeError("CODE_MODE_BINDING_REJECTED", "binding authority must match its manifest");
		map.set(binding.name, { ...binding, manifest, authority });
	}
	return map;
}

function safePolicyResult(
	result: PolicyEvaluationResult | undefined,
	requested: CapabilityAuthority,
	policyVersion: string,
): PolicyEvaluationResult {
	if (
		!result?.decision ||
		!result.decision.id ||
		!result.decision.reasonCode ||
		result.decision.policyVersion !== policyVersion
	)
		throw new CodeModeError("CODE_MODE_POLICY_DENIED");
	let effective = requested;
	if (result.scope !== undefined) {
		try {
			const policyScope = parseCapabilityAuthority(result.scope);
			assertCapabilityAuthoritySubset(policyScope, requested, "active policy scope");
			effective = intersectCapabilityAuthorities(requested, policyScope);
		} catch {
			throw new CodeModeError("CODE_MODE_POLICY_DENIED");
		}
	}
	try {
		assertAuthorized(result, { allowSandbox: true });
	} catch {
		throw new CodeModeError("CODE_MODE_POLICY_DENIED");
	}
	return { ...result, scope: effective };
}

function policyRequest(state: RuntimeState, binding: CodeModeBinding, index: number): PolicyContext {
	const policyContext = state.policyContext;
	if (!policyContext || !state.authorization || policyContext.origin !== "agent")
		throw new CodeModeError("CODE_MODE_POLICY_DENIED");
	try {
		assertCapabilityAuthoritySubset(
			binding.authority,
			parseCapabilityAuthority(policyContext.scope),
			`binding "${binding.name}" authority`,
		);
	} catch (error) {
		if (error instanceof CapabilityAuthorityError || error instanceof CapabilityContractError)
			throw new CodeModeError("CODE_MODE_POLICY_DENIED");
		throw error;
	}
	return {
		...policyContext,
		step: { id: `code-mode:${binding.name}`, index, attempt: 1 },
		manifest: binding.manifest,
		scope: intersectCapabilityAuthorities(parseCapabilityAuthority(policyContext.scope), binding.authority),
		signal: state.controller.signal,
	};
}

async function invokeBinding(
	state: RuntimeState,
	binding: CodeModeBinding,
	input: SessionJsonValue,
	depth: number,
): Promise<SessionJsonValue> {
	if (depth > state.budgets.maxNesting) throw new CodeModeError("CODE_MODE_NESTING_LIMIT");
	if (state.calls >= state.budgets.maxCalls) throw new CodeModeError("CODE_MODE_CALL_LIMIT");
	if (state.activeCalls >= state.budgets.maxParallelism) throw new CodeModeError("CODE_MODE_PARALLELISM_LIMIT");
	if (state.controller.signal.aborted) throw new CodeModeError("CODE_MODE_CANCELLED");
	state.calls += 1;
	state.activeCalls += 1;
	state.peakParallelism = Math.max(state.peakParallelism, state.activeCalls);
	try {
		const parsedInput = binding.input.safeParse(input);
		if (!parsedInput.success) throw new CodeModeError("CODE_MODE_BINDING_REJECTED");
		const request = policyRequest(state, binding, state.calls);
		let policyResult: PolicyEvaluationResult;
		try {
			policyResult = (await state.authorization?.authorize(request)) as PolicyEvaluationResult;
		} catch {
			throw new CodeModeError("CODE_MODE_POLICY_DENIED");
		}
		const effective = safePolicyResult(policyResult, request.scope, state.options.policy?.policyVersion ?? "");
		try {
			assertCapabilityAuthoritySubset(
				binding.authority,
				effective.scope ?? request.scope,
				`binding "${binding.name}" authority`,
			);
		} catch {
			throw new CodeModeError("CODE_MODE_POLICY_DENIED");
		}
		const context: CodeModeBindingCallContext = {
			callId: String(state.calls),
			depth,
			signal: state.controller.signal,
			call: (name, nestedInput) => {
				const nested = state.bindings.get(name);
				if (!nested) return Promise.reject(new CodeModeError("CODE_MODE_BINDING_REJECTED"));
				return invokeBinding(state, nested, nestedInput, depth + 1);
			},
		};
		let rawOutput: unknown;
		try {
			rawOutput = await binding.invoke(parsedInput.data, context);
		} catch (error) {
			if (error instanceof CodeModeError) throw error;
			throw new CodeModeError("CODE_MODE_RUNTIME_ERROR");
		}
		const parsedOutput = binding.output.safeParse(rawOutput);
		if (!parsedOutput.success) throw new CodeModeError("CODE_MODE_BINDING_REJECTED");
		const output = parseJson(parsedOutput.data, "binding output");
		reserveOutput(state, output);
		return output;
	} finally {
		state.activeCalls -= 1;
	}
}

function reserveOutput(state: RuntimeState, value: SessionJsonValue): void {
	const bytes = byteLength(value);
	if (state.outputBytes + bytes > state.budgets.maxOutputBytes) throw new CodeModeError("CODE_MODE_OUTPUT_LIMIT");
	state.outputBytes += bytes;
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
	return isRecord(value) && typeof value.type === "string";
}

function isCallMessage(value: WorkerMessage): value is WorkerCallMessage {
	return value.type === "call" && typeof value.id === "string" && typeof value.name === "string";
}

function isLogMessage(value: WorkerMessage): value is WorkerLogMessage {
	return (value.type === "log" || value.type === "emit") && "value" in value;
}

async function stopWorker(worker: Worker): Promise<void> {
	await Promise.race([worker.terminate(), new Promise<void>((resolve) => setTimeout(resolve, MAX_CLEANUP_WAIT_MS))]);
}

/** Execute one ephemeral model-authored TypeScript function body. */
export async function executeCodeMode(options: CodeModeExecutionOptions): Promise<CodeModeExecutionResult> {
	if (typeof options.source !== "string") throw new CodeModeError("CODE_MODE_INVALID_CONTRACT");
	const validation = validateCodeModeSource(options.source);
	const transpiledSource = validation.transpiledSource;
	if (validation.sourceBytes > CODE_MODE_MAX_SOURCE_BYTES) throw new CodeModeError("CODE_MODE_SOURCE_TOO_LARGE");
	if (!validation.valid || !transpiledSource)
		throw new CodeModeError(
			"CODE_MODE_STATIC_REJECTED",
			"source failed static validation",
			validation.issues.map((issue) => `${issue.line}:${issue.column} ${issue.message}`),
		);
	const budgets = budgetsFor(options.budgets);
	const input = parseJson(options.input ?? null, "input");
	if (byteLength(input) > CODE_MODE_MAX_INPUT_BYTES) throw new CodeModeError("CODE_MODE_INPUT_LIMIT");
	const bindings = prepareBindings(options.bindings ?? []);
	if (bindings.size > 0 && !options.policy) throw new CodeModeError("CODE_MODE_POLICY_DENIED");
	if (options.policy && options.policy.policyVersion.length === 0)
		throw new CodeModeError("CODE_MODE_INVALID_CONTRACT");
	const controller = new AbortController();
	let worker: Worker;
	try {
		const workerThreads = await import("node:worker_threads");
		const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(WORKER_SOURCE)}`);
		worker = new workerThreads.Worker(workerUrl, {
			resourceLimits: {
				maxOldGenerationSizeMb: Math.max(8, Math.ceil(budgets.maxMemoryBytes / (1024 * 1024))),
				maxYoungGenerationSizeMb: Math.max(4, Math.ceil(budgets.maxMemoryBytes / (4 * 1024 * 1024))),
				stackSizeMb: 4,
			},
		});
	} catch {
		throw new CodeModeError("CODE_MODE_HOST_UNSUPPORTED");
	}
	const state: RuntimeState = {
		options,
		budgets,
		bindings,
		policyContext: options.policy?.context,
		authorization: options.policy?.authorization,
		controller,
		worker,
		logs: [],
		emissions: [],
		settled: false,
		calls: 0,
		activeCalls: 0,
		peakParallelism: 0,
		outputBytes: 0,
	};

	return await new Promise<CodeModeExecutionResult>((resolve, reject) => {
		const cleanup = async (): Promise<void> => {
			if (state.timer) clearTimeout(state.timer);
			if (state.options.signal && state.relay) state.options.signal.removeEventListener("abort", state.relay);
			await stopWorker(worker);
		};
		const fail = (error: CodeModeError): void => {
			if (state.settled) return;
			state.settled = true;
			controller.abort(error.code);
			void cleanup().then(
				() => reject(error),
				() => reject(new CodeModeError("CODE_MODE_CLEANUP_FAILED")),
			);
		};
		const succeed = (output: SessionJsonValue): void => {
			if (state.settled) return;
			try {
				reserveOutput(state, output);
				state.settled = true;
				void cleanup().then(
					() =>
						resolve({
							contractVersion: "1",
							output,
							logs: [...state.logs],
							emissions: [...state.emissions],
							calls: state.calls,
							peakParallelism: state.peakParallelism,
							outputBytes: state.outputBytes,
						}),
					(error) => reject(error instanceof CodeModeError ? error : new CodeModeError("CODE_MODE_CLEANUP_FAILED")),
				);
			} catch (error) {
				fail(error instanceof CodeModeError ? error : new CodeModeError("CODE_MODE_OUTPUT_LIMIT"));
			}
		};
		const handleCall = async (message: WorkerCallMessage): Promise<void> => {
			const binding = bindings.get(message.name);
			if (!binding) {
				worker.postMessage({
					type: "call-result",
					id: message.id,
					ok: false,
					code: "CODE_MODE_BINDING_REJECTED",
				} satisfies WorkerCallResultMessage);
				return;
			}
			try {
				const callInput = parseJson(message.input, "binding input");
				const value = await invokeBinding(state, binding, callInput, 1);
				worker.postMessage({ type: "call-result", id: message.id, ok: true, value } satisfies WorkerCallResultMessage);
			} catch (error) {
				const code = error instanceof CodeModeError ? error.code : "CODE_MODE_RUNTIME_ERROR";
				if (
					[
						"CODE_MODE_CALL_LIMIT",
						"CODE_MODE_NESTING_LIMIT",
						"CODE_MODE_PARALLELISM_LIMIT",
						"CODE_MODE_OUTPUT_LIMIT",
						"CODE_MODE_CANCELLED",
					].includes(code)
				) {
					fail(error instanceof CodeModeError ? error : new CodeModeError("CODE_MODE_RUNTIME_ERROR"));
					return;
				}
				try {
					worker.postMessage({
						type: "call-result",
						id: message.id,
						ok: false,
						code,
					} satisfies WorkerCallResultMessage);
				} catch {
					fail(new CodeModeError("CODE_MODE_RUNTIME_ERROR"));
				}
			}
		};
		worker.on("message", (value: unknown) => {
			if (!isWorkerMessage(value) || state.settled) return;
			if (isCallMessage(value)) {
				void handleCall(value);
				return;
			}
			if (isLogMessage(value)) {
				try {
					const item = parseJson(value.value, value.type);
					reserveOutput(state, item);
					if (value.type === "log") {
						if (state.logs.length >= CODE_MODE_MAX_LOG_ENTRIES) throw new CodeModeError("CODE_MODE_OUTPUT_LIMIT");
						state.logs.push({ value: item });
					} else state.emissions.push(item);
				} catch (error) {
					fail(error instanceof CodeModeError ? error : new CodeModeError("CODE_MODE_OUTPUT_LIMIT"));
				}
				return;
			}
			if (value.type === "result") {
				try {
					succeed(parseJson(value.output, "result"));
				} catch {
					fail(new CodeModeError("CODE_MODE_INVALID_CONTRACT"));
				}
				return;
			}
			if (value.type === "error") {
				const code = value.code;
				const known = typeof code === "string" && (CODE_MODE_ERROR_CODES as readonly string[]).includes(code);
				fail(new CodeModeError(known ? (code as CodeModeErrorCode) : "CODE_MODE_RUNTIME_ERROR"));
			}
		});
		worker.on("error", (error: unknown) => {
			if (errorCode(error) === "ERR_WORKER_OUT_OF_MEMORY") fail(new CodeModeError("CODE_MODE_MEMORY_LIMIT"));
			else fail(new CodeModeError("CODE_MODE_RUNTIME_ERROR"));
		});
		worker.on("exit", (code) => {
			if (state.settled) return;
			if (code !== 0) fail(new CodeModeError("CODE_MODE_MEMORY_LIMIT"));
			else fail(new CodeModeError("CODE_MODE_RUNTIME_ERROR"));
		});
		const relay = () => fail(new CodeModeError("CODE_MODE_CANCELLED"));
		state.relay = relay;
		if (options.signal) {
			if (options.signal.aborted) {
				relay();
				return;
			}
			options.signal.addEventListener("abort", relay, { once: true });
		}
		state.timer = setTimeout(() => fail(new CodeModeError("CODE_MODE_TIMEOUT")), budgets.maxWallTimeMs);
		try {
			worker.postMessage({
				type: "start",
				source: transpiledSource,
				input,
				bindingNames: [...bindings.keys()],
				filename: options.filename ?? "code-mode.ts",
			} satisfies WorkerStartMessage);
		} catch {
			fail(new CodeModeError("CODE_MODE_HOST_UNSUPPORTED"));
		}
	});
}
