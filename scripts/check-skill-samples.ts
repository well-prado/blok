#!/usr/bin/env bun
/**
 * Typecheck every TypeScript sample in `.claude/skills/blok-framework.md`
 * against the REAL `@blokjs/core` surface (issue #708).
 *
 * That doc is the AI-facing authoring guide: whatever it shows, agents emit at
 * scale. Eyeballing a sample proves nothing — a sample that names a deleted
 * export, or calls `step()` with the wrong arity, looks exactly as confident as
 * a correct one. So the samples are extracted and fed to `tsc`.
 *
 * HOW A SAMPLE BECOMES A MODULE
 *
 *   ```ts
 *   // file: nodes.ts        ← first line pins the filename; the block is written
 *   …                          there and other samples can `import … from "./nodes"`.
 *   ```
 *
 *   ```ts
 *   …                       ← no `// file:` line → its own module, sample-NN.ts
 *   ```
 *
 * Each sample is a standalone ES module, so it must carry its own imports. That
 * is the point: a sample an agent can copy has to compile on its own.
 *
 * Blocks fenced as anything other than `ts`/`typescript` (json, bash, txt) are
 * ignored — there is no compiler to hand them to.
 *
 * ponytail: `tsc` resolves `@blokjs/core` through the workspace symlink in
 * `node_modules`, which points at `core/core/dist`. So this needs a build first
 * (`bun run build`); it says so rather than building for you, because in CI the
 * build has already run — see `gates()` in scripts/ci-local.sh, which calls this
 * immediately after it.
 *
 * Run directly: bun run scripts/check-skill-samples.ts
 * Wired into: bun run check:skill-samples, scripts/ci-local.sh gates(),
 * .github/workflows/integration.yml (after its build step). A markdown-ONLY PR
 * skips integration.yml via paths-ignore; scripts/check-no-legacy-expr.sh has no
 * paths filter and covers that case for the forms that actually hurt.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = join(ROOT, ".claude/skills/blok-framework.md");
// Lives under node_modules so (a) it is already git-ignored and biome-ignored,
// and (b) Node/tsc resolve `@blokjs/*` by walking up to `<root>/node_modules`.
const OUT = join(ROOT, "node_modules/.cache/blok-skill-samples");

const FENCE = /^```(ts|typescript)\b[^\n]*\n([\s\S]*?)^```$/gm;
const FILE_PRAGMA = /^\/\/ file:\s*([\w.-]+\.ts)\s*$/;

function extract(markdown: string): { name: string; code: string }[] {
	const out: { name: string; code: string }[] = [];
	let anonymous = 0;
	for (const match of markdown.matchAll(FENCE)) {
		const code = match[2] ?? "";
		const pragma = FILE_PRAGMA.exec(code.split("\n", 1)[0] ?? "");
		out.push(
			pragma
				? { name: pragma[1] as string, code }
				: { name: `sample-${String(++anonymous).padStart(2, "0")}.ts`, code },
		);
	}
	return out;
}

if (!existsSync(DOC)) {
	console.error(`✗ ${DOC} not found.`);
	process.exit(1);
}
if (!existsSync(join(ROOT, "node_modules/@blokjs/core/dist/index.d.ts"))) {
	console.error("✗ @blokjs/core is not built — run `bun run build` first (it also appends the Node-ESM fixup).");
	process.exit(1);
}

const samples = extract(readFileSync(DOC, "utf8"));
if (samples.length === 0) {
	console.error("✗ No TypeScript samples found in the skills doc — the extractor or the doc's fences changed.");
	process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const { name, code } of samples) writeFileSync(join(OUT, name), code);
writeFileSync(
	join(OUT, "tsconfig.json"),
	`${JSON.stringify(
		{
			compilerOptions: {
				// Mirrors core/core/tsconfig.json, minus the emit settings.
				target: "es2022",
				module: "es2022",
				moduleResolution: "bundler",
				types: ["node"],
				esModuleInterop: true,
				forceConsistentCasingInFileNames: true,
				strict: true,
				skipLibCheck: true,
				noEmit: true,
				// A doc sample legitimately declares more than it uses (an import
				// shown for completeness, a handle named to be talked about).
				// Unused-code hygiene is a lint concern, not a "does this API exist"
				// concern, and this check only answers the latter.
				noUnusedLocals: false,
			},
			include: ["*.ts"],
		},
		null,
		2,
	)}\n`,
);

const tsc = spawnSync("bunx", ["tsc", "--project", OUT], { cwd: ROOT, encoding: "utf8" });
const output = `${tsc.stdout ?? ""}${tsc.stderr ?? ""}`.trim();
if (tsc.status !== 0) {
	console.error(output);
	console.error(`\n✗ Skill-doc samples do not compile. Generated modules are in ${OUT}.`);
	console.error("  Fix the sample in .claude/skills/blok-framework.md — an agent will copy it verbatim.");
	process.exit(1);
}

console.log(
	`✓ ${samples.length} TypeScript sample(s) in .claude/skills/blok-framework.md compile against @blokjs/core.`,
);
