import * as path from "node:path";
import * as vscode from "vscode";

type TreeItemType = "workflow" | "trigger" | "step" | "node" | "condition";

interface WorkflowData {
	name: string;
	version: string;
	description?: string;
	trigger: Record<string, unknown>;
	steps: Array<{ name: string; node: string; type: string; runtime?: string }>;
	nodes: Record<string, unknown>;
	filePath: string;
}

/**
 * Provides a tree view of all Blok workflows in the workspace.
 *
 * Displays:
 * - Workflow files with name and version
 * - Trigger type for each workflow
 * - Steps with node references
 * - Conditional branches (if/else)
 */
export class WorkflowTreeProvider implements vscode.TreeDataProvider<WorkflowTreeItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<WorkflowTreeItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private workflows: WorkflowData[] = [];

	constructor() {
		this.loadWorkflows();
	}

	refresh(): void {
		this.loadWorkflows();
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: WorkflowTreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: WorkflowTreeItem): Promise<WorkflowTreeItem[]> {
		if (!element) {
			// Root level: show workflows
			await this.loadWorkflows();
			return this.workflows.map(
				(wf) =>
					new WorkflowTreeItem(
						wf.name,
						`v${wf.version}`,
						"workflow",
						vscode.TreeItemCollapsibleState.Collapsed,
						wf.filePath,
						wf,
					),
			);
		}

		if (element.type === "workflow" && element.workflowData) {
			const wf = element.workflowData;
			const children: WorkflowTreeItem[] = [];

			// Trigger
			const triggerType = Object.keys(wf.trigger)[0] || "unknown";
			children.push(
				new WorkflowTreeItem(
					`Trigger: ${triggerType}`,
					this.getTriggerDescription(triggerType, wf.trigger[triggerType] as Record<string, unknown>),
					"trigger",
					vscode.TreeItemCollapsibleState.None,
					wf.filePath,
				),
			);

			// Steps
			for (const step of wf.steps) {
				const hasConditions =
					wf.nodes[step.name] &&
					typeof wf.nodes[step.name] === "object" &&
					Array.isArray((wf.nodes[step.name] as Record<string, unknown>).conditions);

				children.push(
					new WorkflowTreeItem(
						step.name,
						`${step.node} (${step.type}${step.runtime ? `, ${step.runtime}` : ""})`,
						"step",
						hasConditions ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
						wf.filePath,
						wf,
						step.name,
					),
				);
			}

			return children;
		}

		if (element.type === "step" && element.workflowData && element.stepName) {
			const wf = element.workflowData;
			const nodeConfig = wf.nodes[element.stepName] as Record<string, unknown> | undefined;
			if (!nodeConfig || !Array.isArray(nodeConfig.conditions)) return [];

			return (nodeConfig.conditions as Array<Record<string, unknown>>).map((cond, i) => {
				const condType = (cond.type as string) || "unknown";
				const condExpr = condType === "if" ? ((cond.condition as string) || "").substring(0, 40) : "";
				const nestedSteps = Array.isArray(cond.steps) ? cond.steps.length : 0;

				return new WorkflowTreeItem(
					`${condType}${condExpr ? `: ${condExpr}` : ""}`,
					`${nestedSteps} step${nestedSteps === 1 ? "" : "s"}`,
					"condition",
					vscode.TreeItemCollapsibleState.None,
					wf.filePath,
				);
			});
		}

		return [];
	}

	private async loadWorkflows(): Promise<void> {
		this.workflows = [];

		const config = vscode.workspace.getConfiguration("blok");
		const glob = config.get<string>("workflowGlob", "**/workflows/**/*.json");
		const files = await vscode.workspace.findFiles(glob, "**/node_modules/**", 100);

		for (const file of files) {
			try {
				const content = await vscode.workspace.fs.readFile(file);
				const text = Buffer.from(content).toString("utf-8");
				const json = JSON.parse(text);

				if (json.trigger && json.steps && json.nodes) {
					this.workflows.push({
						name: json.name || path.basename(file.fsPath, ".json"),
						version: json.version || "0.0.0",
						description: json.description,
						trigger: json.trigger,
						steps: json.steps,
						nodes: json.nodes,
						filePath: file.fsPath,
					});
				}
			} catch {
				// Skip invalid files
			}
		}

		this.workflows.sort((a, b) => a.name.localeCompare(b.name));
	}

	private getTriggerDescription(type: string, config: Record<string, unknown> | undefined): string {
		if (!config) return type;

		switch (type) {
			case "http":
				return `${config.method || "ANY"} ${config.path || "/"}`;
			case "cron":
				return (config.schedule as string) || "no schedule";
			case "queue":
				return `${config.provider || "unknown"}: ${config.topic || "no topic"}`;
			case "pubsub":
				return `${config.provider || "unknown"}: ${config.topic || "no topic"}`;
			case "worker":
				return `queue: ${config.queue || "default"}`;
			case "webhook":
				return `${config.source || "custom"}: ${Array.isArray(config.events) ? config.events.join(", ") : "all"}`;
			case "websocket":
				return (config.path as string) || "/ws";
			case "sse":
				return (config.path as string) || "/events";
			default:
				return "";
		}
	}
}

class WorkflowTreeItem extends vscode.TreeItem {
	constructor(
		public readonly label: string,
		public readonly description: string,
		public readonly type: TreeItemType,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly filePath: string,
		public readonly workflowData?: WorkflowData,
		public readonly stepName?: string,
	) {
		super(label, collapsibleState);
		this.tooltip = `${label} - ${description}`;

		// Set icons
		switch (type) {
			case "workflow":
				this.iconPath = new vscode.ThemeIcon("circuit-board");
				this.command = {
					command: "vscode.open",
					title: "Open Workflow",
					arguments: [vscode.Uri.file(filePath)],
				};
				break;
			case "trigger":
				this.iconPath = new vscode.ThemeIcon("zap");
				break;
			case "step":
				this.iconPath = new vscode.ThemeIcon("debug-step-over");
				break;
			case "node":
				this.iconPath = new vscode.ThemeIcon("symbol-function");
				break;
			case "condition":
				this.iconPath = new vscode.ThemeIcon("git-branch");
				break;
		}

		this.contextValue = type;
	}
}
