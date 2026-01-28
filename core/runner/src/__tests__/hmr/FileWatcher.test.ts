import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileWatcher, type HMREvent } from "../../hmr/FileWatcher";
import { mkdirSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("FileWatcher", () => {
	let testDir: string;
	let watcher: FileWatcher;

	beforeEach(() => {
		testDir = join(tmpdir(), `blok-test-watcher-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		mkdirSync(join(testDir, "nodes"), { recursive: true });
		mkdirSync(join(testDir, "workflows"), { recursive: true });
	});

	afterEach(async () => {
		if (watcher) {
			await watcher.stop();
		}
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Cleanup best-effort
		}
	});

	it("should initialize with default config", () => {
		watcher = new FileWatcher();
		const status = watcher.getStatus();
		expect(status.running).toBe(false);
		expect(status.watchedDirectories).toBe(0);
		expect(status.knownFiles).toBe(0);
	});

	it("should start watching directories", async () => {
		watcher = new FileWatcher({
			nodePaths: [join(testDir, "nodes")],
			workflowPaths: [join(testDir, "workflows")],
		});

		const readyPromise = new Promise<void>((resolve) => {
			watcher.on("ready", () => resolve());
		});

		await watcher.start();
		await readyPromise;

		const status = watcher.getStatus();
		expect(status.running).toBe(true);
		expect(status.watchedDirectories).toBe(2);
	});

	it("should emit change events for modified files", async () => {
		const nodeFile = join(testDir, "nodes", "test-node.ts");
		writeFileSync(nodeFile, "// initial content");

		watcher = new FileWatcher({
			nodePaths: [join(testDir, "nodes")],
			debounceMs: 50,
		});

		await watcher.start();

		const changePromise = new Promise<HMREvent>((resolve) => {
			watcher.on("change", (event: HMREvent) => {
				resolve(event);
			});
		});

		// Modify the file
		await new Promise((r) => setTimeout(r, 100));
		writeFileSync(nodeFile, "// modified content");

		const event = await Promise.race([
			changePromise,
			new Promise<null>((r) => setTimeout(() => r(null), 2000)),
		]);

		if (event) {
			expect(event.type).toBe("node:change");
			expect(event.relativePath).toBe("test-node.ts");
			expect(event.timestamp).toBeGreaterThan(0);
		}
	});

	it("should detect new file additions", async () => {
		watcher = new FileWatcher({
			nodePaths: [join(testDir, "nodes")],
			debounceMs: 50,
		});

		await watcher.start();

		const addPromise = new Promise<HMREvent>((resolve) => {
			watcher.on("node:add", (event: HMREvent) => {
				resolve(event);
			});
		});

		// Add a new file
		await new Promise((r) => setTimeout(r, 100));
		writeFileSync(join(testDir, "nodes", "new-node.ts"), "// new node");

		const event = await Promise.race([
			addPromise,
			new Promise<null>((r) => setTimeout(() => r(null), 2000)),
		]);

		if (event) {
			expect(event.type).toBe("node:add");
			expect(event.relativePath).toBe("new-node.ts");
		}
	});

	it("should ignore files matching ignore patterns", async () => {
		mkdirSync(join(testDir, "nodes", "node_modules"), { recursive: true });

		watcher = new FileWatcher({
			nodePaths: [join(testDir, "nodes")],
			ignorePatterns: ["node_modules"],
			debounceMs: 50,
		});

		await watcher.start();

		const changeSpy = vi.fn();
		watcher.on("change", changeSpy);

		// Write to ignored directory
		await new Promise((r) => setTimeout(r, 100));
		writeFileSync(join(testDir, "nodes", "node_modules", "pkg.ts"), "// ignored");

		await new Promise((r) => setTimeout(r, 500));
		expect(changeSpy).not.toHaveBeenCalled();
	});

	it("should only watch configured extensions", async () => {
		watcher = new FileWatcher({
			nodePaths: [join(testDir, "nodes")],
			extensions: [".ts"],
			debounceMs: 50,
		});

		await watcher.start();

		const changeSpy = vi.fn();
		watcher.on("change", changeSpy);

		// Write a .txt file (should be ignored)
		await new Promise((r) => setTimeout(r, 100));
		writeFileSync(join(testDir, "nodes", "readme.txt"), "// text file");

		await new Promise((r) => setTimeout(r, 500));
		expect(changeSpy).not.toHaveBeenCalled();
	});

	it("should stop watching on stop()", async () => {
		watcher = new FileWatcher({
			nodePaths: [join(testDir, "nodes")],
		});

		await watcher.start();
		expect(watcher.getStatus().running).toBe(true);

		await watcher.stop();
		expect(watcher.getStatus().running).toBe(false);
		expect(watcher.getStatus().watchedDirectories).toBe(0);
	});

	it("should not start twice", async () => {
		watcher = new FileWatcher({
			nodePaths: [join(testDir, "nodes")],
		});

		await watcher.start();
		await watcher.start(); // Should be no-op

		expect(watcher.getStatus().watchedDirectories).toBe(1);
	});

	it("should index existing files on start", async () => {
		writeFileSync(join(testDir, "nodes", "existing.ts"), "// existing");
		writeFileSync(join(testDir, "nodes", "existing2.ts"), "// existing2");

		watcher = new FileWatcher({
			nodePaths: [join(testDir, "nodes")],
		});

		await watcher.start();

		const status = watcher.getStatus();
		expect(status.knownFiles).toBe(2);
	});
});
