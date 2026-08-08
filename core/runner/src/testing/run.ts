/**
 * `runNode` / `runWorkflow` — the typed-first testing surface (#688).
 *
 * Two functions, no new engine: both are thin wrappers over the classes that
 * already live in this folder ({@link NodeTestHarness}, {@link
 * WorkflowTestRunner}), which in turn drive the REAL `Configuration` + `Runner`
 * for v2 workflows. Everything they add is ergonomics and one guarantee the
 * classes could not give: a mock is checked against the mocked node's declared
 * output schema, so it cannot quietly promise a field the node never returns.
 *
 * No server, no Docker, no `deps.inline`, no import-time filesystem work.
 */
import { readFileSync } from "node:fs";
import type { Context, EnvContext, NodeBase } from "@blokjs/shared";
import type { z } from "zod";
import type BlokService from "../Blok";
import { type FunctionNode, getDefinedNode } from "../defineNode";
import type { InputOf, OutputOf } from "../handles";
import { type InternalWorkflow, normalizeWorkflow } from "../workflow/WorkflowNormalizer";
import { NodeTestHarness, type TestContextOverrides } from "./TestHarness";
import { type WorkflowExecuteOptions, WorkflowTestRunner } from "./WorkflowTestRunner";

// =============================================================================
// runNode — one isolated node, Zod-validated in and out
// =============================================================================

/**
 * Execute a single node against `input` and return its output.
 *
 * Input and output are validated by the node's own Zod schemas (this is the
 * node's real `handle()` path, not a re-implementation). A node that fails —
 * a Zod violation or a throw inside `execute` — rejects, so failure paths are
 * asserted with `await expect(runNode(...)).rejects.toThrow(...)`.
 *
 * @example
 * const out = await runNode(orderValidator, { body: { id: "o-1" } }, { env: { API_KEY: "test" } });
 * expect(out.total).toBe(120);
 */
export async function runNode<N extends { name: string }>(
	node: N,
	input: InputOf<N>,
	opts?: TestContextOverrides,
): Promise<OutputOf<N>> {
	const harness = new NodeTestHarness<InputOf<N>, OutputOf<N>>(node as unknown as BlokService<unknown>);
	const result = await harness.execute(input, opts);
	if (!result.success) {
		throw new Error(`Node "${node.name}" failed: ${describeError(result.error)}`);
	}
	return result.data as OutputOf<N>;
}

// =============================================================================
// runWorkflow — a typed `workflow()` export through the real engine
// =============================================================================

/** A mock implementation swapped in for a node key. Same `(input, ctx)` shape as `WorkflowTestRunner.mockNode`. */
export type NodeMock = (input: never, ctx: Context) => unknown | Promise<unknown>;

export interface RunWorkflowOptions extends WorkflowExecuteOptions {
	/**
	 * Replace nodes by their `use:` key. The return value is validated against
	 * the REAL node's declared output schema whenever that node is resolvable,
	 * so a mock cannot claim a field the node does not produce.
	 */
	mock?: Record<string, NodeMock>;
	/**
	 * Nodes to register explicitly, each under its own `name`. Only needed for
	 * nodes that never got constructed in this process — a node referenced by
	 * string (`node("…")`) or a cross-runtime stub. A `defineNode()` node that
	 * the workflow imports resolves on its own.
	 */
	nodes?: readonly { name: string }[];
	/** Environment visible to nodes as `ctx.env`. */
	env?: EnvContext;
	/** Abort the run after this many ms. Default 30000. */
	timeout?: number;
	/** Print per-step engine chatter. Default false. */
	verbose?: boolean;
}

/** What one step did — enough to assert on data flow, not just on the final response. */
export interface StepRun {
	/** The step id (its `ctx.state` key, unless `as`/`spread`/`ephemeral` says otherwise). */
	id: string;
	/** The node key the step runs (`use:`). */
	node: string;
	/** True when the step actually ran. False = an untaken branch/switch arm, or a step past a failure. */
	executed: boolean;
	/** Inputs AFTER the Mapper resolved every `{$ref}` / `js/…` — what the node really received. */
	inputs: unknown;
	/** The node's output, or `null` when the step failed or never ran. */
	output: unknown;
	/** How many times the step ran. > 1 inside `forEach`; `inputs`/`output` hold the last iteration. */
	calls: number;
}

export interface WorkflowRun<TResponse = unknown> {
	/** Did the whole run complete without a step throwing? */
	readonly ok: boolean;
	/** The final step's output — what the trigger would return. */
	readonly response: TResponse;
	/** The failure that ended the run, or `null`. */
	readonly error: unknown;
	/** Every declared step in authoring order, executed or skipped. */
	readonly steps: readonly StepRun[];
	/** The real `ctx.state` after the run — absent key = the step did not succeed. */
	readonly stateAll: Readonly<Record<string, unknown>>;
	/** The persisted output of one step. `undefined` = it was skipped or it threw. */
	state<T = unknown>(id: string): T | undefined;
	/** One step's record, by id. */
	step(id: string): StepRun | undefined;
}

/** Recover a workflow's declared output type from the `workflow()` export, when it has one. */
type WorkflowOutputOf<W> = Awaited<W> extends { __blokTypes?: { output: infer O } } ? O : unknown;

/**
 * Run a workflow through the real engine and report what each step did.
 *
 * Accepts the `workflow()` export DIRECTLY — including the promise it returns,
 * so `import wf from "./workflows/process-order"` needs no `await` of its own.
 * A JSON workflow still works: pass the path to the `.json` file, or its text.
 *
 * **`input` is not enforced here (ADR 0015).** The declared-`input` gate lives at
 * the `TriggerBase.run()` transport boundary; `runWorkflow` drives the runner
 * directly, the same position a `subworkflow:` child occupies. So `input` runs
 * verbatim — no 400, no `.default()`s applied, nothing stripped. That is
 * deliberate: this tests the workflow BODY, and a harness that silently rewrote
 * the payload would be testing something the assertion never named. To cover the
 * input contract, `safeParse` the schema in the test.
 *
 * @example
 * const run = await runWorkflow(orderFlow, { id: "o-1", total: 120 }, {
 *   mock: { "charge-card": async () => ({ receipt: "r-1" }) },
 * });
 * expect(run.ok).toBe(true);
 * expect(run.state("validate")).toEqual({ id: "o-1", total: 120 });
 * expect(run.step("vip")?.executed).toBe(false);
 */
export async function runWorkflow<W>(
	workflow: W,
	input?: unknown,
	opts?: RunWorkflowOptions,
): Promise<WorkflowRun<WorkflowOutputOf<W>>> {
	const authored = toWorkflowModel(await workflow);
	// Normalize FIRST: `branch()` only becomes an `@blokjs/if-else` step here, and
	// nested arms only become addressable steps here. Discovering node keys off
	// the authored IR would miss both. `normalizeWorkflow` deep-copies, and
	// Configuration re-runs it — this pass is read-only reconnaissance.
	const declared = declaredSteps(normalizeWorkflow(authored));
	const model = unpinMockedRuntimeSteps(authored, declared, opts?.mock);

	const runner = new WorkflowTestRunner({ timeout: opts?.timeout, verbose: opts?.verbose });
	const calls: RecordedCall[] = [];
	const violations: Error[] = [];
	await registerNodes(runner, model, declared, calls, violations, opts);

	runner.loadWorkflow(model);
	const result = await runner.execute(input ?? {}, {
		headers: opts?.headers,
		query: opts?.query,
		params: opts?.params,
		contextOverrides: {
			...opts?.contextOverrides,
			...(opts?.env ? { env: opts.env } : {}),
		},
	});

	// A mock that broke its node's output contract fails the TEST, not just the
	// step: the engine turns any throw inside a node into a step error, and a
	// run that merely reports `ok: false` is one an author can forget to assert.
	if (violations.length > 0) throw violations[0];

	// Declared order is the authoring order, so a skipped arm keeps its slot.
	// A legacy `{name, node}` workflow declares nothing recognizable here — fall
	// back to the sequential executor's own trace so it still reports steps.
	const steps: StepRun[] =
		declared.length > 0
			? declared
					.filter((d) => !d.structural)
					.map(({ id, use }) => {
						const mine = calls.filter((c) => c.id === id);
						const last = mine[mine.length - 1];
						return {
							id,
							node: use,
							executed: mine.length > 0,
							inputs: last?.inputs ?? null,
							output: last?.output ?? null,
							calls: mine.length,
						};
					})
			: result.trace.map((t) => ({
					id: t.nodeName,
					node: t.nodeName,
					executed: true,
					inputs: t.input,
					output: t.output,
					calls: 1,
				}));

	const state = result.state ?? {};
	return {
		ok: result.success,
		response: result.output as WorkflowOutputOf<W>,
		error: result.success ? null : result.output,
		steps,
		stateAll: state,
		state: <T = unknown>(id: string): T | undefined => state[id] as T | undefined,
		step: (id: string): StepRun | undefined => steps.find((s) => s.id === id),
	};
}

// =============================================================================
// Internals
// =============================================================================

interface RecordedCall {
	id: string;
	inputs: unknown;
	output: unknown;
}

interface DeclaredStep {
	id: string;
	use: string;
	/** Normalized step type: `module`, `runtime.<kind>`, `forEach`, `switch`, … */
	type: string;
	/** Control flow the author wrote as `branch`/`forEach`/…, not a data step. */
	structural: boolean;
}

/** Normalized step types the runner resolves internally — no node to register. */
const STRUCTURAL_TYPES = new Set(["forEach", "switch", "tryCatch", "loop", "wait"]);

/** Unwrap whatever the author passed into the plain v2 workflow object. */
function toWorkflowModel(source: unknown): Record<string, unknown> {
	if (typeof source === "string") {
		// A path or the JSON itself — the back-compat entry point for JSON workflows.
		const text = source.trimStart().startsWith("{") ? source : readFileSync(source, "utf8");
		return JSON.parse(text) as Record<string, unknown>;
	}
	if (source === null || typeof source !== "object") {
		throw new Error("runWorkflow() needs a workflow() export, a workflow object, or a path to a workflow JSON.");
	}
	const wrapper = source as { _config?: unknown };
	const model = (wrapper._config ?? source) as Record<string, unknown>;
	if (!Array.isArray(model.steps)) {
		throw new Error("runWorkflow(): the workflow has no `steps` array — is this really a workflow() export?");
	}
	return model;
}

/**
 * Every step in the normalized workflow, in authoring order, nested arms
 * immediately after the construct that owns them.
 *
 * A normalized step is `{name, node, type}` at the top level; its arms live in
 * `nodes[name]` (`steps` for forEach/loop, `conditions[].steps` for the
 * if-else a `branch()` lowers to, `cases[].steps` + `default` for switch, …).
 * Walking the `nodes` map through each step keeps arms in declaration order —
 * which is what makes "this arm was skipped" readable in a test failure.
 */
function declaredSteps(workflow: InternalWorkflow): DeclaredStep[] {
	const out: DeclaredStep[] = [];
	const seen = new Set<string>();
	const nodes = workflow.nodes as unknown as Record<string, unknown>;

	const walk = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		if (value === null || typeof value !== "object") return;
		const obj = value as Record<string, unknown>;

		if (typeof obj.name === "string" && typeof obj.node === "string" && !seen.has(obj.name)) {
			const type = typeof obj.type === "string" ? obj.type : "module";
			seen.add(obj.name);
			out.push({
				id: obj.name,
				use: obj.node,
				type,
				structural: obj.flow === true || STRUCTURAL_TYPES.has(type),
			});
			walk(nodes[obj.name]); // this step's arms, if it has any
			return;
		}

		for (const [key, nested] of Object.entries(obj)) {
			// `inputs` is author data, not structure — never walk into it.
			if (key !== "inputs") walk(nested);
		}
	};

	walk(workflow.steps);
	return out;
}

/**
 * Let `mock` reach a cross-runtime step.
 *
 * A `runtime.<kind>` step is resolved by KIND, not through the node registry,
 * so a mock registered under its key would be ignored and the test would go
 * looking for a live sidecar. Dropping the pin on the steps the author
 * explicitly mocked routes them back through the in-process registry, where
 * the mock is. Untouched when nothing runtime-typed is mocked.
 */
function unpinMockedRuntimeSteps(
	model: Record<string, unknown>,
	declared: readonly DeclaredStep[],
	mock?: Record<string, NodeMock>,
): Record<string, unknown> {
	const keys = new Set(declared.filter((d) => d.type.startsWith("runtime.") && mock?.[d.use]).map((d) => d.use));
	if (keys.size === 0) return model;

	const strip = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) strip(item);
			return;
		}
		if (value === null || typeof value !== "object") return;
		const obj = value as Record<string, unknown>;
		const ref = typeof obj.use === "string" ? obj.use : obj.node;
		if (typeof ref === "string" && keys.has(ref) && typeof obj.type === "string" && obj.type.startsWith("runtime.")) {
			obj.type = undefined;
		}
		for (const [key, nested] of Object.entries(obj)) {
			if (key !== "inputs") strip(nested);
		}
	};

	const copy = structuredClone(model);
	strip(copy.steps);
	return copy;
}

/** Resolve every node key the workflow references and register it, instrumented. */
async function registerNodes(
	runner: WorkflowTestRunner,
	model: Record<string, unknown>,
	declared: readonly DeclaredStep[],
	calls: RecordedCall[],
	violations: Error[],
	opts?: RunWorkflowOptions,
): Promise<void> {
	const explicit = new Map((opts?.nodes ?? []).map((n) => [n.name, n as unknown as NodeBase]));
	// Only `module` steps go through the node registry — forEach/switch/tryCatch
	// and friends are resolved by the runner itself, and a `runtime.<kind>` step
	// that was NOT mocked is a live-sidecar call this harness deliberately leaves
	// alone (mocking one rewrites it to `module` before we get here).
	const keys = new Set(
		declared
			.filter((s) => s.type === "module" || (s.type.startsWith("runtime.") && opts?.mock?.[s.use] !== undefined))
			.map((s) => s.use),
	);
	const missing: string[] = [];

	for (const key of keys) {
		const mock = opts?.mock?.[key];
		if (mock) {
			const impl = mock as unknown as (input: unknown, ctx: Context) => unknown | Promise<unknown>;
			// A regular function, not an arrow: `MockNode.handle` invokes the
			// handler as `this.handler(...)`, and the runner clones the mock node
			// per step with `name` set to the step id — so `this.name` is the only
			// place the step id is visible from inside a mock.
			runner.mockNode(key, async function (this: { name?: string }, mockInput: unknown, ctx: Context) {
				const value = await impl(mockInput, ctx);
				let output: unknown;
				try {
					output = validateMockOutput(key, value);
				} catch (violation) {
					violations.push(violation as Error);
					throw violation;
				}
				calls.push({ id: typeof this?.name === "string" ? this.name : key, inputs: mockInput, output });
				return output;
			});
			continue;
		}
		const node = explicit.get(key) ?? getDefinedNode(key) ?? (await importNode(key));
		if (!node) {
			missing.push(key);
			continue;
		}
		runner.registerNode(key, instrument(node as NodeBase, calls) as never);
	}

	if (missing.length > 0) {
		const refs = missing.map((k) => `"${k}"`).join(", ");
		throw new Error(
			`runWorkflow("${String(model.name ?? "workflow")}"): no implementation found for node ${missing.length > 1 ? "keys" : "key"} ${refs}.\n` +
				`A defineNode() node registers itself once its module is imported — importing the workflow normally does that. Otherwise pass it in: { nodes: [myNode] }, or mock it by key: { mock: { "${missing[0]}": async (input) => ({ /* … */ }) } }.`,
		);
	}
}

/**
 * Wrap a node so every invocation reports its resolved inputs and output.
 *
 * The wrapper is a shallow clone carrying an OWN `handle`, because
 * `Configuration.moduleResolver` clones the registered node per step with
 * `Object.assign(Object.create(proto), node)` — own properties survive that,
 * and `this` inside is the per-step clone, whose `name` is the step id.
 */
function instrument(node: NodeBase, calls: RecordedCall[]): NodeBase {
	type Handler = (ctx: Context, inputs: unknown) => Promise<unknown>;
	const original = (node as unknown as { handle: Handler }).handle;
	const wrapper = Object.assign(Object.create(Object.getPrototypeOf(node)) as NodeBase, node);

	(wrapper as unknown as { handle: Handler }).handle = async function (
		this: NodeBase,
		ctx: Context,
		inputs: unknown,
	): Promise<unknown> {
		const response = await original.call(this, ctx, inputs);
		const envelope = response as { data?: unknown; error?: unknown } | undefined;
		const failed = envelope?.error !== undefined && envelope?.error !== null;
		calls.push({ id: this.name, inputs, output: failed ? null : (envelope?.data ?? null) });
		return response;
	};
	return wrapper;
}

/**
 * Check a mock's return value against the real node's declared output schema.
 *
 * This is the whole point of mocking by KEY rather than by handler: the key
 * still identifies a node with a published contract. A mock that returns a
 * field the schema never declares is the exact defect class that ships to
 * production green ("readModelServed: null"), so unknown keys are rejected —
 * `strict()` on the output object, not the node's own permissive `parse`.
 *
 * A key with no resolvable node (a cross-runtime stub, or a node string that
 * was never imported) has no contract to check — the mock passes through.
 */
function validateMockOutput(key: string, value: unknown): unknown {
	const real = getDefinedNode(key) as FunctionNode<z.ZodTypeAny, z.ZodTypeAny> | undefined;
	const schema = real?.schemas?.output;
	if (!schema) return value;

	const strictable = schema as { strict?: () => z.ZodTypeAny };
	const checked = typeof strictable.strict === "function" ? strictable.strict() : schema;
	const parsed = checked.safeParse(value);
	if (parsed.success) return parsed.data;

	const problems = parsed.error.issues.map((issue) => {
		const unknownKeys = (issue as { keys?: unknown }).keys;
		if (Array.isArray(unknownKeys)) {
			return `  - field(s) not in the output schema: ${unknownKeys.map(String).join(", ")}`;
		}
		return `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`;
	});
	const hint =
		"Fix the mock to match the node's output schema (or fix the schema) — a mock that can lie about the contract hides exactly the wiring bug this test would otherwise catch.";
	throw new Error(
		`Mock for node "${key}" returned data its declared output schema rejects:\n${problems.join("\n")}\n${hint}`,
	);
}

/** npm package specifier — a node ref that a consumer can plainly `import`. */
const PACKAGE_SPECIFIER = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

/**
 * Last resort for a node key that nothing in-process defines: import it.
 *
 * Node keys ARE package names for published nodes (ADR 0002), so this resolves
 * `@blokjs/if-else` (what `branch()` lowers to), `@blokjs/expr`, and any node
 * package the consumer depends on, with no registration ceremony. Failure is
 * not an error here — the caller reports the unresolved keys together.
 */
async function importNode(key: string): Promise<NodeBase | undefined> {
	if (!PACKAGE_SPECIFIER.test(key)) return undefined;
	try {
		const mod = (await import(key)) as { default?: unknown };
		const value = mod.default;
		const named = value as { name?: unknown; handle?: unknown } | undefined;
		return typeof named?.name === "string" && typeof named?.handle === "function" ? (value as NodeBase) : undefined;
	} catch {
		return undefined;
	}
}

/** Best-effort human text for whatever a node threw (Error, GlobalError, or a bare value). */
function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (error && typeof error === "object") {
		const ctx = (error as { context?: { message?: unknown } }).context;
		if (ctx && typeof ctx.message === "string") return ctx.message;
		return JSON.stringify(error);
	}
	return String(error);
}
