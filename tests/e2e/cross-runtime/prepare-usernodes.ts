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
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	csharp_node_file,
	go_node_file,
	java_node_file,
	php_node_file,
	python3_file,
	ruby_node_file,
	rust_node_file,
} from "../../../packages/cli/src/commands/create/utils/Examples.js";
import {
	generateCSharpNodeRegistry,
	generateGoNodeRegistry,
	generateJavaNodeRegistry,
	generateRustNodeRegistry,
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
	csharp: ["bin", "obj"],
	python3: ["__pycache__"],
	ruby: [],
	php: ["vendor"],
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
prepCompiled("csharp", `${PASCAL}Node.cs`, csharp_node_file, generateCSharpNodeRegistry);

// Dynamic — BLOK_NODES_DIR fs-scan at boot.
prepDynamic("python3", "node.py", python3_file, { "__init__.py": "" });
prepDynamic("ruby", "node.rb", ruby_node_file);
prepDynamic("php", `src/Nodes/${PASCAL}Node.php`, php_node_file);

console.log("Done. Build with: docker compose -f tests/e2e/cross-runtime/docker-compose.yml up -d --build");
