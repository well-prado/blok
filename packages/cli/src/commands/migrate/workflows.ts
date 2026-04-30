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
 * - Preserves the LEGACY URL by injecting `trigger.http.path = "/<filename-key>"`
 *   so consumers don't break when the catch-all is replaced by file-based
 *   routing. Pass `--strip-legacy-path` to opt out and rely on the
 *   file-derived URL instead.
 *
 * Each migrated file gets a `<name>.json.bak` backup unless `--no-backup`
 * is set. Use `--dry-run` to preview without writing.
 *
 * Skips files whose first key is already `id` (already v2) and prints a
 * one-line summary at the end.
 *
 * **Note:** TS workflow migration is NOT covered by this command — TS
 * files use a chained builder API that requires AST rewriting. Migrate
 * TS workflows manually using the v2 examples in CLAUDE.md.
 */
export async function migrateWorkflows(opts: OptionValues): Promise<void> {
	const cwd = process.cwd();
	const explicitDir = (opts.dir as string | undefined) ?? null;
	const dryRun = opts.dryRun === true;
	const stripLegacyPath = opts.stripLegacyPath === true;
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
		const result = await migrateOne(file, root, { dryRun, stripLegacyPath, writeBackup });
		results.push(result);
		printResult(result);
	}

	console.log("");
	printSummary(results, dryRun);
}

// =============================================================================
// Internals
// =============================================================================

interface MigrationOpts {
	readonly dryRun: boolean;
	readonly stripLegacyPath: boolean;
	readonly writeBackup: boolean;
}

type MigrationResult =
	| { kind: "migrated"; file: string; injectedPath: string | null }
	| { kind: "already-v2"; file: string }
	| { kind: "not-http"; file: string; trigger: string }
	| { kind: "skipped"; file: string; reason: string }
	| { kind: "error"; file: string; error: string };

async function migrateOne(file: string, rootDir: string, opts: MigrationOpts): Promise<MigrationResult> {
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

	// Detect if already v2 — first step has `id` and no top-level `nodes{}`.
	const steps = Array.isArray(wf.steps) ? (wf.steps as unknown[]) : [];
	const firstStep = steps.find(isPlainObject) as Record<string, unknown> | undefined;
	if (firstStep && "id" in firstStep && !("nodes" in wf)) {
		return { kind: "already-v2", file };
	}

	const triggerKind = detectTriggerKind(wf);

	// File-derived key — used to preserve the legacy URL.
	const relPath = path.relative(rootDir, file);
	const legacyKey = relPath.replace(/\.json$/i, "").replace(/\\/g, "/");
	const legacyUrl = `/${legacyKey}`;

	// Build the v2 shape.
	const v2 = convertToV2(wf, {
		legacyUrl: opts.stripLegacyPath ? null : legacyUrl,
		isHttp: triggerKind === "http",
	});

	const serialized = `${JSON.stringify(v2, null, "\t")}\n`;

	if (opts.dryRun) {
		return {
			kind: "migrated",
			file,
			injectedPath: opts.stripLegacyPath || triggerKind !== "http" ? null : legacyUrl,
		};
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
		injectedPath: opts.stripLegacyPath || triggerKind !== "http" ? null : legacyUrl,
		trigger: triggerKind,
	} as MigrationResult;
}

interface ConvertOpts {
	readonly legacyUrl: string | null;
	readonly isHttp: boolean;
}

function convertToV2(wf: Record<string, unknown>, opts: ConvertOpts): Record<string, unknown> {
	const out: Record<string, unknown> = {};

	if (typeof wf.name === "string") out.name = wf.name;
	if (typeof wf.version === "string") out.version = wf.version;
	if (typeof wf.description === "string") out.description = wf.description;

	out.trigger = convertTrigger(wf.trigger, opts);
	out.steps = convertSteps(
		Array.isArray(wf.steps) ? (wf.steps as unknown[]) : [],
		isPlainObject(wf.nodes) ? (wf.nodes as Record<string, unknown>) : {},
	);

	return out;
}

function convertTrigger(rawTrigger: unknown, opts: ConvertOpts): Record<string, unknown> {
	if (!isPlainObject(rawTrigger)) return {};
	const out: Record<string, unknown> = {};
	for (const [kind, cfg] of Object.entries(rawTrigger as Record<string, unknown>)) {
		if (kind === "http" && isPlainObject(cfg)) {
			const httpCfg: Record<string, unknown> = { ...(cfg as Record<string, unknown>) };
			// Convert `*` → `ANY`
			if (httpCfg.method === "*") httpCfg.method = "ANY";
			// Inject explicit path to preserve legacy URL (unless --strip-legacy-path).
			if (opts.legacyUrl !== null && opts.isHttp) {
				const existingPath = typeof httpCfg.path === "string" ? httpCfg.path : null;
				const subPath = existingPath && existingPath !== "/" ? existingPath : "";
				httpCfg.path = `${opts.legacyUrl}${subPath}`;
			}
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
		const nodeRef = pickString(step.node) ?? pickString(step.use);
		if (!nodeRef) continue;

		const v1NodeConfig = isPlainObject(nodes[id]) ? (nodes[id] as Record<string, unknown>) : null;
		const inputs = (() => {
			if (isPlainObject(step.inputs)) return step.inputs;
			if (v1NodeConfig && isPlainObject(v1NodeConfig.inputs)) return v1NodeConfig.inputs;
			return null;
		})();

		// Branch detection — if the v1 node config has `conditions` array,
		// convert to v2 branch shape.
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
						when: typeof ifCond.condition === "string" ? ifCond.condition : "true",
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
		if (inputs) v2Step.inputs = inputs;
		// set_var: true is a no-op going forward; drop.
		// set_var: false → ephemeral: true.
		if (step.set_var === false) v2Step.ephemeral = true;
		// Preserve other v2 knobs if author already set them.
		if (typeof step.as === "string") v2Step.as = step.as;
		if (step.spread === true) v2Step.spread = true;
		if (step.ephemeral === true) v2Step.ephemeral = true;
		if (step.active === false) v2Step.active = false;
		if (step.stop === true) v2Step.stop = true;
		if (typeof step.stream_logs === "boolean") v2Step.stream_logs = step.stream_logs;
		out.push(v2Step);
	}
	return out;
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
			console.log(
				`  ${color.green("✓")} ${color.cyan(file)}${result.injectedPath ? color.dim(`  → preserved URL ${result.injectedPath}`) : ""}`,
			);
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

function printSummary(results: readonly MigrationResult[], dryRun: boolean): void {
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
	} else if (counts.migrated + counts.notHttp > 0) {
		console.log(
			color.dim("\nBackups written next to each file as <name>.json.bak. Run with --no-backup to skip backups."),
		);
	}
	if (counts.error > 0) process.exit(1);
}
