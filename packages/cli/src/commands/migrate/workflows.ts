import { promises as fsp } from "node:fs";
import path from "node:path";
import type { OptionValues } from "commander";
import color from "picocolors";

/**
 * Migrate v1 JSON workflows to the v2 shape.
 *
 * Conversion rules (1:1 with the runner-side WorkflowNormalizer):
 * - `steps[].name` → `steps[].id`
 * - `steps[].node` → `steps[].use`
 * - `nodes[stepName].inputs` → inlined onto the step
 * - `nodes[stepName].conditions` → `step.branch` shape (when 2-condition if/else)
 * - `set_var: true` → dropped (now default)
 * - `set_var: false` → `ephemeral: true`
 * - `method: "*"` → `method: "ANY"`
 * - Legacy `js/ctx.vars[...]` / `js/ctx.response.data` references in
 *   step inputs are rewritten to canonical `js/ctx.state[...]` /
 *   `js/ctx.prev.data` spellings.
 *
 * **`trigger.http.path` is preserved verbatim.** The legacy URL
 * `/<workflow-key>/<sub-path>` keeps working because the catch-all
 * extracts the workflow key from the URL; file-based routing derives
 * `/<filename>` from the file location automatically. Injecting an
 * absolute path here would break the catch-all without helping
 * file-based routing.
 *
 * Each migrated file gets a `<name>.json.bak` backup unless `--no-backup`
 * is set. Use `--dry-run` to preview without writing.
 *
 * **Note:** TS workflow migration is NOT covered by this command — TS
 * files use a chained builder API that requires AST rewriting. Migrate
 * TS workflows manually using the v2 examples in CLAUDE.md.
 */
export async function migrateWorkflows(opts: OptionValues): Promise<void> {
	const cwd = process.cwd();
	const explicitDir = (opts.dir as string | undefined) ?? null;
	const dryRun = opts.dryRun === true;
	const writeBackup = opts.backup !== false; // default true unless --no-backup

	console.log(color.cyan("\n🔄 Workflow v1 → v2 migrator"));
	console.log(color.dim("Converts legacy JSON workflows to the canonical v2 shape.\n"));

	const root = await resolveJsonRoot(cwd, explicitDir);
	if (!root) {
		console.log(
			color.red(
				"❌ Could not find a JSON workflows directory. Looked in: " +
					"workflows/json/, triggers/http/workflows/json/. Pass --dir <path> to override.",
			),
		);
		process.exit(1);
	}

	console.log(color.dim(`Scanning ${color.cyan(root)} (recursive)\n`));

	const files = await collectJsonFiles(root);
	if (files.length === 0) {
		console.log(color.yellow("No JSON workflow files found."));
		return;
	}

	const results: MigrationResult[] = [];
	for (const file of files) {
		const result = await migrateOne(file, { dryRun, writeBackup });
		results.push(result);
		printResult(result);
	}

	console.log("");
	printSummary(results, dryRun, writeBackup);
}

// =============================================================================
// Internals
// =============================================================================

interface MigrationOpts {
	readonly dryRun: boolean;
	readonly writeBackup: boolean;
}

type MigrationResult =
	| { kind: "migrated"; file: string }
	| { kind: "already-v2"; file: string }
	| { kind: "not-http"; file: string; trigger: string }
	| { kind: "skipped"; file: string; reason: string }
	| { kind: "error"; file: string; error: string };

async function migrateOne(file: string, opts: MigrationOpts): Promise<MigrationResult> {
	let raw: string;
	let parsed: unknown;
	try {
		raw = await fsp.readFile(file, "utf8");
		parsed = JSON.parse(raw);
	} catch (err) {
		return { kind: "error", file, error: (err as Error).message };
	}

	if (!isPlainObject(parsed)) {
		return { kind: "error", file, error: "Workflow must be a JSON object" };
	}

	const wf = parsed as Record<string, unknown>;
	const triggerKind = detectTriggerKind(wf);

	// Build the v2 shape. Runs unconditionally — even on already-v2
	// workflows — so legacy `js/ctx.vars[...]` / `js/ctx.response.data`
	// references inside step inputs get rewritten to the canonical v2
	// `js/ctx.state[...]` / `js/ctx.prev.data` spellings.
	const v2 = convertToV2(wf);

	const serialized = `${JSON.stringify(v2, null, "\t")}\n`;

	// If the canonical output equals the input verbatim, the file is
	// already in idiomatic v2 shape — no write needed, no backup needed.
	if (serialized.trimEnd() === raw.trimEnd()) {
		return { kind: "already-v2", file };
	}

	if (opts.dryRun) {
		return { kind: "migrated", file };
	}

	if (opts.writeBackup) {
		try {
			await fsp.writeFile(`${file}.bak`, raw);
		} catch (err) {
			return { kind: "error", file, error: `Failed to write backup: ${(err as Error).message}` };
		}
	}

	try {
		await fsp.writeFile(file, serialized);
	} catch (err) {
		return { kind: "error", file, error: (err as Error).message };
	}

	return {
		kind: triggerKind === "http" ? "migrated" : "not-http",
		file,
		trigger: triggerKind,
	} as MigrationResult;
}

function convertToV2(wf: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};

	if (typeof wf.name === "string") out.name = wf.name;
	if (typeof wf.version === "string") out.version = wf.version;
	if (typeof wf.description === "string") out.description = wf.description;

	out.trigger = convertTrigger(wf.trigger);
	out.steps = convertSteps(
		Array.isArray(wf.steps) ? (wf.steps as unknown[]) : [],
		isPlainObject(wf.nodes) ? (wf.nodes as Record<string, unknown>) : {},
	);

	return out;
}

function convertTrigger(rawTrigger: unknown): Record<string, unknown> {
	if (!isPlainObject(rawTrigger)) return {};
	const out: Record<string, unknown> = {};
	for (const [kind, cfg] of Object.entries(rawTrigger as Record<string, unknown>)) {
		if (kind === "http" && isPlainObject(cfg)) {
			const httpCfg: Record<string, unknown> = { ...(cfg as Record<string, unknown>) };
			// Convert `*` → `ANY`. Leave `path` exactly as the author wrote it
			// — the catch-all interprets `path` as a sub-path (after the
			// workflow key), and file-based routing derives the prefix from
			// the file location. Injecting an absolute path here would break
			// the catch-all without helping file-based routing (which already
			// derives `/<filename>` correctly when `path` is `/`).
			if (httpCfg.method === "*") httpCfg.method = "ANY";
			out[kind] = httpCfg;
		} else {
			out[kind] = cfg;
		}
	}
	return out;
}

function convertSteps(steps: readonly unknown[], nodes: Record<string, unknown>): unknown[] {
	const out: unknown[] = [];
	for (const rawStep of steps) {
		if (!isPlainObject(rawStep)) continue;
		const step = rawStep as Record<string, unknown>;
		const id = pickString(step.name) ?? pickString(step.id);
		if (!id) continue;

		// Already-v2 branch step (`{id, branch: {when, then, else}}`) —
		// detected BEFORE the nodeRef check because branch steps don't
		// carry `use`. Walk nested inputs for legacy js/ rewrites.
		if (isPlainObject(step.branch)) {
			const rawBranch = step.branch as Record<string, unknown>;
			const branchStep: Record<string, unknown> = {
				id,
				branch: {
					when: rewriteLegacyExpressions(typeof rawBranch.when === "string" ? rawBranch.when : "true"),
					then: convertSteps(Array.isArray(rawBranch.then) ? (rawBranch.then as unknown[]) : [], {}),
				},
			};
			if (Array.isArray(rawBranch.else)) {
				(branchStep.branch as Record<string, unknown>).else = convertSteps(rawBranch.else as unknown[], {});
			}
			if (step.active === false) branchStep.active = false;
			if (step.stop === true) branchStep.stop = true;
			out.push(branchStep);
			continue;
		}

		const nodeRef = pickString(step.node) ?? pickString(step.use);
		if (!nodeRef) continue;

		const v1NodeConfig = isPlainObject(nodes[id]) ? (nodes[id] as Record<string, unknown>) : null;
		const inputs = (() => {
			if (isPlainObject(step.inputs)) return step.inputs;
			if (v1NodeConfig && isPlainObject(v1NodeConfig.inputs)) return v1NodeConfig.inputs;
			return null;
		})();

		// V1 if/else: synthesised from `nodes[name].conditions[]` array.
		if (v1NodeConfig && Array.isArray(v1NodeConfig.conditions)) {
			const conds = v1NodeConfig.conditions as unknown[];
			const ifCond = conds.find((c) => isPlainObject(c) && (c as Record<string, unknown>).type === "if") as
				| Record<string, unknown>
				| undefined;
			const elseCond = conds.find((c) => isPlainObject(c) && (c as Record<string, unknown>).type === "else") as
				| Record<string, unknown>
				| undefined;

			if (ifCond) {
				const branchStep: Record<string, unknown> = {
					id,
					branch: {
						when: rewriteLegacyExpressions(typeof ifCond.condition === "string" ? ifCond.condition : "true"),
						then: convertSteps(Array.isArray(ifCond.steps) ? (ifCond.steps as unknown[]) : [], {}),
					},
				};
				if (elseCond) {
					(branchStep.branch as Record<string, unknown>).else = convertSteps(
						Array.isArray(elseCond.steps) ? (elseCond.steps as unknown[]) : [],
						{},
					);
				}
				if (step.active === false) branchStep.active = false;
				if (step.stop === true) branchStep.stop = true;
				out.push(branchStep);
				continue;
			}
		}

		// Regular step.
		const v2Step: Record<string, unknown> = { id, use: nodeRef };
		if (typeof step.type === "string") v2Step.type = step.type;
		if (inputs) v2Step.inputs = rewriteLegacyExpressions(inputs);
		// `set_var` is a v1-only field. In v2 the runner default-stores every
		// step's output; an explicit `set_var: false` means "skip persistence",
		// which v2 spells as `ephemeral: true`. We translate here:
		//   - set_var: false → ephemeral: true   (preserves v1 semantics)
		//   - set_var: true  → drop              (matches v2 default)
		// We NEVER copy `set_var` onto v2Step. A stray `set_var: false` in a
		// migrated workflow would short-circuit `PersistenceHelper.applyStepOutput`
		// at runtime and silently disable persistence for the step — see the
		// regression that broke cross-runtime-chain on Phase 6.
		if (step.set_var === false) v2Step.ephemeral = true;
		// Preserve other v2 knobs if author already set them.
		if (typeof step.as === "string") v2Step.as = step.as;
		if (step.spread === true) v2Step.spread = true;
		if (step.ephemeral === true) v2Step.ephemeral = true;
		if (step.active === false) v2Step.active = false;
		if (step.stop === true) v2Step.stop = true;
		if (typeof step.stream_logs === "boolean") v2Step.stream_logs = step.stream_logs;
		// `v2Step` is built field-by-field above; `set_var` is intentionally
		// not on the allow-list. If you add a future field that does
		// `Object.assign(v2Step, step)` or similar, add `set_var` to the strip
		// list here — it must not survive into a v2 workflow.
		out.push(v2Step);
	}
	return out;
}

/**
 * Recursively rewrite legacy `js/ctx.vars[...]` / `js/ctx.response.data`
 * (and their `${...}` template-string equivalents) to the v2 canonical
 * `js/ctx.state[...]` / `js/ctx.prev.data` spellings.
 *
 * `vars` and `response` are runtime aliases of `state` and `prev`
 * respectively, so legacy spellings still work — but the canonical v2
 * spelling is what authors should see post-migration.
 *
 * Walks plain objects + arrays recursively; leaves primitives and
 * non-plain values untouched.
 *
 * @internal exported for unit testing
 */
export function rewriteLegacyExpressions<T>(value: T): T {
	if (typeof value === "string") {
		return rewriteOneString(value) as T;
	}
	if (Array.isArray(value)) {
		return value.map((v) => rewriteLegacyExpressions(v)) as T;
	}
	if (isPlainObject(value)) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = rewriteLegacyExpressions(v);
		}
		return out as T;
	}
	return value;
}

function rewriteOneString(input: string): string {
	let s = input;
	// js/ prefix variants
	s = s.replace(/js\/ctx\.vars\b/g, "js/ctx.state");
	s = s.replace(/js\/ctx\.response\.data\b/g, "js/ctx.prev.data");
	// ${...} template variants
	s = s.replace(/\$\{ctx\.vars\b/g, "${ctx.state");
	s = s.replace(/\$\{ctx\.response\.data\b/g, "${ctx.prev.data");
	return s;
}

function detectTriggerKind(wf: Record<string, unknown>): string {
	if (!isPlainObject(wf.trigger)) return "unknown";
	const keys = Object.keys(wf.trigger as Record<string, unknown>);
	return keys[0] ?? "unknown";
}

async function resolveJsonRoot(cwd: string, explicit: string | null): Promise<string | null> {
	if (explicit) {
		const abs = path.isAbsolute(explicit) ? explicit : path.resolve(cwd, explicit);
		if (await dirExists(abs)) return abs;
		return null;
	}
	const candidates = [path.join(cwd, "workflows", "json"), path.join(cwd, "triggers", "http", "workflows", "json")];
	for (const c of candidates) {
		if (await dirExists(c)) return c;
	}
	return null;
}

async function dirExists(p: string): Promise<boolean> {
	try {
		const stat = await fsp.stat(p);
		return stat.isDirectory();
	} catch {
		return false;
	}
}

async function collectJsonFiles(root: string): Promise<string[]> {
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
		if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await walk(full, out);
		} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
			out.push(full);
		}
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || value === undefined) return false;
	if (typeof value !== "object") return false;
	if (Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === null || proto === Object.prototype;
}

function pickString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function printResult(result: MigrationResult): void {
	const file = path.relative(process.cwd(), result.file);
	switch (result.kind) {
		case "migrated":
			console.log(`  ${color.green("✓")} ${color.cyan(file)}`);
			break;
		case "already-v2":
			console.log(`  ${color.dim("⊙")} ${color.dim(file)} ${color.dim("(already v2)")}`);
			break;
		case "not-http":
			console.log(
				`  ${color.green("✓")} ${color.cyan(file)} ${color.dim(`(${result.trigger} trigger; no URL preserved)`)}`,
			);
			break;
		case "skipped":
			console.log(`  ${color.dim("→")} ${color.dim(file)} ${color.dim(`(${result.reason})`)}`);
			break;
		case "error":
			console.log(`  ${color.red("✗")} ${color.cyan(file)} ${color.red(`— ${result.error}`)}`);
			break;
	}
}

function printSummary(results: readonly MigrationResult[], dryRun: boolean, writeBackup: boolean): void {
	const counts = {
		migrated: 0,
		alreadyV2: 0,
		notHttp: 0,
		skipped: 0,
		error: 0,
	};
	for (const r of results) {
		if (r.kind === "migrated") counts.migrated++;
		else if (r.kind === "already-v2") counts.alreadyV2++;
		else if (r.kind === "not-http") counts.notHttp++;
		else if (r.kind === "skipped") counts.skipped++;
		else if (r.kind === "error") counts.error++;
	}
	const total = results.length;
	const verb = dryRun ? "would migrate" : "migrated";
	const summary = `Total: ${total}  ·  ${color.green(`${verb}: ${counts.migrated + counts.notHttp}`)}${counts.alreadyV2 > 0 ? `  ·  ${color.dim(`already v2: ${counts.alreadyV2}`)}` : ""}${counts.error > 0 ? `  ·  ${color.red(`errors: ${counts.error}`)}` : ""}`;
	console.log(summary);

	if (dryRun) {
		console.log(color.dim("\nDry run — no files written. Re-run without --dry-run to apply."));
	} else if (writeBackup && counts.migrated + counts.notHttp > 0) {
		console.log(
			color.dim("\nBackups written next to each file as <name>.json.bak. Run with --no-backup to skip backups."),
		);
	}
	if (counts.error > 0) process.exit(1);
}
