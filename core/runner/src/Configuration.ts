// import { NodeBase } from "@blok/shared";
// import { z } from "zod";
import type { NodeBase } from "@blok/shared";
import ConfigurationResolver from "./ConfigurationResolver";
import RunnerNode from "./RunnerNode";
import type RunnerNodeBase from "./RunnerNodeBase";
import { RuntimeAdapterNode } from "./RuntimeAdapterNode";
import { RuntimeRegistry } from "./RuntimeRegistry";
import { HttpRuntimeAdapter } from "./adapters/HttpRuntimeAdapter";
import { NodeJsRuntimeAdapter } from "./adapters/NodeJsRuntimeAdapter";
import type { RuntimeKind } from "./adapters/RuntimeAdapter";
import type Condition from "./types/Condition";
import type Config from "./types/Config";
import type Flow from "./types/Flow";
import type GlobalOptions from "./types/GlobalOptions";
import type Mapper from "./types/Mapper";
import type Node from "./types/Node";
import type Trigger from "./types/Trigger";
import type TryCatch from "./types/TryCatch";
import { RuntimeVersionValidator } from "./version/RuntimeVersionValidator";

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
	 * Initialize the RuntimeRegistry with built-in adapters
	 */
	private initializeRuntimeRegistry(): void {
		const registry = RuntimeRegistry.getInstance();

		// Register NodeJS runtime adapter if not already registered
		if (!registry.has("nodejs")) {
			registry.register(new NodeJsRuntimeAdapter());
		}

		// Register HTTP-based runtime adapters for all SDK languages
		// Python3 now uses HttpRuntimeAdapter (same as Go/Rust/Java/C#/PHP/Ruby)
		const httpRuntimes: Array<{
			kind: RuntimeKind;
			hostEnv: string;
			portEnv: string;
			defaultPort: number;
		}> = [
			{ kind: "go", hostEnv: "RUNTIME_GO_HOST", portEnv: "RUNTIME_GO_PORT", defaultPort: 9001 },
			{ kind: "rust", hostEnv: "RUNTIME_RUST_HOST", portEnv: "RUNTIME_RUST_PORT", defaultPort: 9002 },
			{ kind: "java", hostEnv: "RUNTIME_JAVA_HOST", portEnv: "RUNTIME_JAVA_PORT", defaultPort: 9003 },
			{ kind: "csharp", hostEnv: "RUNTIME_CSHARP_HOST", portEnv: "RUNTIME_CSHARP_PORT", defaultPort: 9004 },
			{ kind: "php", hostEnv: "RUNTIME_PHP_HOST", portEnv: "RUNTIME_PHP_PORT", defaultPort: 9005 },
			{ kind: "ruby", hostEnv: "RUNTIME_RUBY_HOST", portEnv: "RUNTIME_RUBY_PORT", defaultPort: 9006 },
			{ kind: "python3", hostEnv: "RUNTIME_PYTHON3_HOST", portEnv: "RUNTIME_PYTHON3_PORT", defaultPort: 9007 },
		];

		for (const rt of httpRuntimes) {
			if (!registry.has(rt.kind)) {
				const host = process.env[rt.hostEnv] || "localhost";
				const port = process.env[rt.portEnv] ? Number.parseInt(process.env[rt.portEnv] as string) : rt.defaultPort;
				registry.register(new HttpRuntimeAdapter(rt.kind, host, port));
			}
		}
	}

	public async init(workflowNameInPath: string, opts?: GlobalOptions) {
		if (this.globalOptions === undefined && opts !== undefined) {
			this.globalOptions = opts;
		}

		if (workflowNameInPath === undefined) throw new Error("Workflow name must be provided");
		const resolver = new ConfigurationResolver(opts as GlobalOptions);

		this.workflow = await resolver.get("local", workflowNameInPath as string);

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
			node.set_var = step.set_var !== undefined ? step.set_var : false;
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
			node.set_var = step.set_var !== undefined ? step.set_var : false;

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
		targetNode.set_var = node.set_var !== undefined ? node.set_var : false;

		// Wrap in RuntimeAdapterNode to integrate with existing Runner
		return new RuntimeAdapterNode(adapter, targetNode) as RunnerNode;
	}

	protected async moduleResolver(node: RunnerNode, opts: GlobalOptions): Promise<RunnerNode> {
		const nodeHandler = opts?.nodes?.getNode(node.node);

		if (!nodeHandler) {
			throw new Error(`Node ${node.node} not found`);
		}

		// Validate runtime requirements if the node declares them
		this.validateNodeRuntimeRequirements(nodeHandler);

		const clone = Object.assign(Object.create(Object.getPrototypeOf(nodeHandler)), nodeHandler);
		return clone as RunnerNode;
	}

	/**
	 * Check if a resolved node has runtimeRequirements and validate them
	 * against the currently known runtime versions in the RuntimeRegistry.
	 */
	private validateNodeRuntimeRequirements(node: unknown): void {
		const fnNode = node as { runtimeRequirements?: Partial<Record<string, string>>; name?: string };
		if (!fnNode.runtimeRequirements) return;

		const registry = RuntimeRegistry.getInstance();
		const runtimeVersions: Record<string, string> = {};
		for (const kind of registry.getRegisteredKinds()) {
			const version = registry.getVersion(kind);
			if (version) {
				runtimeVersions[kind] = version;
			}
		}

		// If no runtime versions are known yet, skip validation
		// (versions are populated when health checks succeed)
		if (Object.keys(runtimeVersions).length === 0) return;

		const validator = new RuntimeVersionValidator(runtimeVersions);
		const results = validator.validateNode({
			name: fnNode.name || "unknown",
			runtimeRequirements: fnNode.runtimeRequirements,
		});

		const failures = results.filter((r) => !r.valid);
		if (failures.length > 0) {
			throw new Error(RuntimeVersionValidator.formatErrors(failures));
		}
	}

	protected async localResolver(node: RunnerNode): Promise<RunnerNode> {
		const path = `${process.env.NODES_PATH}/${node.node}`;
		return new (await import(path)).default() as Promise<RunnerNode>;
	}
}

type NodeResolverTypes = {
	[key: string]: {
		resolver: (node: RunnerNode, opts: GlobalOptions) => Promise<RunnerNode>;
	};
};
