/**
 * Spawn plan for the persistent JavaScript runtime worker (ADR 0016 §3).
 *
 * The orchestrator host and the project's JavaScript execution target are
 * different axes. When they differ, `runtime.nodejs` / `runtime.bun` /
 * `runtime.deno` steps execute in a long-lived `@blokjs/runtime-worker`
 * process rather than in the trigger process — and `blokctl dev` is what puts
 * that process on the machine, health-probed and restarted like any other
 * sidecar.
 *
 * Nothing here ever substitutes a different engine: a missing binary, a
 * too-old binary, or a missing worker package produces a reported skip with
 * exact remediation, and the affected steps then fail loudly at runtime.
 */

import child_process from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { JavaScriptRuntime } from "@blokjs/shared";
import { JS_WORKER_ENTRY, detectJavaScriptRuntime } from "./runtime-detector.js";

export interface JsWorkerSpawn {
	cmd: string;
	args: string[];
	name: string;
	cwd: string;
	env: Record<string, string>;
	port: number;
	/** Permission flags actually granted (Deno only; empty elsewhere). */
	permissions: string[];
}

export type JsWorkerPlan =
	| { kind: "spawn"; spawn: JsWorkerSpawn }
	| { kind: "in-process"; reason: string }
	| { kind: "skip"; reason: string };

/** Which engine hosts the orchestrator. `blokctl dev` boots triggers under
 * Bun unless the trigger's own `startCmd` says otherwise. */
export function hostTargetFromStartCommands(startCmds: readonly string[]): JavaScriptRuntime {
	for (const cmd of startCmds) {
		const bin = path.basename(cmd.trim().split(/\s+/)[0] ?? "");
		if (bin === "node") return "node";
		if (bin === "deno") return "deno";
		if (bin === "bun") return "bun";
	}
	return "bun";
}

/** gRPC port for a target: explicit override wins, then the canonical default. */
export function jsWorkerPort(target: JavaScriptRuntime, defaultPort: number, env = process.env): number {
	const kind = target === "node" ? "NODEJS" : target.toUpperCase();
	const parsed = Number.parseInt(env[`RUNTIME_${kind}_GRPC_PORT`] ?? "", 10);
	return Number.isNaN(parsed) || parsed <= 0 ? defaultPort : parsed;
}

/**
 * Deno's switch for Node-style `.js` specifiers that resolve to `.ts` sources.
 *
 * A scaffolded project compiles under `moduleResolution: nodenext`, so
 * `src/Nodes.ts` imports `./nodes/examples/index.js` while only `index.ts`
 * exists on disk (#709/#741). Node resolves that after `tsc`; Bun rewrites it;
 * Deno refuses without this flag. It is a RESOLUTION switch, not a permission —
 * it grants the worker no additional authority.
 *
 * The spelling moved from `--unstable-sloppy-imports` to `--sloppy-imports` in
 * Deno 2.2, and both are accepted on current releases, so probe rather than
 * pin: the CLI must work against whichever Deno the user installed.
 */
let sloppyImportsFlag: string | null | undefined;
export function denoSloppyImportsFlag(binary: string): string | null {
	if (sloppyImportsFlag !== undefined) return sloppyImportsFlag;
	for (const candidate of ["--unstable-sloppy-imports", "--sloppy-imports"]) {
		const probe = child_process.spawnSync(binary, ["run", candidate, "--help"], { stdio: "ignore", timeout: 15_000 });
		if (probe.status === 0) {
			sloppyImportsFlag = candidate;
			return candidate;
		}
	}
	sloppyImportsFlag = null;
	return null;
}

/** Test-only: drop the probe result so a different binary is re-probed. */
export function _resetDenoFlagProbe(): void {
	sloppyImportsFlag = undefined;
}

/**
 * Ask the worker, under least-privilege introspection flags, which effects its
 * nodes declare — then use the flags it computed from them. Falls back to the
 * introspection baseline (and says so) when the probe can't run, so a Deno
 * worker never silently launches with more authority than it could justify.
 */
function derivedDenoFlags(
	binary: string,
	entry: string,
	projectRoot: string,
	env: Record<string, string>,
	baseline: string[],
): { flags: string[]; note: string; grants: Array<{ flag: string; reason: string }> } {
	try {
		const probe = child_process.spawnSync(binary, [...baseline, entry, "--print-permissions"], {
			cwd: projectRoot,
			env: { ...process.env, ...env },
			encoding: "utf8",
			timeout: 60_000,
		});
		const line = (probe.stdout ?? "").split("\n").find((l) => l.startsWith("BLOK_PERMISSIONS "));
		if (!line) {
			return {
				flags: baseline,
				grants: [],
				note: "could not read declared capabilities; running with the least-privilege baseline",
			};
		}
		const parsed = JSON.parse(line.slice("BLOK_PERMISSIONS ".length)) as {
			effects: string[];
			flags: string[];
			grants?: Array<{ flag: string; reason: string }>;
		};
		return {
			flags: parsed.flags,
			grants: parsed.grants ?? [],
			note: parsed.effects.length > 0 ? `declared effects: ${parsed.effects.join(", ")}` : "no declared effects",
		};
	} catch (err) {
		return {
			flags: baseline,
			grants: [],
			note: `capability probe failed (${(err as Error).message.split("\n")[0]}); running with the least-privilege baseline`,
		};
	}
}

/**
 * Decide what (if anything) `blokctl dev` should spawn for this project's
 * JavaScript execution target.
 */
export async function planJsWorker(options: {
	projectRoot: string;
	target: JavaScriptRuntime;
	hostTarget: JavaScriptRuntime;
	blobDir?: string | null;
}): Promise<JsWorkerPlan> {
	const { projectRoot, target, hostTarget } = options;

	if (process.env.BLOK_SKIP_JS_WORKER === "1") {
		return { kind: "skip", reason: "BLOK_SKIP_JS_WORKER=1" };
	}
	if (target === hostTarget) {
		return {
			kind: "in-process",
			reason: `the orchestrator host is ${target}, so runtime.${target === "node" ? "nodejs" : target} steps execute in-process`,
		};
	}

	const info = await detectJavaScriptRuntime(target);
	if (!info.available) return { kind: "skip", reason: info.remediation };

	const entry = path.join(projectRoot, JS_WORKER_ENTRY);
	if (!fs.existsSync(entry)) {
		return {
			kind: "skip",
			reason: `@blokjs/runtime-worker is not installed (expected ${JS_WORKER_ENTRY}). Add it to the project's dependencies and re-install.`,
		};
	}

	const port = jsWorkerPort(target, info.defaultGrpcPort);
	const env: Record<string, string> = { GRPC_PORT: String(port), HOST: "127.0.0.1" };
	if (options.blobDir) env.BLOK_BLOB_DIR = options.blobDir;

	let permissions: string[] = [];
	if (target === "deno") {
		// Mirrors `denoIntrospectionFlags` in @blokjs/runtime-worker; kept here so
		// the CLI can build phase 1 before the worker package is loadable.
		// The worker package can be a symlink outside the project (a `file:`
		// dependency in a dev scaffold), and Deno checks REAL paths for explicit
		// filesystem reads — the worker reads its own `runtime.proto` at boot.
		const workerRoot = path.resolve(path.dirname(fs.realpathSync(entry)), "..");
		const readPaths = [projectRoot];
		if (!workerRoot.startsWith(projectRoot)) readPaths.push(workerRoot);
		if (options.blobDir) readPaths.push(options.blobDir);
		const read = readPaths.join(",");
		const baseline = [`--allow-net=127.0.0.1:${port},localhost:${port}`, `--allow-read=${read}`, "--allow-env"];
		// Resolution switches, not permissions — appended to whatever grant set
		// we end up with, never counted as authority.
		const sloppy = denoSloppyImportsFlag(info.binary);
		if (!sloppy) {
			console.log(
				"  ! Deno worker: this Deno build has no sloppy-imports flag; a `.js` specifier pointing at a `.ts` source will not resolve.",
			);
		}
		const resolution = ["--node-modules-dir=manual", ...(sloppy ? [sloppy] : [])];

		if (process.env.BLOK_DENO_ALLOW_ALL === "1") {
			permissions = ["--allow-all", ...resolution];
			console.log(
				"  ! Deno worker: BLOK_DENO_ALLOW_ALL=1 — launching with --allow-all. This disables Deno's permission boundary and must not be a production default.",
			);
		} else {
			const derived = derivedDenoFlags(info.binary, entry, projectRoot, env, [...baseline, ...resolution]);
			permissions = [...derived.flags, ...resolution];
			console.log(`  Deno worker permissions: ${derived.flags.join(" ")} (${derived.note})`);
			// Print WHY each grant exists. Least privilege the operator cannot
			// inspect is indistinguishable from --allow-all with extra steps.
			for (const grant of derived.grants) console.log(`    ${grant.flag} — ${grant.reason}`);
			if (derived.flags.includes("--allow-net")) {
				console.log(
					"    ! --allow-net is unrestricted. A capability manifest names no outbound hosts; set BLOK_DENO_ALLOW_NET=host[:port],… to scope it.",
				);
			}
		}
	}

	return {
		kind: "spawn",
		spawn: {
			cmd: info.binary,
			args: target === "deno" ? ["run", ...permissions, entry] : [entry],
			name: `${info.label} Worker (grpc port ${port})`,
			cwd: projectRoot,
			env,
			port,
			permissions,
		},
	};
}
