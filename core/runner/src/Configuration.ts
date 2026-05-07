// import { NodeBase } from "@blokjs/shared";
// import { z } from "zod";
import { sep as pathSep, resolve as resolvePath } from "node:path";
import { tryParseDuration } from "@blokjs/helper";
import type { NodeBase } from "@blokjs/shared";
import ConfigurationResolver from "./ConfigurationResolver";
import RunnerNode from "./RunnerNode";
import type RunnerNodeBase from "./RunnerNodeBase";
import { RuntimeAdapterNode } from "./RuntimeAdapterNode";
import { RuntimeRegistry } from "./RuntimeRegistry";
import { HttpRuntimeAdapter } from "./adapters/HttpRuntimeAdapter";
import { NodeJsRuntimeAdapter } from "./adapters/NodeJsRuntimeAdapter";
import type { RuntimeAdapter, RuntimeKind } from "./adapters/RuntimeAdapter";
import { GrpcRuntimeAdapter } from "./adapters/grpc/GrpcRuntimeAdapter";
import { DEFAULT_GRPC_PORTS, GRPC_DEFAULTS, type GrpcAdapterConfig, type Transport } from "./adapters/grpc/types";
import {
	isLoopbackHost,
	isStreamLogsEnabled,
	isStrictTlsEnabled,
	loadTlsConfigForKind,
	resolveHealthCheckFailureThreshold,
	resolveHealthCheckIntervalMs,
	resolveTransportForKind,
} from "./adapters/transport";
import type Condition from "./types/Condition";
import type Config from "./types/Config";
import type Flow from "./types/Flow";
import type GlobalOptions from "./types/GlobalOptions";
import type Mapper from "./types/Mapper";
import type Node from "./types/Node";
import type Trigger from "./types/Trigger";
import type TryCatch from "./types/TryCatch";

export default class Configuration implements Config {
	public workflow: Config = <Config>{};
	public name: string;
	public version: string;
	public steps: NodeBase[];
	public nodes: Node;
	public trigger: Trigger;
	public static loaded_nodes: Node = <Node>{};
	public globalOptions: GlobalOptions | undefined;

	constructor() {
		this.steps = [];
		this.nodes = <Node>{};
		this.version = "";
		this.name = "";
		this.trigger = {};
		this.initializeRuntimeRegistry();
	}

	/**
	 * Initialize the RuntimeRegistry with built-in adapters.
	 *
	 * Registers `NodeJsRuntimeAdapter` for in-process JS nodes, then for each
	 * SDK language picks `HttpRuntimeAdapter` or `GrpcRuntimeAdapter` based on
	 * {@link resolveTransportForKind} (env-driven). This is the single point
	 * of transport selection — no other file branches on transport.
	 */
	private initializeRuntimeRegistry(): void {
		const registry = RuntimeRegistry.getInstance();

		if (!registry.has("nodejs")) {
			registry.register(new NodeJsRuntimeAdapter());
		}

		const sdkLanguages: Array<{
			kind: RuntimeKind;
			hostEnv: string;
			httpPortEnv: string;
			grpcPortEnv: string;
			defaultHttpPort: number;
		}> = [
			{
				kind: "go",
				hostEnv: "RUNTIME_GO_HOST",
				httpPortEnv: "RUNTIME_GO_PORT",
				grpcPortEnv: "RUNTIME_GO_GRPC_PORT",
				defaultHttpPort: 9001,
			},
			{
				kind: "rust",
				hostEnv: "RUNTIME_RUST_HOST",
				httpPortEnv: "RUNTIME_RUST_PORT",
				grpcPortEnv: "RUNTIME_RUST_GRPC_PORT",
				defaultHttpPort: 9002,
			},
			{
				kind: "java",
				hostEnv: "RUNTIME_JAVA_HOST",
				httpPortEnv: "RUNTIME_JAVA_PORT",
				grpcPortEnv: "RUNTIME_JAVA_GRPC_PORT",
				defaultHttpPort: 9003,
			},
			{
				kind: "csharp",
				hostEnv: "RUNTIME_CSHARP_HOST",
				httpPortEnv: "RUNTIME_CSHARP_PORT",
				grpcPortEnv: "RUNTIME_CSHARP_GRPC_PORT",
				defaultHttpPort: 9004,
			},
			{
				kind: "php",
				hostEnv: "RUNTIME_PHP_HOST",
				httpPortEnv: "RUNTIME_PHP_PORT",
				grpcPortEnv: "RUNTIME_PHP_GRPC_PORT",
				defaultHttpPort: 9005,
			},
			{
				kind: "ruby",
				hostEnv: "RUNTIME_RUBY_HOST",
				httpPortEnv: "RUNTIME_RUBY_PORT",
				grpcPortEnv: "RUNTIME_RUBY_GRPC_PORT",
				defaultHttpPort: 9006,
			},
			{
				kind: "python3",
				hostEnv: "RUNTIME_PYTHON3_HOST",
				httpPortEnv: "RUNTIME_PYTHON3_PORT",
				grpcPortEnv: "RUNTIME_PYTHON3_GRPC_PORT",
				defaultHttpPort: 9007,
			},
		];

		for (const lang of sdkLanguages) {
			if (registry.has(lang.kind)) continue;
			const transport: Transport = resolveTransportForKind(lang.kind);
			const host = process.env[lang.hostEnv] || "localhost";
			const adapter: RuntimeAdapter =
				transport === "grpc"
					? this.buildGrpcAdapter(lang.kind, host, lang.grpcPortEnv)
					: this.buildHttpAdapter(lang.kind, host, lang.httpPortEnv, lang.defaultHttpPort);
			registry.register(adapter);
		}
	}

	private buildHttpAdapter(kind: RuntimeKind, host: string, portEnv: string, defaultPort: number): HttpRuntimeAdapter {
		const port = process.env[portEnv] ? Number.parseInt(process.env[portEnv] as string, 10) : defaultPort;
		return new HttpRuntimeAdapter(kind, host, port);
	}

	private buildGrpcAdapter(kind: RuntimeKind, host: string, portEnv: string): GrpcRuntimeAdapter {
		const defaultPort = DEFAULT_GRPC_PORTS[kind];
		const port = process.env[portEnv] ? Number.parseInt(process.env[portEnv] as string, 10) : defaultPort;
		const tls = loadTlsConfigForKind(kind);

		// Strict mode rejects insecure channels against non-loopback hosts so
		// production deployments can't accidentally ship plaintext mTLS-bypass.
		if (!tls && isStrictTlsEnabled() && !isLoopbackHost(host)) {
			throw new Error(
				`BLOK_GRPC_REQUIRE_TLS=true: refusing to build a plaintext gRPC adapter for runtime.${kind} targeting ${host}:${port}. Set RUNTIME_${kind.toUpperCase()}_TLS_CA (and CLIENT_CERT/CLIENT_KEY for mTLS) or fall back to a loopback host.`,
			);
		}

		const config: GrpcAdapterConfig = {
			kind,
			host,
			port,
			defaultDeadlineMs: GRPC_DEFAULTS.DEFAULT_DEADLINE_MS,
			maxMessageBytes: GRPC_DEFAULTS.MAX_MESSAGE_BYTES,
			keepalive: {
				timeMs: GRPC_DEFAULTS.KEEPALIVE_TIME_MS,
				timeoutMs: GRPC_DEFAULTS.KEEPALIVE_TIMEOUT_MS,
				permitWithoutCalls: GRPC_DEFAULTS.KEEPALIVE_PERMIT_WITHOUT_CALLS,
			},
			tls,
			healthCheckIntervalMs: resolveHealthCheckIntervalMs(),
			healthCheckFailureThreshold: resolveHealthCheckFailureThreshold(),
		};
		const adapter = new GrpcRuntimeAdapter(config);
		// Start the background health probe loop now so the circuit breaker
		// is warm before the first workflow run. Adapters created in tests
		// either disable the interval (BLOK_GRPC_HEALTH_INTERVAL_MS=0) or
		// avoid Configuration entirely.
		adapter.startHealthCheck();
		return adapter;
	}

	/**
	 * Initialize the configuration for a workflow run.
	 *
	 * @param workflowNameInPath - workflow identifier; used by the resolver
	 *   to locate the workflow on disk and as the trace label.
	 * @param opts - global options (workflows map, nodes map, etc.).
	 * @param preloaded - optional pre-parsed workflow object. When provided,
	 *   the resolver is skipped and this object is used directly. Used by
	 *   the file-based router so workflows scanned at boot don't re-load
	 *   from disk on every request. The object still flows through the
	 *   normalizer for v1→v2 conversion.
	 */
	public async init(workflowNameInPath: string, opts?: GlobalOptions, preloaded?: unknown) {
		if (this.globalOptions === undefined && opts !== undefined) {
			this.globalOptions = opts;
		}

		if (workflowNameInPath === undefined) throw new Error("Workflow name must be provided");

		if (preloaded !== undefined) {
			// Boot-time scan path — workflow object already loaded, just
			// normalize it through the same v1→v2 pipeline as disk-loaded
			// workflows. **Deep-clone first** so per-request mutations
			// (`NodeBase.blueprintMapper` → `mapper.replaceObjectStrings`
			// resolves `js/...` expressions in place) don't bleed across
			// requests by baking the first request's resolved values into
			// the shared route-table workflow object. JSON-clone is safe:
			// workflow definitions are pure data, and helper proxies like
			// `$.req.body` serialize to their `js/...` string form via
			// `Symbol.toPrimitive` / `toJSON`.
			const { normalizeWorkflow } = await import("./workflow/WorkflowNormalizer");
			const fresh = JSON.parse(JSON.stringify(preloaded));
			this.workflow = normalizeWorkflow(fresh, workflowNameInPath) as unknown as typeof this.workflow;
		} else {
			const resolver = new ConfigurationResolver(opts as GlobalOptions);
			this.workflow = await resolver.get("local", workflowNameInPath as string);
		}

		if (!this.workflow) throw new Error(`No workflow found with path '${workflowNameInPath}'`);

		// Instances of the Blok Services
		this.steps = await this.getSteps(this.workflow.steps as RunnerNode[]);

		// Configuration of the Blok Services
		this.nodes = await this.getNodes(this.workflow.nodes);
		this.version = this.workflow.version;
		this.name = this.workflow.name;
		this.trigger = this.workflow.trigger;
	}

	protected async getSteps(blueprint_steps: RunnerNode[]): Promise<NodeBase[]> {
		const nodes: NodeBase[] = [];

		if (blueprint_steps === undefined) {
			throw new Error("Workflow must have at least one step");
		}
		if (blueprint_steps.length === 0) {
			throw new Error("Workflow must have at least one step");
		}

		for (let i = 0; i < blueprint_steps.length; i++) {
			const step: RunnerNode = blueprint_steps[i];
			const node: RunnerNode = await this.nodeResolver(step);

			// const validator = z.instanceof(NodeBase);
			// validator.parse(node);
			node.node = step.node;
			node.name = step.name;
			node.active = step.active !== undefined ? step.active : true;
			node.stop = step.stop !== undefined ? step.stop : false;
			// Pass `set_var` through verbatim — DO NOT default to `false`. The
			// `false` value short-circuits PersistenceHelper.applyStepOutput
			// and silently disables v2's default-store rule. Legacy v1
			// workflows that explicitly set `set_var: false` are normalized
			// to `ephemeral: true` upstream by WorkflowNormalizer.
			if (step.set_var !== undefined) node.set_var = step.set_var;
			// V2 persistence knobs — read by PersistenceHelper.applyStepOutput.
			// `as` renames the state key; `spread` flattens result.data into
			// state; `ephemeral: true` skips persistence entirely. Default
			// behaviour (none set) is to store at state[name].
			node.as = (step as RunnerNode & { as?: string }).as;
			node.spread = (step as RunnerNode & { spread?: boolean }).spread === true;
			node.ephemeral = (step as RunnerNode & { ephemeral?: boolean }).ephemeral === true;
			// V2 idempotency cache + retry knobs — read by RunnerSteps before
			// delegating to step.process(). Caching layers ABOVE
			// PersistenceHelper; retry wraps the same call site.
			const v2Idem = step as RunnerNode & {
				idempotencyKey?: string;
				idempotencyKeyTTL?: number;
				retry?: NodeBase["retry"];
				subworkflow?: string;
				wait?: boolean;
				maxDuration?: number | string;
			};
			if (v2Idem.idempotencyKey !== undefined) node.idempotencyKey = v2Idem.idempotencyKey;
			if (v2Idem.idempotencyKeyTTL !== undefined) node.idempotencyKeyTTL = v2Idem.idempotencyKeyTTL;
			if (v2Idem.retry !== undefined) node.retry = v2Idem.retry;
			// V2 sub-workflow knobs — read by SubworkflowNode at run time.
			if (v2Idem.subworkflow !== undefined) node.subworkflow = v2Idem.subworkflow;
			if (v2Idem.wait !== undefined) node.wait = v2Idem.wait;
			// Tier 2 quick-wins — parse maxDuration string/number → ms.
			if (v2Idem.maxDuration !== undefined) {
				const parsed = tryParseDuration(v2Idem.maxDuration);
				if (parsed !== null) node.maxDurationMs = parsed;
			}
			nodes.push(node);
		}

		return nodes;
	}

	protected async getNodes(workflow_nodes: Node): Promise<Node> {
		const nodes: Node = <Node>{};

		if (workflow_nodes !== undefined) {
			const keys = Object.keys(workflow_nodes);

			for (let i = 0; i < keys.length; i++) {
				const key = keys[i];
				const currentNode = workflow_nodes[key] as RunnerNodeBase;

				const isFlow = currentNode.steps !== undefined && Array.isArray(currentNode.steps);
				const isConditions = currentNode.conditions !== undefined && Array.isArray(currentNode.conditions);
				const isFlowWithProperties = isFlow && Object.keys(workflow_nodes[key]).length > 1;
				const hasOutputs = currentNode.mapper !== undefined;

				if (isFlowWithProperties) {
					const steps = currentNode.steps as unknown as RunnerNode[];
					nodes[key] = await this.getFlow(steps);
					const copyBlueprintNode = { ...workflow_nodes[key] } as RunnerNodeBase;
					(copyBlueprintNode as unknown as Flow).steps = [];

					nodes[key] = { ...nodes[key], ...copyBlueprintNode };
				} else if (isFlow) {
					const steps = currentNode.steps as unknown as RunnerNode[];
					nodes[key] = await this.getFlow(steps);
				} else if (isConditions) {
					const conditions = currentNode.conditions as unknown as Condition[];
					for (let j = 0; j < conditions.length; j++) {
						const condition = conditions[j];
						const steps = condition.steps as unknown as RunnerNode[];
						const tempSteps = (await this.getFlow(steps)).steps;
						conditions[j].steps = [...tempSteps];
					}

					nodes[key] = { conditions };
				} else if (
					typeof workflow_nodes[key] === "object" &&
					currentNode.try &&
					(currentNode.try as unknown as Flow).steps &&
					currentNode.catch &&
					(currentNode.catch as unknown as Flow).steps
				) {
					(nodes[key] as TryCatch) = {
						try: await this.getFlow((currentNode.try as unknown as Flow).steps),
						catch: await this.getFlow((currentNode.catch as unknown as Flow).steps),
					};
				} else {
					nodes[key] = { ...workflow_nodes[key] };
				}

				// Resolves the internal mapper
				if (hasOutputs) {
					const step: RunnerNode = currentNode.mapper as unknown as RunnerNode;
					if (typeof step === "object" && step.name && step.node && step.type && step.node.startsWith("mapper@")) {
						(nodes[key] as Mapper).mapper = (await this.getFlow([step])).steps[0];
					}
				}
			}
		}

		return nodes;
	}

	protected async getFlow(steps: RunnerNode[]): Promise<Flow> {
		const flows: Flow = {
			steps: [],
		};

		for (let j = 0; j < steps.length; j++) {
			const step: RunnerNode = steps[j];
			const node: RunnerNode = await this.nodeResolver(step);
			node.node = step.node;
			node.name = step.name;
			node.active = step.active !== undefined ? step.active : true;
			node.stop = step.stop !== undefined ? step.stop : false;
			// Pass `set_var` through verbatim — DO NOT default to `false`. The
			// `false` value short-circuits PersistenceHelper.applyStepOutput
			// and silently disables v2's default-store rule. Legacy v1
			// workflows that explicitly set `set_var: false` are normalized
			// to `ephemeral: true` upstream by WorkflowNormalizer.
			if (step.set_var !== undefined) node.set_var = step.set_var;
			// V2 persistence + idempotency + retry knobs flow through nested
			// flow steps too. Without this, a `branch.then[0]` step with
			// `idempotencyKey` set would NOT be cached on rerun. Mirrors the
			// same trio Configuration.getSteps copies onto top-level steps.
			const v2Flow = step as RunnerNode & {
				as?: string;
				spread?: boolean;
				ephemeral?: boolean;
				idempotencyKey?: string;
				idempotencyKeyTTL?: number;
				retry?: NodeBase["retry"];
				subworkflow?: string;
				wait?: boolean;
				maxDuration?: number | string;
			};
			if (v2Flow.as !== undefined) node.as = v2Flow.as;
			node.spread = v2Flow.spread === true;
			node.ephemeral = v2Flow.ephemeral === true;
			if (v2Flow.idempotencyKey !== undefined) node.idempotencyKey = v2Flow.idempotencyKey;
			if (v2Flow.idempotencyKeyTTL !== undefined) node.idempotencyKeyTTL = v2Flow.idempotencyKeyTTL;
			if (v2Flow.retry !== undefined) node.retry = v2Flow.retry;
			// V2 sub-workflow knobs — also flow through nested branches so a
			// `branch.then[0]` step that invokes a sub-workflow works.
			if (v2Flow.subworkflow !== undefined) node.subworkflow = v2Flow.subworkflow;
			if (v2Flow.wait !== undefined) node.wait = v2Flow.wait;
			if (v2Flow.maxDuration !== undefined) {
				const parsed = tryParseDuration(v2Flow.maxDuration);
				if (parsed !== null) node.maxDurationMs = parsed;
			}

			// const validator = z.instanceof(NodeBase);
			// validator.parse(node);
			flows.steps.push(node);
		}

		return flows;
	}

	protected async nodeResolver(node: RunnerNode): Promise<RunnerNode> {
		const node_types = this.nodeTypes();
		if (node_types[node.type]) {
			return await node_types[node.type].resolver(node, this.globalOptions as GlobalOptions);
		}

		throw new Error(`Node type ${node.type} not found`);
	}

	protected nodeTypes(): NodeResolverTypes {
		return {
			module: {
				resolver: async (node: RunnerNode, opts: GlobalOptions) => await this.moduleResolver(node, opts),
			},
			local: {
				resolver: async (node: RunnerNode, opts: GlobalOptions) => await this.localResolver(node),
			},
			"runtime.python3": {
				resolver: async (node: RunnerNode) => await this.runtimeResolver(node),
			},
			"runtime.go": {
				resolver: async (node: RunnerNode) => await this.runtimeResolver(node),
			},
			"runtime.rust": {
				resolver: async (node: RunnerNode) => await this.runtimeResolver(node),
			},
			"runtime.java": {
				resolver: async (node: RunnerNode) => await this.runtimeResolver(node),
			},
			"runtime.csharp": {
				resolver: async (node: RunnerNode) => await this.runtimeResolver(node),
			},
			"runtime.php": {
				resolver: async (node: RunnerNode) => await this.runtimeResolver(node),
			},
			"runtime.ruby": {
				resolver: async (node: RunnerNode) => await this.runtimeResolver(node),
			},
			subworkflow: {
				resolver: async (node: RunnerNode) => await this.subworkflowResolver(node),
			},
			// PR 4 · `wait.for(duration)` / `wait.until(date)` step. Resolves
			// to a stub node — RunnerSteps intercepts before step.process()
			// runs, so the stub's `run()` should never fire in practice.
			// Without this entry, getSteps() throws `Node type wait not found`
			// at workflow load.
			wait: {
				resolver: async (node: RunnerNode) => await this.waitResolver(node),
			},
		};
	}

	async runtimeResolver(node: RunnerNode): Promise<RunnerNode> {
		// Determine the runtime kind from explicit field or type string
		// e.g., "runtime.go" → "go", "runtime.python3" → "python3"
		let runtimeKind: string | undefined = node.runtime;
		if (!runtimeKind && node.type?.startsWith("runtime.")) {
			runtimeKind = node.type.substring("runtime.".length);
		}
		// Backward compatibility: default to "python3" if nothing specified
		if (!runtimeKind) {
			runtimeKind = "python3";
		}

		// Get the runtime adapter from registry
		const registry = RuntimeRegistry.getInstance();
		const adapter = registry.get(runtimeKind as RuntimeKind);

		// Create a minimal node instance to pass to the adapter
		// The adapter will execute this node
		const targetNode = new (class extends RunnerNode {
			async run() {
				return { success: false, data: null, error: null };
			}
		})();
		targetNode.node = node.node;
		targetNode.name = node.name;
		targetNode.type = node.type;
		targetNode.runtime = runtimeKind as RuntimeKind;
		targetNode.active = node.active !== undefined ? node.active : true;
		targetNode.stop = node.stop !== undefined ? node.stop : false;
		// Pass `set_var` through verbatim — DO NOT default to `false`. The v2
		// default-store rule in PersistenceHelper persists `result.data` at
		// `state[name]` unless `set_var === false` is explicit. Defaulting to
		// `false` here silently disabled persistence for every SDK step,
		// breaking `js/ctx.state['<id>']` reads in v2 workflows
		// (cross-runtime-chain regressed: `state['go']` was undefined even
		// though the GO step ran fine).
		if (node.set_var !== undefined) targetNode.set_var = node.set_var;
		// V2 persistence knobs — flow through to PersistenceHelper.
		const v2 = node as RunnerNode & {
			as?: string;
			spread?: boolean;
			ephemeral?: boolean;
			idempotencyKey?: string;
			idempotencyKeyTTL?: number;
			retry?: NodeBase["retry"];
			maxDuration?: number | string;
		};
		if (v2.as !== undefined) targetNode.as = v2.as;
		targetNode.spread = v2.spread === true;
		targetNode.ephemeral = v2.ephemeral === true;
		// V2 idempotency cache + retry knobs — copied here so the targetNode
		// surfaces them for any future code that inspects the inner SDK node
		// directly. The OUTER RuntimeAdapterNode also carries them via
		// getSteps/getFlow so RunnerSteps' cache-check + retry-loop wrapper
		// works regardless of which side it reads.
		if (v2.idempotencyKey !== undefined) targetNode.idempotencyKey = v2.idempotencyKey;
		if (v2.idempotencyKeyTTL !== undefined) targetNode.idempotencyKeyTTL = v2.idempotencyKeyTTL;
		if (v2.retry !== undefined) targetNode.retry = v2.retry;
		if (v2.maxDuration !== undefined) {
			const parsed = tryParseDuration(v2.maxDuration);
			if (parsed !== null) targetNode.maxDurationMs = parsed;
		}

		// Wrap in RuntimeAdapterNode to integrate with existing Runner.
		// Per-step `stream_logs: true|false` overrides the global
		// `BLOK_STREAM_LOGS` env flag (master plan §17 Phase 5 follow-up).
		// This lets workflow authors silence one chatty step without
		// disabling streaming workflow-wide, or opt a single step in
		// without flipping the whole runtime.
		const stepStreamLogs = (node as { stream_logs?: boolean }).stream_logs;
		const streamLogs = stepStreamLogs !== undefined ? stepStreamLogs : isStreamLogsEnabled();
		return new RuntimeAdapterNode(adapter, targetNode, { streamLogs }) as RunnerNode;
	}

	/**
	 * Resolve a `subworkflow` step into a fully-wired `SubworkflowNode` —
	 * the dispatch class that looks up the named child workflow in the
	 * `WorkflowRegistry` and runs it inline with isolated state.
	 *
	 * The returned node carries the parent's `globalOptions` so the
	 * child `Configuration.init()` can resolve `module` step references
	 * against the same node registry.
	 */
	protected async subworkflowResolver(node: RunnerNode): Promise<RunnerNode> {
		const v2 = node as RunnerNode & { subworkflow?: string; wait?: boolean };
		if (typeof v2.subworkflow !== "string" || v2.subworkflow.length === 0) {
			throw new Error(
				`[blok] subworkflowResolver: step "${node.name}" is missing the \`subworkflow\` field after normalization.`,
			);
		}
		// Lazy import to avoid a circular dep (SubworkflowNode imports
		// Configuration to construct the child).
		const { SubworkflowNode } = await import("./SubworkflowNode");
		const subworkflowNode = new SubworkflowNode();
		subworkflowNode.node = node.node;
		subworkflowNode.name = node.name;
		subworkflowNode.type = node.type;
		subworkflowNode.active = node.active !== undefined ? node.active : true;
		subworkflowNode.stop = node.stop !== undefined ? node.stop : false;
		subworkflowNode.subworkflow = v2.subworkflow;
		// `wait: false` triggers the fire-and-forget branch in SubworkflowNode.run.
		// Default to `true` (synchronous) when unset.
		subworkflowNode.wait = v2.wait !== false;
		// `globalOptions` is the runner's node registry — child Configuration.init
		// needs it for `module:` step resolution.
		subworkflowNode.globalOptions = this.globalOptions;
		return subworkflowNode as RunnerNode;
	}

	protected async moduleResolver(node: RunnerNode, opts: GlobalOptions): Promise<RunnerNode> {
		const nodeHandler = opts?.nodes?.getNode(node.node);

		if (!nodeHandler) {
			throw new Error(`Node ${node.node} not found`);
		}

		const clone = Object.assign(Object.create(Object.getPrototypeOf(nodeHandler)), nodeHandler);
		// Copy step-level metadata from the workflow JSON onto the clone.
		// Without this, `step.type` is undefined for module nodes and
		// downstream consumers (RunnerSteps step prefix, RunTracker
		// `startNode`'s `nodeType` field) fall back to "unknown" — which
		// surfaces in dev as `[step 1/9] init (unknown) → started`. The
		// runtimeResolver already does this; we mirror it here.
		(clone as RunnerNode).name = node.name;
		(clone as RunnerNode).node = node.node;
		(clone as RunnerNode).type = node.type;
		if (node.active !== undefined) (clone as RunnerNode).active = node.active;
		if (node.stop !== undefined) (clone as RunnerNode).stop = node.stop;
		if (node.set_var !== undefined) (clone as RunnerNode).set_var = node.set_var;
		return clone as RunnerNode;
	}

	/**
	 * PR 4 · resolve a `wait` step to a stub node. The runner's wait
	 * primitive (`wait.for`/`wait.until`) is implemented at the
	 * RunnerSteps level — this resolver exists only to satisfy
	 * getSteps() at workflow load time so `Node type wait not found`
	 * doesn't fire on otherwise-valid wait steps.
	 */
	protected async waitResolver(node: RunnerNode): Promise<RunnerNode> {
		const { WaitNode } = await import("./WaitNode");
		const stub = new WaitNode();
		stub.node = node.node;
		stub.name = node.name;
		stub.type = node.type;
		stub.active = node.active !== undefined ? node.active : true;
		stub.stop = node.stop !== undefined ? node.stop : false;
		const v2 = node as RunnerNode & { waitForMs?: number; waitUntil?: number | string };
		if (v2.waitForMs !== undefined) stub.waitForMs = v2.waitForMs;
		if (v2.waitUntil !== undefined) stub.waitUntil = v2.waitUntil;
		return stub;
	}

	protected async localResolver(node: RunnerNode): Promise<RunnerNode> {
		// Security review FW-3 — canonicalize the resolved path against
		// NODES_PATH so a node.node value like "../../malicious" can't
		// walk the filesystem outside the configured directory.
		const base = resolvePath(process.env.NODES_PATH || ".");
		const target = resolvePath(base, node.node);
		if (target !== base && !target.startsWith(base + pathSep)) {
			throw new Error(`[blok] local node path escapes NODES_PATH: '${node.node}' resolves outside ${base}`);
		}
		return new (await import(target)).default() as Promise<RunnerNode>;
	}
}

type NodeResolverTypes = {
	[key: string]: {
		resolver: (node: RunnerNode, opts: GlobalOptions) => Promise<RunnerNode>;
	};
};
