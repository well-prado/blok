// doctor: what is in place on this machine and in this project, and what to do about what is not.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Paths } from "./analyze.ts";
import type { Report } from "./commands.ts";
import { pyprojectSettings } from "./language.ts";
import { PKL_VERSION, findPkl } from "./pkl-bin.ts";
import { PYTHON_KERNEL, python } from "./python.ts";
import { VERSION } from "./scaffold.ts";

interface Finding {
	what: string;
	/** "problem" stops the tool from working. "note" is worth knowing and breaks nothing. */
	state: "ok" | "problem" | "note";
	detail: string;
}

const firstLine = (command: string, args: string[]) => {
	const run = spawnSync(command, args, { encoding: "utf8" });
	return run.error ? undefined : `${run.stdout}${run.stderr}`.trim().split("\n")[0];
};
const numbers = (text: string) => (/(\d+)\.(\d+)(?:\.(\d+))?/.exec(text) ?? []).slice(1).map(Number);
const older = (a: number[], b: number[]) => a[0] < b[0] || (a[0] === b[0] && (a[1] ?? 0) < (b[1] ?? 0));

export async function doctor(paths: Paths, env: Record<string, string | undefined> = process.env): Promise<Report> {
	const findings: Finding[] = [];
	const add = (what: string, state: Finding["state"], detail: string) => findings.push({ what, state, detail });

	const isPython = paths.language.name === "python";
	if (!isPython) {
		// The command runs on Node, and imports the project's TypeScript nodes as they are.
		const node = numbers(process.versions.node);
		add(
			"Node",
			older(node, [22, 18]) ? "problem" : "ok",
			older(node, [22, 18])
				? `This is Node ${process.versions.node}. blokctl needs 22.18 or newer, which runs TypeScript files directly.`
				: `Node ${process.versions.node}.`,
		);
	}

	try {
		const pkl = await findPkl({ env: { ...env, BLOK_OFFLINE: "1" } });
		const version = firstLine(pkl, ["--version"]) ?? "";
		const behind = older(numbers(version), numbers(PKL_VERSION));
		add(
			"Pkl",
			behind ? "note" : "ok",
			behind
				? `${pkl} is ${version}. blokctl is tested with ${PKL_VERSION}. Update it if a workflow fails to evaluate.`
				: `${pkl} (${version}).`,
		);
	} catch {
		add(
			"Pkl",
			env.BLOK_OFFLINE ? "problem" : "note",
			env.BLOK_OFFLINE
				? "There is no `pkl` command, and BLOK_OFFLINE forbids downloading it. Install Pkl (https://pkl-lang.org), or point BLOK_PKL at it."
				: `There is no \`pkl\` command. blokctl will download Pkl ${PKL_VERSION} the first time a .pkl workflow is checked.`,
		);
	}

	let manifest: { imports?: Record<string, string> } | undefined;
	try {
		manifest = JSON.parse(readFileSync(join(paths.root, "package.json"), "utf8"));
	} catch {}
	if (isPython) {
		// blokctl reads no Python. It asks the project's own Python, so that is what has to be in place.
		const asked = python(paths.root, ["-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"]);
		const version = asked.error || asked.status !== 0 ? undefined : asked.stdout.trim();
		add(
			"Python",
			version === undefined || older(numbers(version), [3, 11]) ? "problem" : "ok",
			version === undefined
				? `Python could not be run as "${asked.command}". Install Python 3.11 or newer, or say where it is with \`python = "..."\` under [tool.blok] in pyproject.toml.`
				: older(numbers(version), [3, 11])
					? `"${asked.command}" is Python ${version}. The kernel needs 3.11 or newer.`
					: `Python ${version}, run as "${asked.command}".`,
		);
		add(
			"Project",
			pyprojectSettings(paths.root) ? "ok" : "problem",
			pyprojectSettings(paths.root)
				? `pyproject.toml has a [tool.blok] table${existsSync(paths.nodes) ? "" : `. There is no ${paths.nodes} folder yet`}.`
				: 'pyproject.toml has no [tool.blok] table, which is how blokctl tells a Python project. Run "blokctl init" to add it.',
		);
		if (version !== undefined) {
			const kernel = python(paths.root, ["-c", "import blok; print(blok.VERSION)"]);
			const found = kernel.status === 0 ? kernel.stdout.trim() : undefined;
			add(
				"blok-kernel",
				found === undefined ? "problem" : found === PYTHON_KERNEL ? "ok" : "note",
				found === undefined
					? `It is not installed for "${asked.command}". Add "blok-kernel" to the project's dependencies and install them.`
					: found === PYTHON_KERNEL
						? `Installed, ${found}, the version this blokctl goes with.`
						: `The project has blok-kernel ${found} and this blokctl ${VERSION} goes with ${PYTHON_KERNEL}. Use the two that go together.`,
			);
		}
	} else if (!manifest) {
		add(
			"Project",
			"problem",
			'There is no package.json here. Run "blokctl init <name>" to start a project, or run this in one.',
		);
	} else {
		const missing = ["#blok", "#ports"].filter((name) => !manifest?.imports?.[name]);
		add(
			"Project",
			missing.length > 0 ? "problem" : "ok",
			missing.length > 0
				? `package.json has no "imports" entry for ${missing.join(" and ")}, which the nodes import. Run "blokctl init" to add them.`
				: `package.json maps #blok and #ports${existsSync(paths.nodes) ? "" : `. There is no ${paths.nodes} folder yet`}.`,
		);

		let kernel: string | undefined;
		try {
			kernel = JSON.parse(
				readFileSync(join(paths.root, "node_modules", "@blokjs", "kernel", "package.json"), "utf8"),
			).version;
		} catch {}
		add(
			"@blokjs/kernel",
			kernel === undefined ? "problem" : kernel === VERSION ? "ok" : "note",
			kernel === undefined
				? "It is not installed in this project. Install your dependencies."
				: kernel === VERSION
					? `Installed, ${kernel}, the same version as blokctl.`
					: `The project has @blokjs/kernel ${kernel} and this is blokctl ${VERSION}. Use the same version of both.`,
		);
	}
	if (isPython || manifest) {
		// Git itself knows best, because the rule may be in a .gitignore further up.
		const asked = spawnSync("git", ["check-ignore", "-q", join(paths.dir, ".blok", "workflows")], { cwd: paths.root });
		const listed =
			existsSync(join(paths.root, ".gitignore")) &&
			/(^|\n)\s*(.*\/)?\.blok\/?\s*(\n|$)/.test(readFileSync(join(paths.root, ".gitignore"), "utf8"));
		const ignored = asked.status === 0 || (asked.status !== 1 && listed);
		add(
			"Git",
			ignored ? "ok" : "note",
			ignored
				? "The built JSON in .blok/ is ignored by git."
				: 'Git does not ignore ".blok/". The built JSON is generated and should not be committed: add ".blok/" to .gitignore.',
		);
	}

	// The editor is optional: `blokctl check` prints the same Pkl errors without it.
	const java = firstLine(env.JAVA_HOME ? join(env.JAVA_HOME, "bin", "java") : "java", ["-version"]);
	const javaMajor = java ? numbers(java)[0] : undefined;
	const extensions = join(homedir(), ".vscode", "extensions");
	const extension = existsSync(extensions)
		? readdirSync(extensions).find((name) => name.startsWith("pkl.pkl-vscode"))
		: undefined;
	add(
		"Editor",
		"note",
		[
			extension
				? `The Pkl extension for VS Code is installed (${extension}).`
				: "The Pkl extension for VS Code is not installed. It is not in the marketplace: download the .vsix from https://github.com/apple/pkl-vscode/releases and install it from the Extensions menu.",
			javaMajor !== undefined && javaMajor >= 22
				? `Java ${javaMajor} is on the PATH, which the extension needs to underline mistakes.`
				: `The extension needs Java 22 or newer to underline mistakes${javaMajor === undefined ? ", and no `java` is on the PATH. If Java is installed somewhere else, set pkl.lsp.java.path in VS Code" : `, and this is Java ${javaMajor}`}.`,
			"Nothing else needs the editor.",
		].join(" "),
	);

	const problems = findings.filter((finding) => finding.state === "problem");
	const mark = { ok: "ok     ", problem: "PROBLEM", note: "note   " };
	const text = [
		...findings.map((finding) => `${mark[finding.state]} ${finding.what}: ${finding.detail}`),
		"",
		problems.length === 0
			? "Nothing here stops blokctl from working."
			: `${problems.length} of these ${problems.length === 1 ? "stops" : "stop"} blokctl from working.`,
	].join("\n");
	return { ok: problems.length === 0, text, data: { ok: problems.length === 0, findings } };
}
