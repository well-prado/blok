import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import color from "picocolors";
import type { OptionValues } from "../../services/commander.js";
import { isNonInteractive } from "../../services/non-interactive.js";
import { type RuntimeInfo, detectRuntimes, getRuntimeDefinition } from "../../services/runtime-detector.js";
import {
	ensureRuntimeGitignore,
	rewriteRuntimeEnvBlock,
	rewriteSupervisordRuntimes,
	runtimeEnvKey,
	withRuntime,
} from "../../services/runtime-mutations.js";
import {
	type ProjectConfig,
	type RuntimeConfig,
	buildRuntimeConfig,
	setupRuntime,
} from "../../services/runtime-setup.js";
import {
	RuntimeCommandError,
	assertGrpcPortFree,
	assertSidecarKind,
	readConfigSafe,
	reportRuntimeError,
	resolveProjectRoot,
	resolveSdkSource,
} from "./shared.js";

/**
 * `blokctl runtime add [lang]` — add a language sidecar runtime to an existing
 * project. Copies the version-matched SDK into `.blok/runtimes/<lang>/`,
 * installs/builds it, and merges the runtime into `.blok/config.json` +
 * `.env.local` + `supervisord.conf`. Projects scaffolded with `--examples`
 * also get the runtime's hello example workflow (copied + registered in
 * src/Workflows.ts, same as `create project`). No runner changes — the
 * framework already resolves all seven `runtime.<lang>` step types. When
 * `lang` is omitted in interactive mode, an availability-aware picker is shown.
 */
export async function runtimeAdd(kindArg: string | undefined, options: OptionValues): Promise<void> {
	try {
		// Cheap input validation first — fail before the toolchain detection sweep.
		let grpcPortOverride: number | undefined;
		if (options.grpcPort !== undefined) {
			const parsed = Number(options.grpcPort);
			if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
				throw new RuntimeCommandError(`--grpc-port must be an integer 1-65535 (got "${options.grpcPort}").`);
			}
			grpcPortOverride = parsed;
		}

		const root = resolveProjectRoot(options.directory);
		const config = readConfigSafe(root);
		const installedKinds = Object.keys(config.runtimes ?? {});
		const nonInteractive = isNonInteractive() || options.yes === true;

		// Detection is only needed up-front when we have to show a picker.
		let detected: RuntimeInfo[] | undefined;
		let kind = kindArg?.trim().toLowerCase();
		if (!kind) {
			if (nonInteractive) {
				throw new RuntimeCommandError("Specify a runtime: blokctl runtime add <go|rust|java|csharp|php|ruby|python3>");
			}
			detected = await detectRuntimes();
			const choices = detected
				.filter((d) => !installedKinds.includes(d.kind))
				.map((d) => ({
					value: d.kind,
					label: d.label,
					hint: d.available ? `${d.toolchain} ready` : `needs ${d.toolchain}`,
				}));
			if (choices.length === 0) {
				p.intro(color.inverse(" Add runtime "));
				p.outro(color.dim("All supported runtimes are already installed."));
				return;
			}
			const picked = await p.select({ message: "Which runtime do you want to add?", options: choices });
			if (p.isCancel(picked)) {
				p.cancel("Cancelled.");
				return;
			}
			kind = picked as string;
		}

		assertSidecarKind(kind);
		const def = getRuntimeDefinition(kind);
		if (!def) throw new RuntimeCommandError(`Unknown runtime "${kind}".`);
		const sdkDir = path.join(root, ".blok", "runtimes", kind);
		const alreadyInstalled = Boolean(config.runtimes?.[kind]) || fs.existsSync(sdkDir);

		p.intro(color.inverse(` Add ${def.label} runtime `));

		// 0. `--enable`: wire an ALREADY-scaffolded runtime (SDK dir on disk) into
		// .blok/config.json WITHOUT re-copying or re-installing it — for a dir that
		// exists but is missing from config (hand-copied, or a lost config write).
		// No clone, no install, no toolchain sweep.
		if (options.enable === true) {
			if (config.runtimes?.[kind]) {
				p.outro(color.dim(`${def.label} is already wired into .blok/config.json.`));
				return;
			}
			if (!fs.existsSync(sdkDir)) {
				throw new RuntimeCommandError(
					`${def.label} isn't scaffolded at ${path.relative(root, sdkDir)}. Run \`blokctl runtime add ${kind}\` (without --enable) to install it first.`,
				);
			}
			const rt = (detected ?? (await detectRuntimes())).find((d) => d.kind === kind);
			if (!rt) throw new RuntimeCommandError(`Unknown runtime "${kind}".`);
			const grpcPort = grpcPortOverride ?? rt.defaultGrpcPort;
			const clash = Object.values(config.runtimes ?? {}).find((rc) => rc.kind !== kind && rc.grpcPort === grpcPort);
			if (clash) {
				throw new RuntimeCommandError(
					`gRPC port ${grpcPort} is already used by the ${clash.label} runtime. Pass --grpc-port <n> to pick another.`,
				);
			}
			const rc = buildRuntimeConfig(rt, root);
			if (grpcPortOverride !== undefined) {
				rc.grpcPort = grpcPortOverride;
				if (rc.grpcStartCmd)
					rc.grpcStartCmd = rc.grpcStartCmd.split(String(rt.defaultGrpcPort)).join(String(grpcPortOverride));
			}
			finalizeRuntime(root, config, rc, kind, def.label);
			return;
		}

		// 1. Idempotency — short-circuit BEFORE the multi-toolchain detection sweep.
		if (alreadyInstalled && options.force !== true) {
			if (nonInteractive) {
				p.outro(color.dim(`${def.label} is already installed. Re-run with --force to reinstall.`));
				return;
			}
			const reinstall = await p.confirm({
				message: `${def.label} is already installed. Reinstall it?`,
				initialValue: false,
			});
			if (p.isCancel(reinstall) || !reinstall) {
				p.outro(color.dim("Left unchanged."));
				return;
			}
		}

		// 2. Toolchain availability (reuse the picker's detection when we have it).
		const rt = (detected ?? (await detectRuntimes())).find((d) => d.kind === kind);
		if (!rt) throw new RuntimeCommandError(`Unknown runtime "${kind}".`);
		if (!rt.available && options.skipToolchainCheck !== true) {
			let missing = rt.toolchain;
			let hint = rt.installHint;
			if (rt.secondaryTool && rt.secondaryTool.available === false) {
				missing = rt.secondaryTool.name; // surface the tool that's actually missing…
				hint = rt.secondaryTool.installHint; // …and the hint to install it
			}
			throw new RuntimeCommandError(
				`${def.label} toolchain not detected (need ${color.bold(missing)}). ${hint}\n  Already have it? Re-run with --skip-toolchain-check.`,
			);
		}

		// 3. Port resolution + collision (config entries, then a live-listener probe for fresh installs).
		const grpcPort = grpcPortOverride ?? rt.defaultGrpcPort;
		const clash = Object.values(config.runtimes ?? {}).find((rc) => rc.kind !== kind && rc.grpcPort === grpcPort);
		if (clash) {
			throw new RuntimeCommandError(
				`gRPC port ${grpcPort} is already used by the ${clash.label} runtime. Pass --grpc-port <n> to pick another.`,
			);
		}
		if (!alreadyInstalled) await assertGrpcPortFree(grpcPort);

		// 4. Resolve a version-matched SDK source.
		const s = p.spinner();
		s.start("Resolving SDK source…");
		const source = await resolveSdkSource(root, options.local, (msg) => s.message(msg));

		// On reinstall, clear the old SDK dir so stale build output (target/, venv,
		// vendor/, *.jar) from a possibly different version can't survive.
		if (alreadyInstalled) fs.rmSync(sdkDir, { recursive: true, force: true });

		// 5. Copy + install/build BEFORE any config write (no half-config on failure).
		let rc: RuntimeConfig;
		try {
			rc = await setupRuntime(rt, source, root, s);
		} catch (err) {
			fs.rmSync(sdkDir, { recursive: true, force: true }); // clean the partial copy
			s.stop(color.red(`${def.label} setup failed`));
			throw new RuntimeCommandError(`${def.label} setup failed: ${(err as Error).message.split("\n")[0]}`);
		}

		// Apply the gRPC-port override to config, env, AND any port baked into the
		// boot command (PHP's RoadRunner hardcodes `grpc.listen=…:<port>`).
		if (grpcPortOverride !== undefined) {
			rc.grpcPort = grpcPortOverride;
			if (rc.grpcStartCmd)
				rc.grpcStartCmd = rc.grpcStartCmd.split(String(rt.defaultGrpcPort)).join(String(grpcPortOverride));
		}
		s.stop(`${def.label} runtime ready`);

		// 5.5. Projects scaffolded with --examples get the same hello-over-gRPC
		// example workflow `create project` ships for this runtime.
		if (stampHelloExample(root, source, kind)) {
			p.log.success(
				`Shipped the ${def.label} hello example — ${color.cyan(`POST /runtimes/${kind}/hello`)} (registered in src/Workflows.ts)`,
			);
		}

		// 6 + 7. Persist (config/env/supervisord/gitignore) + summary.
		finalizeRuntime(root, config, rc, kind, def.label);
	} catch (err) {
		reportRuntimeError(err);
	}
}

/**
 * Ship the per-runtime hello example workflow into a project that carries the
 * `--examples` layout (src/workflows/examples/ + the generated src/Workflows.ts):
 * copy `examples/ts-workflows/runtime-<kind>-hello.ts` from the SDK source and
 * register it (import + record entry), mirroring the create-time stamping in
 * create/project.ts. Idempotent — re-adding (or --force reinstalls) never
 * duplicates the registration. Returns true only when the example is shipped
 * AND registered; projects without the examples layout are silently skipped,
 * and a hand-reshaped Workflows.ts gets a warning instead of a corrupt write.
 */
function stampHelloExample(root: string, source: string, kind: string): boolean {
	const file = `runtime-${kind}-hello.ts`;
	const srcFile = path.join(source, "examples", "ts-workflows", file);
	const examplesDir = path.join(root, "src", "workflows", "examples");
	const workflowsTs = path.join(root, "src", "Workflows.ts");
	if (!fs.existsSync(srcFile) || !fs.existsSync(examplesDir) || !fs.existsSync(workflowsTs)) return false;

	const importName = `Runtime${kind.charAt(0).toUpperCase()}${kind.slice(1)}Hello`;
	const importLine = `import ${importName} from "./workflows/examples/runtime-${kind}-hello";`;
	// No `await`: the hello examples are object-form workflow({…}) — sync,
	// unlike the callback-form trigger demos (see create/project.ts notes).
	const entryLine = `\t"runtime-${kind}-hello": ${importName},`;

	const content = fs.readFileSync(workflowsTs, "utf8");
	if (content.includes(`./workflows/examples/runtime-${kind}-hello`)) {
		fs.copyFileSync(srcFile, path.join(examplesDir, file)); // refresh the file on --force reinstalls
		return true;
	}

	const lines = content.split("\n");
	const openIdx = lines.findIndex((l) => /^const workflows\b.*=\s*\{\s*$/.test(l));
	let lastImport = -1;
	for (let i = 0; i < (openIdx === -1 ? lines.length : openIdx); i++) {
		if (/^import /.test(lines[i])) lastImport = i;
	}
	if (openIdx === -1 || lastImport === -1) {
		p.log.warn(
			`src/Workflows.ts doesn't look generated — register the ${kind} hello example yourself:\n  ${importLine}\n  ${entryLine.trim()}`,
		);
		return false;
	}

	lines.splice(openIdx + 1, 0, entryLine); // openIdx > lastImport, so insert here first
	lines.splice(lastImport + 1, 0, importLine);
	fs.copyFileSync(srcFile, path.join(examplesDir, file));
	fs.writeFileSync(workflowsTs, lines.join("\n"));
	return true;
}

/**
 * Persist a resolved RuntimeConfig into the project — config.json (merge,
 * preserving triggers + sibling runtimes), .env.local, supervisord.conf,
 * .gitignore — then print the summary. Shared by the install path and the
 * `--enable` path so the two never drift.
 */
function finalizeRuntime(root: string, config: ProjectConfig, rc: RuntimeConfig, kind: string, label: string): void {
	const nextConfig = withRuntime(config, rc);
	const remaining = Object.values(nextConfig.runtimes ?? {});

	fs.mkdirSync(path.join(root, ".blok"), { recursive: true });
	fs.writeFileSync(path.join(root, ".blok", "config.json"), `${JSON.stringify(nextConfig, null, 2)}\n`);

	const envPath = path.join(root, ".env.local");
	const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
	fs.writeFileSync(envPath, rewriteRuntimeEnvBlock(envContent, remaining));

	const supervisordPath = path.join(root, "supervisord.conf");
	if (fs.existsSync(supervisordPath)) {
		fs.writeFileSync(supervisordPath, rewriteSupervisordRuntimes(fs.readFileSync(supervisordPath, "utf8"), remaining));
	}

	const gitignorePath = path.join(root, ".gitignore");
	if (fs.existsSync(gitignorePath)) {
		const before = fs.readFileSync(gitignorePath, "utf8");
		const after = ensureRuntimeGitignore(before);
		if (after !== before) fs.writeFileSync(gitignorePath, after);
	}

	p.note(
		[
			`${color.green("✓")} .blok/config.json   ${color.dim(`runtimes.${kind}`)}`,
			`${color.green("✓")} .env.local          ${color.dim(`RUNTIME_${runtimeEnvKey(kind)}_GRPC_PORT=${rc.grpcPort}`)}`,
			fs.existsSync(supervisordPath)
				? `${color.green("✓")} supervisord.conf    ${color.dim(`[program:${kind}_runtime]`)}`
				: "",
			`${color.green("✓")} runtimes/${kind}/nodes/  ${color.dim("(your runtime nodes go here)")}`,
		]
			.filter(Boolean)
			.join("\n"),
		`${label} added`,
	);
	p.outro(
		`Run ${color.cyan("blokctl dev")} to start it, then add ${color.cyan(`type: "runtime.${kind}"`)} steps to your workflows.`,
	);
}
