import * as vscode from "vscode";
import {
	registerGenerateNodeCommand,
	registerGenerateTriggerCommand,
	registerGenerateWorkflowCommand,
	registerMigrateNodeCommand,
	registerOpenMonitorCommand,
	registerValidateWorkflowCommand,
} from "./commands";
import { WorkflowCompletionProvider } from "./providers/WorkflowCompletionProvider";
import { WorkflowDiagnostics } from "./providers/WorkflowDiagnostics";
import { WorkflowHoverProvider } from "./providers/WorkflowHoverProvider";
import { RuntimeTreeProvider } from "./views/RuntimeTreeProvider";
import { WorkflowTreeProvider } from "./views/WorkflowTreeProvider";

const WORKFLOW_SELECTOR: vscode.DocumentSelector = {
	language: "json",
	pattern: "**/workflows/**/*.json",
};

export function activate(context: vscode.ExtensionContext): void {
	const outputChannel = vscode.window.createOutputChannel("Blok");
	outputChannel.appendLine("Blok extension activated");

	// Diagnostics
	const diagnosticCollection = vscode.languages.createDiagnosticCollection("blok");
	const workflowDiagnostics = new WorkflowDiagnostics(diagnosticCollection);
	context.subscriptions.push(diagnosticCollection);

	// Validate on save
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((doc) => {
			const config = vscode.workspace.getConfiguration("blok");
			if (config.get<boolean>("validateOnSave", true) && isWorkflowFile(doc)) {
				workflowDiagnostics.validate(doc);
			}
		}),
	);

	// Validate on open
	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument((doc) => {
			if (isWorkflowFile(doc)) {
				workflowDiagnostics.validate(doc);
			}
		}),
	);

	// Clear diagnostics on close
	context.subscriptions.push(
		vscode.workspace.onDidCloseTextDocument((doc) => {
			diagnosticCollection.delete(doc.uri);
		}),
	);

	// Hover provider
	const hoverProvider = new WorkflowHoverProvider();
	context.subscriptions.push(vscode.languages.registerHoverProvider(WORKFLOW_SELECTOR, hoverProvider));

	// Completion provider
	const completionProvider = new WorkflowCompletionProvider();
	context.subscriptions.push(
		vscode.languages.registerCompletionItemProvider(WORKFLOW_SELECTOR, completionProvider, '"', ":"),
	);

	// Tree views
	const workflowTreeProvider = new WorkflowTreeProvider();
	context.subscriptions.push(vscode.window.registerTreeDataProvider("blokWorkflows", workflowTreeProvider));

	const runtimeTreeProvider = new RuntimeTreeProvider();
	context.subscriptions.push(vscode.window.registerTreeDataProvider("blokRuntimes", runtimeTreeProvider));

	// Commands
	context.subscriptions.push(
		registerGenerateNodeCommand(outputChannel),
		registerGenerateWorkflowCommand(outputChannel),
		registerGenerateTriggerCommand(outputChannel),
		registerValidateWorkflowCommand(workflowDiagnostics),
		registerOpenMonitorCommand(outputChannel),
		registerMigrateNodeCommand(outputChannel),
		vscode.commands.registerCommand("blok.refreshWorkflows", () => {
			workflowTreeProvider.refresh();
		}),
	);

	// Validate already open workflow files
	for (const doc of vscode.workspace.textDocuments) {
		if (isWorkflowFile(doc)) {
			workflowDiagnostics.validate(doc);
		}
	}

	outputChannel.appendLine("Blok extension ready - workflow validation, snippets, and AI generation active");
}

export function deactivate(): void {
	// Cleanup handled by context.subscriptions
}

function isWorkflowFile(doc: vscode.TextDocument): boolean {
	if (doc.languageId !== "json") return false;
	const config = vscode.workspace.getConfiguration("blok");
	const glob = config.get<string>("workflowGlob", "**/workflows/**/*.json");
	const relativePath = vscode.workspace.asRelativePath(doc.uri);
	return vscode.languages.match({ pattern: glob }, doc) > 0 || relativePath.includes("workflows/");
}
