import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateJavaNodeRegistry } from "../../src/services/runtime-setup.js";

let projectDir: string;

function writeNode(name: string, className: string, src: string): void {
	const dir = path.join(
		projectDir,
		"runtimes",
		"java",
		"nodes",
		name,
		"src",
		"main",
		"java",
		"com",
		"blok",
		"blok",
		"nodes",
	);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${className}.java`), src);
}

const conformingNode = (className: string) => `package com.blok.blok.nodes;
import com.blok.blok.node.NodeHandler;
import com.blok.blok.types.Context;
import java.util.Map;
public class ${className} implements NodeHandler {
	public Object execute(Context ctx, Map<String, Object> config) { return Map.of(); }
}
`;

beforeEach(() => {
	projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "blok-java-codegen-"));
	// The build module source root must exist (setup copies the SDK here).
	fs.mkdirSync(path.join(projectDir, ".blok", "runtimes", "java", "src", "main", "java", "com", "blok", "blok"), {
		recursive: true,
	});
});

afterEach(() => {
	fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("generateJavaNodeRegistry", () => {
	it("registers a conforming node and copies its package tree into the module", () => {
		writeNode("greet-user", "GreetUserNode", conformingNode("GreetUserNode"));
		const file = generateJavaNodeRegistry(projectDir);

		const out = fs.readFileSync(file, "utf8");
		expect(out).toContain('registry.register("greet-user", new com.blok.blok.nodes.GreetUserNode());');
		expect(out).toContain("public static void registerUserNodes(NodeRegistry registry)");

		// Package tree copied into the build module so it compiles in-tree.
		const copied = path.join(
			projectDir,
			".blok",
			"runtimes",
			"java",
			"src",
			"main",
			"java",
			"usernodes",
			"greet-user",
			"com",
			"blok",
			"blok",
			"nodes",
			"GreetUserNode.java",
		);
		expect(fs.existsSync(copied)).toBe(true);
	});

	it("emits a valid empty shim when there are no user nodes", () => {
		const out = fs.readFileSync(generateJavaNodeRegistry(projectDir), "utf8");
		expect(out).toContain("package com.blok.blok;");
		expect(out).toContain("public static void registerUserNodes(NodeRegistry registry)");
		expect(out).not.toContain("usernodes");
	});

	it("skips a directory whose class does not implement NodeHandler", () => {
		writeNode("bad", "NotANode", "package com.blok.blok.nodes;\npublic class NotANode { }\n");
		writeNode("good", "GoodNode", conformingNode("GoodNode"));
		const out = fs.readFileSync(generateJavaNodeRegistry(projectDir), "utf8");

		expect(out).toContain('registry.register("good"');
		expect(out).not.toContain('registry.register("bad"');
		expect(
			fs.existsSync(path.join(projectDir, ".blok", "runtimes", "java", "src", "main", "java", "usernodes", "bad")),
		).toBe(false);
	});

	it("wipes stale copied sources from a previous run", () => {
		const usernodes = path.join(projectDir, ".blok", "runtimes", "java", "src", "main", "java", "usernodes");
		fs.mkdirSync(path.join(usernodes, "deleted"), { recursive: true });
		fs.writeFileSync(path.join(usernodes, "deleted", "x.java"), "stale");

		generateJavaNodeRegistry(projectDir); // no nodes this run
		expect(fs.existsSync(path.join(usernodes, "deleted"))).toBe(false);
	});
});
