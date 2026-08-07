/**
 * #692 — `blokctl dev`'s restart watcher.
 *
 * The hot half of the loop (workflows + nodes, no restart) is proved end to end
 * in `triggers/http/__tests__/integration/hmr-dev-loop.test.ts`. This is the
 * other half: the changes HMR legitimately cannot absorb must trigger a
 * CONTROLLED restart, and the console must name the file and the reason —
 * previously `bun --watch` restarted on everything and explained nothing.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shouldWatchAll } from "../src/commands/dev/index.js";
import { type DevWatcher, classifyDevChange, startDevWatcher } from "../src/commands/dev/watch.js";

let root: string;
let watcher: DevWatcher | null = null;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "blok-devwatch-"));
	mkdirSync(path.join(root, "src", "triggers", "http"), { recursive: true });
	mkdirSync(path.join(root, "src", "workflows"), { recursive: true });
	mkdirSync(path.join(root, ".blok"), { recursive: true });
	mkdirSync(path.join(root, "runtimes", "python3", "nodes"), { recursive: true });
});

afterEach(() => {
	watcher?.stop();
	watcher = null;
	rmSync(root, { recursive: true, force: true });
});

type DevEvent = { kind: "restart" | "regen"; file: string; reason: string };

/** Wait for the first event of either kind, or resolve null on timeout. */
function nextEvent(timeoutMs: number): {
	promise: Promise<DevEvent | null>;
	onRestart: (file: string, reason: string) => void;
	onRegen: (file: string, reason: string) => void;
} {
	let settle: (v: DevEvent | null) => void = () => {};
	const promise = new Promise<DevEvent | null>((resolve) => {
		settle = resolve;
		setTimeout(() => resolve(null), timeoutMs);
	});
	return {
		promise,
		onRestart: (file, reason) => settle({ kind: "restart", file, reason }),
		onRegen: (file, reason) => settle({ kind: "regen", file, reason }),
	};
}

/**
 * Keep touching `file` until `pending` settles.
 *
 * `fs.watch` on macOS establishes its FSEvents stream asynchronously, so a
 * write issued microseconds after `watch()` returns can be missed entirely —
 * which shows up as flake once the CI box is loaded. Re-saving models what a
 * developer actually does and takes the race out of the assertion.
 */
async function touchUntilSettled(file: string, body: string, pending: Promise<DevEvent | null>) {
	let done = false;
	void pending.then(() => {
		done = true;
	});
	writeFileSync(file, body);
	while (!done) {
		await new Promise((r) => setTimeout(r, 150));
		if (done) break;
		writeFileSync(file, `${body}# ${Date.now()}\n`);
	}
	return pending;
}

const roots = (r: string) => ({
	triggerPaths: [path.join(r, "src", "triggers")],
	runtimePaths: [path.join(r, "runtimes", "python3")],
});

describe("classifyDevChange — the restart watcher only claims what HMR can't absorb", () => {
	it("claims trigger entrypoints, .env* and project config", () => {
		const r = roots("/app");
		expect(classifyDevChange("/app/src/triggers/http/index.ts", r).action).toBe("restart");
		expect(classifyDevChange("/app/.env", r).action).toBe("restart");
		expect(classifyDevChange("/app/.env.local", r).action).toBe("restart");
		expect(classifyDevChange("/app/.blok/config.json", r).action).toBe("restart");
	});

	it("leaves workflows and nodes to in-process HMR", () => {
		const r = roots("/app");
		// No workflow/node roots are passed, so these classify as "outside the
		// watched roots" — the restart watcher must never claim them.
		expect(classifyDevChange("/app/workflows/json/orders.json", r).action).not.toBe("restart");
		expect(classifyDevChange("/app/src/nodes/charge/index.ts", r).action).not.toBe("restart");
	});

	it("routes sidecar node sources to stub regen, and never restarts on generated output", () => {
		const r = roots("/app");
		expect(classifyDevChange("/app/runtimes/python3/nodes/score.py", r).action).toBe("regen");
		// Regen writes here — restarting on it would be an infinite loop.
		expect(classifyDevChange("/app/nodes-gen/runtime-python3.ts", r).action).toBe("ignore");
	});
});

describe("startDevWatcher", () => {
	it("restarts on a .env change and names the file and the reason", async () => {
		const ev = nextEvent(8000);
		watcher = startDevWatcher({ root, ...roots(root), onRestart: ev.onRestart, onRegen: ev.onRegen, debounceMs: 20 });

		const event = await touchUntilSettled(path.join(root, ".env"), "STACK_TOKEN=abc\n", ev.promise);
		expect(event?.kind).toBe("restart");
		expect(event?.file).toBe(path.join(root, ".env"));
		expect(event?.reason).toMatch(/environment file/i);
	});

	it("restarts on a trigger entrypoint change and names the file and the reason", async () => {
		const ev = nextEvent(8000);
		watcher = startDevWatcher({ root, ...roots(root), onRestart: ev.onRestart, onRegen: ev.onRegen, debounceMs: 20 });

		const event = await touchUntilSettled(
			path.join(root, "src", "triggers", "http", "index.ts"),
			"export default 1;\n",
			ev.promise,
		);
		expect(event?.kind).toBe("restart");
		expect(event?.file).toBe(path.join(root, "src", "triggers", "http", "index.ts"));
		expect(event?.reason).toMatch(/trigger entrypoint/i);
	});

	it("regenerates stubs on a sidecar node change instead of restarting", async () => {
		const ev = nextEvent(8000);
		watcher = startDevWatcher({ root, ...roots(root), onRestart: ev.onRestart, onRegen: ev.onRegen, debounceMs: 20 });

		const event = await touchUntilSettled(
			path.join(root, "runtimes", "python3", "nodes", "score.py"),
			"# node\n",
			ev.promise,
		);
		expect(event?.kind).toBe("regen");
		expect(event?.reason).toMatch(/sidecar node source/i);
	});

	it("restarts when a triggerPath names a single entrypoint FILE, not a directory", async () => {
		// The legacy single-runner layout is `src/index.ts`, so `triggerPaths`
		// carries a file. Watching a file reports its own basename, which naive
		// path joining turns into `src/index.ts/index.ts` — a path that doesn't
		// exist, so the restart silently never fired.
		const entry = path.join(root, "src", "index.ts");
		writeFileSync(entry, "export default 0;\n");
		const ev = nextEvent(8000);
		watcher = startDevWatcher({
			root,
			triggerPaths: [entry],
			runtimePaths: [],
			onRestart: ev.onRestart,
			onRegen: ev.onRegen,
			debounceMs: 20,
		});

		const event = await touchUntilSettled(entry, "export default 1;\n", ev.promise);
		expect(event?.kind).toBe("restart");
		expect(event?.file).toBe(entry);
	});

	it("stays silent for a workflow edit — that belongs to in-process HMR", async () => {
		const ev = nextEvent(2000);
		watcher = startDevWatcher({ root, ...roots(root), onRestart: ev.onRestart, onRegen: ev.onRegen, debounceMs: 20 });

		expect(
			await touchUntilSettled(path.join(root, "src", "workflows", "orders.ts"), "export default {};\n", ev.promise),
		).toBeNull();
	});

	it("stop() releases the watchers", async () => {
		const ev = nextEvent(800);
		watcher = startDevWatcher({ root, ...roots(root), onRestart: ev.onRestart, onRegen: ev.onRegen, debounceMs: 20 });
		watcher.stop();

		expect(await touchUntilSettled(path.join(root, ".env"), "A=1\n", ev.promise)).toBeNull();
	});
});

describe("shouldWatchAll — the documented escape hatch", () => {
	const original = process.env.BLOK_DEV_WATCH_ALL;
	afterEach(() => {
		// biome-ignore lint/performance/noDelete: restore literal absence, not the string "undefined"
		if (original === undefined) delete process.env.BLOK_DEV_WATCH_ALL;
		else process.env.BLOK_DEV_WATCH_ALL = original;
	});

	it("is off by default — `bun --watch` no longer preempts HMR", () => {
		// biome-ignore lint/performance/noDelete: restore literal absence, not the string "undefined"
		delete process.env.BLOK_DEV_WATCH_ALL;
		expect(shouldWatchAll({})).toBe(false);
	});

	it("is enabled by --watch-all", () => {
		// biome-ignore lint/performance/noDelete: restore literal absence, not the string "undefined"
		delete process.env.BLOK_DEV_WATCH_ALL;
		expect(shouldWatchAll({ watchAll: true })).toBe(true);
	});

	it("is enabled by BLOK_DEV_WATCH_ALL=1", () => {
		process.env.BLOK_DEV_WATCH_ALL = "1";
		expect(shouldWatchAll({})).toBe(true);
	});
});
