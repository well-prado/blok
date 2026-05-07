/**
 * Security review FW-3 — `localResolver` path canonicalization.
 *
 * Before the fix, `${process.env.NODES_PATH}/${node.node}` was naively
 * concatenated and passed to `import()`. A node.node value containing
 * `..` walked the filesystem outside the configured directory. The
 * fix canonicalizes both `base` and `target` against `NODES_PATH` and
 * throws when the resolved target escapes the base directory.
 */

import { resolve as resolvePath } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Configuration from "../../Configuration";
import type RunnerNode from "../../RunnerNode";

class TestableConfiguration extends Configuration {
	public callLocalResolver(node: RunnerNode): Promise<RunnerNode> {
		return this.localResolver(node);
	}
}

describe("Configuration · localResolver path canonicalization (FW-3)", () => {
	const originalNodesPath = process.env.NODES_PATH;
	let cfg: TestableConfiguration;

	beforeEach(() => {
		cfg = new TestableConfiguration();
		process.env.NODES_PATH = resolvePath("/tmp/blok-fw3-test-nodes");
	});

	afterEach(() => {
		if (originalNodesPath === undefined) {
			process.env.NODES_PATH = undefined;
		} else {
			process.env.NODES_PATH = originalNodesPath;
		}
	});

	it("rejects '..' traversal", async () => {
		const node = { node: "../../etc/passwd" } as unknown as RunnerNode;
		await expect(cfg.callLocalResolver(node)).rejects.toThrow(/escapes NODES_PATH/);
	});

	it("rejects absolute paths outside the base", async () => {
		const node = { node: "/etc/passwd" } as unknown as RunnerNode;
		await expect(cfg.callLocalResolver(node)).rejects.toThrow(/escapes NODES_PATH/);
	});

	it("rejects nested '..' that ultimately escapes", async () => {
		const node = {
			node: "valid/path/../../../etc/shadow",
		} as unknown as RunnerNode;
		await expect(cfg.callLocalResolver(node)).rejects.toThrow(/escapes NODES_PATH/);
	});

	it("rejects URL-encoded traversal sequences (handled by path normalization)", async () => {
		// %2E%2E does NOT decode at the path level — it's literally a
		// two-segment dirname. So the resolver simply tries to import
		// a file called %2E%2E which fails on import (file doesn't
		// exist). The point of this test is to confirm that encoded
		// sequences don't bypass the canonicalization check.
		const node = { node: "%2E%2E/%2E%2E/etc/passwd" } as unknown as RunnerNode;
		await expect(cfg.callLocalResolver(node)).rejects.toThrow();
	});

	it("does not consider a path that resolves to the base itself as escape", async () => {
		// node.node = "." resolves to NODES_PATH itself; the check
		// permits this (target === base) but import() will fail because
		// importing a directory isn't valid. We assert it gets past the
		// canonicalization guard (the error message is NOT the FW-3
		// "escapes NODES_PATH" string).
		const node = { node: "." } as unknown as RunnerNode;
		await expect(cfg.callLocalResolver(node)).rejects.not.toThrow(/escapes NODES_PATH/);
	});

	it("permits an absolute path that lives inside the base directory", async () => {
		// We can't actually import this (the file doesn't exist on disk),
		// but the canonicalization guard should NOT reject. The error
		// must be import-related, not "escapes NODES_PATH".
		const inside = `${process.env.NODES_PATH}/some-node`;
		const node = { node: inside } as unknown as RunnerNode;
		await expect(cfg.callLocalResolver(node)).rejects.not.toThrow(/escapes NODES_PATH/);
	});
});
