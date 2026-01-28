/**
 * Shared constants for Blok workflow validation, completion, and documentation.
 * These are IDE-agnostic and used by both the LSP server and VS Code extension.
 */

export const VALID_TRIGGERS = ["http", "grpc", "manual", "cron", "queue", "pubsub", "worker", "webhook", "websocket", "sse"] as const;

export const VALID_HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "ANY"] as const;

export const VALID_STEP_TYPES = [
	"local",
	"module",
	"runtime.nodejs",
	"runtime.python3",
	"runtime.go",
	"runtime.java",
	"runtime.rust",
	"runtime.php",
	"runtime.csharp",
	"runtime.ruby",
] as const;

export const VALID_RUNTIMES = ["nodejs", "bun", "python3", "go", "java", "rust", "php", "csharp", "ruby", "docker", "wasm"] as const;

export const QUEUE_PROVIDERS = ["kafka", "rabbitmq", "sqs", "redis", "beanstalk"] as const;

export const PUBSUB_PROVIDERS = ["gcp", "aws", "azure", "redis", "nats"] as const;

export const WEBHOOK_SOURCES = ["github", "stripe", "shopify", "custom"] as const;

export const NODE_PACKAGES = [
	{ name: "@nanoservice-ts/api-call", description: "HTTP API call node - makes requests to external services" },
	{ name: "@nanoservice-ts/if-else", description: "Conditional branching node - evaluates conditions for routing" },
	{ name: "@nanoservice-ts/react", description: "React SSR node - server-side rendering" },
] as const;

export interface WorkflowJson {
	name?: unknown;
	version?: unknown;
	description?: unknown;
	trigger?: Record<string, unknown>;
	steps?: unknown[];
	nodes?: Record<string, unknown>;
}

export interface HoverDoc {
	title: string;
	description: string;
	example?: string;
}

export const TRIGGER_DOCS: Record<string, HoverDoc> = {
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
		description: "Triggers workflow when messages arrive on a queue. Supports Kafka, RabbitMQ, SQS, Redis, and Beanstalk.",
		example: `"queue": {\n  "provider": "kafka",\n  "topic": "user-events",\n  "consumerGroup": "blok-workers"\n}`,
	},
	pubsub: {
		title: "Pub/Sub Trigger",
		description: "Triggers workflow on pub/sub messages. Supports GCP Pub/Sub, AWS SNS, Azure Service Bus, Redis, and NATS.",
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

export const FIELD_DOCS: Record<string, HoverDoc> = {
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
			"Array of if/else conditions for branching logic. Use with @nanoservice-ts/if-else node. Each condition has a JavaScript expression and nested steps.",
		example: `"conditions": [\n  {\n    "type": "if",\n    "condition": "ctx.request.query.type === 'admin'",\n    "steps": [...]\n  },\n  {\n    "type": "else",\n    "steps": [...]\n  }\n]`,
	},
	set_var: {
		title: "Set Context Variable",
		description:
			"When true, stores the step's output in ctx.vars['step-name']. This makes the result accessible to downstream steps via ctx.vars.",
		example: `"my-step": {\n  "set_var": true,\n  "inputs": { ... }\n}\n// Later: ctx.vars['my-step'] contains the result`,
	},
};

export const STEP_FIELD_DOCS: Record<string, HoverDoc> = {
	node: {
		title: "Step Node Reference",
		description:
			"The node package or local path to execute. For modules: @nanoservice-ts/api-call. For local nodes: ./nodes/my-node.",
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
