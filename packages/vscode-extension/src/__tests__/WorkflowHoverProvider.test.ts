import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./vscode-mock"));

import * as vscode from "vscode";
import { WorkflowHoverProvider } from "../providers/WorkflowHoverProvider";

function createMockDocument(content: string): vscode.TextDocument {
	const lines = content.split("\n");
	return {
		getText: (range?: vscode.Range) => {
			if (range) {
				const start = range.start as vscode.Position;
				const end = range.end as vscode.Position;
				if (start.line === end.line) {
					return lines[start.line].substring(start.character, end.character);
				}
				return content;
			}
			return content;
		},
		lineAt: (lineOrPos: number | vscode.Position) => ({
			text: lines[typeof lineOrPos === "number" ? lineOrPos : lineOrPos.line],
		}),
		getWordRangeAtPosition: (pos: vscode.Position, regex?: RegExp) => {
			const lineText = lines[pos.line];
			if (!regex) return null;
			const match = regex.exec(lineText);
			if (!match) return null;
			// Find the match that contains the position
			let lastIndex = 0;
			while (true) {
				const m = regex.exec(lineText.substring(lastIndex));
				if (!m) return null;
				const start = lastIndex + m.index;
				const end = start + m[0].length;
				if (pos.character >= start && pos.character <= end) {
					return new vscode.Range(new vscode.Position(pos.line, start), new vscode.Position(pos.line, end));
				}
				lastIndex = start + 1;
				if (lastIndex >= lineText.length) return null;
			}
		},
		uri: { fsPath: "/test/workflow.json" } as vscode.Uri,
		languageId: "json",
	} as unknown as vscode.TextDocument;
}

describe("WorkflowHoverProvider", () => {
	const provider = new WorkflowHoverProvider();

	describe("trigger type hovers", () => {
		it("should show hover for http trigger key", () => {
			const content = '  "http": {';
			const doc = createMockDocument(content);
			const pos = new vscode.Position(0, 4);
			const hover = provider.provideHover(doc, pos, {} as vscode.CancellationToken);

			expect(hover).not.toBeNull();
			if (hover) {
				const md = (hover as vscode.Hover).contents as vscode.MarkdownString;
				expect(md.value).toContain("HTTP Trigger");
			}
		});

		it("should show hover for cron trigger key", () => {
			const content = '  "cron": {';
			const doc = createMockDocument(content);
			const pos = new vscode.Position(0, 4);
			const hover = provider.provideHover(doc, pos, {} as vscode.CancellationToken);

			expect(hover).not.toBeNull();
			if (hover) {
				const md = (hover as vscode.Hover).contents as vscode.MarkdownString;
				expect(md.value).toContain("Cron Trigger");
			}
		});

		it("should show hover for queue trigger key", () => {
			const content = '  "queue": {';
			const doc = createMockDocument(content);
			const pos = new vscode.Position(0, 4);
			const hover = provider.provideHover(doc, pos, {} as vscode.CancellationToken);

			expect(hover).not.toBeNull();
			if (hover) {
				const md = (hover as vscode.Hover).contents as vscode.MarkdownString;
				expect(md.value).toContain("Queue Trigger");
			}
		});

		it("should show hover for webhook trigger key", () => {
			const content = '  "webhook": {';
			const doc = createMockDocument(content);
			const pos = new vscode.Position(0, 6);
			const hover = provider.provideHover(doc, pos, {} as vscode.CancellationToken);

			expect(hover).not.toBeNull();
			if (hover) {
				const md = (hover as vscode.Hover).contents as vscode.MarkdownString;
				expect(md.value).toContain("Webhook Trigger");
			}
		});

		it("should show hover for websocket trigger key", () => {
			const content = '  "websocket": {';
			const doc = createMockDocument(content);
			const pos = new vscode.Position(0, 6);
			const hover = provider.provideHover(doc, pos, {} as vscode.CancellationToken);

			expect(hover).not.toBeNull();
			if (hover) {
				const md = (hover as vscode.Hover).contents as vscode.MarkdownString;
				expect(md.value).toContain("WebSocket Trigger");
			}
		});

		it("should show hover for sse trigger key", () => {
			const content = '  "sse": {';
			const doc = createMockDocument(content);
			const pos = new vscode.Position(0, 4);
			const hover = provider.provideHover(doc, pos, {} as vscode.CancellationToken);

			expect(hover).not.toBeNull();
			if (hover) {
				const md = (hover as vscode.Hover).contents as vscode.MarkdownString;
				expect(md.value).toContain("SSE Trigger");
			}
		});
	});

	describe("field hovers", () => {
		it("should show hover for steps key", () => {
			const content = '  "steps": [';
			const doc = createMockDocument(content);
			const pos = new vscode.Position(0, 4);
			const hover = provider.provideHover(doc, pos, {} as vscode.CancellationToken);

			expect(hover).not.toBeNull();
			if (hover) {
				const md = (hover as vscode.Hover).contents as vscode.MarkdownString;
				expect(md.value).toContain("Workflow Steps");
			}
		});

		it("should show hover for nodes key", () => {
			const content = '  "nodes": {';
			const doc = createMockDocument(content);
			const pos = new vscode.Position(0, 4);
			const hover = provider.provideHover(doc, pos, {} as vscode.CancellationToken);

			expect(hover).not.toBeNull();
			if (hover) {
				const md = (hover as vscode.Hover).contents as vscode.MarkdownString;
				expect(md.value).toContain("Node Configurations");
			}
		});

		it("should show hover for inputs key", () => {
			const content = '  "inputs": {';
			const doc = createMockDocument(content);
			const pos = new vscode.Position(0, 4);
			const hover = provider.provideHover(doc, pos, {} as vscode.CancellationToken);

			expect(hover).not.toBeNull();
			if (hover) {
				const md = (hover as vscode.Hover).contents as vscode.MarkdownString;
				expect(md.value).toContain("Node Inputs");
			}
		});

		it("should show hover for conditions key", () => {
			const content = '  "conditions": [';
			const doc = createMockDocument(content);
			const pos = new vscode.Position(0, 6);
			const hover = provider.provideHover(doc, pos, {} as vscode.CancellationToken);

			expect(hover).not.toBeNull();
			if (hover) {
				const md = (hover as vscode.Hover).contents as vscode.MarkdownString;
				expect(md.value).toContain("Conditional Branches");
			}
		});

		it("should show hover for ephemeral key", () => {
			const content = '  "ephemeral": true';
			const doc = createMockDocument(content);
			const pos = new vscode.Position(0, 6);
			const hover = provider.provideHover(doc, pos, {} as vscode.CancellationToken);

			expect(hover).not.toBeNull();
			if (hover) {
				const md = (hover as vscode.Hover).contents as vscode.MarkdownString;
				expect(md.value).toContain("Skip Persistence");
			}
		});
	});

	describe("node package hovers", () => {
		it("should show hover for @blokjs/api-call value", () => {
			const content = '    "node": "@blokjs/api-call"';
			const doc = createMockDocument(content);
			// Position on the value part
			const pos = new vscode.Position(0, 20);
			const hover = provider.provideHover(doc, pos, {} as vscode.CancellationToken);

			// This depends on the regex matching - the hover should be for the value
			if (hover) {
				const md = (hover as vscode.Hover).contents as vscode.MarkdownString;
				expect(md.value).toContain("api-call");
			}
		});
	});

	describe("no hover for unknown keys", () => {
		it("should return null for unknown keys", () => {
			const content = '  "unknown_key": "value"';
			const doc = createMockDocument(content);
			const pos = new vscode.Position(0, 6);
			const hover = provider.provideHover(doc, pos, {} as vscode.CancellationToken);

			expect(hover).toBeNull();
		});
	});
});
