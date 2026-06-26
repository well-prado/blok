import * as p from "@clack/prompts";
import color from "picocolors";
import type { OptionValues } from "../../services/commander.js";
import { allObservabilityModules } from "./descriptor.js";
import { readConfigSafe, reportObservabilityError, resolveProjectRoot } from "./shared.js";

/**
 * `blokctl observability list` — show which observability modules are enabled in
 * this project and which are still available to add.
 */
export async function observabilityList(options: OptionValues): Promise<void> {
	try {
		const root = resolveProjectRoot(options.directory);
		const enabled = readConfigSafe(root).observability ?? {};
		const modules = allObservabilityModules();

		if (options.json) {
			console.log(
				JSON.stringify(
					modules.map((m) => ({
						id: m.id,
						label: m.label,
						enabled: Boolean(enabled[m.id]?.enabled),
						addedAt: enabled[m.id]?.addedAt,
						dependencies: m.dependencies,
					})),
					null,
					2,
				),
			);
			return;
		}

		p.intro(color.inverse(" Observability modules "));

		const on = modules.filter((m) => enabled[m.id]?.enabled);
		const off = modules.filter((m) => !enabled[m.id]?.enabled);

		if (on.length > 0) {
			p.note(
				on.map((m) => `${color.green("✓")} ${color.bold(m.label.padEnd(26))} ${color.dim(m.id)}`).join("\n"),
				`Enabled (${on.length})`,
			);
		} else {
			p.log.info(color.dim("No observability modules enabled yet."));
		}

		if (off.length > 0) {
			p.note(
				off
					.map(
						(m) =>
							`${color.bold(m.label.padEnd(26))} ${color.dim(m.description)}\n  ${color.dim(`blokctl observability add ${m.id}`)}`,
					)
					.join("\n"),
				`Available to add (${off.length})`,
			);
		}

		p.outro(color.dim("Add with `blokctl observability add <id>`, remove with `… remove <id>`."));
	} catch (err) {
		reportObservabilityError(err);
	}
}
