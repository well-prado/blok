import * as vscode from "vscode";

interface HoverDoc {
	title: string;
	description: string;
	example?: string;
}

const TRIGGER_DOCS: Record<string, HoverDoc> = {
	http: {
		title: "HTTP Trigger",
		description: "Triggers workflow on HTTP requests. Supports GET, POST, PUT, DELETE, PATCH, and ANY methods.",
		example: `"http": {\n  "method": "POST",\n  "path": "/api/users",\n  "accept": "application/json"\n}`,
	},
	grpc: {
		title: "gRPC Trigger",
		description: "Triggers workflow on gRPC method calls using Connect RPC protocol.",
		example: `"grpc": {\n  "service": "UserService",\n  "method": "GetUser"\n}`,
	},
	manual: {
		title: "Manual Trigger",
		description: "No automatic triggering. Workflow must be invoked programmatically.",
		example: `"manual": {}`,
	},
	cron: {
		title: "Cron Trigger",
		description: "Triggers workflow on a schedule using cron expressions. Supports timezone and overlap control.",
		example: `"cron": {\n  "schedule": "*/5 * * * *",\n  "timezone": "America/New_York",\n  "overlap": false\n}`,
	},
	queue: {
		title: "Queue Trigger",
		description:
			"Triggers workflow when messages arrive on a queue. Supports Kafka, RabbitMQ, SQS, Redis, and Beanstalk.",
		example: `"queue": {\n  "provider": "kafka",\n  "topic": "user-events",\n  "consumerGroup": "blok-workers"\n}`,
	},
	pubsub: {
		title: "Pub/Sub Trigger",
		description:
			"Triggers workflow on pub/sub messages. Supports GCP Pub/Sub, AWS SNS, Azure Service Bus, Redis, and NATS.",
		example: `"pubsub": {\n  "provider": "gcp",\n  "topic": "notifications",\n  "subscription": "blok-sub"\n}`,
	},
	worker: {
		title: "Worker Trigger",
		description: "Background job processing with configurable concurrency, timeouts, and retries.",
		example: `"worker": {\n  "queue": "email-jobs",\n  "concurrency": 5,\n  "timeout": 30000,\n  "retries": 3\n}`,
	},
	webhook: {
		title: "Webhook Trigger",
		description: "Triggers workflow when external services send webhook events. Supports HMAC signature verification.",
		example: `"webhook": {\n  "source": "github",\n  "events": ["push", "pull_request"],\n  "secret": "WEBHOOK_SECRET"\n}`,
	},
	websocket: {
		title: "WebSocket Trigger",
		description: "Real-time bidirectional communication. Supports rooms, authentication, and message rate limiting.",
		example: `"websocket": {\n  "path": "/ws",\n  "events": ["message", "join", "leave"],\n  "maxConnections": 1000\n}`,
	},
	sse: {
		title: "SSE Trigger",
		description: "Server-Sent Events for real-time unidirectional streaming. Supports channels and replay.",
		example: `"sse": {\n  "path": "/events",\n  "channels": ["updates", "alerts"],\n  "retryInterval": 3000\n}`,
	},
};

const FIELD_DOCS: Record<string, HoverDoc> = {
	name: {
		title: "Workflow Name",
		description: "Human-readable name identifying this workflow. Used for logging, monitoring, and display purposes.",
	},
	version: {
		title: "Workflow Version",
		description: "Semantic version of this workflow (e.g., 1.0.0). Follows SemVer format: MAJOR.MINOR.PATCH.",
	},
	description: {
		title: "Workflow Description",
		description: "Detailed description of what this workflow does. Shown in documentation and monitoring dashboards.",
	},
	trigger: {
		title: "Workflow Trigger",
		description:
			"Defines how this workflow is invoked. Each workflow has exactly one trigger type: http, grpc, manual, cron, queue, pubsub, worker, webhook, websocket, or sse.",
	},
	steps: {
		title: "Workflow Steps",
		description:
			"Ordered array of steps to execute. Each step references a node and defines its type (local or module). Steps execute sequentially; use conditional nodes for branching.",
	},
	nodes: {
		title: "Node Configurations",
		description:
			'Maps step names to their configurations. Each key matches a step\'s "name" field and contains inputs, conditions, or nested steps.',
	},
	inputs: {
		title: "Node Inputs",
		description:
			"Input values for the node. Supports static values, template variables (${ctx.request.body.field}), JavaScript evaluation (js/ prefix), and context variable references.",
		example: `"inputs": {\n  "url": "https://api.example.com/users",\n  "userId": "\${ctx.request.params.id}",\n  "computed": "js/ctx.response.data.items.length"\n}`,
	},
	conditions: {
		title: "Conditional Branches",
		description:
			"Array of if/else conditions for branching logic. Use with @blok/if-else node. Each condition has a JavaScript expression and nested steps.",
		example: `"conditions": [\n  {\n    "type": "if",\n    "condition": "ctx.request.query.type === 'admin'",\n    "steps": [{ "name": "admin-flow", "node": "...", "type": "module" }]\n  },\n  {\n    "type": "else",\n    "steps": [{ "name": "user-flow", "node": "...", "type": "module" }]\n  }\n]`,
	},
	set_var: {
		title: "Set Context Variable",
		description:
			"When true, stores the step's output in ctx.vars['step-name']. This makes the result accessible to downstream steps via ctx.vars.",
		example: `"my-step": {\n  "set_var": true,\n  "inputs": { ... }\n}\n// Later: ctx.vars['my-step'] contains the result`,
	},
};

const STEP_FIELD_DOCS: Record<string, HoverDoc> = {
	node: {
		title: "Step Node Reference",
		description:
			"The node package or local path to execute. For modules: @blok/api-call. For local nodes: ./nodes/my-node.",
	},
	type: {
		title: "Step Type",
		description:
			"How the node should be resolved.\n- **local**: Node defined in the project\n- **module**: npm package node\n- **runtime.X**: Language-specific runtime (nodejs, python3, go, java, rust, php, csharp, ruby)",
	},
	runtime: {
		title: "Step Runtime",
		description:
			"Override the default runtime for this step. Available: nodejs, bun, python3, go, java, rust, php, csharp, ruby, docker, wasm.",
	},
};

/**
 * Provides hover documentation for Blok workflow JSON files.
 *
 * Shows contextual documentation when hovering over:
 * - Trigger type keys (http, grpc, cron, queue, etc.)
 * - Workflow fields (name, version, steps, nodes, etc.)
 * - Node configuration fields (inputs, conditions, set_var)
 * - Step fields (node, type, runtime)
 */
export class WorkflowHoverProvider implements vscode.HoverProvider {
	provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
		const line = document.lineAt(position).text;
		const wordRange = document.getWordRangeAtPosition(position, /"[^"]+"/);
		if (!wordRange) return null;

		const word = document.getText(wordRange).replace(/"/g, "");

		// Check if it's a key (followed by colon)
		const afterWord = line.substring(wordRange.end.character).trimStart();
		const isKey = afterWord.startsWith(":");

		if (isKey) {
			// Trigger type documentation
			if (TRIGGER_DOCS[word]) {
				return this.createHover(TRIGGER_DOCS[word], wordRange);
			}

			// Field documentation
			if (FIELD_DOCS[word]) {
				return this.createHover(FIELD_DOCS[word], wordRange);
			}

			// Step field documentation
			if (STEP_FIELD_DOCS[word]) {
				return this.createHover(STEP_FIELD_DOCS[word], wordRange);
			}
		}

		// Check for values (trigger types, HTTP methods, step types, runtimes)
		if (!isKey) {
			// HTTP methods
			if (["GET", "POST", "PUT", "DELETE", "PATCH", "ANY"].includes(word)) {
				return new vscode.Hover(
					new vscode.MarkdownString(`**HTTP Method: ${word}**\n\nHTTP request method that will trigger this workflow.`),
					wordRange,
				);
			}

			// Step type values
			if (word.startsWith("runtime.")) {
				const lang = word.replace("runtime.", "");
				return new vscode.Hover(
					new vscode.MarkdownString(
						`**Runtime Type: ${lang}**\n\nExecutes this node using the ${lang} runtime adapter. The node code must be written in ${lang} and served via the Blok runtime protocol (HTTP/gRPC).`,
					),
					wordRange,
				);
			}

			// Common node packages
			if (word === "@blok/api-call") {
				return new vscode.Hover(
					new vscode.MarkdownString(
						"**@blok/api-call**\n\nMakes HTTP API calls to external services.\n\n**Inputs:** `url`, `method`, `headers`, `body`, `responseType`",
					),
					wordRange,
				);
			}
			if (word === "@blok/if-else") {
				return new vscode.Hover(
					new vscode.MarkdownString(
						"**@blok/if-else**\n\nConditional branching node. Evaluates JavaScript conditions against the workflow context.\n\nConfigure conditions in the `nodes` section using the `conditions` array.",
					),
					wordRange,
				);
			}
		}

		return null;
	}

	private createHover(doc: HoverDoc, range: vscode.Range): vscode.Hover {
		const md = new vscode.MarkdownString();
		md.appendMarkdown(`**${doc.title}**\n\n`);
		md.appendMarkdown(`${doc.description}\n\n`);
		if (doc.example) {
			md.appendCodeblock(doc.example, "json");
		}
		return new vscode.Hover(md, range);
	}
}
