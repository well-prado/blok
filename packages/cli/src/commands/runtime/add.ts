import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import color from "picocolors";
import type { OptionValues } from "../../services/commander.js";
import { isNonInteractive } from "../../services/non-interactive.js";
import { detectRuntimes } from "../../services/runtime-detector.js";
import {
	ensureRuntimeGitignore,
	rewriteRuntimeEnvBlock,
	rewriteSupervisordRuntimes,
	withRuntime,
} from "../../services/runtime-mutations.js";
import { type RuntimeConfig, readProjectConfig, setupRuntime } from "../../services/runtime-setup.js";
import {
	RuntimeCommandError,
	assertSidecarKind,
	reportRuntimeError,
	resolveProjectRoot,
	resolveSdkSource,
} from "./shared.js";

/**
 * `blokctl runtime add <lang>` — add a language sidecar runtime to an existing
 * project. Pure config/SDK-dir work: copies the version-matched SDK into
 * `.blok/runtimes/<lang>/`, installs/builds it, and merges the runtime into
 * `.blok/config.json` + `.env.local` + `supervisord.conf`. No runner changes —
 * the framework already resolves all seven `runtime.<lang>` step types.
 */
export async function runtimeAdd(kind: string, options: OptionValues): Promise<void> {
	try {
		assertSidecarKind(kind);
		const root = resolveProjectRoot(options.directory);
		const nonInteractive = isNonInteractive() || options.yes === true;
		const config = readProjectConfig(root) ?? {};
		const sdkDir = path.join(root, ".blok", "runtimes", kind);
		const alreadyInstalled = Boolean(config.runtimes?.[kind]) || fs.existsSync(sdkDir);

		const detected = await detectRuntimes();
		const rt = detected.find((d) => d.kind === kind);
		if (!rt) throw new RuntimeCommandError(`Unknown runtime "${kind}".`);

		p.intro(color.inverse(` Add ${rt.label} runtime `));

		// 1. Idempotency.
		if (alreadyInstalled && options.force !== true) {
			if (nonInteractive) {
				p.outro(color.dim(`${rt.label} is already installed. Re-run with --force to reinstall.`));
				return;
			}
			const reinstall = await p.confirm({
				message: `${rt.label} is already installed. Reinstall it?`,
				initialValue: false,
			});
			if (p.isCancel(reinstall) || !reinstall) {
				p.outro(color.dim("Left unchanged."));
				return;
			}
		}

		// 2. Toolchain availability.
		if (!rt.available && options.skipToolchainCheck !== true) {
			const missing = rt.secondaryTool && rt.secondaryTool.available === false ? rt.secondaryTool.name : rt.toolchain;
			throw new RuntimeCommandError(
				`${rt.label} toolchain not detected (need ${color.bold(missing)}). ${rt.installHint}\n  Already have it? Re-run with --skip-toolchain-check.`,
			);
		}

		// 3. Port resolution + collision check (canonical ports are fixed per kind,
		//    so a clash only happens with a manual re-point or an explicit override).
		let grpcPort = rt.defaultGrpcPort;
		if (options.grpcPort !== undefined) {
			const parsed = Number(options.grpcPort);
			if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
				throw new RuntimeCommandError(`--grpc-port must be an integer 1-65535 (got "${options.grpcPort}").`);
			}
			grpcPort = parsed;
		}
		const clash = Object.values(config.runtimes ?? {}).find((rc) => rc.kind !== kind && rc.grpcPort === grpcPort);
		if (clash) {
			throw new RuntimeCommandError(
				`gRPC port ${grpcPort} is already used by the ${clash.label} runtime. Pass --grpc-port <n> to pick another.`,
			);
		}

		// 4. Resolve a version-matched SDK source.
		const s = p.spinner();
		s.start("Resolving SDK source…");
		const source = await resolveSdkSource(root, options.local, (msg) => s.message(msg));

		// 5. Copy + install/build the SDK. Done BEFORE any config write so a build
		//    failure never leaves a half-config pointing at an unbuilt directory.
		let rc: RuntimeConfig;
		try {
			rc = await setupRuntime(rt, source, root, s);
		} catch (err) {
			fs.rmSync(sdkDir, { recursive: true, force: true }); // clean the partial copy
			s.stop(color.red(`${rt.label} setup failed`));
			throw new RuntimeCommandError(`${rt.label} setup failed: ${(err as Error).message.split("\n")[0]}`);
		}
		if (options.grpcPort !== undefined) rc.grpcPort = grpcPort;
		s.stop(`${rt.label} runtime ready`);

		// 6. Persist — config (merge, preserving triggers + siblings), env, supervisord, gitignore.
		const nextConfig = withRuntime(config, rc);
		const remaining = Object.values(nextConfig.runtimes ?? {});

		fs.mkdirSync(path.join(root, ".blok"), { recursive: true });
		fs.writeFileSync(path.join(root, ".blok", "config.json"), `${JSON.stringify(nextConfig, null, 2)}\n`);

		const envPath = path.join(root, ".env.local");
		const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
		fs.writeFileSync(envPath, rewriteRuntimeEnvBlock(envContent, remaining));

		const supervisordPath = path.join(root, "supervisord.conf");
		if (fs.existsSync(supervisordPath)) {
			fs.writeFileSync(
				supervisordPath,
				rewriteSupervisordRuntimes(fs.readFileSync(supervisordPath, "utf8"), remaining),
			);
		}

		const gitignorePath = path.join(root, ".gitignore");
		if (fs.existsSync(gitignorePath)) {
			const before = fs.readFileSync(gitignorePath, "utf8");
			const after = ensureRuntimeGitignore(before);
			if (after !== before) fs.writeFileSync(gitignorePath, after);
		}

		// 7. Friendly summary + next step.
		p.note(
			[
				`${color.green("✓")} .blok/config.json   ${color.dim(`runtimes.${kind}`)}`,
				`${color.green("✓")} .env.local          ${color.dim(`RUNTIME_${kind === "csharp" ? "CSHARP" : kind.toUpperCase()}_GRPC_PORT=${rc.grpcPort}`)}`,
				fs.existsSync(supervisordPath)
					? `${color.green("✓")} supervisord.conf    ${color.dim(`[program:${kind}_runtime]`)}`
					: "",
				`${color.green("✓")} runtimes/${kind}/nodes/  ${color.dim("(your runtime nodes go here)")}`,
			]
				.filter(Boolean)
				.join("\n"),
			`${rt.label} added`,
		);
		p.outro(
			`Run ${color.cyan("blokctl dev")} to start it, then use ${color.cyan(`type: "runtime.${kind}"`)} steps in your workflows.`,
		);
	} catch (err) {
		reportRuntimeError(err);
	}
}
