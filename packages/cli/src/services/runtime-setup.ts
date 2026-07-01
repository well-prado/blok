import child_process from "node:child_process";
import path from "node:path";
import util from "node:util";
import fsExtra from "fs-extra";
import type { RuntimeInfo } from "./runtime-detector.js";
import { detectRuntimeVersion } from "./runtime-detector.js";
import {
	computeDefaultConstraint,
	formatVersionMismatch,
	formatVersionSuccess,
	satisfiesConstraint,
} from "./semver-utils.js";

const exec = util.promisify(child_process.exec);

type SpinnerHandler = {
	start: (msg?: string) => void;
	stop: (msg?: string, code?: number) => void;
	message: (msg?: string) => void;
};

export interface RuntimeConfig {
	/**
	 * Legacy port field retained for back-compat with `.blok/config.json`
	 * files written by older CLI versions. The CLI's gRPC-only spawn does
	 * not health-probe it; gRPC has been the sole transport since v0.5.
	 */
	port: number;
	/**
	 * gRPC listener port. The CLI spawns the SDK with `BLOK_TRANSPORT=grpc`
	 * and `GRPC_PORT=<grpcPort>`, then waits on a TCP-connect probe to this
	 * port before starting triggers.
	 *
	 * Optional in the type for back-compat reading of pre-Phase-7
	 * `.blok/config.json`. New writes always populate it.
	 */
	grpcPort?: number;
	startCmd: string;
	/**
	 * Optional gRPC-only boot command — used when the SDK's gRPC server is
	 * a different binary entirely (PHP uses RoadRunner). When unset, the
	 * CLI uses `startCmd` with `BLOK_TRANSPORT=grpc` env override.
	 */
	grpcStartCmd?: string;
	cwd: string;
	kind: string;
	label: string;
	/** Exact runtime version detected at setup time (e.g. "3.12.0") */
	version?: string;
	/** Semver constraint for this runtime (e.g. ">=3.12.0") */
	requiredVersion?: string;
	/**
	 * Transport the CLI uses when spawning this runtime. Always `"grpc"`
	 * since v0.5 (`HttpRuntimeAdapter` was removed). The field is retained
	 * for back-compat reads of older `.blok/config.json` files.
	 */
	transport?: "grpc";
}

export interface TriggerConfig {
	kind: string;
	label: string;
	port: number;
	entryPoint: string;
	startCmd: string;
}

/**
 * Per-module record under `.blok/config.json` → `observability`. Tracks which
 * opt-in observability modules (metrics, tracing, …) are enabled in a project,
 * written by `blokctl observability add` and the create-time picker.
 *
 * Remove contract: `blokctl observability remove <id>` deletes this entry AND
 * reverses the module's `.env.local` block. Copied infra files (Helm values,
 * compose services) are left in place with a printed note unless the module's
 * `cleanup()` hook handles them — removal never destroys operator-edited infra.
 *
 * Version drift: `version` records the framework version that scaffolded the
 * module so a future `observability upgrade` can detect stale scaffolds.
 * Monorepo note: the config is per-project-root (resolved via
 * `resolveProjectRoot`), so a workspace with several Blok apps keeps an
 * independent observability set per app.
 */
export interface ObservabilityModuleConfig {
	/** Whether the module is active. Present-and-true is the only enabled state. */
	enabled: boolean;
	/** ISO timestamp the module was added (caller-supplied — keeps this layer pure). */
	addedAt: string;
	/** Framework version that scaffolded the module, for drift detection. */
	version?: string;
	/** Module-specific settings — e.g. obs-stack records its `{ tier }`. */
	settings?: Record<string, unknown>;
}

export interface ProjectConfig {
	triggers?: Record<string, TriggerConfig>;
	runtimes?: Record<string, RuntimeConfig>;
	/** Opt-in observability modules enabled in this project (keyed by module id). */
	observability?: Record<string, ObservabilityModuleConfig>;
}

// Backwards compatibility alias
export type ProjectRuntimeConfig = ProjectConfig;

/**
 * Setup a single runtime SDK in the project directory.
 *
 * This follows the existing Python3 pattern from project.ts:
 * 1. Copy SDK source to .blok/runtimes/{language}/
 * 2. Create runtimes/{language}/nodes/ for user nodes
 * 3. Symlink shared code between SDK and project
 * 4. Install dependencies
 */
export async function setupRuntime(
	runtime: RuntimeInfo,
	githubRepoLocal: string,
	projectDir: string,
	spinner: SpinnerHandler,
): Promise<RuntimeConfig> {
	const sdkSourcePath = path.join(githubRepoLocal, "sdks", runtime.sdkDir);
	const blokctlRuntimeDir = path.join(projectDir, ".blok", "runtimes", runtime.kind);
	const projectRuntimeDir = path.join(projectDir, "runtimes", runtime.kind);

	// Verify SDK source exists in cloned repo
	if (!fsExtra.existsSync(sdkSourcePath)) {
		throw new Error(
			`SDK source for ${runtime.label} not found at ${sdkSourcePath}. Make sure the Blok repository is up to date.`,
		);
	}

	spinner.message(`Setting up ${runtime.label} runtime...`);

	// 1. Copy SDK source to .blok/runtimes/{language}/
	fsExtra.ensureDirSync(path.dirname(blokctlRuntimeDir));
	fsExtra.copySync(sdkSourcePath, blokctlRuntimeDir);

	// 2. Create project-level runtimes directory for user nodes
	fsExtra.ensureDirSync(projectRuntimeDir);
	const nodesDir = path.join(projectRuntimeDir, "nodes");
	fsExtra.ensureDirSync(nodesDir);

	// 3. Language-specific setup (may return an override startCmd)
	let startCmdOverride: string | undefined;
	switch (runtime.kind) {
		case "python3":
			startCmdOverride = await setupPython3(blokctlRuntimeDir, spinner);
			break;
		case "go":
			await setupGo(blokctlRuntimeDir, spinner);
			break;
		case "rust":
			await setupRust(blokctlRuntimeDir, spinner);
			break;
		case "java":
			startCmdOverride = await setupJava(blokctlRuntimeDir, spinner);
			break;
		case "csharp":
			await setupCSharp(blokctlRuntimeDir, spinner);
			break;
		case "php":
			await setupPhp(blokctlRuntimeDir, spinner);
			break;
		case "ruby":
			startCmdOverride = await setupRuby(blokctlRuntimeDir, spinner);
			break;
	}

	// Compiled runtimes can't fs-scan user nodes at boot like Python — generate
	// a registration shim from runtimes/<lang>/nodes into the build module.
	if (runtime.kind === "go") {
		generateGoNodeRegistry(projectDir);
	} else if (runtime.kind === "rust") {
		generateRustNodeRegistry(projectDir);
	} else if (runtime.kind === "java") {
		generateJavaNodeRegistry(projectDir);
	} else if (runtime.kind === "csharp") {
		generateCSharpNodeRegistry(projectDir);
	}

	spinner.message(`${runtime.label} runtime setup complete.`);

	return buildRuntimeConfig(runtime, projectDir, startCmdOverride || runtime.startCmd);
}

/**
 * Build the `.blok/config.json` RuntimeConfig for a runtime WITHOUT copying or
 * installing its SDK — the pure config-shape half of setupRuntime. Used both by
 * setupRuntime (after the copy/install) and by `runtime add --enable`, which
 * wires an already-scaffolded runtime into config without reinstalling. Keeping
 * the shape in one place stops the two paths from drifting (e.g. the requiredVersion
 * floor). `startCmd` overrides the definition default (Java/Ruby resolve a real
 * binary during setup); enable passes none and uses the definition's startCmd.
 */
export function buildRuntimeConfig(runtime: RuntimeInfo, projectDir: string, startCmd?: string): RuntimeConfig {
	const blokctlRuntimeDir = path.join(projectDir, ".blok", "runtimes", runtime.kind);
	return {
		port: runtime.defaultPort,
		grpcPort: runtime.defaultGrpcPort,
		startCmd: startCmd ?? runtime.startCmd,
		grpcStartCmd: runtime.grpcStartCmd,
		cwd: path.relative(projectDir, blokctlRuntimeDir),
		kind: runtime.kind,
		label: runtime.label,
		version: runtime.version,
		requiredVersion: runtime.minVersion
			? computeDefaultConstraint(runtime.minVersion)
			: runtime.version
				? computeDefaultConstraint(runtime.version)
				: undefined,
		transport: "grpc",
	};
}

/**
 * Python3: create venv, install requirements (grpcio lives HERE, not in the
 * system interpreter — see #641). Returns the boot startCmd that runs the
 * sidecar with the VENV python, so `blokctl dev` doesn't fall back to a system
 * `python3` that lacks grpcio (PEP 668 blocks installing it there anyway) and
 * fail with GRPC_UNAVAILABLE. Relative to the runtime cwd (.blok/runtimes/python3).
 */
async function setupPython3(sdkDir: string, spinner: SpinnerHandler): Promise<string> {
	// Create virtual environment
	spinner.message("Creating Python3 virtual environment...");
	await createPythonVenv(sdkDir);
	spinner.message("Python3 virtual environment created.");

	// Install Python packages
	spinner.message("Installing Python3 packages...");
	const venvPip = path.join(sdkDir, "python3_runtime", "bin", "pip3");
	const requirementsFile = path.join(sdkDir, "requirements.txt");
	if (fsExtra.existsSync(requirementsFile)) {
		await exec(`"${venvPip}" install -r "${requirementsFile}"`, { cwd: sdkDir });
	}
	spinner.message("Python3 packages installed.");

	// User nodes live in projectRuntimeDir/nodes/<name>/node.py and are
	// discovered at boot via BLOK_NODES_DIR (set by dev/index.ts + supervisord).
	// No symlinks needed — the live SDK has no nodes/ or core/ dirs to link.

	// Boot with the venv python (where grpcio was installed), NOT system python3.
	return "python3_runtime/bin/python3 bin/serve.py";
}

async function createPythonVenv(sdkDir: string): Promise<void> {
	await exec("python3 -m venv python3_runtime", { cwd: sdkDir, timeout: 60000 });
}

/**
 * Go: download module dependencies.
 */
async function setupGo(sdkDir: string, spinner: SpinnerHandler): Promise<void> {
	spinner.message("Downloading Go dependencies...");
	await exec("go mod download", { cwd: sdkDir, timeout: 120000 });
	spinner.message("Go dependencies installed.");
}

/**
 * Generate the Go user-node registration shim.
 *
 * Go is compiled, so it can't fs-scan user nodes at boot like Python. Instead
 * we scan the project's `runtimes/go/nodes/<name>/` library packages, copy
 * their `.go` sources into the build module under `usernodes/<name>/`, and
 * generate `cmd/server/register_user_nodes.go` (a `package main` file
 * `main.go` already calls via `registerUserNodes(registry)`). `blokctl dev`
 * runs `go run ./cmd/server`, which recompiles and picks up the shim each boot.
 *
 * Returns the generated registry file path. A node dir is skipped (with a
 * warning) if it has no `.go` file exporting `Register(registry)`.
 *
 * ponytail: a genuine compile error *inside* an included node still fails the
 * build — inherent to compiled languages. The cheap `Register(` guard only
 * skips dirs that aren't conforming nodes, not ones that are broken Go.
 */
export function generateGoNodeRegistry(projectDir: string): string {
	const goSdkDir = path.join(projectDir, ".blok", "runtimes", "go");
	const nodesSrcDir = path.join(projectDir, "runtimes", "go", "nodes");
	const usernodesDir = path.join(goSdkDir, "usernodes");
	const registryFile = path.join(goSdkDir, "cmd", "server", "register_user_nodes.go");

	// Reset copied sources each run so deleted/renamed nodes don't linger.
	fsExtra.removeSync(usernodesDir);

	const nodes: Array<{ alias: string; importPath: string }> = [];
	if (fsExtra.existsSync(nodesSrcDir)) {
		let i = 0;
		for (const entry of fsExtra.readdirSync(nodesSrcDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const srcDir = path.join(nodesSrcDir, entry.name);
			const goFiles = fsExtra.readdirSync(srcDir).filter((f) => f.endsWith(".go"));
			if (goFiles.length === 0) continue;

			const exportsRegister = goFiles.some((f) =>
				/func\s+Register\s*\(/.test(fsExtra.readFileSync(path.join(srcDir, f), "utf8")),
			);
			if (!exportsRegister) {
				console.warn(`[blokctl] skipping Go node '${entry.name}': no exported Register(registry) found`);
				continue;
			}

			// Copy only .go sources into the module; the scaffold's go.mod/Dockerfile
			// (if any) would nest a module and break the build.
			const destDir = path.join(usernodesDir, entry.name);
			fsExtra.ensureDirSync(destDir);
			for (const f of goFiles) {
				fsExtra.copySync(path.join(srcDir, f), path.join(destDir, f));
			}

			nodes.push({
				alias: `usernode${i++}`,
				importPath: `github.com/nickincloud/blok-go/usernodes/${entry.name}`,
			});
		}
	}

	const importLines = [
		'\tblok "github.com/nickincloud/blok-go"',
		...nodes.map((n) => `\t${n.alias} "${n.importPath}"`),
	];
	const callLines = nodes.map((n) => `\t${n.alias}.Register(registry)`);
	const content = `// Code generated by blokctl. DO NOT EDIT.
package main

import (
${importLines.join("\n")}
)

// registerUserNodes registers nodes scaffolded under runtimes/go/nodes.
func registerUserNodes(registry *blok.NodeRegistry) {
${callLines.join("\n")}
}
`;

	fsExtra.ensureDirSync(path.dirname(registryFile));
	fsExtra.writeFileSync(registryFile, content);
	return registryFile;
}

/**
 * Generate the Rust user-node registration shim.
 *
 * Rust is compiled, so it can't fs-scan user nodes at boot like Python. Instead
 * we scan the project's `runtimes/rust/nodes/<name>/` library modules, copy
 * their `.rs` sources into the build module under `src/user_nodes/<modident>/`,
 * and generate `src/user_nodes/mod.rs` (a binary-crate module `main.rs` already
 * calls via `user_nodes::register_user_nodes(&mut registry)`). `blokctl dev`
 * runs `cargo run`, which recompiles and picks up the shim each boot.
 *
 * The registry NAME string keeps dashes (it's the workflow-facing node id); the
 * Rust module identifier sanitizes the name to a valid identifier
 * (dashes/anything non-alnum -> `_`, leading digit gets a `_` prefix).
 *
 * Returns the generated mod.rs path. A node dir is skipped (with a warning) if
 * it has no `.rs` file exporting `fn register(...)`.
 *
 * ponytail: a genuine compile error *inside* an included node still fails the
 * build — inherent to compiled languages. The cheap `fn register` guard only
 * skips dirs that aren't conforming nodes, not ones that are broken Rust.
 */
export function generateRustNodeRegistry(projectDir: string): string {
	const rustSdkDir = path.join(projectDir, ".blok", "runtimes", "rust");
	const nodesSrcDir = path.join(projectDir, "runtimes", "rust", "nodes");
	const usernodesDir = path.join(rustSdkDir, "src", "user_nodes");

	// Reset copied sources each run so deleted/renamed nodes don't linger. The
	// generated mod.rs (and per-node subdirs) live entirely under user_nodes/.
	fsExtra.removeSync(usernodesDir);
	fsExtra.ensureDirSync(usernodesDir);

	// Sanitize a node name to a valid Rust module identifier.
	const toModIdent = (name: string): string => {
		let id = name.replace(/[^a-zA-Z0-9_]/g, "_");
		if (/^[0-9]/.test(id)) id = `_${id}`;
		return id;
	};

	const mods: string[] = [];
	if (fsExtra.existsSync(nodesSrcDir)) {
		for (const entry of fsExtra.readdirSync(nodesSrcDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const srcDir = path.join(nodesSrcDir, entry.name);
			const rsFiles = fsExtra.readdirSync(srcDir).filter((f) => f.endsWith(".rs"));
			if (rsFiles.length === 0) continue;

			// Find the file that exports `fn register(...)` — it becomes the
			// module root (mod.rs). Siblings ride along as submodules.
			const rootFile = rsFiles.find((f) =>
				/fn\s+register\s*\(/.test(fsExtra.readFileSync(path.join(srcDir, f), "utf8")),
			);
			if (!rootFile) {
				console.warn(`[blokctl] skipping Rust node '${entry.name}': no .rs exporting fn register(registry) found`);
				continue;
			}

			const modIdent = toModIdent(entry.name);
			const destDir = path.join(usernodesDir, modIdent);
			fsExtra.ensureDirSync(destDir);

			// Copy the conforming file as the module root; any other .rs files
			// are copied alongside and declared as submodules at the top of it.
			const siblings = rsFiles.filter((f) => f !== rootFile);
			for (const f of siblings) {
				fsExtra.copySync(path.join(srcDir, f), path.join(destDir, f));
			}
			let rootSrc = fsExtra.readFileSync(path.join(srcDir, rootFile), "utf8");
			if (siblings.length > 0) {
				const subMods = siblings.map((f) => `mod ${path.basename(f, ".rs")};`).join("\n");
				rootSrc = `${subMods}\n\n${rootSrc}`;
			}
			fsExtra.writeFileSync(path.join(destDir, "mod.rs"), rootSrc);

			mods.push(modIdent);
		}
	}

	// User node files are modules of the BINARY crate (blok-rs); they reference
	// the library crate as `blok::` (NOT `crate::`, which is the binary crate).
	const modLines = mods.map((m) => `pub mod ${m};`);
	const callLines = mods.map((m) => `\t${m}::register(registry);`);
	const content = `// Code generated by blokctl. DO NOT EDIT.
use blok::registry::NodeRegistry;

${modLines.join("\n")}

/// Registers nodes scaffolded under runtimes/rust/nodes.
pub fn register_user_nodes(${mods.length > 0 ? "registry" : "_registry"}: &mut NodeRegistry) {
${callLines.join("\n")}
}
`;

	const registryFile = path.join(usernodesDir, "mod.rs");
	fsExtra.writeFileSync(registryFile, content);
	return registryFile;
}

/**
 * Generate the Java user-node registration shim.
 *
 * Java is compiled and `blokctl dev` boots a prebuilt jar (not recompile-on-boot),
 * so it can't fs-scan user nodes at runtime like Python. Instead we scan the
 * project's `runtimes/java/nodes/<name>/src/main/java/**` library packages, copy
 * each node's `src/main/java` subtree into the build module under
 * `usernodes/<name>/`, and generate `com/blok/blok/UserNodeRegistry.java`
 * (which `Main.java` calls via `UserNodeRegistry.registerUserNodes(registry)`).
 * The caller must run `mvn package` AFTER this so the jar includes the shim.
 *
 * Returns the generated registry file path. A node dir is skipped (with a
 * warning) if it has no `src/main/java`, or no `.java` declaring a class that
 * `implements NodeHandler`.
 *
 * ponytail: the conforming-class scan reads `package` + `class … implements
 * NodeHandler` with regexes — cheap and sufficient for the scaffold shape. A
 * genuine compile error *inside* an included node still fails `mvn package`,
 * inherent to compiled languages; the regex only skips non-node dirs.
 */
export function generateJavaNodeRegistry(projectDir: string): string {
	const javaSdkDir = path.join(projectDir, ".blok", "runtimes", "java");
	const nodesSrcDir = path.join(projectDir, "runtimes", "java", "nodes");
	const sdkJavaRoot = path.join(javaSdkDir, "src", "main", "java");
	const usernodesDir = path.join(sdkJavaRoot, "usernodes");
	const registryFile = path.join(sdkJavaRoot, "com", "blok", "blok", "UserNodeRegistry.java");

	// Reset copied sources each run so deleted/renamed nodes don't linger.
	fsExtra.removeSync(usernodesDir);

	const registrations: string[] = [];
	if (fsExtra.existsSync(nodesSrcDir)) {
		for (const entry of fsExtra.readdirSync(nodesSrcDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const nodeSrcRoot = path.join(nodesSrcDir, entry.name, "src", "main", "java");
			if (!fsExtra.existsSync(nodeSrcRoot)) {
				console.warn(`[blokctl] skipping Java node '${entry.name}': no src/main/java found`);
				continue;
			}

			// Find the .java declaring a class that implements NodeHandler and
			// read its fully-qualified name from the package + class decl.
			const javaFiles: string[] = [];
			const walk = (dir: string): void => {
				for (const f of fsExtra.readdirSync(dir, { withFileTypes: true })) {
					const full = path.join(dir, f.name);
					if (f.isDirectory()) walk(full);
					else if (f.name.endsWith(".java")) javaFiles.push(full);
				}
			};
			walk(nodeSrcRoot);

			let fqcn: string | undefined;
			for (const file of javaFiles) {
				const src = fsExtra.readFileSync(file, "utf8");
				const classMatch = src.match(/class\s+(\w+)\s+implements\s+NodeHandler/);
				if (!classMatch) continue;
				const pkgMatch = src.match(/package\s+([\w.]+)\s*;/);
				fqcn = pkgMatch ? `${pkgMatch[1]}.${classMatch[1]}` : classMatch[1];
				break;
			}
			if (!fqcn) {
				console.warn(`[blokctl] skipping Java node '${entry.name}': no class implementing NodeHandler found`);
				continue;
			}

			// Copy the node's package tree into the build module's source root so
			// it compiles in-tree alongside the SDK's own nodes.
			fsExtra.copySync(nodeSrcRoot, path.join(usernodesDir, entry.name));
			registrations.push(`\t\tregistry.register("${entry.name}", new ${fqcn}());`);
		}
	}

	const content = `// Code generated by blokctl. DO NOT EDIT.
package com.blok.blok;

import com.blok.blok.node.NodeRegistry;

public final class UserNodeRegistry {

\tprivate UserNodeRegistry() {
\t}

\t/** Registers nodes scaffolded under runtimes/java/nodes. */
\tpublic static void registerUserNodes(NodeRegistry registry) {
${registrations.join("\n")}
\t}
}
`;

	fsExtra.ensureDirSync(path.dirname(registryFile));
	fsExtra.writeFileSync(registryFile, content);
	return registryFile;
}

/**
 * Generate the C# user-node registration shim.
 *
 * C# is compiled, so it can't fs-scan user nodes at boot like Python. Instead
 * we scan the project's `runtimes/csharp/nodes/<name>/` library nodes, copy
 * their `.cs` sources into the build module under
 * `src/Blok.Core/Nodes/UserNodes/<name>/` (auto-compiled by the project's
 * default .cs globs), and generate
 * `src/Blok.Core/UserNodeRegistry.cs` — a `Blok.Core.UserNodeRegistry` class
 * `Program.cs` already calls via `UserNodeRegistry.RegisterUserNodes(registry)`.
 * `blokctl dev` runs `dotnet run --project src/Blok.Core`, which rebuilds and
 * picks up the shim each boot.
 *
 * Returns the generated registry file path. A node dir is skipped (with a
 * warning) if it has no `.cs` file declaring a `class X : INodeHandler`.
 * Duplicate class names across nodes share one namespace and would collide, so
 * the second one is skipped with a warning.
 *
 * ponytail: a genuine compile error *inside* an included node still fails the
 * build — inherent to compiled languages. The cheap `class \w+ : INodeHandler`
 * regex only skips dirs that aren't conforming nodes, not ones that are broken
 * C#.
 */
export function generateCSharpNodeRegistry(projectDir: string): string {
	const csSdkDir = path.join(projectDir, ".blok", "runtimes", "csharp");
	const nodesSrcDir = path.join(projectDir, "runtimes", "csharp", "nodes");
	const usernodesDir = path.join(csSdkDir, "src", "Blok.Core", "Nodes", "UserNodes");
	const registryFile = path.join(csSdkDir, "src", "Blok.Core", "UserNodeRegistry.cs");

	// Reset copied sources each run so deleted/renamed nodes don't linger and
	// recompile into the build module.
	fsExtra.removeSync(usernodesDir);

	const seenClasses = new Set<string>();
	const registrations: Array<{ nodeName: string; className: string }> = [];

	if (fsExtra.existsSync(nodesSrcDir)) {
		for (const entry of fsExtra.readdirSync(nodesSrcDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const srcDir = path.join(nodesSrcDir, entry.name);

			// A node dir may nest src/ subfolders — scan recursively for .cs.
			const csFiles = collectFilesRecursive(srcDir, ".cs");
			if (csFiles.length === 0) continue;

			// Find the handler class. The conforming marker is `class X : INodeHandler`.
			let className: string | undefined;
			for (const file of csFiles) {
				const match = fsExtra.readFileSync(file, "utf8").match(/class\s+(\w+)\s*:\s*INodeHandler\b/);
				if (match) {
					className = match[1];
					break;
				}
			}
			if (!className) {
				console.warn(`[blokctl] skipping C# node '${entry.name}': no 'class X : INodeHandler' found`);
				continue;
			}

			// Single namespace (Blok.Core.Nodes) — duplicate class names collide.
			if (seenClasses.has(className)) {
				console.warn(
					`[blokctl] skipping C# node '${entry.name}': duplicate class name '${className}' (single namespace Blok.Core.Nodes)`,
				);
				continue;
			}
			seenClasses.add(className);

			// Copy only .cs sources into the build module; the scaffold has no
			// csproj/Dockerfile to exclude, but copy flat under the node dir so the
			// default compile globs pick them up.
			const destDir = path.join(usernodesDir, entry.name);
			fsExtra.ensureDirSync(destDir);
			for (const file of csFiles) {
				fsExtra.copySync(file, path.join(destDir, path.basename(file)));
			}

			registrations.push({ nodeName: entry.name, className });
		}
	}

	const callLines = registrations.map(
		(r) => `\t\tregistry.Register("${r.nodeName}", new Blok.Core.Nodes.${r.className}());`,
	);
	const content = `// Code generated by blokctl. DO NOT EDIT.
using Blok.Core.Node;

namespace Blok.Core;

/// <summary>
/// Registers user nodes scaffolded under runtimes/csharp/nodes.
/// </summary>
public static class UserNodeRegistry
{
	public static void RegisterUserNodes(NodeRegistry registry)
	{
${callLines.join("\n")}
	}
}
`;

	fsExtra.ensureDirSync(path.dirname(registryFile));
	fsExtra.writeFileSync(registryFile, content);
	return registryFile;
}

/** Recursively collect files with the given extension under `dir`. */
function collectFilesRecursive(dir: string, ext: string): string[] {
	const out: string[] = [];
	for (const entry of fsExtra.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...collectFilesRecursive(full, ext));
		} else if (entry.name.endsWith(ext)) {
			out.push(full);
		}
	}
	return out;
}

/**
 * Rust: build the project (this also downloads dependencies).
 *
 * Debug profile + grpc feature — the exact configuration `blokctl dev` boots
 * (`cargo run --features grpc`), so the long cold build happens HERE behind
 * the spinner instead of inside dev's runtime-readiness window. A release
 * build would warm nothing dev uses.
 */
async function setupRust(sdkDir: string, spinner: SpinnerHandler): Promise<void> {
	spinner.message("Building Rust project (this may take a few minutes on first build)...");
	await exec("cargo build --features grpc", { cwd: sdkDir, timeout: 600000 });
	spinner.message("Rust project built.");
}

/**
 * Java: download dependencies and package with Maven.
 * Returns an override startCmd if the default `java` isn't in PATH (e.g., macOS Homebrew).
 */
async function setupJava(sdkDir: string, spinner: SpinnerHandler): Promise<string | undefined> {
	spinner.message("Building Java project with Maven...");
	await exec("mvn package -q -DskipTests", { cwd: sdkDir, timeout: 300000 });
	spinner.message("Java project built.");

	// Resolve the correct java binary (macOS ships a stub at /usr/bin/java that fails)
	const javaCandidates = ["java", "/opt/homebrew/opt/openjdk/bin/java"];
	for (const javaBin of javaCandidates) {
		try {
			await exec(`${javaBin} --version`, { timeout: 5000 });
			if (javaBin !== "java") {
				return `${javaBin} -jar target/blok-java-1.0.0.jar`;
			}
			return undefined; // default startCmd works
		} catch {
			// try next candidate
		}
	}
	return undefined;
}

/**
 * C# / .NET: restore NuGet packages.
 */
async function setupCSharp(sdkDir: string, spinner: SpinnerHandler): Promise<void> {
	spinner.message("Restoring .NET packages...");
	await exec("dotnet restore", { cwd: sdkDir, timeout: 120000 });
	spinner.message(".NET packages restored.");
}

/**
 * PHP: install Composer dependencies.
 */
async function setupPhp(sdkDir: string, spinner: SpinnerHandler): Promise<void> {
	spinner.message("Installing PHP dependencies...");
	await exec("composer install --no-dev --optimize-autoloader", { cwd: sdkDir, timeout: 120000 });
	spinner.message("PHP dependencies installed.");
}

/**
 * Ruby: install Bundler dependencies.
 * Returns an override startCmd if the system `bundle` is too old (e.g., macOS ships Ruby 2.6).
 */
async function setupRuby(sdkDir: string, spinner: SpinnerHandler): Promise<string> {
	// Resolve the correct bundle binary (macOS ships Ruby 2.6 + Bundler 1.x)
	const bundleCandidates = ["bundle", "/opt/homebrew/opt/ruby/bin/bundle"];
	let resolvedBundle = "bundle";

	for (const bin of bundleCandidates) {
		try {
			const { stdout } = await exec(`${bin} --version`, { timeout: 5000 });
			const match = stdout.match(/(\d+)\./);
			const major = match ? Number.parseInt(match[1], 10) : 0;
			// Need Bundler 2+ for modern gemspecs
			if (major >= 2) {
				resolvedBundle = bin;
				break;
			}
		} catch {
			// try next candidate
		}
	}

	spinner.message("Installing Ruby dependencies...");
	await exec(`"${resolvedBundle}" install`, { cwd: sdkDir, timeout: 120000 });
	spinner.message("Ruby dependencies installed.");

	// bin/serve.rb honors BLOK_TRANSPORT/PORT/GRPC_PORT env (rackup would boot
	// the HTTP-only Rack app and never start the gRPC server blokctl expects).
	// Exec the SAME installation's ruby as the resolved bundle: a bare `ruby`
	// re-resolves from $PATH, and brew Bundler + macOS system ruby 2.6 dies
	// with `uninitialized constant Gem::Resolver::APISet::GemParser`.
	const resolvedRuby = resolvedBundle.includes("/") ? path.join(path.dirname(resolvedBundle), "ruby") : "ruby";
	return `${resolvedBundle} exec ${resolvedRuby} bin/serve.rb`;
}

/**
 * Write the .blok/config.json file with runtime, trigger, and (optionally)
 * observability-module configuration. The observability map round-trips
 * verbatim, so a create-time picker can persist enabled modules in the same
 * write. Incremental `observability add`/`remove` bypass this builder and
 * merge into the full existing config directly (preserving all keys).
 */
export function writeProjectConfig(
	projectDir: string,
	runtimeConfigs: RuntimeConfig[],
	triggerConfigs?: TriggerConfig[],
	observabilityConfigs?: Record<string, ObservabilityModuleConfig>,
): void {
	const config: ProjectConfig = {};

	if (runtimeConfigs.length > 0) {
		config.runtimes = {};
		for (const rc of runtimeConfigs) {
			config.runtimes[rc.kind] = rc;
		}
	}

	if (triggerConfigs && triggerConfigs.length > 0) {
		config.triggers = {};
		for (const tc of triggerConfigs) {
			config.triggers[tc.kind] = tc;
		}
	}

	if (observabilityConfigs && Object.keys(observabilityConfigs).length > 0) {
		config.observability = observabilityConfigs;
	}

	const configPath = path.join(projectDir, ".blok", "config.json");
	fsExtra.ensureDirSync(path.dirname(configPath));
	fsExtra.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/**
 * Read the .blok/config.json file.
 * Returns null if file doesn't exist.
 */
export function readProjectConfig(projectDir: string): ProjectConfig | null {
	const configPath = path.join(projectDir, ".blok", "config.json");
	if (!fsExtra.existsSync(configPath)) {
		return null;
	}
	return JSON.parse(fsExtra.readFileSync(configPath, "utf8"));
}

/**
 * Generate environment variable entries for selected runtimes.
 *
 * Emits both `RUNTIME_<K>_PORT` (retained for back-compat with older
 * configs) and `RUNTIME_<K>_GRPC_PORT` (what the runner probes — gRPC
 * has been the sole transport since v0.5). The trigger-http reads both
 * at boot.
 */
export function generateRuntimeEnvVars(runtimeConfigs: RuntimeConfig[]): string {
	if (runtimeConfigs.length === 0) return "";

	const lines = ["\n# Runtimes (auto-configured by blokctl)"];

	for (const rc of runtimeConfigs) {
		const envKey = rc.kind === "csharp" ? "CSHARP" : rc.kind.toUpperCase();
		lines.push(`RUNTIME_${envKey}_HOST=localhost`);
		lines.push(`RUNTIME_${envKey}_PORT=${rc.port}`);
		if (rc.grpcPort !== undefined) {
			lines.push(`RUNTIME_${envKey}_GRPC_PORT=${rc.grpcPort}`);
		}
	}

	// BLOK_TRANSPORT is purely informational at the runner layer since v0.5
	// (gRPC is the sole transport; `assertGrpcOnlyTransport` rejects any
	// `RUNTIME_TRANSPORT=http` config). We still emit it so users grepping
	// for `BLOK_TRANSPORT` in their `.env` find it.
	lines.push("BLOK_TRANSPORT=grpc");

	return lines.join("\n");
}

/**
 * Generate supervisord config entries for selected runtimes. Each program
 * boots with `BLOK_TRANSPORT=grpc` and a `GRPC_PORT` matching the
 * runtime's gRPC listener so the trigger and CLI can reach it.
 */
export function generateSupervisordConfig(runtimeConfigs: RuntimeConfig[]): string {
	let config = "";

	for (const rc of runtimeConfigs) {
		const cmd = rc.grpcStartCmd ?? rc.startCmd;
		const grpcPortLine = rc.grpcPort !== undefined ? `,GRPC_PORT="${rc.grpcPort}"` : "";
		// Dynamic runtimes fs-scan this dir at boot (serve.py / serve.rb / serve.php).
		const nodesDirLine =
			rc.kind === "python3" || rc.kind === "ruby" || rc.kind === "php"
				? `,BLOK_NODES_DIR="/app/runtimes/${rc.kind}/nodes"`
				: "";
		config += `
[program:${rc.kind}_runtime]
command=${cmd}
directory=/app/${rc.cwd}
environment=PORT="${rc.port}"${grpcPortLine}${nodesDirLine},HOST="0.0.0.0",BLOK_TRANSPORT="grpc"
autostart=true
autorestart=true
stderr_logfile=/var/log/${rc.kind}.err.log
stdout_logfile=/var/log/${rc.kind}.out.log
`;
	}

	return config;
}

/**
 * Result of validating a single runtime's version against its constraint.
 */
export interface RuntimeValidationResult {
	kind: string;
	label: string;
	required: string;
	found: string | undefined;
	satisfied: boolean;
	message: string;
}

/**
 * Validate all project runtimes against their version constraints.
 *
 * Reads `.blok/config.json`, re-detects current runtime versions,
 * and checks each against its `requiredVersion` constraint.
 *
 * Runtimes without a `requiredVersion` are skipped (backward compatible).
 */
export async function validateProjectRuntimes(projectDir: string): Promise<RuntimeValidationResult[]> {
	const config = readProjectConfig(projectDir);
	if (!config?.runtimes) return [];

	const results: RuntimeValidationResult[] = [];

	for (const [kind, rc] of Object.entries(config.runtimes)) {
		// Skip runtimes without version constraints (backward compatibility)
		if (!rc.requiredVersion) continue;

		const currentVersion = await detectRuntimeVersion(kind);

		const satisfied = currentVersion ? satisfiesConstraint(currentVersion, rc.requiredVersion) : false;

		const message = satisfied
			? formatVersionSuccess(rc.label, currentVersion as string, rc.requiredVersion)
			: formatVersionMismatch(rc.label, currentVersion, rc.requiredVersion);

		results.push({
			kind,
			label: rc.label,
			required: rc.requiredVersion,
			found: currentVersion,
			satisfied,
			message,
		});
	}

	return results;
}

// ============================================================================
// Trigger Configuration Helpers
// ============================================================================

/** Default port mapping for each trigger type */
const TRIGGER_PORTS: Record<string, number> = {
	http: 4000,
	sse: 4001,
	websocket: 4002,
	grpc: 4003,
	cron: 4004,
	queue: 4005,
	pubsub: 4006,
	webhook: 4007,
	worker: 4008,
};

/** Human-readable labels for each trigger type */
const TRIGGER_LABELS: Record<string, string> = {
	http: "HTTP Trigger",
	sse: "SSE Trigger",
	websocket: "WebSocket Trigger",
	grpc: "gRPC Trigger",
	cron: "Cron Trigger",
	queue: "Queue Trigger",
	pubsub: "PubSub Trigger",
	webhook: "Webhook Trigger",
	worker: "Worker Trigger",
};

/**
 * Get the default port for a trigger type.
 */
export function getTriggerPort(triggerKind: string): number {
	return TRIGGER_PORTS[triggerKind] ?? 4000;
}

/**
 * Get the human-readable label for a trigger type.
 */
export function getTriggerLabel(triggerKind: string): string {
	return TRIGGER_LABELS[triggerKind] ?? `${triggerKind.toUpperCase()} Trigger`;
}

/**
 * Create a TriggerConfig object for a given trigger type.
 */
export function createTriggerConfig(triggerKind: string): TriggerConfig {
	const port = getTriggerPort(triggerKind);
	return {
		kind: triggerKind,
		label: getTriggerLabel(triggerKind),
		port,
		entryPoint: `src/triggers/${triggerKind}/index.ts`,
		startCmd: `bun run src/triggers/${triggerKind}/index.ts`,
	};
}

/**
 * Generate environment variable entries for selected triggers.
 */
export function generateTriggerEnvVars(triggerConfigs: TriggerConfig[]): string {
	if (triggerConfigs.length === 0) return "";

	const lines = ["\n# Triggers (auto-configured by blokctl)"];

	for (const tc of triggerConfigs) {
		lines.push(`TRIGGER_${tc.kind.toUpperCase()}_PORT=${tc.port}`);
	}

	return lines.join("\n");
}

/**
 * Generate supervisord config entries for selected triggers.
 */
export function generateTriggerSupervisordConfig(triggerConfigs: TriggerConfig[]): string {
	let config = "";

	for (const tc of triggerConfigs) {
		config += `
[program:${tc.kind}_trigger]
command=${tc.startCmd}
directory=/app
environment=PORT="${tc.port}",HOST="0.0.0.0"
autostart=true
autorestart=true
stderr_logfile=/var/log/${tc.kind}_trigger.err.log
stdout_logfile=/var/log/${tc.kind}_trigger.out.log
`;
	}

	return config;
}
