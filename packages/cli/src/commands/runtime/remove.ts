import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import color from "picocolors";
import type { OptionValues } from "../../services/commander.js";
import { isNonInteractive } from "../../services/non-interactive.js";
import { getRuntimeDefinition } from "../../services/runtime-detector.js";
import {
	rewriteRuntimeEnvBlock,
	rewriteSupervisordRuntimes,
	withoutRuntime,
} from "../../services/runtime-mutations.js";
import { readProjectConfig } from "../../services/runtime-setup.js";
import {
	assertSidecarKind,
	listUserNodes,
	reportRuntimeError,
	resolveProjectRoot,
	scanWorkflowsForRuntime,
} from "./shared.js";

/**
 * `blokctl runtime remove <lang>` — remove a language sidecar runtime from an
 * existing project. Warns about workflows that still reference `runtime.<lang>`,
 * never deletes the user's own runtime nodes without asking, and undoes the
 * config/env/supervisord/SDK-dir state the add created.
 */
export async function runtimeRemove(kind: string, options: OptionValues): Promise<void> {
	try {
		assertSidecarKind(kind);
		const root = resolveProjectRoot(options.directory);
		const nonInteractive = isNonInteractive() || options.yes === true;
		const label = getRuntimeDefinition(kind)?.label ?? kind;

		const config = readProjectConfig(root) ?? {};
		const sdkDir = path.join(root, ".blok", "runtimes", kind);
		const inConfig = Boolean(config.runtimes?.[kind]);
		const onDisk = fs.existsSync(sdkDir);

		if (!inConfig && !onDisk) {
			p.intro(color.inverse(` Remove ${label} runtime `));
			p.outro(color.dim(`${label} isn't installed in this project — nothing to remove.`));
			return;
		}

		p.intro(color.inverse(` Remove ${label} runtime `));

		// 1. Warn about workflows that depend on this runtime.
		const hits = scanWorkflowsForRuntime(root, kind);
		if (hits.length > 0) {
			const list = hits
				.slice(0, 10)
				.map((h) => `  ${color.yellow("•")} ${h.file}${h.count > 1 ? color.dim(` (${h.count} refs)`) : ""}`)
				.join("\n");
			const more = hits.length > 10 ? `\n  ${color.dim(`…and ${hits.length - 10} more`)}` : "";
			p.log.warn(
				`${color.yellow(`${hits.length} workflow file(s)`)} reference ${color.bold(`runtime.${kind}`)} — those steps will fail at run time after removal:\n${list}${more}`,
			);
		}

		// 2. The user's own runtime nodes — never auto-delete; ask (default keep).
		const userNodes = listUserNodes(root, kind);
		let deleteNodes = false;
		if (!userNodes.isSymlink && userNodes.files.length > 0) {
			if (options.purgeNodes === true) {
				deleteNodes = true;
			} else if (nonInteractive) {
				deleteNodes = false; // safe default: keep user code
				p.log.info(
					color.dim(
						`Keeping your ${userNodes.files.length} node file(s) in runtimes/${kind}/nodes/ (use --purge-nodes to delete).`,
					),
				);
			} else {
				const answer = await p.confirm({
					message: `Also delete your ${color.bold(`${userNodes.files.length} custom node file(s)`)} in runtimes/${kind}/nodes/?`,
					initialValue: false,
				});
				deleteNodes = !p.isCancel(answer) && answer === true;
			}
		}

		// 3. Final confirmation (skipped with --yes / non-interactive).
		if (!nonInteractive) {
			const ok = await p.confirm({ message: `Remove the ${label} runtime?`, initialValue: true });
			if (p.isCancel(ok) || !ok) {
				p.outro(color.dim("Left unchanged."));
				return;
			}
		}

		const s = p.spinner();
		s.start(`Removing ${label} runtime…`);

		// 4. Config — drop the entry (preserving triggers + siblings); drops the
		//    whole `runtimes` key when this was the last one.
		const nextConfig = withoutRuntime(config, kind);
		fs.mkdirSync(path.join(root, ".blok"), { recursive: true });
		fs.writeFileSync(path.join(root, ".blok", "config.json"), `${JSON.stringify(nextConfig, null, 2)}\n`);

		const remaining = Object.values(nextConfig.runtimes ?? {});

		// 5. Env + supervisord — regenerate the runtime sections for what's left.
		const envPath = path.join(root, ".env.local");
		if (fs.existsSync(envPath)) {
			fs.writeFileSync(envPath, rewriteRuntimeEnvBlock(fs.readFileSync(envPath, "utf8"), remaining));
		}
		const supervisordPath = path.join(root, "supervisord.conf");
		if (fs.existsSync(supervisordPath)) {
			fs.writeFileSync(
				supervisordPath,
				rewriteSupervisordRuntimes(fs.readFileSync(supervisordPath, "utf8"), remaining),
			);
		}

		// 6. SDK source dir.
		fs.rmSync(sdkDir, { recursive: true, force: true });

		// 7. Project-level runtime dir: unlink python3's SDK junctions (nodes/core),
		//    optionally delete user nodes, and drop the dir if it ends up empty.
		const projRuntimeDir = path.join(root, "runtimes", kind);
		const tryLstat = (target: string): fs.Stats | null => {
			try {
				return fs.lstatSync(target);
			} catch {
				return null;
			}
		};
		for (const name of ["nodes", "core"]) {
			const link = path.join(projRuntimeDir, name);
			if (tryLstat(link)?.isSymbolicLink()) fs.unlinkSync(link);
		}
		if (deleteNodes) fs.rmSync(path.join(projRuntimeDir, "nodes"), { recursive: true, force: true });
		if (fs.existsSync(projRuntimeDir) && fs.readdirSync(projRuntimeDir).length === 0) fs.rmdirSync(projRuntimeDir);

		s.stop(`${label} runtime removed`);

		// 8. Summary.
		const keptNodes = !deleteNodes && !userNodes.isSymlink && userNodes.files.length > 0;
		p.note(
			[
				`${color.red("−")} .blok/config.json   ${color.dim(`runtimes.${kind}`)}`,
				`${color.red("−")} .env.local          ${color.dim(`RUNTIME_${kind === "csharp" ? "CSHARP" : kind.toUpperCase()}_*`)}`,
				fs.existsSync(supervisordPath)
					? `${color.red("−")} supervisord.conf    ${color.dim(`[program:${kind}_runtime]`)}`
					: "",
				`${color.red("−")} .blok/runtimes/${kind}/  ${color.dim("(SDK source + build output)")}`,
				keptNodes
					? `${color.green("✓")} runtimes/${kind}/nodes/  ${color.dim(`kept your ${userNodes.files.length} node file(s)`)}`
					: "",
			]
				.filter(Boolean)
				.join("\n"),
			`${label} removed`,
		);
		p.outro(
			hits.length > 0
				? color.yellow(`Remember to update the ${hits.length} workflow(s) that referenced runtime.${kind}.`)
				: color.dim("Done."),
		);
	} catch (err) {
		reportRuntimeError(err);
	}
}
