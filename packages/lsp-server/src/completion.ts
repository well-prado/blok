import { type CompletionItem, CompletionItemKind, InsertTextFormat, MarkupKind } from "vscode-languageserver";
import {
	NODE_PACKAGES,
	PUBSUB_PROVIDERS,
	QUEUE_PROVIDERS,
	VALID_HTTP_METHODS,
	VALID_RUNTIMES,
	VALID_STEP_TYPES,
	VALID_TRIGGERS,
	WEBHOOK_SOURCES,
} from "./constants";

/**
 * Provides contextual auto-completion for Blok workflow JSON files via LSP.
 *
 * Offers completions for:
 * - Trigger types, HTTP methods, step types, runtime kinds
 * - Queue/pubsub providers, webhook sources
 * - Node packages, condition types
 * - Top-level and context-specific keys
 */
export function getCompletions(text: string, offset: number): CompletionItem[] {
	const lines = text.split("\n");
	const pos = offsetToLineChar(text, offset);
	const lineText = lines[pos.line] || "";
	const textBefore = lineText.substring(0, pos.character);

	// Detect which key we're providing a value for
	const keyMatch = textBefore.match(/"(\w+)"\s*:\s*"?$/);
	const parentKey = keyMatch?.[1];

	// Detect enclosing context
	const context = detectContext(text, offset);

	const items: CompletionItem[] = [];

	// Trigger type completions
	if (context === "trigger" || parentKey === "trigger") {
		items.push(...createTriggerTypeCompletions());
	}

	// HTTP method completions
	if (parentKey === "method" && (context === "trigger" || context === "http")) {
		items.push(...createHttpMethodCompletions());
	}

	// Step type completions
	if (parentKey === "type" && context === "steps") {
		items.push(...createStepTypeCompletions());
	}

	// Runtime completions
	if (parentKey === "runtime") {
		items.push(...createRuntimeCompletions());
	}

	// Node package completions
	if (parentKey === "node") {
		items.push(...createNodeCompletions());
	}

	// Queue provider completions
	if (parentKey === "provider" && context === "queue") {
		items.push(...createQueueProviderCompletions());
	}

	// Pubsub provider completions
	if (parentKey === "provider" && context === "pubsub") {
		items.push(...createPubsubProviderCompletions());
	}

	// Webhook source completions
	if (parentKey === "source" && context === "webhook") {
		items.push(...createWebhookSourceCompletions());
	}

	// Condition type completions
	if (parentKey === "type" && context === "conditions") {
		items.push(...createConditionTypeCompletions());
	}

	// Top-level key completions
	if (textBefore.match(/^\s*"$/)) {
		items.push(...createTopLevelKeyCompletions(context));
	}

	return items;
}

function detectContext(text: string, offset: number): string {
	let depth = 0;
	for (let i = offset - 1; i >= 0; i--) {
		if (text[i] === "}" || text[i] === "]") depth++;
		if (text[i] === "{" || text[i] === "[") {
			if (depth === 0) {
				const before = text.substring(Math.max(0, i - 100), i);
				const keyMatch = before.match(/"(\w+)"\s*:\s*$/);
				if (keyMatch) return keyMatch[1];
				const arrayMatch = before.match(/"(\w+)"\s*:\s*\[[\s\S]*$/);
				if (arrayMatch) return arrayMatch[1];
			}
			depth--;
		}
	}
	return "root";
}

function offsetToLineChar(text: string, offset: number): { line: number; character: number } {
	let line = 0;
	let character = 0;
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text[i] === "\n") {
			line++;
			character = 0;
		} else {
			character++;
		}
	}
	return { line, character };
}

function createTriggerTypeCompletions(): CompletionItem[] {
	const triggers: Array<{ label: string; detail: string; docs: string }> = [
		{ label: "http", detail: "HTTP trigger", docs: "Trigger on HTTP requests (GET, POST, PUT, DELETE)" },
		{ label: "grpc", detail: "gRPC trigger", docs: "Trigger on gRPC method calls" },
		{ label: "manual", detail: "Manual trigger", docs: "No auto-trigger, invoke programmatically" },
		{ label: "cron", detail: "Cron trigger", docs: "Scheduled execution with cron expressions" },
		{ label: "queue", detail: "Queue trigger", docs: "Message queue consumer (Kafka, RabbitMQ, SQS)" },
		{ label: "pubsub", detail: "Pub/Sub trigger", docs: "Pub/Sub subscriber (GCP, AWS, Azure, Redis, NATS)" },
		{ label: "worker", detail: "Worker trigger", docs: "Background job processing with retries" },
		{ label: "webhook", detail: "Webhook trigger", docs: "External webhook events (GitHub, Stripe, Shopify)" },
		{ label: "websocket", detail: "WebSocket trigger", docs: "Real-time bidirectional communication" },
		{ label: "sse", detail: "SSE trigger", docs: "Server-Sent Events streaming" },
	];

	return triggers.map((t) => ({
		label: t.label,
		kind: CompletionItemKind.Enum,
		detail: t.detail,
		documentation: { kind: MarkupKind.Markdown, value: t.docs },
	}));
}

function createHttpMethodCompletions(): CompletionItem[] {
	const methods = [
		{ label: "GET", docs: "Retrieve resources" },
		{ label: "POST", docs: "Create resources" },
		{ label: "PUT", docs: "Replace resources" },
		{ label: "DELETE", docs: "Delete resources" },
		{ label: "PATCH", docs: "Partially update resources" },
		{ label: "ANY", docs: "Match any HTTP method" },
	];

	return methods.map((m) => ({
		label: m.label,
		kind: CompletionItemKind.EnumMember,
		documentation: m.docs,
	}));
}

function createStepTypeCompletions(): CompletionItem[] {
	const types = [
		{ label: "module", docs: "Node from npm package (e.g., @nanoservice-ts/api-call)", priority: "1" },
		{ label: "local", docs: "Node defined locally in the project (e.g., ./nodes/my-node)", priority: "2" },
		{ label: "runtime.nodejs", docs: "Execute using Node.js runtime adapter", priority: "3" },
		{ label: "runtime.python3", docs: "Execute using Python 3 runtime adapter (via gRPC)", priority: "4" },
		{ label: "runtime.go", docs: "Execute using Go runtime adapter (Docker container)", priority: "5" },
		{ label: "runtime.java", docs: "Execute using Java runtime adapter (Docker container)", priority: "6" },
		{ label: "runtime.rust", docs: "Execute using Rust runtime adapter (Docker/WASM)", priority: "7" },
		{ label: "runtime.php", docs: "Execute using PHP runtime adapter (Docker container)", priority: "8" },
		{ label: "runtime.csharp", docs: "Execute using C#/.NET runtime adapter", priority: "9" },
		{ label: "runtime.ruby", docs: "Execute using Ruby runtime adapter", priority: "a" },
	];

	return types.map((t) => ({
		label: t.label,
		kind: CompletionItemKind.EnumMember,
		documentation: t.docs,
		sortText: t.priority,
	}));
}

function createRuntimeCompletions(): CompletionItem[] {
	const runtimes = [
		{ label: "nodejs", docs: "Node.js in-process execution (fastest)" },
		{ label: "bun", docs: "Bun runtime execution" },
		{ label: "python3", docs: "Python 3 via gRPC protocol" },
		{ label: "go", docs: "Go via Docker container" },
		{ label: "java", docs: "Java via Docker container" },
		{ label: "rust", docs: "Rust via Docker container or WASM" },
		{ label: "php", docs: "PHP via Docker container" },
		{ label: "csharp", docs: "C#/.NET via Docker container" },
		{ label: "ruby", docs: "Ruby via Docker container" },
		{ label: "docker", docs: "Generic Docker container runtime" },
		{ label: "wasm", docs: "WebAssembly runtime" },
	];

	return runtimes.map((r) => ({
		label: r.label,
		kind: CompletionItemKind.EnumMember,
		documentation: r.docs,
	}));
}

function createNodeCompletions(): CompletionItem[] {
	return NODE_PACKAGES.map((n) => ({
		label: n.name,
		kind: CompletionItemKind.Module,
		documentation: n.description,
	}));
}

function createQueueProviderCompletions(): CompletionItem[] {
	const providers = [
		{ label: "kafka", docs: "Apache Kafka distributed event streaming" },
		{ label: "rabbitmq", docs: "RabbitMQ message broker (AMQP)" },
		{ label: "sqs", docs: "AWS Simple Queue Service" },
		{ label: "redis", docs: "Redis-based queue (BullMQ)" },
		{ label: "beanstalk", docs: "Beanstalk work queue" },
	];

	return providers.map((p) => ({
		label: p.label,
		kind: CompletionItemKind.EnumMember,
		documentation: p.docs,
	}));
}

function createPubsubProviderCompletions(): CompletionItem[] {
	const providers = [
		{ label: "gcp", docs: "Google Cloud Pub/Sub" },
		{ label: "aws", docs: "AWS SNS (Simple Notification Service)" },
		{ label: "azure", docs: "Azure Service Bus" },
		{ label: "redis", docs: "Redis Pub/Sub" },
		{ label: "nats", docs: "NATS messaging system" },
	];

	return providers.map((p) => ({
		label: p.label,
		kind: CompletionItemKind.EnumMember,
		documentation: p.docs,
	}));
}

function createWebhookSourceCompletions(): CompletionItem[] {
	const sources = [
		{ label: "github", docs: "GitHub webhook events (push, PR, issues, etc.)" },
		{ label: "stripe", docs: "Stripe payment events (checkout, invoice, etc.)" },
		{ label: "shopify", docs: "Shopify e-commerce events (order, product, etc.)" },
		{ label: "custom", docs: "Custom webhook source with HMAC verification" },
	];

	return sources.map((s) => ({
		label: s.label,
		kind: CompletionItemKind.EnumMember,
		documentation: s.docs,
	}));
}

function createConditionTypeCompletions(): CompletionItem[] {
	return [
		{
			label: "if",
			kind: CompletionItemKind.Keyword,
			documentation: "Conditional branch - executes steps when condition is true",
		},
		{
			label: "else",
			kind: CompletionItemKind.Keyword,
			documentation: "Default branch - executes when no 'if' condition matches",
		},
	];
}

function createTopLevelKeyCompletions(context: string): CompletionItem[] {
	if (context === "root") {
		const keys = [
			{ label: "name", docs: "Workflow name" },
			{ label: "description", docs: "Workflow description" },
			{ label: "version", docs: "Semantic version (e.g., 1.0.0)" },
			{ label: "trigger", docs: "Workflow trigger configuration" },
			{ label: "steps", docs: "Ordered list of execution steps" },
			{ label: "nodes", docs: "Node configuration map" },
		];

		return keys.map((k) => ({
			label: k.label,
			kind: CompletionItemKind.Property,
			documentation: k.docs,
		}));
	}

	if (context === "http") {
		return ["method", "path", "accept", "jwt_secret"].map((k) => ({
			label: k,
			kind: CompletionItemKind.Property,
		}));
	}

	if (context === "steps") {
		return ["name", "node", "type", "runtime"].map((k) => ({
			label: k,
			kind: CompletionItemKind.Property,
		}));
	}

	return [];
}
