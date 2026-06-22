import * as p from "@clack/prompts";
import color from "picocolors";
import type { OptionValues } from "../../services/commander.js";
import { detectRuntimes } from "../../services/runtime-detector.js";
import { readProjectConfig } from "../../services/runtime-setup.js";
import { reportRuntimeError, resolveProjectRoot } from "./shared.js";

/**
 * `blokctl runtime list` — show installed sidecar runtimes (with toolchain
 * health + gRPC port) and which supported runtimes are still available to add.
 */
export async function runtimeList(options: OptionValues): Promise<void> {
	try {
		const root = resolveProjectRoot(options.directory);
		const installed = readProjectConfig(root)?.runtimes ?? {};
		const detected = await detectRuntimes();
		const detectedByKind = new Map(detected.map((d) => [d.kind, d]));
		const installedKinds = Object.keys(installed);

		if (options.json) {
			console.log(
				JSON.stringify(
					{
						installed: installedKinds.map((kind) => ({
							kind,
							label: installed[kind].label,
							grpcPort: installed[kind].grpcPort,
							version: installed[kind].version,
							requiredVersion: installed[kind].requiredVersion,
							toolchainAvailable: detectedByKind.get(kind)?.available ?? false,
						})),
						available: detected
							.filter((d) => !(d.kind in installed))
							.map((d) => ({ kind: d.kind, label: d.label, toolchainAvailable: d.available })),
					},
					null,
					2,
				),
			);
			return;
		}

		p.intro(color.inverse(" Blok runtimes "));

		if (installedKinds.length === 0) {
			p.log.info(color.dim("No sidecar runtimes installed yet."));
		} else {
			const rows = installedKinds.map((kind) => {
				const rc = installed[kind];
				const d = detectedByKind.get(kind);
				const ready = d?.available ?? false;
				const mark = ready ? color.green("✓") : color.yellow("!");
				const port = color.dim(`gRPC :${rc.grpcPort ?? "?"}`);
				const tool = ready
					? color.dim(`${d?.toolchain} ${d?.version ?? ""}`.trim())
					: color.yellow("toolchain not detected");
				return `${mark} ${color.bold(rc.label.padEnd(12))} ${port.padEnd(18)} ${tool}`;
			});
			p.note(rows.join("\n"), `Installed (${installedKinds.length})`);
		}

		const available = detected.filter((d) => !(d.kind in installed));
		if (available.length > 0) {
			const rows = available.map((d) => {
				const status = d.available ? color.green(`${d.toolchain} ready`) : color.dim(`needs ${d.toolchain}`);
				return `${color.bold(d.label.padEnd(12))} ${status.padEnd(28)} ${color.dim(`blokctl runtime add ${d.kind}`)}`;
			});
			p.note(rows.join("\n"), `Available to add (${available.length})`);
		}

		p.outro(color.dim("Node / TypeScript runs in-process — always available, nothing to install."));
	} catch (err) {
		reportRuntimeError(err);
	}
}
