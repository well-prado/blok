/**
 * Extract the TypeScript samples out of the SPA docs and lay them out as real
 * modules, so `tsc` can tell us whether they compile (#1004).
 *
 * A doc sample that names a deleted export, or calls `render()` with the wrong
 * arity, looks exactly as confident as a correct one. The only way to keep the
 * SPA docs honest is to hand every fenced `ts` / `tsx` block to the compiler,
 * against the REAL packages.
 *
 * HOW A BLOCK BECOMES A MODULE
 *
 *   ```ts src/workflows/orders.ts   ← the fence's info string names the file;
 *   …                                 another block in the SAME page can then
 *   ```                               `import … from "./workflows/orders"`.
 *
 *   ```ts                           ← no path → its own module, snippet-NN.ts
 *
 * Each page gets its own directory, so two pages may both use `src/nodes.ts`
 * without colliding, and imports inside a page stay relative and readable.
 *
 * A block with no `import` and no `export` would be a SCRIPT, whose top-level
 * names collide across files; `export {}` is appended to force module scope.
 *
 * ponytail: this mirrors scripts/check-skill-samples.ts rather than inventing a
 * second mechanism — same extraction idea, same "write modules, run tsc once"
 * shape. Upgrade path if more doc sections want it: hoist this file to
 * scripts/ and take the doc glob as an argument.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");

/** ```ts / ```tsx fences, with an optional file path in the info string. */
const FENCE = /^```(tsx?|typescript)([^\n]*)\n([\s\S]*?)^```$/gm;

export interface Snippet {
	/** Doc file the block came from, relative to the repo root. */
	doc: string;
	/** Path the block is written to, relative to the output root. */
	path: string;
	code: string;
}

/** Every `.mdx` file under `dir`, recursively, sorted. */
export function docFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...docFiles(full));
		else if (entry.name.endsWith(".mdx")) out.push(full);
	}
	return out.sort();
}

/** The slug a doc's snippets live under: `docs/d/spa/index.mdx` → `d-spa-index`. */
function slugOf(docPath: string): string {
	return relative(REPO_ROOT, docPath)
		.replace(/\.mdx$/, "")
		.replace(/[/\\]/g, "-")
		.replace(/^docs-/, "");
}

export function extract(docPath: string): Snippet[] {
	const markdown = readFileSync(docPath, "utf8");
	const slug = slugOf(docPath);
	const out: Snippet[] = [];
	let anonymous = 0;
	for (const match of markdown.matchAll(FENCE)) {
		const lang = match[1] === "tsx" ? "tsx" : "ts";
		const meta = (match[2] ?? "").trim();
		const code = match[3] ?? "";
		const named = /^[\w./-]+\.tsx?$/.test(meta);
		const path = named ? meta : `snippet-${String(++anonymous).padStart(2, "0")}.${lang}`;
		out.push({
			doc: relative(REPO_ROOT, docPath),
			path: join(slug, path),
			// A block with neither is a script: its top-level names would collide
			// with every other script in the program.
			code: /^\s*(import|export)\b/m.test(code) ? code : `${code}\nexport {};\n`,
		});
	}
	return out;
}

/** Write every snippet plus a tsconfig, and return the output root. */
export function materialize(snippets: readonly Snippet[], outDir: string): string {
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	for (const snippet of snippets) {
		const file = join(outDir, snippet.path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, snippet.code);
	}
	writeFileSync(
		join(outDir, "tsconfig.json"),
		`${JSON.stringify(
			{
				compilerOptions: {
					target: "es2022",
					module: "es2022",
					moduleResolution: "bundler",
					jsx: "react-jsx",
					// `vite/client` because a client entry is a Vite module (`import.meta.glob`).
					types: ["node", "vite/client"],
					lib: ["es2023", "dom", "dom.iterable"],
					esModuleInterop: true,
					forceConsistentCasingInFileNames: true,
					strict: true,
					skipLibCheck: true,
					noEmit: true,
					// A doc sample legitimately declares more than it uses (an import
					// shown for completeness, a handle named to be talked about). This
					// check answers "does this API exist", not "is this tidy".
					noUnusedLocals: false,
					noUnusedParameters: false,
				},
				include: ["**/*.ts", "**/*.tsx"],
			},
			null,
			2,
		)}\n`,
	);
	return outDir;
}
