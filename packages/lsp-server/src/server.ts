#!/usr/bin/env node
import { TextDocument } from "vscode-languageserver-textdocument";
import {
	type CompletionParams,
	DidChangeConfigurationNotification,
	type HoverParams,
	type InitializeParams,
	type InitializeResult,
	ProposedFeatures,
	TextDocumentSyncKind,
	TextDocuments,
	createConnection,
} from "vscode-languageserver/node";
import { getCompletions } from "./completion";
import { validateWorkflow } from "./diagnostics";
import { getHover } from "./hover";

/**
 * Blok Workflow Language Server
 *
 * Provides workflow intelligence for any LSP-compatible editor:
 * - Diagnostics: Real-time validation of workflow JSON files
 * - Completion: Contextual auto-completion for triggers, steps, runtimes, etc.
 * - Hover: Rich documentation on hover for workflow fields and values
 *
 * Communication: stdio (default) or TCP
 * File types: JSON files matching **/ workflows; /**\/*.json or blok.workflow.json
 */

// Create connection and document manager
const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

// Server settings
interface BlokLspSettings {
	workflowGlob: string;
	maxDiagnostics: number;
}

const defaultSettings: BlokLspSettings = {
	workflowGlob: "**/workflows/**/*.json",
	maxDiagnostics: 100,
};

let globalSettings: BlokLspSettings = defaultSettings;
const documentSettings = new Map<string, BlokLspSettings>();

connection.onInitialize((params: InitializeParams): InitializeResult => {
	const capabilities = params.capabilities;

	hasConfigurationCapability = !!(capabilities.workspace && capabilities.workspace.configuration);
	hasWorkspaceFolderCapability = !!(capabilities.workspace && capabilities.workspace.workspaceFolders);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			completionProvider: {
				resolveProvider: false,
				triggerCharacters: ['"', ":"],
			},
			hoverProvider: true,
		},
	};

	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true,
			},
		};
	}

	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
});

// Configuration handling
connection.onDidChangeConfiguration((change) => {
	if (hasConfigurationCapability) {
		documentSettings.clear();
	} else {
		globalSettings = change.settings?.blok || defaultSettings;
	}

	// Revalidate all open documents
	for (const doc of documents.all()) {
		validateDocument(doc);
	}
});

function getDocumentSettings(resource: string): BlokLspSettings {
	if (!hasConfigurationCapability) {
		return globalSettings;
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = globalSettings;
		documentSettings.set(resource, result);
	}
	return result;
}

// Document validation
function isWorkflowFile(uri: string): boolean {
	// Match workflow files by path pattern
	return /workflows?[/\\].*\.json$/i.test(uri) || /\.workflow\.json$/i.test(uri) || /blok\.json$/i.test(uri);
}

function validateDocument(document: TextDocument): void {
	if (!isWorkflowFile(document.uri)) return;

	const text = document.getText();
	const diagnostics = validateWorkflow(text);
	const settings = getDocumentSettings(document.uri);

	// Limit diagnostics if configured
	const limited = diagnostics.slice(0, settings.maxDiagnostics);
	connection.sendDiagnostics({ uri: document.uri, diagnostics: limited });
}

// Validate on open and change
documents.onDidChangeContent((change) => {
	validateDocument(change.document);
});

documents.onDidClose((event) => {
	documentSettings.delete(event.document.uri);
	connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

// Completion
connection.onCompletion((params: CompletionParams) => {
	const document = documents.get(params.textDocument.uri);
	if (!document) return [];
	if (!isWorkflowFile(document.uri)) return [];

	const text = document.getText();
	const offset = document.offsetAt(params.position);
	return getCompletions(text, offset);
});

// Hover
connection.onHover((params: HoverParams) => {
	const document = documents.get(params.textDocument.uri);
	if (!document) return null;
	if (!isWorkflowFile(document.uri)) return null;

	const text = document.getText();
	return getHover(text, params.position.line, params.position.character);
});

// Start listening
documents.listen(connection);
connection.listen();
