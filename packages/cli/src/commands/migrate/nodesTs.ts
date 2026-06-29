import { promises as fsp } from "node:fs";
import path from "node:path";
import type { OptionValues } from "commander";
import color from "picocolors";
import ts from "typescript";
import { nameToIdentifier } from "../gen/appTypes.js";

const MARKER = "blok-migrate: hand-migrate (node resolution)";

type ImportKind = "default" | "named";

interface ImportRef {
	kind: ImportKind;
	importName: string;
	importPath: string;
	originFile: string;
}

interface RuntimeRef {
	exportName: string;
	importPath: string;
	runtime: string;
}

interface Resolver {
	modules: Map<string, ImportRef>;
	runtimes: Map<string, RuntimeRef>;
}

interface MigrationStats {
	migrated: number;
	marked: number;
}

interface TextReplacement {
	start: number;
	end: number;
	text: string;
}

type Resolved =
	| { kind: "module"; ref: ImportRef }
	| { kind: "runtime"; ref: RuntimeRef }
	| { kind: "mark"; reason: "ambiguous" | "unresolved" };

const HELPER_EXPORTS: Record<string, string> = {
	"@blokjs/audit-log": "AuditLogNode",
	"@blokjs/ctx-publish": "CtxPublishNode",
	"@blokjs/ctx-publish-many": "CtxPublishManyNode",
	"@blokjs/expr": "ExprNode",
	"@blokjs/hmac-verify": "HmacVerifyNode",
	"@blokjs/in-memory-kv": "InMemoryKvNode",
	"@blokjs/json-schema": "JsonSchemaNode",
	"@blokjs/jwt-verify": "JwtVerifyNode",
	"@blokjs/llm-agent": "LlmAgentNode",
	"@blokjs/llm-stream": "LlmStreamNode",
	"@blokjs/log": "LogNode",
	"@blokjs/metrics-emit": "MetricsEmitNode",
	"@blokjs/pubsub-publish": "PubsubPublishNode",
	"@blokjs/redis-kv": "RedisKvNode",
	"@blokjs/respond": "RespondNode",
	"@blokjs/sse-emit": "SseEmitNode",
	"@blokjs/sse-publish": "SsePublishNode",
	"@blokjs/sse-stream": "SseStreamNode",
	"@blokjs/sse-subscribe": "SseSubscribeNode",
	"@blokjs/throw": "ThrowNode",
	"@blokjs/worker-publish": "WorkerPublishNode",
	"@blokjs/ws-broadcast": "WsBroadcastNode",
	"@blokjs/ws-close": "WsCloseNode",
	"@blokjs/ws-reply": "WsReplyNode",
};

export async function migrateNodesTs(opts: OptionValues): Promise<void> {
	const cwd = process.cwd();
	const workflowsDir = path.resolve(cwd, (opts.dir as string | undefined) ?? "src/workflows");
	const nodesFile = path.resolve(cwd, (opts.nodes as string | undefined) ?? "src/Nodes.ts");
	const stubsDir = path.resolve(cwd, (opts.stubs as string | undefined) ?? "nodes-gen");
	const dryRun = opts.dryRun === true;
	const writeBackup = opts.backup !== false;
	const deleteNodes = opts.deleteNodes === true;

	console.log(color.cyan("\n🔄 Nodes.ts removal codemod"));
	console.log(color.dim("Rewrites handle-DSL step() string node refs to direct imports/runtime stubs.\n"));

	const nodesSource = await readOptional(nodesFile);
	if (!nodesSource) {
		console.log(
			color.yellow(`No Nodes.ts found at ${path.relative(cwd, nodesFile)} — module refs will be unresolved.`),
		);
	}

	const resolver = {
		modules: nodesSource ? await parseNodesMap(nodesSource, nodesFile) : new Map<string, ImportRef>(),
		runtimes: await parseRuntimeStubs(stubsDir),
	};
	const files = (await collectFiles(workflowsDir)).filter((file) => file.endsWith(".ts"));
	const totals = { changed: 0, migrated: 0, marked: 0 };

	for (const file of files) {
		const raw = await fsp.readFile(file, "utf8");
		const result = migrateNodesTsSource(raw, file, resolver);
		totals.migrated += result.stats.migrated;
		totals.marked += result.stats.marked;
		if (result.changed) {
			totals.changed += 1;
			if (!dryRun) {
				if (writeBackup) await fsp.writeFile(`${file}.bak`, raw);
				await fsp.writeFile(file, result.value);
			}
		}
		printFileResult(file, result.changed, result.stats);
	}

	const remaining = await countStringNodeRefs(workflowsDir);
	if (deleteNodes && remaining === 0 && nodesSource && !dryRun) {
		await fsp.rm(nodesFile);
		console.log(color.green(`Deleted ${path.relative(cwd, nodesFile)} (no string workflow refs remain).`));
	} else if (deleteNodes && remaining > 0) {
		console.log(color.yellow(`Keeping Nodes.ts: ${remaining} string workflow node ref(s) still remain.`));
	}

	console.log(
		`\nTotal: ${files.length} · ${color.green(`${dryRun ? "would change" : "changed"}: ${totals.changed}`)} · migrated: ${totals.migrated} · marked: ${totals.marked}`,
	);
	if (dryRun) console.log(color.dim("Dry run — no files written."));
}

export function migrateNodesTsSource(
	source: string,
	file: string,
	resolver: Resolver,
): { value: string; changed: boolean; stats: MigrationStats } {
	const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const replacements: TextReplacement[] = [];
	const markerPositions = new Set<number>();
	const imports = new ImportPlanner(source, file);
	const stats = { migrated: 0, marked: 0 };

	function visit(node: ts.Node): void {
		if (ts.isCallExpression(node) && isStepCall(node)) {
			const useArg = node.arguments[1];
			if (useArg && ts.isStringLiteralLike(useArg)) {
				const use = useArg.text;
				const type = stepType(node);
				const resolved = resolveNode(use, type, resolver);
				if (resolved.kind === "mark") {
					if (!alreadyMarked(source, node.getStart())) {
						markerPositions.add(statementStart(source, node));
						stats.marked += 1;
					}
				} else {
					const ident = imports.add(resolved);
					replacements.push({ start: useArg.getStart(), end: useArg.getEnd(), text: ident });
					stats.migrated += 1;
				}
			}
		}
		ts.forEachChild(node, visit);
	}

	visit(sf);

	let value = applyReplacements(source, [
		...replacements,
		...[...markerPositions].map((pos) => ({ start: pos, end: pos, text: markerFor(source, pos) })),
	]);
	value = imports.render(value);
	return { value, changed: value !== source, stats };
}

export async function parseNodesMap(source: string, nodesFile: string): Promise<Map<string, ImportRef>> {
	const sf = ts.createSourceFile(nodesFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const imports = importBindings(sf, nodesFile);
	const objects = objectVariables(sf);
	const out = new Map<string, ImportRef>();
	const seenObjects = new Set<string>();

	async function addObject(name: string): Promise<void> {
		if (seenObjects.has(name)) return;
		seenObjects.add(name);
		const obj = objects.get(name);
		if (!obj) return;
		for (const prop of obj.properties) {
			if (ts.isPropertyAssignment(prop)) {
				const key = propertyName(prop.name);
				if (!key || !ts.isIdentifier(prop.initializer)) continue;
				const ref = imports.get(prop.initializer.text);
				if (ref) out.set(key, ref);
			} else if (ts.isSpreadAssignment(prop) && ts.isIdentifier(prop.expression)) {
				const spread = prop.expression.text;
				const spreadImport = imports.get(spread);
				if (spreadImport?.importPath === "@blokjs/helpers") {
					for (const [key, importName] of Object.entries(HELPER_EXPORTS)) {
						out.set(key, { kind: "named", importName, importPath: "@blokjs/helpers", originFile: nodesFile });
					}
				} else if (spreadImport?.importPath.startsWith(".")) {
					for (const [key, ref] of await parseDefaultObjectBarrel(spreadImport)) out.set(key, ref);
				} else {
					await addObject(spread);
				}
			}
		}
	}

	for (const name of objects.keys()) await addObject(name);
	return out;
}

export async function parseRuntimeStubs(stubsDir: string): Promise<Map<string, RuntimeRef>> {
	const files = await collectFiles(stubsDir);
	const out = new Map<string, RuntimeRef>();
	for (const file of files.filter((f) => f.endsWith(".ts"))) {
		const runtime = path.basename(file, ".ts");
		const source = await fsp.readFile(file, "utf8");
		const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		for (const stmt of sf.statements) {
			if (!ts.isVariableStatement(stmt)) continue;
			if (!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
			for (const decl of stmt.declarationList.declarations) {
				if (!ts.isIdentifier(decl.name) || !decl.initializer || !ts.isCallExpression(decl.initializer)) continue;
				if (expressionText(decl.initializer.expression) !== "runtimeNode") continue;
				const nameArg = decl.initializer.arguments[0];
				if (!nameArg || !ts.isStringLiteralLike(nameArg)) continue;
				out.set(`${runtime}|${nameArg.text}`, {
					exportName: decl.name.text,
					importPath: file,
					runtime,
				});
			}
		}
	}
	return out;
}

export async function countStringNodeRefs(root: string): Promise<number> {
	let count = 0;
	for (const file of await collectFiles(root)) {
		if (file.endsWith(".json")) {
			count += countJsonStringRefs(JSON.parse(await fsp.readFile(file, "utf8")));
		} else if (file.endsWith(".ts")) {
			count += countTsStringRefs(await fsp.readFile(file, "utf8"), file);
		}
	}
	return count;
}

function resolveNode(use: string, type: string | undefined, resolver: Resolver): Resolved {
	if (type?.startsWith("runtime.")) {
		const ref = resolver.runtimes.get(`${type}|${use}`);
		return ref ? { kind: "runtime", ref } : { kind: "mark", reason: "unresolved" };
	}

	const module = resolver.modules.get(use);
	const runtimeMatches = [...resolver.runtimes.keys()].filter((key) => key.endsWith(`|${use}`));
	if (module && runtimeMatches.length === 0) return { kind: "module", ref: module };
	return { kind: "mark", reason: module || runtimeMatches.length > 0 ? "ambiguous" : "unresolved" };
}

class ImportPlanner {
	private readonly used = new Set<string>();
	private readonly imports: { path: string; default?: string; named: Map<string, string> }[] = [];
	private readonly planned = new Map<string, string>();

	constructor(
		source: string,
		private readonly file: string,
	) {
		const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		for (const stmt of sf.statements) {
			if (ts.isImportDeclaration(stmt) && stmt.importClause) {
				const clause = stmt.importClause;
				if (clause.name) this.used.add(clause.name.text);
				if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
					for (const el of clause.namedBindings.elements) this.used.add(el.name.text);
				}
			}
		}
	}

	add(resolved: Exclude<Resolved, { kind: "mark" }>): string {
		const importPath =
			resolved.kind === "runtime"
				? relativeImport(this.file, resolved.ref.importPath)
				: importPathFor(this.file, resolved.ref);
		const exportName = resolved.kind === "runtime" ? resolved.ref.exportName : resolved.ref.importName;
		const key = `${resolved.kind}:${importPath}:${exportName}`;
		const planned = this.planned.get(key);
		if (planned) return planned;
		const ident =
			this.used.has(exportName) || this.imports.some((i) => i.path !== importPath && i.named.has(exportName))
				? uniqueIdentifier(`${exportName}${runtimeSuffix(resolved)}`, this.used)
				: uniqueIdentifier(exportName, this.used);

		let entry = this.imports.find((i) => i.path === importPath);
		if (!entry) {
			entry = { path: importPath, named: new Map() };
			this.imports.push(entry);
		}
		if (resolved.kind === "module" && resolved.ref.kind === "default") entry.default = ident;
		else entry.named.set(exportName, ident);
		this.planned.set(key, ident);
		return ident;
	}

	render(source: string): string {
		if (this.imports.length === 0) return source;
		const importLines = this.imports
			.sort((a, b) => a.path.localeCompare(b.path))
			.map((entry) => {
				const named = [...entry.named]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([exportName, local]) => (exportName === local ? exportName : `${exportName} as ${local}`));
				if (entry.default && named.length > 0)
					return `import ${entry.default}, { ${named.join(", ")} } from "${entry.path}";`;
				if (entry.default) return `import ${entry.default} from "${entry.path}";`;
				return `import { ${named.join(", ")} } from "${entry.path}";`;
			});
		const insertAt = lastImportEnd(source);
		return `${source.slice(0, insertAt)}${insertAt === 0 ? "" : "\n"}${importLines.join("\n")}\n${source.slice(insertAt)}`;
	}
}

function importBindings(sf: ts.SourceFile, originFile: string): Map<string, ImportRef> {
	const out = new Map<string, ImportRef>();
	for (const stmt of sf.statements) {
		if (!ts.isImportDeclaration(stmt) || !stmt.importClause || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
		const importPath = stmt.moduleSpecifier.text;
		const clause = stmt.importClause;
		if (clause.name)
			out.set(clause.name.text, { kind: "default", importName: clause.name.text, importPath, originFile });
		if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
			for (const el of clause.namedBindings.elements) {
				out.set(el.name.text, {
					kind: "named",
					importName: (el.propertyName ?? el.name).text,
					importPath,
					originFile,
				});
			}
		}
	}
	return out;
}

function objectVariables(sf: ts.SourceFile): Map<string, ts.ObjectLiteralExpression> {
	const out = new Map<string, ts.ObjectLiteralExpression>();
	for (const stmt of sf.statements) {
		if (!ts.isVariableStatement(stmt)) continue;
		for (const decl of stmt.declarationList.declarations) {
			if (ts.isIdentifier(decl.name) && decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) {
				out.set(decl.name.text, decl.initializer);
			}
		}
	}
	return out;
}

async function parseDefaultObjectBarrel(spreadImport: ImportRef): Promise<Map<string, ImportRef>> {
	const file = resolveImportFile(spreadImport.originFile, spreadImport.importPath);
	const source = await readOptional(file);
	if (!source) return new Map();
	const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const imports = importBindings(sf, file);
	const objects = objectVariables(sf);
	const defaultName = sf.statements.find(ts.isExportAssignment);
	const obj =
		defaultName && ts.isIdentifier(defaultName.expression) ? objects.get(defaultName.expression.text) : undefined;
	const out = new Map<string, ImportRef>();
	if (!obj) return out;
	for (const prop of obj.properties) {
		if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.initializer)) continue;
		const key = propertyName(prop.name);
		const ref = imports.get(prop.initializer.text);
		if (key && ref) out.set(key, ref);
	}
	return out;
}

function isStepCall(node: ts.CallExpression): boolean {
	return expressionText(node.expression) === "step" && node.arguments.length >= 2;
}

function stepType(node: ts.CallExpression): string | undefined {
	const opts = node.arguments[3];
	if (!opts || !ts.isObjectLiteralExpression(opts)) return undefined;
	const prop = opts.properties.find(
		(p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && propertyName(p.name) === "type",
	);
	return prop && ts.isStringLiteralLike(prop.initializer) ? prop.initializer.text : undefined;
}

function countTsStringRefs(source: string, file: string): number {
	const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	let count = 0;
	function visit(node: ts.Node): void {
		if (ts.isCallExpression(node) && isStepCall(node) && ts.isStringLiteralLike(node.arguments[1])) count += 1;
		if (
			ts.isPropertyAssignment(node) &&
			propertyName(node.name) === "use" &&
			ts.isStringLiteralLike(node.initializer)
		) {
			count += 1;
		}
		ts.forEachChild(node, visit);
	}
	visit(sf);
	return count;
}

function countJsonStringRefs(value: unknown): number {
	if (Array.isArray(value)) return value.reduce((sum, item) => sum + countJsonStringRefs(item), 0);
	if (!isPlainObject(value)) return 0;
	let count = typeof value.use === "string" || typeof value.node === "string" ? 1 : 0;
	for (const child of Object.values(value)) count += countJsonStringRefs(child);
	return count;
}

function applyReplacements(source: string, replacements: TextReplacement[]): string {
	return [...replacements]
		.sort((a, b) => b.start - a.start)
		.reduce((text, r) => `${text.slice(0, r.start)}${r.text}${text.slice(r.end)}`, source);
}

function statementStart(source: string, node: ts.Node): number {
	let current = node;
	while (current.parent && !ts.isExpressionStatement(current)) current = current.parent;
	const start = current.getStart();
	return source.lastIndexOf("\n", start - 1) + 1;
}

function alreadyMarked(source: string, pos: number): boolean {
	const lineStart = source.lastIndexOf("\n", pos - 1) + 1;
	return source.slice(Math.max(0, lineStart - 200), pos).includes(MARKER);
}

function markerFor(source: string, pos: number): string {
	const lineEnd = source.indexOf("\n", pos);
	const line = source.slice(pos, lineEnd === -1 ? undefined : lineEnd);
	const indent = line.match(/^\s*/)?.[0] ?? "";
	return `${indent}// ${MARKER}\n`;
}

function expressionText(expr: ts.Expression): string | undefined {
	return ts.isIdentifier(expr) ? expr.text : undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
	return undefined;
}

function importPathFor(workflowFile: string, ref: ImportRef): string {
	return ref.importPath.startsWith(".")
		? relativeImport(workflowFile, resolveImportFile(ref.originFile, ref.importPath))
		: ref.importPath;
}

function resolveImportFile(fromFile: string, spec: string): string {
	if (!spec.startsWith(".")) return spec;
	const base = path.resolve(path.dirname(fromFile), spec);
	return path.extname(base) ? base : `${base}.ts`;
}

function relativeImport(fromFile: string, targetFile: string): string {
	let rel = path.relative(path.dirname(fromFile), targetFile).replace(/\\/g, "/").replace(/\.ts$/, "");
	if (!rel.startsWith(".")) rel = `./${rel}`;
	return rel;
}

function runtimeSuffix(resolved: Exclude<Resolved, { kind: "mark" }>): string {
	if (resolved.kind !== "runtime") return "";
	return pascal(resolved.ref.runtime.replace(/^runtime\./, ""));
}

function uniqueIdentifier(base: string, used: Set<string>): string {
	let ident = /^[A-Za-z_$]/.test(base) ? base : `node_${base}`;
	ident = ident.replace(/[^A-Za-z0-9_$]/g, "_");
	let next = ident;
	let i = 2;
	while (used.has(next)) next = `${ident}${i++}`;
	used.add(next);
	return next;
}

function pascal(value: string): string {
	return nameToIdentifier(value).replace(/^./, (s) => s.toUpperCase());
}

function lastImportEnd(source: string): number {
	const sf = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	let end = 0;
	for (const stmt of sf.statements) {
		if (ts.isImportDeclaration(stmt)) end = stmt.getEnd();
	}
	return end;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readOptional(file: string): Promise<string | null> {
	try {
		return await fsp.readFile(file, "utf8");
	} catch {
		return null;
	}
}

async function collectFiles(root: string): Promise<string[]> {
	const out: string[] = [];
	await walk(root, out);
	out.sort();
	return out;
}

async function walk(dir: string, out: string[]): Promise<void> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fsp.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) await walk(full, out);
		else if (entry.isFile() && /\.(json|ts)$/.test(entry.name)) out.push(full);
	}
}

function printFileResult(file: string, changed: boolean, stats: MigrationStats): void {
	const rel = path.relative(process.cwd(), file);
	const icon = changed ? color.green("✓") : color.dim("⊙");
	const note = changed ? `migrated: ${stats.migrated}, marked: ${stats.marked}` : "unchanged";
	console.log(`  ${icon} ${color.cyan(rel)} ${color.dim(note)}`);
}
