import * as vscode from "vscode";

interface RuntimeInfo {
	name: string;
	kind: string;
	protocol: string;
	status: string;
	languages: string[];
}

const SUPPORTED_RUNTIMES: RuntimeInfo[] = [
	{
		name: "Node.js",
		kind: "nodejs",
		protocol: "In-Process",
		status: "Production",
		languages: ["TypeScript", "JavaScript"],
	},
	{
		name: "Bun",
		kind: "bun",
		protocol: "In-Process",
		status: "Beta",
		languages: ["TypeScript", "JavaScript"],
	},
	{
		name: "Python 3",
		kind: "python3",
		protocol: "gRPC",
		status: "Production",
		languages: ["Python"],
	},
	{
		name: "Go",
		kind: "go",
		protocol: "HTTP / gRPC",
		status: "Production",
		languages: ["Go"],
	},
	{
		name: "Java",
		kind: "java",
		protocol: "HTTP / gRPC",
		status: "Production",
		languages: ["Java", "Kotlin"],
	},
	{
		name: "Rust",
		kind: "rust",
		protocol: "HTTP / gRPC / WASM",
		status: "Production",
		languages: ["Rust"],
	},
	{
		name: "C# / .NET",
		kind: "csharp",
		protocol: "HTTP / gRPC",
		status: "Production",
		languages: ["C#", "F#"],
	},
	{
		name: "PHP",
		kind: "php",
		protocol: "HTTP",
		status: "Production",
		languages: ["PHP"],
	},
	{
		name: "Ruby",
		kind: "ruby",
		protocol: "HTTP",
		status: "Production",
		languages: ["Ruby"],
	},
];

/**
 * Displays the available Blok runtime adapters in the sidebar.
 *
 * Shows each runtime with its protocol, status, and supported languages.
 */
export class RuntimeTreeProvider implements vscode.TreeDataProvider<RuntimeTreeItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<RuntimeTreeItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	getTreeItem(element: RuntimeTreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: RuntimeTreeItem): RuntimeTreeItem[] {
		if (!element) {
			return SUPPORTED_RUNTIMES.map(
				(rt) => new RuntimeTreeItem(rt.name, `${rt.protocol} - ${rt.status}`, vscode.TreeItemCollapsibleState.None, rt),
			);
		}
		return [];
	}
}

class RuntimeTreeItem extends vscode.TreeItem {
	constructor(
		public readonly label: string,
		public readonly description: string,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly runtime: RuntimeInfo,
	) {
		super(label, collapsibleState);

		const statusIcon = runtime.status === "Production" ? "check" : "beaker";
		this.iconPath = new vscode.ThemeIcon(statusIcon);
		this.tooltip = new vscode.MarkdownString(
			`**${runtime.name}** (${runtime.kind})\n\n` +
				`- Protocol: ${runtime.protocol}\n` +
				`- Status: ${runtime.status}\n` +
				`- Languages: ${runtime.languages.join(", ")}`,
		);
		this.contextValue = "runtime";
	}
}
