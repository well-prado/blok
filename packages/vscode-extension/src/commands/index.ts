import * as vscode from "vscode";
import type { WorkflowDiagnostics } from "../providers/WorkflowDiagnostics";

function getNanoctlPath(): string {
	const config = vscode.workspace.getConfiguration("blok");
	return config.get<string>("nanoctlPath", "nanoctl");
}

function getWorkspaceFolder(): string | undefined {
	const folders = vscode.workspace.workspaceFolders;
	return folders?.[0]?.uri.fsPath;
}

/**
 * Runs a nanoctl command in the integrated terminal.
 */
function runInTerminal(command: string, name: string): void {
	const terminal = vscode.window.createTerminal({ name: `Blok: ${name}` });
	terminal.show();
	terminal.sendText(command);
}

/**
 * Generate AI Node command.
 * Prompts user for description and runs `nanoctl generate ai-node`.
 */
export function registerGenerateNodeCommand(output: vscode.OutputChannel): vscode.Disposable {
	return vscode.commands.registerCommand("blok.generateNode", async () => {
		const description = await vscode.window.showInputBox({
			prompt: "Describe the node you want to generate",
			placeHolder: "e.g., Fetch user from PostgreSQL by ID",
		});

		if (!description) return;

		const style = await vscode.window.showQuickPick(
			[
				{ label: "function", description: "Function-first with defineNode() (recommended)" },
				{ label: "class", description: "Class-based with NanoService" },
			],
			{ placeHolder: "Select node style" },
		);

		if (!style) return;

		const nanoctlPath = getNanoctlPath();
		const cmd = `${nanoctlPath} generate ai-node "${description}" --style=${style.label}`;

		output.appendLine(`Generating AI node: ${description}`);
		runInTerminal(cmd, "Generate Node");
	});
}

/**
 * Generate AI Workflow command.
 * Prompts user for description and runs `nanoctl generate ai-workflow`.
 */
export function registerGenerateWorkflowCommand(output: vscode.OutputChannel): vscode.Disposable {
	return vscode.commands.registerCommand("blok.generateWorkflow", async () => {
		const description = await vscode.window.showInputBox({
			prompt: "Describe the workflow you want to generate",
			placeHolder: "e.g., User registration with email verification",
		});

		if (!description) return;

		const trigger = await vscode.window.showQuickPick(
			[
				{ label: "http", description: "HTTP REST endpoint" },
				{ label: "grpc", description: "gRPC service method" },
				{ label: "cron", description: "Scheduled execution" },
				{ label: "queue", description: "Message queue consumer" },
				{ label: "pubsub", description: "Pub/Sub subscriber" },
				{ label: "worker", description: "Background job" },
				{ label: "webhook", description: "External webhook" },
				{ label: "websocket", description: "WebSocket connection" },
				{ label: "sse", description: "Server-Sent Events" },
			],
			{ placeHolder: "Select trigger type" },
		);

		if (!trigger) return;

		const nanoctlPath = getNanoctlPath();
		const cmd = `${nanoctlPath} generate ai-workflow "${description}" --trigger=${trigger.label}`;

		output.appendLine(`Generating AI workflow: ${description}`);
		runInTerminal(cmd, "Generate Workflow");
	});
}

/**
 * Generate AI Trigger command.
 * Prompts user for description and runs `nanoctl generate ai-trigger`.
 */
export function registerGenerateTriggerCommand(output: vscode.OutputChannel): vscode.Disposable {
	return vscode.commands.registerCommand("blok.generateTrigger", async () => {
		const description = await vscode.window.showInputBox({
			prompt: "Describe the trigger you want to generate",
			placeHolder: "e.g., Kafka consumer for user-events topic",
		});

		if (!description) return;

		const nanoctlPath = getNanoctlPath();
		const cmd = `${nanoctlPath} generate ai-trigger "${description}"`;

		output.appendLine(`Generating AI trigger: ${description}`);
		runInTerminal(cmd, "Generate Trigger");
	});
}

/**
 * Validate current workflow file command.
 * Runs diagnostic validation on the active editor's file.
 */
export function registerValidateWorkflowCommand(diagnostics: WorkflowDiagnostics): vscode.Disposable {
	return vscode.commands.registerCommand("blok.validateWorkflow", () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showWarningMessage("No active editor. Open a workflow JSON file first.");
			return;
		}

		if (editor.document.languageId !== "json") {
			vscode.window.showWarningMessage("Active file is not a JSON file.");
			return;
		}

		diagnostics.validate(editor.document);
		vscode.window.showInformationMessage("Workflow validation complete. Check the Problems panel for any issues.");
	});
}

/**
 * Open Monitor Dashboard command.
 * Runs `nanoctl monitor` in the integrated terminal.
 */
export function registerOpenMonitorCommand(output: vscode.OutputChannel): vscode.Disposable {
	return vscode.commands.registerCommand("blok.openMonitor", () => {
		const cwd = getWorkspaceFolder();
		if (!cwd) {
			vscode.window.showWarningMessage("No workspace folder open.");
			return;
		}

		const nanoctlPath = getNanoctlPath();
		output.appendLine("Opening Blok monitor dashboard");
		runInTerminal(`cd "${cwd}" && ${nanoctlPath} monitor`, "Monitor");
	});
}

/**
 * Migrate Node to Function-First command.
 * Runs `nanoctl migrate node` on the current file.
 */
export function registerMigrateNodeCommand(output: vscode.OutputChannel): vscode.Disposable {
	return vscode.commands.registerCommand("blok.migrateNode", async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showWarningMessage("No active editor. Open a node TypeScript file first.");
			return;
		}

		const filePath = editor.document.uri.fsPath;
		if (!filePath.endsWith(".ts")) {
			vscode.window.showWarningMessage("Active file is not a TypeScript file.");
			return;
		}

		const confirm = await vscode.window.showWarningMessage(
			`Migrate "${vscode.workspace.asRelativePath(filePath)}" to function-first pattern?`,
			"Yes",
			"No",
		);

		if (confirm !== "Yes") return;

		const nanoctlPath = getNanoctlPath();
		const cmd = `${nanoctlPath} migrate node "${filePath}"`;

		output.appendLine(`Migrating node to function-first: ${filePath}`);
		runInTerminal(cmd, "Migrate Node");
	});
}
