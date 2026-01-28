import * as vscode from "vscode";

/**
 * Provides auto-completion for Blok workflow JSON files.
 *
 * Offers contextual completions for:
 * - Trigger types (http, grpc, cron, queue, pubsub, worker, webhook, websocket, sse)
 * - HTTP methods (GET, POST, PUT, DELETE, PATCH, ANY)
 * - Step types (local, module, runtime.*)
 * - Runtime kinds (nodejs, python3, go, java, rust, etc.)
 * - Queue/pubsub providers
 * - Common node packages (@nanoservice-ts/api-call, @nanoservice-ts/if-else)
 * - Context variable patterns (ctx.request.*, ctx.response.*, ctx.vars.*)
 */
export class WorkflowCompletionProvider implements vscode.CompletionItemProvider {
	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
	): vscode.ProviderResult<vscode.CompletionItem[]> {
		const lineText = document.lineAt(position).text;
		const textBefore = lineText.substring(0, position.character);
		const fullText = document.getText();

		// Detect context: what key are we providing a value for?
		const keyMatch = textBefore.match(/"(\w+)"\s*:\s*"?$/);
		const parentKey = keyMatch?.[1];

		// Check if we're inside a specific object by scanning backward
		const context = this.detectContext(fullText, document.offsetAt(position));

		const items: vscode.CompletionItem[] = [];

		// Trigger type completions (when cursor is inside "trigger" object)
		if (context === "trigger" || parentKey === "trigger") {
			items.push(...this.createTriggerTypeCompletions());
		}

		// HTTP method completions
		if (parentKey === "method" && (context === "trigger" || context === "http")) {
			items.push(...this.createHttpMethodCompletions());
		}

		// Step type completions
		if (parentKey === "type" && context === "steps") {
			items.push(...this.createStepTypeCompletions());
		}

		// Runtime completions
		if (parentKey === "runtime") {
			items.push(...this.createRuntimeCompletions());
		}

		// Node package completions
		if (parentKey === "node") {
			items.push(...this.createNodeCompletions());
		}

		// Queue provider completions
		if (parentKey === "provider" && context === "queue") {
			items.push(...this.createQueueProviderCompletions());
		}

		// Pubsub provider completions
		if (parentKey === "provider" && context === "pubsub") {
			items.push(...this.createPubsubProviderCompletions());
		}

		// Webhook source completions
		if (parentKey === "source" && context === "webhook") {
			items.push(...this.createWebhookSourceCompletions());
		}

		// Condition type completions
		if (parentKey === "type" && context === "conditions") {
			items.push(...this.createConditionTypeCompletions());
		}

		// Top-level key completions
		if (textBefore.match(/^\s*"$/)) {
			items.push(...this.createTopLevelKeyCompletions(context));
		}

		return items;
	}

	private detectContext(text: string, offset: number): string {
		// Walk backward to find the enclosing key context
		let depth = 0;
		for (let i = offset - 1; i >= 0; i--) {
			if (text[i] === "}" || text[i] === "]") depth++;
			if (text[i] === "{" || text[i] === "[") {
				if (depth === 0) {
					// Find the key before this brace
					const before = text.substring(Math.max(0, i - 100), i);
					const keyMatch = before.match(/"(\w+)"\s*:\s*$/);
					if (keyMatch) return keyMatch[1];
					// Check for array context
					const arrayMatch = before.match(/"(\w+)"\s*:\s*\[[\s\S]*$/);
					if (arrayMatch) return arrayMatch[1];
				}
				depth--;
			}
		}
		return "root";
	}

	private createTriggerTypeCompletions(): vscode.CompletionItem[] {
		const triggers = [
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

		return triggers.map((t) => {
			const item = new vscode.CompletionItem(t.label, vscode.CompletionItemKind.Enum);
			item.detail = t.detail;
			item.documentation = new vscode.MarkdownString(t.docs);
			return item;
		});
	}

	private createHttpMethodCompletions(): vscode.CompletionItem[] {
		const methods = [
			{ label: "GET", docs: "Retrieve resources" },
			{ label: "POST", docs: "Create resources" },
			{ label: "PUT", docs: "Replace resources" },
			{ label: "DELETE", docs: "Delete resources" },
			{ label: "PATCH", docs: "Partially update resources" },
			{ label: "ANY", docs: "Match any HTTP method" },
		];

		return methods.map((m) => {
			const item = new vscode.CompletionItem(m.label, vscode.CompletionItemKind.EnumMember);
			item.documentation = m.docs;
			return item;
		});
	}

	private createStepTypeCompletions(): vscode.CompletionItem[] {
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

		return types.map((t) => {
			const item = new vscode.CompletionItem(t.label, vscode.CompletionItemKind.EnumMember);
			item.documentation = t.docs;
			item.sortText = t.priority;
			return item;
		});
	}

	private createRuntimeCompletions(): vscode.CompletionItem[] {
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

		return runtimes.map((r) => {
			const item = new vscode.CompletionItem(r.label, vscode.CompletionItemKind.EnumMember);
			item.documentation = r.docs;
			return item;
		});
	}

	private createNodeCompletions(): vscode.CompletionItem[] {
		const nodes = [
			{ label: "@nanoservice-ts/api-call", docs: "HTTP API call node - makes requests to external services" },
			{ label: "@nanoservice-ts/if-else", docs: "Conditional branching node - evaluates conditions for routing" },
			{ label: "@nanoservice-ts/react", docs: "React SSR node - server-side rendering" },
		];

		return nodes.map((n) => {
			const item = new vscode.CompletionItem(n.label, vscode.CompletionItemKind.Module);
			item.documentation = n.docs;
			return item;
		});
	}

	private createQueueProviderCompletions(): vscode.CompletionItem[] {
		const providers = [
			{ label: "kafka", docs: "Apache Kafka distributed event streaming" },
			{ label: "rabbitmq", docs: "RabbitMQ message broker (AMQP)" },
			{ label: "sqs", docs: "AWS Simple Queue Service" },
			{ label: "redis", docs: "Redis-based queue (BullMQ)" },
			{ label: "beanstalk", docs: "Beanstalk work queue" },
		];

		return providers.map((p) => {
			const item = new vscode.CompletionItem(p.label, vscode.CompletionItemKind.EnumMember);
			item.documentation = p.docs;
			return item;
		});
	}

	private createPubsubProviderCompletions(): vscode.CompletionItem[] {
		const providers = [
			{ label: "gcp", docs: "Google Cloud Pub/Sub" },
			{ label: "aws", docs: "AWS SNS (Simple Notification Service)" },
			{ label: "azure", docs: "Azure Service Bus" },
			{ label: "redis", docs: "Redis Pub/Sub" },
			{ label: "nats", docs: "NATS messaging system" },
		];

		return providers.map((p) => {
			const item = new vscode.CompletionItem(p.label, vscode.CompletionItemKind.EnumMember);
			item.documentation = p.docs;
			return item;
		});
	}

	private createWebhookSourceCompletions(): vscode.CompletionItem[] {
		const sources = [
			{ label: "github", docs: "GitHub webhook events (push, PR, issues, etc.)" },
			{ label: "stripe", docs: "Stripe payment events (checkout, invoice, etc.)" },
			{ label: "shopify", docs: "Shopify e-commerce events (order, product, etc.)" },
			{ label: "custom", docs: "Custom webhook source with HMAC verification" },
		];

		return sources.map((s) => {
			const item = new vscode.CompletionItem(s.label, vscode.CompletionItemKind.EnumMember);
			item.documentation = s.docs;
			return item;
		});
	}

	private createConditionTypeCompletions(): vscode.CompletionItem[] {
		return [
			(() => {
				const item = new vscode.CompletionItem("if", vscode.CompletionItemKind.Keyword);
				item.documentation = "Conditional branch - executes steps when condition is true";
				return item;
			})(),
			(() => {
				const item = new vscode.CompletionItem("else", vscode.CompletionItemKind.Keyword);
				item.documentation = "Default branch - executes when no 'if' condition matches";
				return item;
			})(),
		];
	}

	private createTopLevelKeyCompletions(context: string): vscode.CompletionItem[] {
		if (context === "root") {
			const keys = [
				{ label: "name", docs: "Workflow name" },
				{ label: "description", docs: "Workflow description" },
				{ label: "version", docs: "Semantic version (e.g., 1.0.0)" },
				{ label: "trigger", docs: "Workflow trigger configuration" },
				{ label: "steps", docs: "Ordered list of execution steps" },
				{ label: "nodes", docs: "Node configuration map" },
			];

			return keys.map((k) => {
				const item = new vscode.CompletionItem(k.label, vscode.CompletionItemKind.Property);
				item.documentation = k.docs;
				return item;
			});
		}

		if (context === "http") {
			return ["method", "path", "accept", "jwt_secret"].map((k) => {
				const item = new vscode.CompletionItem(k, vscode.CompletionItemKind.Property);
				return item;
			});
		}

		if (context === "steps") {
			return ["name", "node", "type", "runtime"].map((k) => {
				const item = new vscode.CompletionItem(k, vscode.CompletionItemKind.Property);
				return item;
			});
		}

		return [];
	}
}
