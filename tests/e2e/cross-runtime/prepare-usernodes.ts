/**
 * Prepare per-language docker build contexts with a scaffolded `e2e-user` node
 * baked in, so the cross-runtime harness can prove user-authored nodes are
 * discovered + executed in every SDK (not just the built-in examples) — E05-T007.
 *
 * Mirrors exactly what `blokctl create node` + `blokctl dev` do, using the REAL
 * templates (Examples.ts) and the REAL codegen (runtime-setup.ts):
 *   - Compiled (go/rust/java/csharp): render the template into a fake project's
 *     runtimes/<lang>/nodes/e2e-user/, then run generateXxxNodeRegistry so the
 *     shim + copied node land in the build context (.blok/runtimes/<lang>).
 *   - Dynamic (python3/ruby/php): drop the node into <ctx>/e2e_usernodes/e2e-user/
 *     at the path each runtime's boot-scan expects; compose sets BLOK_NODES_DIR.
 *
 * Output: tests/e2e/cross-runtime/.build/<lang>/  (gitignored). docker-compose
 * builds each service from the matching context.
 *
 * Run:  bun tests/e2e/cross-runtime/prepare-usernodes.ts
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	csharp_node_file,
	dart_node_file,
	elixir_node_file,
	function_first_node_file,
	go_node_file,
	java_node_file,
	kotlin_node_file,
	php_node_file,
	python3_file,
	ruby_node_file,
	rust_node_file,
	swift_node_file,
} from "../../../packages/cli/src/commands/create/utils/Examples.js";
import {
	generateCSharpNodeRegistry,
	generateDartNodeRegistry,
	generateElixirNodeRegistry,
	generateGoNodeRegistry,
	generateJavaNodeRegistry,
	generateKotlinNodeRegistry,
	generateRustNodeRegistry,
	generateSwiftNodeRegistry,
} from "../../../packages/cli/src/services/runtime-setup.js";

const HERE = import.meta.dir;
const ROOT = join(HERE, "..", "..", "..");
const BUILD = join(HERE, ".build");

const NAME = "e2e-user";
const PASCAL = "E2eUser"; // toPascalCase("e2e-user")
const PKG = "e2euser"; // node name minus non-alnum, lowercased (Go package)

function render(tmpl: string): string {
	return tmpl
		.replace(/\{\{NODE_NAME_PASCAL\}\}/g, PASCAL)
		.replace(/\{\{NODE_PKG\}\}/g, PKG)
		.replace(/\{\{NODE_NAME\}\}/g, NAME);
}

function write(file: string, content: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

// Build-artifact dirs to skip per language so the context is clean + small.
// NB: `bin/` is C#'s build output but ALSO the SOURCE dir for python/ruby/php
// (bin/serve.*), so it must be excluded per-language, never globally.
const EXCLUDES: Record<string, string[]> = {
	go: [],
	rust: ["target"],
	java: ["target"],
	kotlin: ["build", ".gradle"],
	csharp: ["bin", "obj"],
	python3: ["__pycache__"],
	ruby: [],
	php: ["vendor"],
	swift: [".build"],
	dart: [".dart_tool"],
	elixir: ["_build", "deps"],
};

function copySdk(lang: string, dest: string): void {
	const skip = ["node_modules", ".git", ...(EXCLUDES[lang] ?? [])];
	cpSync(join(ROOT, "sdks", lang), dest, {
		recursive: true,
		filter: (src) => !skip.some((d) => src.includes(`/${d}/`) || src.endsWith(`/${d}`)),
	});
}

/**
 * Compiled: build a fake project { .blok/runtimes/<lang> = SDK copy (the docker
 * context), runtimes/<lang>/nodes/e2e-user = rendered node }, run the real
 * codegen, and return the docker build context (.blok/runtimes/<lang>).
 */
function prepCompiled(lang: string, nodeRel: string, tmpl: string, gen: (projectDir: string) => string): void {
	const proj = join(BUILD, lang);
	rmSync(proj, { recursive: true, force: true });
	const ctx = join(proj, ".blok", "runtimes", lang);
	copySdk(lang, ctx);
	write(join(proj, "runtimes", lang, "nodes", NAME, nodeRel), render(tmpl));
	gen(proj);
	console.log(`  ${lang}: codegen ok → build context ${ctx.replace(ROOT, ".")}`);
}

/**
 * Dynamic: SDK copy is the docker context; drop the node under
 * <ctx>/e2e_usernodes/e2e-user/<rel> where the boot-scan expects it.
 */
function prepDynamic(lang: string, nodeRel: string, tmpl: string, extra: Record<string, string> = {}): void {
	const ctx = join(BUILD, lang);
	rmSync(ctx, { recursive: true, force: true });
	copySdk(lang, ctx);
	const base = join(ctx, "e2e_usernodes", NAME);
	write(join(base, nodeRel), render(tmpl));
	for (const [rel, content] of Object.entries(extra)) write(join(base, rel), content);
	console.log(`  ${lang}: node baked → build context ${ctx.replace(ROOT, ".")} (BLOK_NODES_DIR=/app/e2e_usernodes)`);
}

mkdirSync(BUILD, { recursive: true });
console.log("Preparing e2e-user node build contexts...");

// Compiled — real codegen (paths mirror node.ts's create-node branches).
prepCompiled("go", "node.go", go_node_file, generateGoNodeRegistry);
prepCompiled("rust", "node.rs", rust_node_file, generateRustNodeRegistry);
prepCompiled("java", `src/main/java/com/blok/blok/nodes/${PASCAL}Node.java`, java_node_file, generateJavaNodeRegistry);
prepCompiled(
	"kotlin",
	`src/main/kotlin/com/blok/kotlin/nodes/${PASCAL}Node.kt`,
	kotlin_node_file,
	generateKotlinNodeRegistry,
);
prepCompiled("csharp", `${PASCAL}Node.cs`, csharp_node_file, generateCSharpNodeRegistry);
prepCompiled("swift", "node.swift", swift_node_file, generateSwiftNodeRegistry);
prepCompiled("dart", "node.dart", dart_node_file, generateDartNodeRegistry);
prepCompiled("elixir", "node.ex", elixir_node_file, generateElixirNodeRegistry);

/**
 * JavaScript — the three engines share ONE build context because they share one
 * worker. This mirrors what a scaffolded project actually does: the REAL
 * `defineNode` template under `src/nodes/<name>/index.ts`, a `src/Nodes.ts`
 * default-exporting the node record, and the project's own `tsc` emitting
 * `dist/Nodes.js`. The worker then loads that module — Node.js needs the
 * compiled output, Bun and Deno would take either.
 */
function prepJavaScript(): void {
	const ctx = join(BUILD, "javascript");
	rmSync(ctx, { recursive: true, force: true });
	write(join(ctx, "src", "nodes", NAME, "index.ts"), render(function_first_node_file));
	write(
		join(ctx, "src", "Nodes.ts"),
		`import e2eUser from "./nodes/${NAME}/index.js";\n\nconst nodes = { "${NAME}": e2eUser };\n\nexport default nodes;\n`,
	);
	// `"type": "module"` so Node loads the emitted ESM without reparsing it.
	write(
		join(ctx, "package.json"),
		`${JSON.stringify({ name: "blok-e2e-javascript-usernodes", private: true, type: "module" }, null, 2)}\n`,
	);
	write(
		join(ctx, "tsconfig.json"),
		`${JSON.stringify(
			{
				compilerOptions: {
					target: "es2022",
					module: "es2022",
					moduleResolution: "bundler",
					lib: ["es2022"],
					rootDir: "./src",
					outDir: "./dist",
					strict: true,
					skipLibCheck: true,
				},
				include: ["./src"],
			},
			null,
			2,
		)}\n`,
	);
	const built = spawnSync("bunx", ["tsc", "-p", ctx], { cwd: ROOT, encoding: "utf8" });
	if (built.status !== 0 || !existsSync(join(ctx, "dist", "Nodes.js"))) {
		console.log(
			`  javascript: tsc FAILED — the JS workers will serve built-ins only\n${built.stdout ?? ""}${built.stderr ?? ""}`,
		);
		return;
	}
	console.log(`  javascript: node compiled → ${join(ctx, "dist", "Nodes.js").replace(ROOT, ".")} (BLOK_WORKER_NODES)`);
}

// Dynamic — BLOK_NODES_DIR fs-scan at boot.
prepDynamic("python3", "node.py", python3_file, { "__init__.py": "" });
prepDynamic("ruby", "node.rb", ruby_node_file);
prepDynamic("php", `src/Nodes/${PASCAL}Node.php`, php_node_file);

// JavaScript (node/bun/deno) — one worker, one compiled node module.
prepJavaScript();

console.log("Done. Build with: docker compose -f tests/e2e/cross-runtime/docker-compose.yml up -d --build");
