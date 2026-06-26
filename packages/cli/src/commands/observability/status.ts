import * as p from "@clack/prompts";
import color from "picocolors";
import type { OptionValues } from "../../services/commander.js";
import { getObservabilityModule } from "./descriptor.js";
import { readConfigSafe, reportObservabilityError, resolveProjectRoot } from "./shared.js";

/**
 * `blokctl observability status` — report the health of each enabled module.
 * Foundation stub: lists enabled modules and runs each descriptor's optional
 * `verify()` hook when present (module epics add the real probes). Modules with
 * no `verify()` yet are reported as "enabled (no health check)".
 */
export async function observabilityStatus(options: OptionValues): Promise<void> {
	try {
		const root = resolveProjectRoot(options.directory);
		const enabled = readConfigSafe(root).observability ?? {};
		const enabledIds = Object.keys(enabled).filter((id) => enabled[id]?.enabled);

		p.intro(color.inverse(" Observability status "));

		if (enabledIds.length === 0) {
			p.outro(color.dim("No observability modules enabled. Add one with `blokctl observability add <id>`."));
			return;
		}

		const rows: string[] = [];
		for (const id of enabledIds) {
			const mod = getObservabilityModule(id);
			if (!mod) continue;
			if (mod.verify) {
				const res = await mod.verify(root);
				const mark = res.ok ? color.green("✓") : color.yellow("!");
				const link = res.dashboardUrl ? color.dim(`  ${res.dashboardUrl}`) : "";
				rows.push(`${mark} ${color.bold(mod.label.padEnd(26))} ${res.message}${link}`);
			} else {
				rows.push(
					`${color.dim("•")} ${color.bold(mod.label.padEnd(26))} ${color.dim("enabled (no health check yet)")}`,
				);
			}
		}

		p.note(rows.join("\n"), `Enabled (${enabledIds.length})`);
		p.outro(color.dim("Health probes land with each module epic."));
	} catch (err) {
		reportObservabilityError(err);
	}
}
