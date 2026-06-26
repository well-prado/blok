import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import color from "picocolors";
import type { OptionValues } from "../../services/commander.js";
import { isNonInteractive } from "../../services/non-interactive.js";
import { rewriteObservabilityEnvBlock, withoutObservabilityModule } from "../../services/observability-mutations.js";
import { OBSERVABILITY_MODULE_IDS, getObservabilityModule } from "./descriptor.js";
import { ObservabilityCommandError, readConfigSafe, reportObservabilityError, resolveProjectRoot } from "./shared.js";

/**
 * `blokctl observability remove <module>` — disable an observability module.
 * Reverses the `.blok/config.json` entry + the `.env.local` block, runs the
 * module's `cleanup()` hook if it has one, and otherwise leaves any copied infra
 * files in place (with a note) so operator-edited infra is never destroyed.
 */
export async function observabilityRemove(moduleArg: string, options: OptionValues): Promise<void> {
	try {
		const id = moduleArg.trim().toLowerCase();
		const mod = getObservabilityModule(id);
		if (!mod) {
			throw new ObservabilityCommandError(
				`Unknown observability module "${id}". Known: ${OBSERVABILITY_MODULE_IDS.join(", ")}.`,
			);
		}

		const root = resolveProjectRoot(options.directory);
		const config = readConfigSafe(root);
		const enabled = config.observability ?? {};
		const nonInteractive = isNonInteractive() || options.yes === true;

		p.intro(color.inverse(` Remove ${mod.label} `));

		if (!enabled[mod.id]) {
			p.outro(color.dim(`${mod.label} isn't enabled in this project — nothing to remove.`));
			return;
		}

		// 1. Warn about enabled modules that DEPEND on this one (they'll be left dangling).
		const dependents = Object.keys(enabled).filter((eid) => getObservabilityModule(eid)?.dependencies.includes(mod.id));
		if (dependents.length > 0) {
			const labels = dependents.map((d) => getObservabilityModule(d)?.label ?? d).join(", ");
			p.log.warn(
				`${color.yellow(labels)} ${dependents.length > 1 ? "depend" : "depends"} on ${color.bold(mod.label)} — remove ${dependents.length > 1 ? "them" : "it"} too, or expect reduced function.`,
			);
		}

		// 2. Confirm (skipped with --yes / non-interactive). Defaults to "no".
		if (!nonInteractive) {
			const ok = await p.confirm({ message: `Remove the ${mod.label} module?`, initialValue: false });
			if (p.isCancel(ok) || !ok) {
				p.outro(color.dim("Left unchanged."));
				return;
			}
		}

		// 3. Module-specific cleanup hook (none in the foundation).
		if (mod.cleanup) await mod.cleanup({ projectDir: root, nonInteractive });

		// 4. Config — drop the entry (preserving runtimes/triggers/siblings).
		const nextConfig = withoutObservabilityModule(config, mod.id);
		fs.mkdirSync(path.join(root, ".blok"), { recursive: true });
		fs.writeFileSync(path.join(root, ".blok", "config.json"), `${JSON.stringify(nextConfig, null, 2)}\n`);

		// 5. Env — rewrite the managed block for whatever modules remain.
		const remainingIds = Object.keys(nextConfig.observability ?? {});
		const envBlocks = remainingIds.map((eid) => getObservabilityModule(eid)?.envBlock({ projectDir: root }) ?? "");
		const envPath = path.join(root, ".env.local");
		if (fs.existsSync(envPath)) {
			fs.writeFileSync(envPath, rewriteObservabilityEnvBlock(fs.readFileSync(envPath, "utf8"), envBlocks));
		}

		// 6. Summary. Infra files (if the module copied any) are left in place by design.
		p.note(
			[
				`${color.red("−")} .blok/config.json   ${color.dim(`observability.${mod.id}`)}`,
				`${color.red("−")} .env.local          ${color.dim(`${mod.label} env block`)}`,
				mod.infraFiles.length > 0 && !mod.cleanup
					? `${color.yellow("•")} infra files left in place ${color.dim("(remove by hand if unused)")}`
					: "",
			]
				.filter(Boolean)
				.join("\n"),
			`${mod.label} removed`,
		);
		p.outro(color.dim(`Re-add anytime: blokctl observability add ${mod.id}.`));
	} catch (err) {
		reportObservabilityError(err);
	}
}
