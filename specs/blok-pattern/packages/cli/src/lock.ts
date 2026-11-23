// A locked contract: `contract.json` beside a node. It is what the design pass promised, written down where
// the build pass cannot change it by accident, and in a form any language and any agent can read.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type Unit, contract } from "@blokjs/kernel";
import { type Analysis, type Paths, nodeFolder } from "./analyze.ts";
import type { Report } from "./commands.ts";

export const LOCK_FILE = "contract.json";

/** The part of a node other things rely on: what it takes, what it answers with, and how it may fail. */
export interface Locked {
	id: string;
	input: unknown;
	output: unknown;
	errors: string[];
	/** When each error happens. For readers: a better description is not a change of contract. */
	errorMeanings?: Record<string, string>;
}

export function lockOf(unit: Unit): Locked {
	const described = contract(unit);
	const meanings = Object.keys(described.errorMeanings).length > 0 ? { errorMeanings: described.errorMeanings } : {};
	return {
		id: unit.id,
		input: described.input,
		output: described.output,
		errors: [...described.errors].sort(),
		...meanings,
	};
}

/** JSON with the keys in one order, so two equal contracts are equal text. */
const canonical = (value: unknown): string =>
	JSON.stringify(value, (_key, inner) =>
		inner !== null && typeof inner === "object" && !Array.isArray(inner)
			? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
			: inner,
	);

/** What the node's folder says was promised, or nothing when it was never locked. */
export function readLock(folder: string): Locked | undefined {
	const file = join(folder, LOCK_FILE);
	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Locked) : undefined;
}

/** The parts of a node's contract that no longer match what was locked. */
export function drift(unit: Unit, lock: Locked): Array<"input" | "output" | "errors"> {
	const now = lockOf(unit);
	return (["input", "output", "errors"] as const).filter((part) => canonical(now[part]) !== canonical(lock[part]));
}

/**
 * Writes `contract.json` for every node that has none. With an id, it writes that node's again,
 * which is how a contract that is still being designed gets changed on purpose.
 */
export function lock(analysis: Analysis, paths: Paths, id?: string): Report {
	if (id && !analysis.nodes.has(id)) {
		const text = `${id} is not a node. Run "blokctl list" to see the nodes.`;
		return { ok: false, text, data: { ok: false, problems: [text] } };
	}
	const written: string[] = [];
	const kept: string[] = [];
	for (const unit of analysis.nodes.values()) {
		if (id && unit.id !== id) continue;
		const folder = nodeFolder(paths, unit.id);
		if (!id && existsSync(join(folder, LOCK_FILE))) {
			kept.push(unit.id);
			continue;
		}
		writeFileSync(join(folder, LOCK_FILE), `${JSON.stringify(lockOf(unit), null, "\t")}\n`);
		written.push(unit.id);
	}
	const lines = [
		written.length > 0
			? `Locked ${written.length === 1 ? written[0] : `${written.length} nodes`}: ${LOCK_FILE} is now beside ${written.length === 1 ? "it" : "each of them"}, in ${relative(process.cwd(), paths.nodes) || "."}.`
			: "Every node was already locked. Nothing was written.",
		...(kept.length > 0 && written.length > 0 ? [`${kept.length} were already locked and were left alone.`] : []),
		...(written.length > 0
			? ['From here on, "blokctl check" refuses a node whose input, output or errors differ from its contract.json.']
			: []),
	];
	return { ok: true, text: lines.join("\n"), data: { ok: true, locked: written, alreadyLocked: kept } };
}
