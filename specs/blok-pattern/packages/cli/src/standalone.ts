// blokctl is also built as one file that needs no Node, for projects in other languages. That build
// carries the files this tool ships with inside itself, and starts itself again without a script path.
// `bin.ts`, the entry of that build, fills this in before anything runs.
import { fileURLToPath } from "node:url";

const state: { on: boolean; assets: Record<string, string>; version?: string } = { on: false, assets: {} };

export function setStandalone(assets: Record<string, string>, version: string): void {
	state.on = true;
	state.assets = assets;
	state.version = version;
}

/** The text of a shipped file, when this is the single-file build. */
export const assetText = (name: string): string | undefined => state.assets[name];

/** The version, when this is the single-file build, which has no package.json beside it. */
export const standaloneVersion = (): string | undefined => state.version;

/** The command that starts this tool again: itself, or Node with the script it was started from. */
export const self = (): string[] =>
	state.on ? [process.execPath] : [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url))];
