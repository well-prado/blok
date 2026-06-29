import { promises as fsp } from "node:fs";
import path from "node:path";
import type { OptionValues } from "commander";
import color from "picocolors";
import ts from "typescript";

const MARKER = "blok-migrate: hand-migrate (dynamic expression / branch.when not handle-safe)";

type PathSegment = string | number;

interface StructuralRef {
	$ref: {
		step: string;
		path: PathSegment[];
	};
}

interface StructuralTpl {
	$tpl: unknown[];
}

interface StepInfo {
	id: string;
	stateKey: string;
	ephemeral: boolean;
	spread: boolean;
	use?: string;
}

interface StepContext {
	previous?: StepInfo;
	stepsByStateKey: Map<string, StepInfo>;
}

interface MigrationStats {
	migrated: number;
	marked: number;
}

export interface RefMigrationResult<T> {
	value: T;
	changed: boolean;
	stats: MigrationStats;
}

type ParsedRef = { kind: "ref"; ref: StructuralRef } | { kind: "tpl"; tpl: StructuralTpl } | { kind: "dynamic" };
type HelperName = "$" | "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
type BranchWhenMigration =
	| { kind: "convert"; rawWhen: string; tsExpr: string; helpers: HelperName[] }
	| { kind: "mark" }
	| { kind: "none" };

/** CLI entrypoint for Codemod 1: field-aware input refs only. */
export async function migrateRefs(opts: OptionValues): Promise<void> {
	const cwd = process.cwd();
	const root = path.resolve(cwd, (opts.dir as string | undefined) ?? ".");
	const dryRun = opts.dryRun === true;
	const writeBackup = opts.backup !== false;

	console.log(color.cyan("\n🔄 Field-aware ref codemod"));
	console.log(color.dim("Rewrites pure step input refs to structural handles; marks dynamic expressions.\n"));

	const files = await collectWorkflowFiles(root);
	if (files.length === 0) {
		console.log(color.yellow("No TS or JSON workflow files found."));
		return;
	}

	const totals = { changed: 0, migrated: 0, marked: 0, errors: 0 };
	for (const file of files) {
		try {
			const raw = await fsp.readFile(file, "utf8");
			const result = file.endsWith(".json") ? migrateJsonText(raw) : migrateTsSource(raw, path.basename(file));
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
		} catch (err) {
			totals.errors += 1;
			console.log(`  ${color.red("✗")} ${color.cyan(path.relative(cwd, file))} ${color.red((err as Error).message)}`);
		}
	}

	console.log(
		`\nTotal: ${files.length} · ${color.green(`${dryRun ? "would change" : "changed"}: ${totals.changed}`)} · migrated refs: ${totals.migrated} · marked: ${totals.marked}`,
	);
	if (dryRun) console.log(color.dim("Dry run — no files written."));
	if (totals.errors > 0) process.exit(1);
}

export function migrateJsonText(raw: string): RefMigrationResult<string> {
	const parsed = JSON.parse(raw) as unknown;
	const result = migrateJsonWorkflow(parsed);
	return {
		value: `${JSON.stringify(result.value, null, "\t")}\n`,
		changed: result.changed,
		stats: result.stats,
	};
}

export function migrateJsonWorkflow<T>(workflow: T): RefMigrationResult<T> {
	const stats = emptyStats();
	const value = cloneJson(workflow);
	if (isPlainObject(value) && Array.isArray(value.steps)) {
		migrateJsonStepArray(value.steps, stats);
	}
	return { value, changed: stats.migrated + stats.marked > 0, stats };
}

export function migrateTsSource(source: string, fileName = "workflow.ts"): RefMigrationResult<string> {
	const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const replacements: TextReplacement[] = [];
	const markerPositions = new Set<number>();
	const helperImports = new Set<HelperName>();
	const stats = emptyStats();

	function visit(node: ts.Node): void {
		if (ts.isArrayLiteralExpression(node) && isStepArray(node)) {
			migrateTsStepArray(node, source, replacements, markerPositions, helperImports, stats);
		}
		ts.forEachChild(node, visit);
	}

	visit(sf);

	const withMarkers = [...markerPositions]
		.sort((a, b) => b - a)
		.reduce((text, pos) => `${text.slice(0, pos)}${markerFor(source, pos)}${text.slice(pos)}`, source);
	const adjusted = replacements.map((r) => ({
		...r,
		start: r.start + insertedBefore(markerPositions, r.start, source),
		end: r.end + insertedBefore(markerPositions, r.end, source),
	}));
	const rewritten = applyReplacements(withMarkers, adjusted);
	const value = helperImports.size > 0 ? ensureHelperImports(rewritten, helperImports) : rewritten;
	return { value, changed: value !== source, stats };
}

function migrateJsonStepArray(rawSteps: unknown[], stats: MigrationStats): void {
	const steps = rawSteps.filter(isPlainObject);
	const infos = steps.map(readJsonStepInfo);
	const byStateKey = new Map(infos.filter(isStepInfo).map((info) => [info.stateKey, info]));

	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		const info = infos[i];
		const previous = previousConcreteInfo(infos, i);
		const ctx = { previous, stepsByStateKey: byStateKey };
		let marked = false;
		const alreadyMarkedStep = jsonStepMarked(step);

		if (isPlainObject(step.inputs)) {
			marked ||= migrateJsonInputs(step.inputs, info?.use, ctx, stats, !alreadyMarkedStep);
		}
		if (isPlainObject(step.branch)) {
			marked ||= migrateJsonBranchWhen(step.branch, stats, !alreadyMarkedStep);
		}
		if (marked) markJsonStep(step);
		recurseJsonControlFlow(step, stats);
	}
}

function migrateJsonInputs(
	value: unknown,
	use: string | undefined,
	ctx: StepContext,
	stats: MigrationStats,
	canMark: boolean,
): boolean {
	if (isStructuralSentinel(value)) return false;
	let marked = false;
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const result = migrateJsonValue(value[i], undefined, use, ctx, stats, canMark);
			value[i] = result.value;
			marked ||= result.marked;
		}
		return marked;
	}
	if (!isPlainObject(value)) return false;
	for (const [key, child] of Object.entries(value)) {
		const result = migrateJsonValue(child, key, use, ctx, stats, canMark);
		value[key] = result.value;
		marked ||= result.marked;
	}
	return marked;
}

function migrateJsonValue(
	value: unknown,
	key: string | undefined,
	use: string | undefined,
	ctx: StepContext,
	stats: MigrationStats,
	canMark: boolean,
): { value: unknown; marked: boolean } {
	if (use === "@blokjs/expr" && key === "expression") return { value, marked: false };
	if (typeof value === "string") {
		const parsed = parseRefValue(value, ctx);
		if (parsed?.kind === "ref") {
			stats.migrated += 1;
			return { value: parsed.ref, marked: false };
		}
		if (parsed?.kind === "tpl") {
			stats.migrated += 1;
			return { value: parsed.tpl, marked: false };
		}
		if (parsed?.kind === "dynamic") {
			if (!canMark) return { value, marked: false };
			stats.marked += 1;
			return { value, marked: true };
		}
		return { value, marked: false };
	}
	if (Array.isArray(value) || isPlainObject(value)) {
		const marked = migrateJsonInputs(value, use, ctx, stats, canMark);
		return { value, marked };
	}
	return { value, marked: false };
}

function recurseJsonControlFlow(step: Record<string, unknown>, stats: MigrationStats): void {
	if (isPlainObject(step.branch)) {
		if (Array.isArray(step.branch.then)) migrateJsonStepArray(step.branch.then, stats);
		if (Array.isArray(step.branch.else)) migrateJsonStepArray(step.branch.else, stats);
	}
	if (isPlainObject(step.forEach) && Array.isArray(step.forEach.do)) migrateJsonStepArray(step.forEach.do, stats);
	if (isPlainObject(step.loop) && Array.isArray(step.loop.do)) migrateJsonStepArray(step.loop.do, stats);
	if (isPlainObject(step.tryCatch)) {
		if (Array.isArray(step.tryCatch.try)) migrateJsonStepArray(step.tryCatch.try, stats);
		if (Array.isArray(step.tryCatch.catch)) migrateJsonStepArray(step.tryCatch.catch, stats);
		if (Array.isArray(step.tryCatch.finally)) migrateJsonStepArray(step.tryCatch.finally, stats);
	}
	if (isPlainObject(step.switch) && Array.isArray(step.switch.cases)) {
		for (const c of step.switch.cases) {
			if (!isPlainObject(c)) continue;
			if (Array.isArray(c.steps)) migrateJsonStepArray(c.steps, stats);
			if (Array.isArray(c.do)) migrateJsonStepArray(c.do, stats);
		}
	}
	if (isPlainObject(step.switch) && Array.isArray(step.switch.default))
		migrateJsonStepArray(step.switch.default, stats);
}

function migrateJsonBranchWhen(branch: Record<string, unknown>, stats: MigrationStats, canMark: boolean): boolean {
	if (typeof branch.when !== "string") return false;
	const result = analyzeBranchWhen(branch.when);
	if (result.kind === "convert") {
		if (branch.when !== result.rawWhen) {
			branch.when = result.rawWhen;
			stats.migrated += 1;
		}
		return false;
	}
	if (result.kind !== "mark" || !canMark) return false;
	stats.marked += 1;
	return true;
}

function migrateTsStepArray(
	array: ts.ArrayLiteralExpression,
	source: string,
	replacements: TextReplacement[],
	markerPositions: Set<number>,
	helperImports: Set<HelperName>,
	stats: MigrationStats,
): void {
	const elements = array.elements.filter(ts.isObjectLiteralExpression);
	const infos = elements.map(readTsStepInfo);
	const byStateKey = new Map(infos.filter(isStepInfo).map((info) => [info.stateKey, info]));

	for (let i = 0; i < elements.length; i++) {
		const step = elements[i];
		const info = infos[i];
		const previous = previousConcreteInfo(infos, i);
		const ctx = { previous, stepsByStateKey: byStateKey };
		const beforeMarked = stats.marked;
		const alreadyMarkedStep = alreadyMarked(source, step.getStart());
		migrateTsBranchWhen(step, source, replacements, helperImports, stats, !alreadyMarkedStep);
		const inputs = getProperty(step, "inputs");
		if (inputs && ts.isObjectLiteralExpression(inputs.initializer)) {
			migrateTsInputs(inputs.initializer, info?.use, ctx, source, replacements, stats, !alreadyMarkedStep);
		}
		if (stats.marked > beforeMarked && !alreadyMarkedStep) markerPositions.add(step.getStart());
	}
}

function migrateTsBranchWhen(
	step: ts.ObjectLiteralExpression,
	source: string,
	replacements: TextReplacement[],
	helperImports: Set<HelperName>,
	stats: MigrationStats,
	canMark: boolean,
): void {
	const branch = getProperty(step, "branch");
	if (!branch || !ts.isObjectLiteralExpression(branch.initializer)) return;
	const when = getProperty(branch.initializer, "when");
	if (!when) return;
	const init = when.initializer;
	if (isDollarPath(init)) return;
	if (ts.isCallExpression(init) || !ts.isStringLiteralLike(init)) return;
	const result = analyzeBranchWhen(init.text);
	if (result.kind === "convert") {
		replacements.push({ start: init.getStart(), end: init.getEnd(), text: result.tsExpr });
		for (const helper of result.helpers) helperImports.add(helper);
		stats.migrated += 1;
	} else if (result.kind === "mark" && canMark) {
		stats.marked += 1;
	}
}

function migrateTsInputs(
	obj: ts.ObjectLiteralExpression,
	use: string | undefined,
	ctx: StepContext,
	source: string,
	replacements: TextReplacement[],
	stats: MigrationStats,
	canMark: boolean,
): void {
	for (const prop of obj.properties) {
		if (!ts.isPropertyAssignment(prop)) continue;
		const key = propertyNameText(prop.name);
		if (use === "@blokjs/expr" && key === "expression") continue;
		migrateTsExpression(prop.initializer, use, ctx, source, replacements, stats, canMark);
	}
}

function migrateTsExpression(
	node: ts.Expression,
	use: string | undefined,
	ctx: StepContext,
	source: string,
	replacements: TextReplacement[],
	stats: MigrationStats,
	canMark: boolean,
): void {
	if (ts.isObjectLiteralExpression(node)) {
		if (isTsStructuralSentinel(node)) return;
		migrateTsInputs(node, use, ctx, source, replacements, stats, canMark);
		return;
	}
	if (ts.isArrayLiteralExpression(node)) {
		for (const item of node.elements) migrateTsExpression(item, use, ctx, source, replacements, stats, canMark);
		return;
	}
	const raw = tsExpressionValue(node, source);
	if (!raw) return;
	const parsed = parseRefValue(raw, ctx);
	if (parsed?.kind === "ref") {
		replacements.push({ start: node.getStart(), end: node.getEnd(), text: refToTs(parsed.ref) });
		stats.migrated += 1;
	} else if (parsed?.kind === "tpl") {
		replacements.push({ start: node.getStart(), end: node.getEnd(), text: tplToTs(parsed.tpl) });
		stats.migrated += 1;
	} else if (parsed?.kind === "dynamic") {
		if (!canMark) return;
		stats.marked += 1;
	}
}

function parseRefValue(value: string, ctx: StepContext): ParsedRef | null {
	if (value.startsWith("js/")) {
		const expr = value.slice(3);
		const tpl = parseTemplate(expr, ctx);
		if (tpl) return tpl;
		const ref = parsePurePath(expr, ctx);
		if (ref) return { kind: "ref", ref };
		return referencesRuntimeExpression(expr) ? { kind: "dynamic" } : null;
	}
	if (value.startsWith("$.")) {
		const ref = parsePurePath(value, ctx);
		return ref ? { kind: "ref", ref } : { kind: "dynamic" };
	}
	return null;
}

function analyzeBranchWhen(value: string): BranchWhenMigration {
	const expr = value.trim();
	if (expr.length === 0) return { kind: "none" };
	if (expr.startsWith("$.") || expr.startsWith("js/")) return { kind: "mark" };

	const parsed = parseExpression(expr);
	if (!parsed) return referencesRuntimeExpression(expr) ? { kind: "mark" } : { kind: "none" };

	const path = expressionToBranchPath(parsed);
	if (path) return { kind: "convert", rawWhen: path.raw, tsExpr: path.proxy, helpers: ["$"] };

	if (!ts.isBinaryExpression(parsed)) return referencesRuntimeExpression(expr) ? { kind: "mark" } : { kind: "none" };
	const op = binaryOperator(parsed.operatorToken.kind);
	if (!op) return { kind: "mark" };

	const leftPath = expressionToBranchPath(parsed.left);
	const rightPath = expressionToBranchPath(parsed.right);
	if (!leftPath || rightPath) return { kind: "mark" };

	const literal = literalExpression(parsed.right);
	if (!literal) return { kind: "mark" };

	if (op === "===" && literal.raw === "true") {
		return { kind: "convert", rawWhen: leftPath.raw, tsExpr: leftPath.proxy, helpers: ["$"] };
	}

	const helper = helperForOperator(op);
	return {
		kind: "convert",
		rawWhen: `${leftPath.raw} ${op} ${literal.raw}`,
		tsExpr: `${helper}(${leftPath.proxy}, ${literal.ts})`,
		helpers: ["$", helper],
	};
}

function binaryOperator(kind: ts.SyntaxKind): "===" | "!==" | ">" | ">=" | "<" | "<=" | null {
	switch (kind) {
		case ts.SyntaxKind.EqualsEqualsEqualsToken:
			return "===";
		case ts.SyntaxKind.ExclamationEqualsEqualsToken:
			return "!==";
		case ts.SyntaxKind.GreaterThanToken:
			return ">";
		case ts.SyntaxKind.GreaterThanEqualsToken:
			return ">=";
		case ts.SyntaxKind.LessThanToken:
			return "<";
		case ts.SyntaxKind.LessThanEqualsToken:
			return "<=";
		default:
			return null;
	}
}

function helperForOperator(op: "===" | "!==" | ">" | ">=" | "<" | "<="): Exclude<HelperName, "$"> {
	switch (op) {
		case "===":
			return "eq";
		case "!==":
			return "ne";
		case ">":
			return "gt";
		case ">=":
			return "gte";
		case "<":
			return "lt";
		case "<=":
			return "lte";
	}
}

function literalExpression(expr: ts.Expression): { raw: string; ts: string } | null {
	if (
		ts.isStringLiteralLike(expr) ||
		ts.isNumericLiteral(expr) ||
		expr.kind === ts.SyntaxKind.TrueKeyword ||
		expr.kind === ts.SyntaxKind.FalseKeyword ||
		expr.kind === ts.SyntaxKind.NullKeyword ||
		(ts.isIdentifier(expr) && expr.text === "undefined")
	) {
		const raw = expr.getText();
		return { raw, ts: raw };
	}
	return null;
}

function expressionToBranchPath(expr: ts.Expression): { raw: string; proxy: string } | null {
	const path = expressionPath(expr);
	if (!path) return null;
	const [root, ...rest] = path;
	if (root !== "ctx") return null;
	const [field, ...tail] = rest;
	if (field === "request" || field === "req") return branchPath("ctx.request", "$.request", tail);
	if (field === "state" || field === "vars") return branchPath("ctx.state", "$.state", tail);
	if (field === "response" || field === "prev") return branchPath("ctx.response", "$.prev", tail);
	return null;
}

function branchPath(rawRoot: string, proxyRoot: string, tail: PathSegment[]): { raw: string; proxy: string } {
	const suffix = tail.map(accessSegment).join("");
	return { raw: `${rawRoot}${suffix}`, proxy: `${proxyRoot}${suffix}` };
}

function accessSegment(seg: PathSegment): string {
	if (typeof seg === "number") return `[${seg}]`;
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seg) ? `.${seg}` : `[${JSON.stringify(seg)}]`;
}

function parseTemplate(expr: string, ctx: StepContext): ParsedRef | null {
	const wrapped = parseExpression(expr);
	if (!wrapped) return null;
	if (ts.isNoSubstitutionTemplateLiteral(wrapped)) return null;
	if (!ts.isTemplateExpression(wrapped)) return null;
	const segments: unknown[] = [wrapped.head.text];
	for (const span of wrapped.templateSpans) {
		const ref = expressionToRef(span.expression, ctx);
		if (!ref) return { kind: "dynamic" };
		segments.push(ref, span.literal.text);
	}
	return { kind: "tpl", tpl: { $tpl: segments } };
}

function parsePurePath(expr: string, ctx: StepContext): StructuralRef | null {
	if (expr.includes("?.")) return null;
	const parsed = parseExpression(expr);
	return parsed ? expressionToRef(parsed, ctx) : null;
}

function expressionToRef(expr: ts.Expression, ctx: StepContext): StructuralRef | null {
	const path = expressionPath(expr);
	if (!path) return null;
	const [root, ...rest] = path;
	if (root === "$") return dollarPathToRef(rest, ctx);
	if (root !== "ctx") return null;
	return ctxPathToRef(rest, ctx);
}

function dollarPathToRef(pathParts: PathSegment[], ctx: StepContext): StructuralRef | null {
	const [root, ...path] = pathParts;
	if (root === "state" || root === "vars") return statePathToRef(path, ctx);
	if (root === "req" || root === "request") return { $ref: { step: "@trigger", path } };
	if (root === "prev" || root === "response") return prevPathToRef(path, ctx);
	return null;
}

function ctxPathToRef(pathParts: PathSegment[], ctx: StepContext): StructuralRef | null {
	const [root, ...path] = pathParts;
	if (root === "state" || root === "vars") return statePathToRef(path, ctx);
	if (root === "request" || root === "req") return { $ref: { step: "@trigger", path } };
	if (root === "prev") return prevPathToRef(path, ctx);
	if (root === "response" && path[0] === "data") return prevPathToRef(path.slice(1), ctx);
	return null;
}

function statePathToRef(pathParts: PathSegment[], ctx: StepContext): StructuralRef | null {
	const [stateKey, ...path] = pathParts;
	if (typeof stateKey !== "string") return null;
	const owner = ctx.stepsByStateKey.get(stateKey);
	if (owner?.spread && typeof path[0] === "string") {
		return { $ref: { step: path[0], path: path.slice(1) } };
	}
	return { $ref: { step: stateKey, path } };
}

function prevPathToRef(pathParts: PathSegment[], ctx: StepContext): StructuralRef | null {
	if (!ctx.previous || ctx.previous.ephemeral) return null;
	const path = pathParts[0] === "data" ? pathParts.slice(1) : pathParts;
	return { $ref: { step: ctx.previous.stateKey, path } };
}

function expressionPath(expr: ts.Expression): PathSegment[] | null {
	if (ts.isIdentifier(expr)) return [expr.text];
	if (ts.isPropertyAccessExpression(expr)) {
		const base = expressionPath(expr.expression);
		return base ? [...base, expr.name.text] : null;
	}
	if (ts.isElementAccessExpression(expr)) {
		const base = expressionPath(expr.expression);
		const seg = elementSegment(expr.argumentExpression);
		return base && seg !== null ? [...base, seg] : null;
	}
	return null;
}

function elementSegment(expr: ts.Expression | undefined): PathSegment | null {
	if (!expr) return null;
	if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
	if (ts.isNumericLiteral(expr)) return Number(expr.text);
	return null;
}

function referencesRuntimeExpression(expr: string): boolean {
	return /\bctx\b|\$\.|process\.env|Date\.|Array\.|=>|\?\?|\|\||&&|\?|\.\.\.|new\s+|\bfunction\b/.test(expr);
}

function parseExpression(expr: string): ts.Expression | null {
	const sf = ts.createSourceFile("expr.ts", `const __blok = ${expr};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const stmt = sf.statements[0];
	if (!stmt || !ts.isVariableStatement(stmt)) return null;
	const decl = stmt.declarationList.declarations[0];
	return decl?.initializer ?? null;
}

function readJsonStepInfo(step: Record<string, unknown>): StepInfo | undefined {
	const id = typeof step.id === "string" ? step.id : typeof step.name === "string" ? step.name : undefined;
	if (!id) return undefined;
	return {
		id,
		stateKey: typeof step.as === "string" ? step.as : id,
		ephemeral: step.ephemeral === true,
		spread: step.spread === true,
		use: typeof step.use === "string" ? step.use : typeof step.node === "string" ? step.node : undefined,
	};
}

function readTsStepInfo(step: ts.ObjectLiteralExpression): StepInfo | undefined {
	const id = literalProperty(step, "id") ?? literalProperty(step, "name");
	if (!id) return undefined;
	return {
		id,
		stateKey: literalProperty(step, "as") ?? id,
		ephemeral: booleanProperty(step, "ephemeral") === true,
		spread: booleanProperty(step, "spread") === true,
		use: literalProperty(step, "use") ?? literalProperty(step, "node"),
	};
}

function previousConcreteInfo(infos: (StepInfo | undefined)[], index: number): StepInfo | undefined {
	for (let i = index - 1; i >= 0; i--) {
		if (infos[i]) return infos[i];
	}
	return undefined;
}

function getProperty(obj: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
	return obj.properties.find(
		(prop): prop is ts.PropertyAssignment => ts.isPropertyAssignment(prop) && propertyNameText(prop.name) === name,
	);
}

function literalProperty(obj: ts.ObjectLiteralExpression, name: string): string | undefined {
	const prop = getProperty(obj, name);
	return prop && ts.isStringLiteralLike(prop.initializer) ? prop.initializer.text : undefined;
}

function booleanProperty(obj: ts.ObjectLiteralExpression, name: string): boolean | undefined {
	const prop = getProperty(obj, name);
	if (!prop) return undefined;
	if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) return true;
	if (prop.initializer.kind === ts.SyntaxKind.FalseKeyword) return false;
	return undefined;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
	return undefined;
}

function tsExpressionValue(node: ts.Expression, source: string): string | null {
	if (ts.isStringLiteralLike(node)) return node.text;
	if (isDollarPath(node)) return source.slice(node.getStart(), node.getEnd());
	return null;
}

function isDollarPath(node: ts.Node): boolean {
	return expressionPath(node as ts.Expression)?.[0] === "$";
}

function isStepArray(array: ts.ArrayLiteralExpression): boolean {
	const parent = array.parent;
	if (!ts.isPropertyAssignment(parent)) return false;
	const name = propertyNameText(parent.name);
	return name === "steps" || name === "do" || name === "then" || name === "else" || name === "try" || name === "catch";
}

function isTsStructuralSentinel(obj: ts.ObjectLiteralExpression): boolean {
	return obj.properties.some(
		(prop) =>
			ts.isPropertyAssignment(prop) &&
			(propertyNameText(prop.name) === "$ref" || propertyNameText(prop.name) === "$tpl"),
	);
}

function isStructuralSentinel(value: unknown): boolean {
	return isPlainObject(value) && ("$ref" in value || "$tpl" in value);
}

function markJsonStep(step: Record<string, unknown>): void {
	const ui = isPlainObject(step.ui) ? step.ui : {};
	const notes = typeof ui.notes === "string" ? ui.notes : "";
	if (notes.includes(MARKER)) return;
	step.ui = { ...ui, notes: notes ? `${notes}\n${MARKER}` : MARKER };
}

function jsonStepMarked(step: Record<string, unknown>): boolean {
	return isPlainObject(step.ui) && typeof step.ui.notes === "string" && step.ui.notes.includes(MARKER);
}

interface TextReplacement {
	start: number;
	end: number;
	text: string;
}

function applyReplacements(source: string, replacements: TextReplacement[]): string {
	return [...replacements]
		.sort((a, b) => b.start - a.start)
		.reduce((text, r) => `${text.slice(0, r.start)}${r.text}${text.slice(r.end)}`, source);
}

function alreadyMarked(source: string, pos: number): boolean {
	const lineStart = source.lastIndexOf("\n", pos - 1) + 1;
	return source.slice(Math.max(0, lineStart - 200), pos).includes(MARKER);
}

function markerFor(source: string, pos: number): string {
	const lineStart = source.lastIndexOf("\n", pos - 1) + 1;
	const indent = source.slice(lineStart, pos).match(/^\s*/)?.[0] ?? "";
	return `${indent}// ${MARKER}\n`;
}

function insertedBefore(positions: Set<number>, offset: number, source: string): number {
	let inserted = 0;
	for (const pos of positions) {
		if (pos < offset) inserted += markerFor(source, pos).length;
	}
	return inserted;
}

function ensureHelperImports(source: string, helpers: Set<HelperName>): string {
	const ordered = (["$", "eq", "ne", "gt", "gte", "lt", "lte"] as const).filter((name) => helpers.has(name));
	if (ordered.length === 0) return source;

	const namedImport = /import\s*{([^}]*)}\s*from\s*["'](@blokjs\/(?:helper|core))["'];?/m;
	const match = namedImport.exec(source);
	if (!match) return `import { ${ordered.join(", ")} } from "@blokjs/helper";\n${source}`;

	const existing = new Set(
		match[1]
			.split(",")
			.map((part) =>
				part
					.trim()
					.split(/\s+as\s+/)[0]
					?.trim(),
			)
			.filter(Boolean),
	);
	const missing = ordered.filter((name) => !existing.has(name));
	if (missing.length === 0) return source;

	const current = match[1].trim();
	const next = current ? `${current}, ${missing.join(", ")}` : missing.join(", ");
	return `${source.slice(0, match.index)}import { ${next} } from "${match[2]}";${source.slice(match.index + match[0].length)}`;
}

function refToTs(ref: StructuralRef): string {
	return `{ $ref: { step: ${JSON.stringify(ref.$ref.step)}, path: ${JSON.stringify(ref.$ref.path)} } }`;
}

function tplToTs(tpl: StructuralTpl): string {
	return `{ $tpl: [${tpl.$tpl.map((part) => (isStructuralRef(part) ? refToTs(part) : JSON.stringify(part))).join(", ")}] }`;
}

function emptyStats(): MigrationStats {
	return { migrated: 0, marked: 0 };
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function isStepInfo(value: StepInfo | undefined): value is StepInfo {
	return value !== undefined;
}

function isStructuralRef(value: unknown): value is StructuralRef {
	return isPlainObject(value) && isPlainObject(value.$ref) && typeof value.$ref.step === "string";
}

async function collectWorkflowFiles(root: string): Promise<string[]> {
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
	const note = changed ? `refs: ${stats.migrated}, marked: ${stats.marked}` : "unchanged";
	console.log(`  ${icon} ${color.cyan(rel)} ${color.dim(note)}`);
}
