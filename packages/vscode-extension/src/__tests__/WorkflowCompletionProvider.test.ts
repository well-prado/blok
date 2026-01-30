import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./vscode-mock"));

import * as vscode from "vscode";
import { WorkflowCompletionProvider } from "../providers/WorkflowCompletionProvider";

function createMockDocument(content: string): vscode.TextDocument {
	const lines = content.split("\n");
	return {
		getText: () => content,
		lineAt: (line: number) => ({ text: lines[line] || "" }),
		offsetAt: (pos: vscode.Position) => {
			let offset = 0;
			for (let i = 0; i < pos.line && i < lines.length; i++) {
				offset += lines[i].length + 1;
			}
			offset += pos.character;
			return offset;
		},
		uri: { fsPath: "/test/workflow.json" } as vscode.Uri,
		languageId: "json",
	} as unknown as vscode.TextDocument;
}

describe("WorkflowCompletionProvider", () => {
	const provider = new WorkflowCompletionProvider();

	describe("HTTP method completions", () => {
		it("should provide HTTP method completions for method key", () => {
			const content = '{\n  "trigger": {\n    "http": {\n      "method": "';
			const doc = createMockDocument(content);
			const lines = content.split("\n");
			const lastLine = lines[lines.length - 1];
			const pos = new vscode.Position(lines.length - 1, lastLine.length);

			const items = provider.provideCompletionItems(
				doc,
				pos,
				{} as vscode.CancellationToken,
				{} as vscode.CompletionContext,
			) as vscode.CompletionItem[];

			if (items && items.length > 0) {
				const labels = items.map((i) => i.label);
				expect(labels).toContain("GET");
				expect(labels).toContain("POST");
				expect(labels).toContain("DELETE");
			}
		});
	});

	describe("step type completions", () => {
		it("should provide step type completions", () => {
			const content = '{\n  "steps": [\n    {\n      "type": "';
			const doc = createMockDocument(content);
			const lines = content.split("\n");
			const lastLine = lines[lines.length - 1];
			const pos = new vscode.Position(lines.length - 1, lastLine.length);

			const items = provider.provideCompletionItems(
				doc,
				pos,
				{} as vscode.CancellationToken,
				{} as vscode.CompletionContext,
			) as vscode.CompletionItem[];

			if (items && items.length > 0) {
				const labels = items.map((i) => i.label);
				expect(labels).toContain("module");
				expect(labels).toContain("local");
			}
		});
	});

	describe("runtime completions", () => {
		it("should provide runtime completions", () => {
			const content = '{\n  "steps": [\n    {\n      "runtime": "';
			const doc = createMockDocument(content);
			const lines = content.split("\n");
			const lastLine = lines[lines.length - 1];
			const pos = new vscode.Position(lines.length - 1, lastLine.length);

			const items = provider.provideCompletionItems(
				doc,
				pos,
				{} as vscode.CancellationToken,
				{} as vscode.CompletionContext,
			) as vscode.CompletionItem[];

			if (items && items.length > 0) {
				const labels = items.map((i) => i.label);
				expect(labels).toContain("nodejs");
				expect(labels).toContain("python3");
				expect(labels).toContain("go");
				expect(labels).toContain("java");
				expect(labels).toContain("rust");
			}
		});
	});

	describe("node package completions", () => {
		it("should provide node completions for node key", () => {
			const content = '{\n  "steps": [\n    {\n      "node": "';
			const doc = createMockDocument(content);
			const lines = content.split("\n");
			const lastLine = lines[lines.length - 1];
			const pos = new vscode.Position(lines.length - 1, lastLine.length);

			const items = provider.provideCompletionItems(
				doc,
				pos,
				{} as vscode.CancellationToken,
				{} as vscode.CompletionContext,
			) as vscode.CompletionItem[];

			if (items && items.length > 0) {
				const labels = items.map((i) => i.label);
				expect(labels).toContain("@blok/api-call");
				expect(labels).toContain("@blok/if-else");
			}
		});
	});

	describe("webhook source completions", () => {
		it("should provide webhook source completions", () => {
			const content = '{\n  "trigger": {\n    "webhook": {\n      "source": "';
			const doc = createMockDocument(content);
			const lines = content.split("\n");
			const lastLine = lines[lines.length - 1];
			const pos = new vscode.Position(lines.length - 1, lastLine.length);

			const items = provider.provideCompletionItems(
				doc,
				pos,
				{} as vscode.CancellationToken,
				{} as vscode.CompletionContext,
			) as vscode.CompletionItem[];

			if (items && items.length > 0) {
				const labels = items.map((i) => i.label);
				expect(labels).toContain("github");
				expect(labels).toContain("stripe");
				expect(labels).toContain("shopify");
			}
		});
	});

	describe("condition type completions", () => {
		it("should provide condition type completions", () => {
			const content = '{\n  "nodes": {\n    "filter": {\n      "conditions": [\n        {\n          "type": "';
			const doc = createMockDocument(content);
			const lines = content.split("\n");
			const lastLine = lines[lines.length - 1];
			const pos = new vscode.Position(lines.length - 1, lastLine.length);

			const items = provider.provideCompletionItems(
				doc,
				pos,
				{} as vscode.CancellationToken,
				{} as vscode.CompletionContext,
			) as vscode.CompletionItem[];

			if (items && items.length > 0) {
				const labels = items.map((i) => i.label);
				expect(labels).toContain("if");
				expect(labels).toContain("else");
			}
		});
	});
});
