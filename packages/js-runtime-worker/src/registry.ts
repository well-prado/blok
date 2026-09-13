/**
 * Node registry + execution for the JavaScript worker.
 *
 * The worker executes the SAME `defineNode()` modules the in-process adapter
 * executes, loaded from the SAME source of truth: the project's generated
 * `Nodes.ts` default export (a `Record<string, NodeBase>` built from the npm
 * nodes plus `discoverNodes()`), which is exactly what the runner turns into
 * its `NodeMap`. Registration follows `NodeMap.addNodes`: each node registers
 * under its OWN `node.name` — the canonical `use:` ref (ADR 0002) — so a node
 * is registered once regardless of the map key it was exported under.
 */

import type { Context, NodeBase, RuntimeKind } from "@blokjs/shared";
import { WorkerError } from "./errors.js";
import { detectHostRuntime, runtimeKindOf } from "./host.js";

/** What the worker needs from a node beyond `NodeBase`. Duck-typed on purpose:
 * `handle()` lives on `BlokService` in `@blokjs/runner`, and the reflection
 * schemas only on `FunctionNode`, but a plain `NodeBase` subclass is still a
 * valid node. */
export interface WorkerNode extends NodeBase {
	description?: string;
	handle?(ctx: Context, inputs: unknown): Promise<unknown>;
	getReflectionSchemas?(): { input: unknown; output: unknown };
	inputSchema?: unknown;
	outputSchema?: unknown;
}

export interface NodeDescriptor {
	name: string;
	description: string;
	inputSchema: unknown;
	outputSchema: unknown;
	tags: string[];
	capabilityManifest: unknown;
}

export interface ExecuteContextProjection {
	/** Resolved step inputs — already mapped by the runner. */
	inputs: unknown;
	/** Step id, the key the node's config slice lives under. */
	stepName: string;
	/** Trigger request envelope (`ctx.request`). */
	request: Context["request"];
	/** Environment mirror the runner chose to expose (`ctx.env`). */
	env: Record<string, string>;
	/** Run id (`ctx.id`). */
	runId: string;
	workflowName: string;
	workflowPath: string;
	/** Cooperative cancellation, wired to the gRPC deadline and cancel signal. */
	signal: AbortSignal;
}

export interface WorkerLogLine {
	level: string;
	message: string;
	attributes: Record<string, string>;
}

export interface WorkerExecution {
	success: boolean;
	data: unknown;
	error: unknown;
	logs: WorkerLogLine[];
	contentType: string;
	varsDelta: Record<string, unknown>;
}

/** Captures what a node logs so it can ride back on the response. */
class CapturingLogger {
	readonly lines: WorkerLogLine[] = [];
	private readonly plain: string[] = [];

	log(message: string): void {
		this.logLevel("info", message);
	}
	logLevel(level: string, message: string): void {
		if (this.lines.length >= 512) return; // bounded: a chatty node must not OOM the worker
		this.lines.push({ level, message, attributes: {} });
		this.plain.push(message);
	}
	error(message: string, stack: string): void {
		this.logLevel("error", stack ? `${message}\n${stack}` : message);
	}
	getLogs(): string[] {
		return this.plain;
	}
	getLogsAsText(): string {
		return this.plain.join("\n");
	}
	getLogsAsBase64(): string {
		return Buffer.from(this.getLogsAsText()).toString("base64");
	}
	isLevelEnabled(): boolean {
		return true;
	}
}

/**
 * Build the documented context projection (ADR 0016 §3): resolved inputs, the
 * trigger request, env, a logger, and a cancellation signal. Deliberately NOT
 * the accumulated workflow state — `ctx.state`/`ctx.vars` start empty and any
 * `ctx.publish` write travels back as `vars_delta`.
 */
function projectContext(p: ExecuteContextProjection): {
	ctx: Context;
	logger: CapturingLogger;
	vars: Record<string, unknown>;
} {
	const logger = new CapturingLogger();
	const vars: Record<string, unknown> = {};
	const ctx = {
		id: p.runId,
		workflow_name: p.workflowName,
		workflow_path: p.workflowPath,
		request: p.request,
		response: { success: true, data: null, error: null },
		error: { message: "" },
		logger,
		eventLogger: logger,
		config: { [p.stepName]: { inputs: p.inputs } },
		state: {},
		vars: {},
		env: p.env,
		signal: p.signal,
		publish: (name: string, value: unknown) => {
			vars[name] = value;
		},
	} as unknown as Context;
	return { ctx, logger, vars };
}

/**
 * The runtime constraint a node declares (`capabilityManifest.runtimes`).
 *
 * Entries are canonical runner kinds — `nodejs`, `bun`, `deno`, `go`, … — with
 * the project-target aliases `node`/`typescript`/`ts` accepted for `nodejs`.
 * An absent or empty list means portable: runnable on any engine.
 */
function declaredRuntimes(node: WorkerNode): string[] {
	const manifest = (node.capabilityManifestRaw ?? node.capabilityManifest) as { runtimes?: unknown } | null | undefined;
	const runtimes = manifest?.runtimes;
	if (!Array.isArray(runtimes)) return [];
	return runtimes.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

const RUNTIME_ALIASES: Readonly<Record<string, string>> = { node: "nodejs", typescript: "nodejs", ts: "nodejs" };

/**
 * Is a node with these declared runtimes executable on `kind`?
 *
 * ADR 0016 §4: a node that reaches for `node:` APIs, `Bun.*`, `Deno.*`, or a
 * native addon declares the engines it supports. Loading it into the wrong
 * worker must fail at BOOT with a message naming both sides, not halfway
 * through a production run with a `ReferenceError: Bun is not defined`.
 */
export function isRuntimeCompatible(declared: readonly string[], kind: RuntimeKind): boolean {
	if (declared.length === 0) return true;
	return declared.some((entry) => {
		const normalized = entry.toLowerCase().replace(/^runtime\./, "");
		return (RUNTIME_ALIASES[normalized] ?? normalized) === kind;
	});
}

export interface IncompatibleNode {
	name: string;
	declared: string[];
	message: string;
}

export class WorkerRegistry {
	private readonly nodes = new Map<string, WorkerNode>();
	/** Nodes this engine refused: declared for other runtimes only. */
	private readonly incompatible = new Map<string, IncompatibleNode>();
	/** Executions served by THIS process, for the worker-reuse proof. */
	public executions = 0;

	constructor(private readonly runtimeKind: RuntimeKind = runtimeKindOf(detectHostRuntime())) {}

	/** Register under the node's own `name`. A later registration replaces an
	 * earlier one so a project node can shadow a built-in fixture of the same
	 * name; the caller decides whether to warn.
	 *
	 * Returns the rejection when the node declares a runtime constraint this
	 * engine does not satisfy — the caller reports it at boot. */
	register(node: WorkerNode): IncompatibleNode | null {
		const name = (node as { name?: unknown }).name;
		if (typeof name !== "string" || name.length === 0) {
			throw new Error(
				"[blok][worker] a node has no string `name` to register under — every defineNode() needs a name.",
			);
		}
		const declared = declaredRuntimes(node);
		if (!isRuntimeCompatible(declared, this.runtimeKind)) {
			const rejection: IncompatibleNode = {
				name,
				declared,
				message: `Node "${name}" declares capabilityManifest.runtimes = [${declared.join(", ")}] and cannot run on runtime.${this.runtimeKind}. Select a matching JavaScript target (\`blokctl runtime use …\`), pin the step to a runtime it declares, or widen the node's declaration if it is actually portable.`,
			};
			this.incompatible.set(name, rejection);
			this.nodes.delete(name);
			return rejection;
		}
		this.incompatible.delete(name);
		this.nodes.set(name, node);
		return null;
	}

	/** Nodes refused at load because they declare other runtimes. */
	rejected(): IncompatibleNode[] {
		return [...this.incompatible.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	has(name: string): boolean {
		return this.nodes.has(name);
	}

	names(): string[] {
		return [...this.nodes.keys()].sort();
	}

	descriptors(): NodeDescriptor[] {
		return this.names().map((name) => {
			const node = this.nodes.get(name) as WorkerNode;
			// `getReflectionSchemas()` is the real draft-7 JSON Schema derived
			// from the node's Zod contract; `inputSchema` is the permissive `{}`
			// the in-process pre-check uses and would tell a consumer nothing.
			const reflected = node.getReflectionSchemas?.();
			return {
				name,
				description: node.description ?? "",
				inputSchema: reflected?.input ?? node.inputSchema ?? {},
				outputSchema: reflected?.output ?? node.outputSchema ?? {},
				tags: [],
				capabilityManifest: node.capabilityManifestRaw ?? node.capabilityManifest ?? null,
			};
		});
	}

	/**
	 * Run one node.
	 *
	 * ponytail: calls `handle()`, not `run()`. `run()` additionally re-runs the
	 * blueprint mapper over inputs the runner already resolved, emits per-node
	 * OTel metrics the runner records again on its own side, and calls
	 * `applyStepOutput` into a `ctx.state` this process throws away. `handle()`
	 * is exactly the Zod-validate → execute → Zod-validate contract the wire
	 * protocol specifies.
	 */
	async execute(nodeName: string, projection: ExecuteContextProjection): Promise<WorkerExecution> {
		const rejection = this.incompatible.get(nodeName);
		if (rejection) {
			// Distinct from NODE_NOT_FOUND on purpose: the node EXISTS, this
			// engine is the wrong one for it. A "not found" here would send the
			// operator hunting for a missing file.
			throw new WorkerError(
				"NODE_RUNTIME_INCOMPATIBLE",
				rejection.message,
				"CONFIGURATION",
				501,
				false,
				`Declared runtimes: ${rejection.declared.join(", ")}. This worker executes runtime.${this.runtimeKind}.`,
			);
		}
		const registered = this.nodes.get(nodeName);
		if (!registered) {
			throw new WorkerError(
				"NODE_NOT_FOUND",
				`Node "${nodeName}" is not registered in this worker`,
				"NOT_FOUND",
				404,
				false,
				`Registered nodes: ${this.names().join(", ") || "(none)"}. Check the node's defineNode({ name }) and that it is reachable from the project's Nodes module.`,
			);
		}
		if (typeof registered.handle !== "function") {
			throw new WorkerError(
				"NODE_NOT_EXECUTABLE",
				`Node "${nodeName}" has no handle() — only defineNode()/BlokService nodes can run in a runtime worker`,
				"CONFIGURATION",
				501,
			);
		}
		this.executions++;

		// Per-call clone so concurrent executions of the same node never share
		// the mutable `name`/`originalConfig` fields — same trick the runner's
		// moduleResolver uses for the in-process path.
		const node = Object.assign(Object.create(Object.getPrototypeOf(registered)), registered) as WorkerNode;
		node.name = projection.stepName;

		const { ctx, logger, vars } = projectContext(projection);
		const result = (await node.handle?.(ctx, projection.inputs)) as
			| { success?: boolean; data?: unknown; error?: unknown }
			| unknown[];

		if (Array.isArray(result)) {
			throw new WorkerError(
				"FLOW_NODE_UNSUPPORTED",
				`Node "${nodeName}" is a flow node; flow control runs in the orchestrator, not in a runtime worker`,
				"CONFIGURATION",
				501,
			);
		}

		const errored = result?.error !== undefined && result?.error !== null;
		return {
			success: !errored && result?.success !== false,
			data: errored ? null : result?.data,
			error: errored ? result?.error : null,
			logs: logger.lines,
			contentType: registered.contentType || "application/json",
			varsDelta: vars,
		};
	}
}

/**
 * Import a project's node module and return its nodes. Accepts the generated
 * `Nodes.ts`/`Nodes.js` default export shape (`Record<string, NodeBase>`), a
 * default-exported array, or a module whose named exports are nodes.
 */
export async function loadNodesFromModule(specifier: string): Promise<WorkerNode[]> {
	const mod = (await import(specifier)) as Record<string, unknown>;
	const candidates = mod.default !== undefined ? mod.default : mod;
	const values = Array.isArray(candidates)
		? candidates
		: candidates !== null && typeof candidates === "object"
			? Object.values(candidates as Record<string, unknown>)
			: [];
	return values.filter(isWorkerNode);
}

function isWorkerNode(value: unknown): value is WorkerNode {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as { name?: unknown; handle?: unknown };
	return typeof candidate.name === "string" && candidate.name.length > 0 && typeof candidate.handle === "function";
}
