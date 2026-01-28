import { describe, expect, it } from "vitest";
import { CompletionItemKind } from "vscode-languageserver";
import { getCompletions } from "../completion";

function getOffset(text: string): number {
	// Returns the offset at the end of the text
	return text.length;
}

describe("WorkflowCompletionProvider (LSP)", () => {
	describe("trigger type completions", () => {
		it("should provide trigger type completions inside trigger object", () => {
			const content = '{\n  "trigger": {\n    "';
			const items = getCompletions(content, getOffset(content));
			const labels = items.map((i) => i.label);
			expect(labels).toContain("http");
			expect(labels).toContain("grpc");
			expect(labels).toContain("cron");
			expect(labels).toContain("queue");
			expect(labels).toContain("pubsub");
			expect(labels).toContain("worker");
			expect(labels).toContain("webhook");
			expect(labels).toContain("websocket");
			expect(labels).toContain("sse");
		});
	});

	describe("HTTP method completions", () => {
		it("should provide HTTP method completions for method key in trigger", () => {
			const content = '{\n  "trigger": {\n    "http": {\n      "method": "';
			const items = getCompletions(content, getOffset(content));
			const labels = items.map((i) => i.label);
			expect(labels).toContain("GET");
			expect(labels).toContain("POST");
			expect(labels).toContain("PUT");
			expect(labels).toContain("DELETE");
			expect(labels).toContain("PATCH");
			expect(labels).toContain("ANY");
		});
	});

	describe("step type completions", () => {
		it("should provide step type completions inside steps", () => {
			const content = '{\n  "steps": [\n    {\n      "type": "';
			const items = getCompletions(content, getOffset(content));
			const labels = items.map((i) => i.label);
			expect(labels).toContain("module");
			expect(labels).toContain("local");
			expect(labels).toContain("runtime.nodejs");
			expect(labels).toContain("runtime.python3");
			expect(labels).toContain("runtime.go");
			expect(labels).toContain("runtime.java");
			expect(labels).toContain("runtime.rust");
		});
	});

	describe("runtime completions", () => {
		it("should provide runtime completions", () => {
			const content = '{\n  "steps": [\n    {\n      "runtime": "';
			const items = getCompletions(content, getOffset(content));
			const labels = items.map((i) => i.label);
			expect(labels).toContain("nodejs");
			expect(labels).toContain("python3");
			expect(labels).toContain("go");
			expect(labels).toContain("java");
			expect(labels).toContain("rust");
			expect(labels).toContain("docker");
			expect(labels).toContain("wasm");
		});
	});

	describe("node package completions", () => {
		it("should provide node completions for node key", () => {
			const content = '{\n  "steps": [\n    {\n      "node": "';
			const items = getCompletions(content, getOffset(content));
			const labels = items.map((i) => i.label);
			expect(labels).toContain("@nanoservice-ts/api-call");
			expect(labels).toContain("@nanoservice-ts/if-else");
			expect(labels).toContain("@nanoservice-ts/react");
		});

		it("should use Module kind for node packages", () => {
			const content = '{\n  "steps": [\n    {\n      "node": "';
			const items = getCompletions(content, getOffset(content));
			const apiCall = items.find((i) => i.label === "@nanoservice-ts/api-call");
			expect(apiCall?.kind).toBe(CompletionItemKind.Module);
		});
	});

	describe("queue provider completions", () => {
		it("should provide queue provider completions", () => {
			const content = '{\n  "trigger": {\n    "queue": {\n      "provider": "';
			const items = getCompletions(content, getOffset(content));
			const labels = items.map((i) => i.label);
			expect(labels).toContain("kafka");
			expect(labels).toContain("rabbitmq");
			expect(labels).toContain("sqs");
			expect(labels).toContain("redis");
		});
	});

	describe("pubsub provider completions", () => {
		it("should provide pubsub provider completions", () => {
			const content = '{\n  "trigger": {\n    "pubsub": {\n      "provider": "';
			const items = getCompletions(content, getOffset(content));
			const labels = items.map((i) => i.label);
			expect(labels).toContain("gcp");
			expect(labels).toContain("aws");
			expect(labels).toContain("azure");
			expect(labels).toContain("nats");
		});
	});

	describe("webhook source completions", () => {
		it("should provide webhook source completions", () => {
			const content = '{\n  "trigger": {\n    "webhook": {\n      "source": "';
			const items = getCompletions(content, getOffset(content));
			const labels = items.map((i) => i.label);
			expect(labels).toContain("github");
			expect(labels).toContain("stripe");
			expect(labels).toContain("shopify");
			expect(labels).toContain("custom");
		});
	});

	describe("condition type completions", () => {
		it("should provide condition type completions", () => {
			const content = '{\n  "nodes": {\n    "filter": {\n      "conditions": [\n        {\n          "type": "';
			const items = getCompletions(content, getOffset(content));
			const labels = items.map((i) => i.label);
			expect(labels).toContain("if");
			expect(labels).toContain("else");
		});

		it("should use Keyword kind for condition types", () => {
			const content = '{\n  "nodes": {\n    "filter": {\n      "conditions": [\n        {\n          "type": "';
			const items = getCompletions(content, getOffset(content));
			const ifItem = items.find((i) => i.label === "if");
			expect(ifItem?.kind).toBe(CompletionItemKind.Keyword);
		});
	});

	describe("top-level key completions", () => {
		it("should provide top-level key completions at root", () => {
			const content = '{\n  "';
			const items = getCompletions(content, getOffset(content));
			const labels = items.map((i) => i.label);
			expect(labels).toContain("name");
			expect(labels).toContain("version");
			expect(labels).toContain("trigger");
			expect(labels).toContain("steps");
			expect(labels).toContain("nodes");
		});

		it("should provide HTTP-specific keys inside http object", () => {
			const content = '{\n  "trigger": {\n    "http": {\n      "';
			const items = getCompletions(content, getOffset(content));
			const labels = items.map((i) => i.label);
			expect(labels).toContain("method");
			expect(labels).toContain("path");
		});

		it("should provide step-specific keys inside steps array", () => {
			const content = '{\n  "steps": [\n    {\n      "';
			const items = getCompletions(content, getOffset(content));
			const labels = items.map((i) => i.label);
			expect(labels).toContain("name");
			expect(labels).toContain("node");
			expect(labels).toContain("type");
			expect(labels).toContain("runtime");
		});
	});

	describe("empty results", () => {
		it("should return empty for unknown context", () => {
			const content = '{\n  "unknown": {\n    "provider": "';
			const items = getCompletions(content, getOffset(content));
			// Should not provide queue/pubsub providers in unknown context
			const labels = items.map((i) => i.label);
			expect(labels).not.toContain("kafka");
			expect(labels).not.toContain("gcp");
		});
	});
});
