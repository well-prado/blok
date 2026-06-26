import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import color from "picocolors";
import type { OptionValues } from "../../services/commander.js";
import { isNonInteractive } from "../../services/non-interactive.js";
import { rewriteObservabilityEnvBlock, withObservabilityModule } from "../../services/observability-mutations.js";
import {
	OBSERVABILITY_MODULE_IDS,
	type ObservabilityModuleId,
	allObservabilityModules,
	getObservabilityModule,
	resolveWithDependencies,
} from "./descriptor.js";
import {
	ObservabilityCommandError,
	readConfigSafe,
	readFrameworkVersion,
	reportObservabilityError,
	resolveProjectRoot,
} from "./shared.js";

/**
 * `blokctl observability add [module]` — enable an opt-in observability module
 * (metrics, tracing, trace-store, logging, alerting, error-sink, obs-stack) in
 * an existing project. Idempotent: re-adding an enabled module is skipped unless
 * `--force`. Dependencies are auto-resolved. Persists to `.blok/config.json` +
 * `.env.local` via the pure mutation helpers, preserving runtimes + triggers.
 */
export async function observabilityAdd(moduleArg: string | undefined, options: OptionValues): Promise<void> {
	try {
		const root = resolveProjectRoot(options.directory);
		const config = readConfigSafe(root);
		const enabled = config.observability ?? {};
		const nonInteractive = isNonInteractive() || options.yes === true;

		// 1. Resolve the target module id (argument or interactive picker).
		let id = moduleArg?.trim().toLowerCase();
		if (!id) {
			if (nonInteractive) {
				throw new ObservabilityCommandError(
					`Specify a module: blokctl observability add <${OBSERVABILITY_MODULE_IDS.join("|")}>`,
				);
			}
			const choices = allObservabilityModules()
				.filter((m) => !enabled[m.id])
				.map((m) => ({ value: m.id, label: m.label, hint: m.description }));
			if (choices.length === 0) {
				p.intro(color.inverse(" Add observability module "));
				p.outro(color.dim("All observability modules are already enabled."));
				return;
			}
			const picked = await p.select({ message: "Which observability module do you want to add?", options: choices });
			if (p.isCancel(picked)) {
				p.cancel("Cancelled.");
				return;
			}
			id = picked as string;
		}

		const mod = getObservabilityModule(id);
		if (!mod) {
			throw new ObservabilityCommandError(
				`Unknown observability module "${id}". Known: ${OBSERVABILITY_MODULE_IDS.join(", ")}.`,
			);
		}

		p.intro(color.inverse(` Add ${mod.label} `));

		// 2. Idempotency — skip an already-enabled module unless --force re-applies it.
		if (enabled[mod.id] && options.force !== true) {
			p.outro(color.dim(`${mod.label} is already enabled. Re-run with --force to re-apply its scaffold.`));
			return;
		}

		// 3. Dependency resolution (transitive). Prompt to enable missing deps; auto under --yes.
		const { resolved, added } = resolveWithDependencies([mod.id]);
		const newDeps = added.filter((d) => !enabled[d]);
		if (newDeps.length > 0) {
			const labels = newDeps.map((d) => getObservabilityModule(d)?.label ?? d).join(", ");
			if (nonInteractive) {
				p.log.info(color.dim(`Also enabling required dependencies: ${labels}`));
			} else {
				const ok = await p.confirm({
					message: `${mod.label} requires ${labels}. Enable ${newDeps.length > 1 ? "them" : "it"} too?`,
					initialValue: true,
				});
				if (p.isCancel(ok) || !ok) {
					p.outro(color.dim("Left unchanged."));
					return;
				}
			}
		}

		// 4. The set to (re)apply now: the target + any not-yet-enabled dependency.
		const toApply: ObservabilityModuleId[] = resolved.filter((rid) => rid === mod.id || !enabled[rid]);
		const addedAt = new Date().toISOString();
		const version = readFrameworkVersion(root);

		// 5. Run each module's optional validate/scaffold/setup hooks (no-ops in the
		//    foundation; module epics fill these in). File writes happen only after.
		const s = p.spinner();
		let nextConfig = config;
		const scaffoldOpts = {
			projectDir: root,
			nonInteractive,
			tier: options.tier as string | undefined,
			localRepo: options.local as string | undefined,
		};
		for (const rid of toApply) {
			const d = getObservabilityModule(rid);
			if (!d) continue;
			if (d.validate) await d.validate(root);
			if (d.scaffold) {
				s.start(`Scaffolding ${d.label}…`);
				await d.scaffold(scaffoldOpts);
				s.stop(`${d.label} ready`);
			}
			if (d.setup) await d.setup(scaffoldOpts);
			// obs-stack records its chosen tier so list/status/remove know it.
			const extra = rid === "obs-stack" ? { settings: { tier: options.tier ?? "lite" } } : {};
			nextConfig = withObservabilityModule(nextConfig, rid, { enabled: true, addedAt, version, ...extra });
		}

		// 6. Persist — full merged config (preserves runtimes/triggers/siblings).
		fs.mkdirSync(path.join(root, ".blok"), { recursive: true });
		fs.writeFileSync(path.join(root, ".blok", "config.json"), `${JSON.stringify(nextConfig, null, 2)}\n`);

		// 7. Rewrite the managed .env.local block to reflect ALL enabled modules.
		const enabledIds = Object.keys(nextConfig.observability ?? {});
		const envBlocks = enabledIds.map((eid) => getObservabilityModule(eid)?.envBlock({ projectDir: root }) ?? "");
		const envPath = path.join(root, ".env.local");
		const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
		fs.writeFileSync(envPath, rewriteObservabilityEnvBlock(envContent, envBlocks));

		// 8. Merge any package.json deps the applied modules declare (empty in the foundation).
		const deps: Record<string, string> = {};
		for (const rid of toApply) Object.assign(deps, getObservabilityModule(rid)?.packageDeps ?? {});
		if (Object.keys(deps).length > 0) mergePackageDeps(root, deps);

		// 9. Summary.
		p.note(
			toApply.map((rid) => `${color.green("✓")} ${getObservabilityModule(rid)?.label ?? rid}`).join("\n"),
			`${mod.label} added`,
		);
		p.outro(color.dim(`Enabled modules: ${enabledIds.join(", ")}.`));
	} catch (err) {
		reportObservabilityError(err);
	}
}

/** Merge dependency entries into the project's package.json (no version downgrade logic — additive). */
function mergePackageDeps(root: string, deps: Record<string, string>): void {
	const pkgPath = path.join(root, "package.json");
	const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string> };
	pkg.dependencies = { ...(pkg.dependencies ?? {}), ...deps };
	fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}
