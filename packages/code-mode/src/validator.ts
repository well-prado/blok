import ts from "typescript";
import {
	CODE_MODE_MAX_SOURCE_BYTES,
	type CodeModeValidationIssue,
	type CodeModeValidationOptions,
	type CodeModeValidationResult,
} from "./contracts";

const FORBIDDEN_IDENTIFIERS = new Set([
	"Bun",
	"Deno",
	"WebAssembly",
	"__dirname",
	"__filename",
	"atob",
	"btoa",
	"child_process",
	"console",
	"ctx",
	"crypto",
	"document",
	"dns",
	"env",
	"eval",
	"exports",
	"fetch",
	"filesystem",
	"Function",
	"fs",
	"global",
	"globalThis",
	"http",
	"https",
	"importScripts",
	"js",
	"module",
	"net",
	"node",
	"os",
	"path",
	"performance",
	"process",
	"queueMicrotask",
	"require",
	"RegExp",
	"Reflect",
	"Math",
	"stream",
	"setImmediate",
	"setInterval",
	"setTimeout",
	"tls",
	"url",
	"window",
	"XMLHttpRequest",
]);

const FORBIDDEN_PROPERTIES = new Set([
	"__defineGetter__",
	"__defineSetter__",
	"__lookupGetter__",
	"__lookupSetter__",
	"__proto__",
	"arguments",
	"caller",
	"constructor",
	"create",
	"defineProperties",
	"defineProperty",
	"getOwnPropertyDescriptor",
	"getOwnPropertyNames",
	"getOwnPropertySymbols",
	"getPrototypeOf",
	"prototype",
	"setPrototypeOf",
]);

const FORBIDDEN_NODE_KINDS = new Set([
	ts.SyntaxKind.ClassDeclaration,
	ts.SyntaxKind.ClassExpression,
	ts.SyntaxKind.EnumDeclaration,
	ts.SyntaxKind.ExportAssignment,
	ts.SyntaxKind.ExportDeclaration,
	ts.SyntaxKind.FunctionDeclaration,
	ts.SyntaxKind.ImportDeclaration,
	ts.SyntaxKind.ImportEqualsDeclaration,
	ts.SyntaxKind.InterfaceDeclaration,
	ts.SyntaxKind.ModuleDeclaration,
	ts.SyntaxKind.NamespaceExportDeclaration,
	ts.SyntaxKind.TypeAliasDeclaration,
]);

const MAX_VALIDATION_ISSUES = 64;
const MAX_AST_NODES = 20_000;
const SOURCE_PREFIX = "code-mode.ts";

function sourceBytes(source: string): number {
	return new TextEncoder().encode(source).byteLength;
}

function issueAt(sourceFile: ts.SourceFile, node: ts.Node, message: string): CodeModeValidationIssue {
	const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
	return { message, line: position.line + 1, column: position.character + 1 };
}

function diagnosticsFor(sourceFile: ts.SourceFile, diagnostics: readonly ts.Diagnostic[]): CodeModeValidationIssue[] {
	return diagnostics.slice(0, MAX_VALIDATION_ISSUES).map((diagnostic) => {
		const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
		const start = diagnostic.start ?? 0;
		const position = sourceFile.getLineAndCharacterOfPosition(start);
		return { message, line: position.line + 1, column: position.character + 1 };
	});
}

function validateNode(
	sourceFile: ts.SourceFile,
	node: ts.Node,
	issues: CodeModeValidationIssue[],
	state: { count: number },
): void {
	if (issues.length >= MAX_VALIDATION_ISSUES) return;
	state.count += 1;
	if (state.count > MAX_AST_NODES) {
		issues.push({ message: "source contains too many syntax nodes", line: 1, column: 1 });
		return;
	}

	if (FORBIDDEN_NODE_KINDS.has(node.kind)) {
		issues.push(issueAt(sourceFile, node, "construct is not supported in Code Mode"));
		return;
	}
	if (ts.isIdentifier(node) && FORBIDDEN_IDENTIFIERS.has(node.text)) {
		issues.push(issueAt(sourceFile, node, `identifier "${node.text}" is unavailable in Code Mode`));
		return;
	}
	if (ts.isPrivateIdentifier(node)) {
		issues.push(issueAt(sourceFile, node, "private fields are unavailable in Code Mode"));
		return;
	}
	if (ts.isPropertyAccessExpression(node) && FORBIDDEN_PROPERTIES.has(node.name.text)) {
		issues.push(issueAt(sourceFile, node.name, `property "${node.name.text}" is unavailable in Code Mode`));
		return;
	}
	if (ts.isElementAccessExpression(node)) {
		issues.push(issueAt(sourceFile, node, "computed property access is unavailable in Code Mode"));
		return;
	}
	if (ts.isNewExpression(node)) {
		issues.push(issueAt(sourceFile, node, "object construction is unavailable in Code Mode"));
		return;
	}
	if (ts.isRegularExpressionLiteral(node)) {
		issues.push(issueAt(sourceFile, node, "regular expressions are unavailable in Code Mode"));
		return;
	}
	if (
		ts.isDeleteExpression(node) ||
		ts.isWithStatement(node) ||
		ts.isDebuggerStatement(node) ||
		ts.isYieldExpression(node)
	) {
		issues.push(issueAt(sourceFile, node, "control construct is unavailable in Code Mode"));
		return;
	}
	if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
		issues.push(issueAt(sourceFile, node, "dynamic module loading is unavailable in Code Mode"));
		return;
	}
	if (ts.isStringLiteral(node) && node.text.startsWith("js/")) {
		issues.push(issueAt(sourceFile, node, "Blok expression evaluation is unavailable in Code Mode"));
		return;
	}

	ts.forEachChild(node, (child) => validateNode(sourceFile, child, issues, state));
}

/** Validate and transpile the erasable TypeScript/function-body subset. */
export function validateCodeModeSource(
	source: string,
	options: CodeModeValidationOptions = {},
): CodeModeValidationResult {
	if (typeof source !== "string") {
		return { valid: false, sourceBytes: 0, issues: [{ message: "source must be a string", line: 1, column: 1 }] };
	}
	const bytes = sourceBytes(source);
	const maxBytes = options.maxSourceBytes ?? CODE_MODE_MAX_SOURCE_BYTES;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		return { valid: false, sourceBytes: bytes, issues: [{ message: "maxSourceBytes is invalid", line: 1, column: 1 }] };
	}
	if (bytes > maxBytes) {
		return {
			valid: false,
			sourceBytes: bytes,
			issues: [{ message: "source exceeds the Code Mode source bound", line: 1, column: 1 }],
		};
	}
	const sourceFile = ts.createSourceFile(SOURCE_PREFIX, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const transpiled = ts.transpileModule(source, {
		fileName: SOURCE_PREFIX,
		reportDiagnostics: true,
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.None,
			removeComments: true,
			noEmitHelpers: true,
			useDefineForClassFields: true,
		},
	});
	const issues = diagnosticsFor(sourceFile, transpiled.diagnostics ?? []);
	validateNode(sourceFile, sourceFile, issues, { count: 0 });
	if (issues.length > 0) return { valid: false, sourceBytes: bytes, issues: issues.slice(0, MAX_VALIDATION_ISSUES) };
	return { valid: true, sourceBytes: bytes, issues: [], transpiledSource: transpiled.outputText };
}
