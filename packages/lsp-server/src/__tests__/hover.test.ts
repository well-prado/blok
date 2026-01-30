import { describe, expect, it } from "vitest";
import { getHover } from "../hover";

describe("WorkflowHoverProvider (LSP)", () => {
	describe("trigger type hover", () => {
		it("should show hover for http trigger key", () => {
			const text = '{\n  "trigger": {\n    "http": {\n      "method": "GET"\n    }\n  }\n}';
			// Line 2: '    "http": {'  - cursor on "http"
			const hover = getHover(text, 2, 6);
			expect(hover).not.toBeNull();
			expect(hover!.contents).toHaveProperty("value");
			const value = (hover!.contents as { value: string }).value;
			expect(value).toContain("HTTP Trigger");
		});

		it("should show hover for cron trigger key", () => {
			const text = '{\n  "trigger": {\n    "cron": {\n      "schedule": "* * * * *"\n    }\n  }\n}';
			const hover = getHover(text, 2, 6);
			expect(hover).not.toBeNull();
			const value = (hover!.contents as { value: string }).value;
			expect(value).toContain("Cron Trigger");
		});

		it("should show hover for queue trigger key", () => {
			const text = '{\n  "trigger": {\n    "queue": {\n      "provider": "kafka"\n    }\n  }\n}';
			const hover = getHover(text, 2, 6);
			expect(hover).not.toBeNull();
			const value = (hover!.contents as { value: string }).value;
			expect(value).toContain("Queue Trigger");
		});

		it("should show hover for webhook trigger key", () => {
			const text = '{\n  "trigger": {\n    "webhook": {\n      "source": "github"\n    }\n  }\n}';
			const hover = getHover(text, 2, 6);
			expect(hover).not.toBeNull();
			const value = (hover!.contents as { value: string }).value;
			expect(value).toContain("Webhook Trigger");
		});

		it("should show hover for websocket trigger key", () => {
			const text = '{\n  "trigger": {\n    "websocket": {\n      "path": "/ws"\n    }\n  }\n}';
			const hover = getHover(text, 2, 6);
			expect(hover).not.toBeNull();
			const value = (hover!.contents as { value: string }).value;
			expect(value).toContain("WebSocket Trigger");
		});

		it("should show hover for sse trigger key", () => {
			const text = '{\n  "trigger": {\n    "sse": {\n      "path": "/events"\n    }\n  }\n}';
			const hover = getHover(text, 2, 6);
			expect(hover).not.toBeNull();
			const value = (hover!.contents as { value: string }).value;
			expect(value).toContain("SSE Trigger");
		});
	});

	describe("workflow field hover", () => {
		it("should show hover for name field", () => {
			const text = '{\n  "name": "my-workflow"\n}';
			const hover = getHover(text, 1, 4);
			expect(hover).not.toBeNull();
			const value = (hover!.contents as { value: string }).value;
			expect(value).toContain("Workflow Name");
		});

		it("should show hover for version field", () => {
			const text = '{\n  "version": "1.0.0"\n}';
			const hover = getHover(text, 1, 5);
			expect(hover).not.toBeNull();
			const value = (hover!.contents as { value: string }).value;
			expect(value).toContain("Workflow Version");
		});

		it("should show hover for steps field", () => {
			const text = '{\n  "steps": []\n}';
			const hover = getHover(text, 1, 5);
			expect(hover).not.toBeNull();
			const value = (hover!.contents as { value: string }).value;
			expect(value).toContain("Workflow Steps");
		});

		it("should show hover for nodes field", () => {
			const text = '{\n  "nodes": {}\n}';
			const hover = getHover(text, 1, 5);
			expect(hover).not.toBeNull();
			const value = (hover!.contents as { value: string }).value;
			expect(value).toContain("Node Configurations");
		});

		it("should show hover for inputs field", () => {
			const text = '{\n  "nodes": {\n    "step1": {\n      "inputs": {}\n    }\n  }\n}';
			const hover = getHover(text, 3, 8);
			expect(hover).not.toBeNull();
			const value = (hover!.contents as { value: string }).value;
			expect(value).toContain("Node Inputs");
		});

		it("should show hover for conditions field", () => {
			const text = '{\n  "nodes": {\n    "router": {\n      "conditions": []\n    }\n  }\n}';
			const hover = getHover(text, 3, 10);
			expect(hover).not.toBeNull();
			const value = (hover!.contents as { value: string }).value;
			expect(value).toContain("Conditional Branches");
		});
	});

	describe("step field hover", () => {
		it("should show hover for node field in step", () => {
			const text = '{\n  "steps": [\n    {\n      "node": "@blok/api-call"\n    }\n  ]\n}';
			const hover = getHover(text, 3, 8);
			expect(hover).not.toBeNull();
			const value = (hover!.contents as { value: string }).value;
			expect(value).toContain("Step Node Reference");
		});

		it("should show hover for type field in step", () => {
			const text = '{\n  "steps": [\n    {\n      "type": "module"\n    }\n  ]\n}';
			const hover = getHover(text, 3, 8);
			expect(hover).not.toBeNull();
			const value = (hover!.contents as { value: string }).value;
			expect(value).toContain("Step Type");
		});

		it("should show hover for runtime field in step", () => {
			const text = '{\n  "steps": [\n    {\n      "runtime": "python3"\n    }\n  ]\n}';
			const hover = getHover(text, 3, 9);
			expect(hover).not.toBeNull();
			const value = (hover!.contents as { value: string }).value;
			expect(value).toContain("Step Runtime");
		});
	});

	describe("value hover", () => {
		it("should show hover for HTTP method value", () => {
			const text = '{\n  "trigger": {\n    "http": {\n      "method": "POST"\n    }\n  }\n}';
			// "POST" is at position after "method": "
			const hover = getHover(text, 3, 20);
			expect(hover).not.toBeNull();
			const value = (hover!.contents as { value: string }).value;
			expect(value).toContain("HTTP Method: POST");
		});

		it("should show hover for runtime type value", () => {
			const text = '{\n  "steps": [\n    {\n      "type": "runtime.go"\n    }\n  ]\n}';
			const hover = getHover(text, 3, 18);
			expect(hover).not.toBeNull();
			const value = (hover!.contents as { value: string }).value;
			expect(value).toContain("Runtime Type: go");
		});

		it("should show hover for @blok/api-call value", () => {
			const text = '{\n  "steps": [\n    {\n      "node": "@blok/api-call"\n    }\n  ]\n}';
			const hover = getHover(text, 3, 18);
			expect(hover).not.toBeNull();
			const value = (hover!.contents as { value: string }).value;
			expect(value).toContain("api-call");
			expect(value).toContain("HTTP API calls");
		});

		it("should show hover for @blok/if-else value", () => {
			const text = '{\n  "steps": [\n    {\n      "node": "@blok/if-else"\n    }\n  ]\n}';
			const hover = getHover(text, 3, 18);
			expect(hover).not.toBeNull();
			const value = (hover!.contents as { value: string }).value;
			expect(value).toContain("if-else");
			expect(value).toContain("Conditional");
		});
	});

	describe("no hover", () => {
		it("should return null for unknown keys", () => {
			const text = '{\n  "unknown_key": "value"\n}';
			const hover = getHover(text, 1, 5);
			expect(hover).toBeNull();
		});

		it("should return null for plain string values", () => {
			const text = '{\n  "name": "my-workflow"\n}';
			// Hover on the value "my-workflow"
			const hover = getHover(text, 1, 14);
			expect(hover).toBeNull();
		});

		it("should return null when cursor is not on a quoted string", () => {
			const text = '{\n  "steps": []\n}';
			// Hover on []
			const hover = getHover(text, 1, 12);
			expect(hover).toBeNull();
		});

		it("should return null for empty line", () => {
			const text = "{\n\n}";
			const hover = getHover(text, 1, 0);
			expect(hover).toBeNull();
		});
	});

	describe("hover includes examples", () => {
		it("should include code example for trigger types with examples", () => {
			const text = '{\n  "trigger": {\n    "http": {}\n  }\n}';
			const hover = getHover(text, 2, 6);
			expect(hover).not.toBeNull();
			const value = (hover!.contents as { value: string }).value;
			expect(value).toContain("```json");
			expect(value).toContain("method");
		});

		it("should include code example for inputs field", () => {
			const text = '{\n  "inputs": {}\n}';
			const hover = getHover(text, 1, 5);
			expect(hover).not.toBeNull();
			const value = (hover!.contents as { value: string }).value;
			expect(value).toContain("```json");
		});
	});

	describe("hover range", () => {
		it("should return correct range for hovered word", () => {
			const text = '{\n  "name": "my-workflow"\n}';
			const hover = getHover(text, 1, 4);
			expect(hover).not.toBeNull();
			expect(hover!.range).toBeDefined();
			expect(hover!.range!.start.line).toBe(1);
			expect(hover!.range!.end.line).toBe(1);
		});
	});
});
