// The language the nodes of a project are written in. Workflows, the check and the built JSON are the
// same for every language. What differs is listed here, so no command has to ask which language it is in.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Language {
	name: "typescript" | "python";
	/** The file that holds a node, inside the node's folder. */
	nodeFile: string;
	/** The test that sits beside it. */
	testFile: string;
	/** Where the ports are, below the project folder. */
	portsFile: string;
	/** The file that names the project and its dependencies. */
	manifest: string;
	/** How a node with no logic yet is written. */
	todo: string;
	/** Whether a file is source code of this language, for copying a node to its next version. */
	source: RegExp;
}

export const TYPESCRIPT: Language = {
	name: "typescript",
	nodeFile: "node.ts",
	testFile: "node.test.ts",
	portsFile: "ports/index.ts",
	manifest: "package.json",
	todo: "run: todo",
	source: /\.[cm]?[jt]s$/,
};

export const PYTHON: Language = {
	name: "python",
	nodeFile: "node.py",
	testFile: "test_node.py",
	portsFile: "ports/__init__.py",
	manifest: "pyproject.toml",
	todo: "run=todo",
	source: /\.py$/,
};

export const LANGUAGES = { typescript: TYPESCRIPT, python: PYTHON } as const;

/**
 * The `[tool.blok]` table of a pyproject.toml, as far as blokctl reads it: plain `key = "text"` lines.
 * Nothing when there is no such file or no such table.
 */
export function pyprojectSettings(root: string): Record<string, string> | undefined {
	let text: string;
	try {
		text = readFileSync(join(root, "pyproject.toml"), "utf8");
	} catch {
		return undefined;
	}
	const start = /^\[tool\.blok\][ \t]*(#.*)?$/m.exec(text);
	if (!start) return undefined;
	const rest = text.slice(start.index + start[0].length);
	const table = rest.slice(0, /^\[/m.exec(rest)?.index ?? rest.length);
	const settings: Record<string, string> = {};
	for (const line of table.split("\n")) {
		const pair = /^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(#.*)?$/.exec(line);
		if (pair) settings[pair[1]] = pair[2] ?? pair[3];
	}
	return settings;
}

/**
 * A project is Python when its pyproject.toml has a `[tool.blok]` table, which `blokctl init` writes, or when
 * it has a pyproject.toml and no package.json. Everything else is TypeScript.
 */
export function languageOf(root: string): Language {
	if (pyprojectSettings(root)) return PYTHON;
	if (existsSync(join(root, "package.json"))) return TYPESCRIPT;
	return existsSync(join(root, "pyproject.toml")) ? PYTHON : TYPESCRIPT;
}
