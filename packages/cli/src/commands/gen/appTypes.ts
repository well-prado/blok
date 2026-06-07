import { promises as fsp } from "node:fs";
import path from "node:path";
import type { OptionValues } from "commander";
import color from "picocolors";

/**
 * `blokctl gen app-types` — generate the `BlokApp` type for `@blokjs/client`.
 *
 * Scans a project's TypeScript workflow files and emits a types-only
 * `blok-app.d.ts` that indexes every workflow by its (dotted) `name` and points
 * at the file via `import type`. The frontend then does
 * `import type { BlokApp } from "./blok-app"` + `createBlokClient<BlokApp>()`
 * and gets a fully-typed client — no hand-written aggregation.
 *
 * The generator does NOT execute project code (blokctl runs under node, which
 * can't import `.ts`). It extracts each workflow's `name` STATICALLY. The name
 * is what the client's RPC call is keyed by (`/__blok/rpc/<name>`), so the
 * nesting mirrors the registered name exactly.
 *
 * JSON-authored workflows are skipped (no TS type to import) — use the codegen
 * fallback (`blokctl gen client`, planned) against `/__blok/schema` for those.
 */

/** One discovered TS workflow: its registered name + absolute file path. */
export interface WorkflowEntry {
	name: string;
	file: string;
}

/**
 * Extract the workflow `name` from a TS source file WITHOUT executing it.
 * Anchors on the `workflow(`/`Workflow(` factory call, then reads the first
 * `name:` string literal. Returns null when the file has no workflow factory
 * call or uses a non-literal name (e.g. a variable) — the caller warns + skips.
 */
export function extractWorkflowName(source: string): string | null {
	// Strip block + line comments so a commented-out `name:` can't match.
	const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
	const factory = /\b(?:workflow|Workflow)\s*\(/.exec(stripped);
	if (!factory) return null;
	const rest = stripped.slice(factory.index);
	const nameMatch = /\bname\s*:\s*(["'`])([^"'`]+)\1/.exec(rest);
	return nameMatch ? nameMatch[2].trim() : null;
}

/** Turn a dotted workflow name into a safe, unique TS identifier. */
export function nameToIdentifier(name: string): string {
	const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
	const camel = parts.map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1))).join("");
	const safe = camel.length === 0 ? "wf" : camel;
	return /^[0-9]/.test(safe) ? `wf_${safe}` : safe;
}

/** Compute the `import` specifier from the output file to a workflow file (no extension, POSIX). */
export function importSpecifier(outFile: string, workflowFile: string): string {
	let rel = path.relative(path.dirname(outFile), workflowFile).replace(/\\/g, "/").replace(/\.ts$/, "");
	if (!rel.startsWith(".")) rel = `./${rel}`;
	return rel;
}

interface TypeTree {
	[segment: string]: TypeTree | { __leaf: string };
}

function isLeaf(node: TypeTree | { __leaf: string }): node is { __leaf: string } {
	return typeof (node as { __leaf?: unknown }).__leaf === "string";
}

/**
 * Build the `blok-app.d.ts` source from the discovered workflows. Pure (no IO)
 * so it's unit-testable. Returns `{ source, collisions, identifiers }`.
 */
export function buildAppTypeSource(
	entries: readonly WorkflowEntry[],
	outFile: string,
): { source: string; collisions: string[] } {
	const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
	const collisions: string[] = [];
	const usedIdents = new Map<string, string>(); // ident -> name
	const imports: string[] = [];
	const tree: TypeTree = {};

	for (const entry of sorted) {
		let ident = nameToIdentifier(entry.name);
		// Disambiguate identifier collisions (distinct names → same camelCase).
		if (usedIdents.has(ident) && usedIdents.get(ident) !== entry.name) {
			let n = 2;
			while (usedIdents.has(`${ident}${n}`)) n++;
			ident = `${ident}${n}`;
		}
		usedIdents.set(ident, entry.name);
		imports.push(`import type ${ident} from "${importSpecifier(outFile, entry.file)}";`);

		// Nest by the dotted name: "users.list" -> tree.users.list = leaf.
		const segments = entry.name.split(".").filter(Boolean);
		let node: TypeTree = tree;
		let collided = false;
		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];
			const last = i === segments.length - 1;
			if (last) {
				if (node[seg] !== undefined) {
					collisions.push(entry.name);
					collided = true;
					break;
				}
				node[seg] = { __leaf: ident };
			} else {
				const existing = node[seg];
				if (existing === undefined) {
					const child: TypeTree = {};
					node[seg] = child;
					node = child;
				} else if (isLeaf(existing)) {
					// A name is both a leaf ("users") and a group ("users.list").
					collisions.push(entry.name);
					collided = true;
					break;
				} else {
					node = existing;
				}
			}
		}
		if (collided) imports.pop();
	}

	const render = (node: TypeTree, indent: string): string => {
		const lines: string[] = ["{"];
		for (const key of Object.keys(node).sort()) {
			const child = node[key];
			const k = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
			if (isLeaf(child)) {
				lines.push(`${indent}\t${k}: ${child.__leaf};`);
			} else {
				lines.push(`${indent}\t${k}: ${render(child, `${indent}\t`)};`);
			}
		}
		lines.push(`${indent}}`);
		return lines.join("\n");
	};

	const header = [
		"// AUTO-GENERATED by `blokctl gen app-types`. Do not edit by hand.",
		"// Regenerate after adding, removing, or renaming a workflow.",
		"// Consumed by `@blokjs/client`: `createBlokClient<BlokApp>()`.",
		"",
	].join("\n");

	const body =
		imports.length === 0
			? "export type BlokApp = Record<string, never>;\n"
			: `${imports.join("\n")}\n\nexport type BlokApp = ${render(tree, "")};\n`;

	return { source: `${header}${body}`, collisions };
}

/** Recursively collect candidate `.ts` workflow files under `dir`. */
async function collectTsFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	let dirents: import("node:fs").Dirent[];
	try {
		dirents = await fsp.readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const d of dirents) {
		if (d.name.startsWith("_") || d.name.startsWith(".")) continue;
		const full = path.join(dir, d.name);
		if (d.isDirectory()) {
			out.push(...(await collectTsFiles(full)));
		} else if (
			d.name.endsWith(".ts") &&
			!d.name.endsWith(".test.ts") &&
			!d.name.endsWith(".spec.ts") &&
			!d.name.endsWith(".d.ts")
		) {
			out.push(full);
		}
	}
	return out;
}

async function resolveWorkflowsDir(cwd: string, explicit?: string | null): Promise<string | null> {
	const candidates = explicit
		? [explicit]
		: ["triggers/http/src/workflows", "src/workflows", "workflows/ts", "workflows"];
	for (const c of candidates) {
		const abs = path.isAbsolute(c) ? c : path.join(cwd, c);
		try {
			const stat = await fsp.stat(abs);
			if (stat.isDirectory()) return abs;
		} catch {
			/* try next */
		}
	}
	return null;
}

/** CLI entrypoint for `blokctl gen app-types`. */
export async function generateAppTypes(opts: OptionValues): Promise<void> {
	const cwd = process.cwd();
	const explicitDir = (opts.dir as string | undefined) ?? null;

	console.log(color.cyan("\n🧬 Blok app-types generator"));
	console.log(color.dim("Generates the typed `BlokApp` index consumed by @blokjs/client.\n"));

	const dir = await resolveWorkflowsDir(cwd, explicitDir);
	if (!dir) {
		console.log(
			color.red(
				"❌ Could not find a TS workflows directory. Looked in: triggers/http/src/workflows/, " +
					"src/workflows/, workflows/. Pass --dir <path> to override.",
			),
		);
		process.exit(1);
		return;
	}

	const outFile = path.isAbsolute(opts.out ?? "")
		? (opts.out as string)
		: path.join(cwd, (opts.out as string | undefined) ?? "blok-app.d.ts");

	console.log(color.dim(`Scanning ${color.cyan(dir)} (recursive)\n`));
	const files = await collectTsFiles(dir);

	const entries: WorkflowEntry[] = [];
	const skipped: string[] = [];
	for (const file of files) {
		const src = await fsp.readFile(file, "utf8");
		const name = extractWorkflowName(src);
		if (name) entries.push({ name, file });
		else skipped.push(path.relative(cwd, file));
	}

	if (entries.length === 0) {
		console.log(color.yellow("No TS workflows with a literal `name:` found — nothing to generate."));
		if (skipped.length > 0) console.log(color.dim(`Skipped (no literal name): ${skipped.join(", ")}`));
		return;
	}

	const { source, collisions } = buildAppTypeSource(entries, outFile);

	if (opts.dryRun === true) {
		console.log(color.dim(`— dry run — would write ${color.cyan(path.relative(cwd, outFile))}:\n`));
		console.log(source);
	} else {
		await fsp.mkdir(path.dirname(outFile), { recursive: true });
		await fsp.writeFile(outFile, source, "utf8");
		console.log(color.green(`✅ Wrote ${color.cyan(path.relative(cwd, outFile))} (${entries.length} workflow(s)).`));
	}

	for (const c of collisions) {
		console.log(color.yellow(`⚠️  name collision — "${c}" overlaps another workflow's path and was dropped.`));
	}
	if (skipped.length > 0) {
		console.log(
			color.dim(
				`ℹ️  Skipped ${skipped.length} file(s) without a literal workflow name (dynamic name or not a workflow): ${skipped.join(", ")}`,
			),
		);
	}
	console.log(
		color.dim('\nNext: `import type { BlokApp } from "<out>"` and `createBlokClient<BlokApp>({ baseUrl })`.\n'),
	);
}
