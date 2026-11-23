// Finding the `pkl` command. One that is already installed is used as it is. Otherwise Apple's
// official binary is downloaded once, at a pinned version, and checked against a checksum kept here.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export const PKL_VERSION = "0.33.1";

/** The files of the official release, with the SHA-256 that GitHub publishes for each. */
const RELEASE: Record<string, { file: string; sha256: string }> = {
	"darwin-arm64": {
		file: "pkl-macos-aarch64",
		sha256: "6f93ddf6524a5771bd4b6ebde11010c6dfee8e3a8906ffebaa8f52f8a0ba16b7",
	},
	"linux-x64": {
		file: "pkl-linux-amd64",
		sha256: "acbca9bb4f31139d09e295d03c9fb25f77edf5a74af4e772b56b32dc6dc17c44",
	},
	"linux-arm64": {
		file: "pkl-linux-aarch64",
		sha256: "4a752096dab13d7432e1f0a4f1219833df95e1e36ce0b8d424b0edb2cd5436f9",
	},
	"linux-x64-musl": {
		file: "pkl-alpine-linux-amd64",
		sha256: "a9d84c3d92ef3706f81457daa90218ef32fbc5623e278675260f9b01c7257742",
	},
	"win32-x64": {
		file: "pkl-windows-amd64.exe",
		sha256: "b1da686befc4ce4d92fe81bd2892e7457a505328313380010c4791c7f68d7432",
	},
};

export interface PklOptions {
	env?: Record<string, string | undefined>;
	/** `<platform>-<arch>`, with `-musl` added on Alpine. Default: this machine. */
	target?: string;
	/** Where the release files are. Default: Apple's releases on GitHub. */
	baseUrl?: string;
	/** Overrides the pinned files, for tests. */
	release?: Record<string, { file: string; sha256: string }>;
	cacheDir?: string;
	/** Called once before a download starts. */
	onDownload?: (url: string) => void;
}

function thisMachine(): string {
	const base = `${process.platform}-${process.arch}`;
	if (process.platform !== "linux") return base;
	// glibc reports its version here. A Linux without it is musl, which is what Alpine uses.
	const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
	return report?.header?.glibcVersionRuntime ? base : `${base}-musl`;
}

function onPath(env: Record<string, string | undefined>): string | undefined {
	const names = process.platform === "win32" ? ["pkl.exe", "pkl.cmd", "pkl.bat"] : ["pkl"];
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		for (const name of names) if (dir && existsSync(join(dir, name))) return join(dir, name);
	}
	return undefined;
}

function cacheRoot(env: Record<string, string | undefined>): string {
	if (env.BLOK_CACHE_DIR) return env.BLOK_CACHE_DIR;
	if (process.platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "blok");
	return join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "blok");
}

/**
 * The path of a `pkl` command to run. In order: `BLOK_PKL`, one on the PATH, one downloaded earlier,
 * and last a fresh download. The download is refused unless its checksum matches, and `BLOK_OFFLINE` forbids it.
 */
export async function findPkl(options: PklOptions = {}): Promise<string> {
	const env = options.env ?? process.env;
	if (env.BLOK_PKL) {
		if (!existsSync(env.BLOK_PKL)) throw new Error(`BLOK_PKL points at "${env.BLOK_PKL}", which does not exist.`);
		return env.BLOK_PKL;
	}
	const installed = onPath(env);
	if (installed) return installed;

	const target = options.target ?? thisMachine();
	const asset = (options.release ?? RELEASE)[target];
	if (!asset) {
		throw new Error(
			`Workflows are written in Pkl, and Pkl ${PKL_VERSION} has no ready-made binary for ${target}. Install Pkl yourself (https://pkl-lang.org) and put it on the PATH, or point BLOK_PKL at it.`,
		);
	}
	const cached = join(options.cacheDir ?? cacheRoot(env), "pkl", PKL_VERSION, asset.file);
	if (existsSync(cached)) return cached;
	if (env.BLOK_OFFLINE) {
		throw new Error(
			"Workflows are written in Pkl, and no `pkl` command was found. BLOK_OFFLINE is set, so it was not downloaded. Install Pkl (https://pkl-lang.org) and put it on the PATH, or point BLOK_PKL at it.",
		);
	}

	const url = `${options.baseUrl ?? `https://github.com/apple/pkl/releases/download/${PKL_VERSION}`}/${asset.file}`;
	options.onDownload?.(url);
	let bytes: Uint8Array;
	try {
		const response = await fetch(url);
		if (!response.ok) throw new Error(`the server answered ${response.status}`);
		bytes = new Uint8Array(await response.arrayBuffer());
	} catch (err) {
		throw new Error(
			`Workflows are written in Pkl, and it could not be downloaded from ${url}: ${(err as Error).message}. Install Pkl yourself and put it on the PATH, or point BLOK_PKL at it.`,
		);
	}
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	if (sha256 !== asset.sha256) {
		throw new Error(
			`The Pkl download from ${url} is not the file that was expected, so it was thrown away. Its SHA-256 is ${sha256}, and it should be ${asset.sha256}.`,
		);
	}
	// Written beside its final place and renamed, so a half-written file is never run.
	mkdirSync(dirname(cached), { recursive: true });
	const partial = `${cached}.${process.pid}.partial`;
	try {
		writeFileSync(partial, bytes);
		chmodSync(partial, 0o755);
		renameSync(partial, cached);
	} finally {
		rmSync(partial, { force: true });
	}
	return cached;
}
