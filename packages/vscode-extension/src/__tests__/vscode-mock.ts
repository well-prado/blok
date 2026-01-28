/**
 * Mock for the vscode module used in unit tests.
 *
 * Provides stubs for core VS Code APIs so extension logic can be tested
 * outside the VS Code extension host.
 */

export class Position {
	constructor(
		public readonly line: number,
		public readonly character: number,
	) {}
}

export class Range {
	constructor(
		public readonly start: Position | number,
		public readonly end: Position | number,
		public readonly startChar?: number,
		public readonly endChar?: number,
	) {
		if (typeof start === "number") {
			this.start = new Position(start as number, (startChar ?? end) as number);
			this.end = new Position((end ?? start) as number, (endChar ?? startChar ?? 0) as number);
		}
	}
}

export class Diagnostic {
	constructor(
		public readonly range: Range,
		public readonly message: string,
		public readonly severity: number,
	) {}
}

export const DiagnosticSeverity = {
	Error: 0,
	Warning: 1,
	Information: 2,
	Hint: 3,
};

export class MarkdownString {
	value: string;
	constructor(value?: string) {
		this.value = value || "";
	}
	appendMarkdown(value: string): MarkdownString {
		this.value += value;
		return this;
	}
	appendCodeblock(code: string, language?: string): MarkdownString {
		this.value += `\n\`\`\`${language || ""}\n${code}\n\`\`\`\n`;
		return this;
	}
}

export class Hover {
	constructor(
		public readonly contents: MarkdownString | string,
		public readonly range?: Range,
	) {}
}

export enum CompletionItemKind {
	Text = 0,
	Method = 1,
	Function = 2,
	Constructor = 3,
	Field = 4,
	Variable = 5,
	Class = 6,
	Interface = 7,
	Module = 8,
	Property = 9,
	Unit = 10,
	Value = 11,
	Enum = 12,
	Keyword = 13,
	Snippet = 14,
	Color = 15,
	File = 16,
	Reference = 17,
	Folder = 18,
	EnumMember = 19,
}

export class CompletionItem {
	detail?: string;
	documentation?: string | MarkdownString;
	sortText?: string;
	constructor(
		public readonly label: string,
		public readonly kind?: CompletionItemKind,
	) {}
}

export class ThemeIcon {
	constructor(public readonly id: string) {}
}

export enum TreeItemCollapsibleState {
	None = 0,
	Collapsed = 1,
	Expanded = 2,
}

export class TreeItem {
	label?: string;
	description?: string;
	tooltip?: string | MarkdownString;
	iconPath?: ThemeIcon;
	command?: { command: string; title: string; arguments?: unknown[] };
	contextValue?: string;
	collapsibleState?: TreeItemCollapsibleState;

	constructor(label: string, collapsibleState?: TreeItemCollapsibleState) {
		this.label = label;
		this.collapsibleState = collapsibleState;
	}
}

export class EventEmitter<T> {
	private listeners: Array<(e: T) => void> = [];
	event = (listener: (e: T) => void) => {
		this.listeners.push(listener);
		return { dispose: () => {} };
	};
	fire(data: T): void {
		for (const listener of this.listeners) listener(data);
	}
}

export class Uri {
	constructor(public readonly fsPath: string) {}
	static file(path: string): Uri {
		return new Uri(path);
	}
}

export const languages = {
	createDiagnosticCollection: (name: string) => ({
		name,
		entries: new Map<string, Diagnostic[]>(),
		set(uri: Uri | string, diagnostics: Diagnostic[]) {
			const key = typeof uri === "string" ? uri : uri.fsPath;
			this.entries.set(key, diagnostics);
		},
		delete(uri: Uri | string) {
			const key = typeof uri === "string" ? uri : uri.fsPath;
			this.entries.delete(key);
		},
		get(uri: Uri | string): Diagnostic[] | undefined {
			const key = typeof uri === "string" ? uri : uri.fsPath;
			return this.entries.get(key);
		},
		clear() {
			this.entries.clear();
		},
		dispose() {},
	}),
	registerHoverProvider: () => ({ dispose: () => {} }),
	registerCompletionItemProvider: () => ({ dispose: () => {} }),
	match: () => 1,
};

export const window = {
	createOutputChannel: (name: string) => ({
		name,
		appendLine: () => {},
		show: () => {},
		dispose: () => {},
	}),
	showInputBox: async () => undefined,
	showQuickPick: async () => undefined,
	showWarningMessage: async () => undefined,
	showInformationMessage: async () => undefined,
	createTerminal: () => ({ show: () => {}, sendText: () => {}, dispose: () => {} }),
	registerTreeDataProvider: () => ({ dispose: () => {} }),
	activeTextEditor: undefined,
};

export const workspace = {
	getConfiguration: () => ({
		get: <T>(key: string, defaultValue?: T) => defaultValue,
	}),
	workspaceFolders: undefined,
	onDidSaveTextDocument: () => ({ dispose: () => {} }),
	onDidOpenTextDocument: () => ({ dispose: () => {} }),
	onDidCloseTextDocument: () => ({ dispose: () => {} }),
	textDocuments: [],
	asRelativePath: (uri: Uri | string) => (typeof uri === "string" ? uri : uri.fsPath),
	findFiles: async () => [],
	fs: {
		readFile: async () => Buffer.from(""),
	},
};

export const commands = {
	registerCommand: (command: string, callback: (...args: unknown[]) => void) => ({
		dispose: () => {},
		command,
		callback,
	}),
};
