import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateGoNodeRegistry } from "../../src/services/runtime-setup.js";

let projectDir: string;

function writeNode(name: string, src: string): void {
	const dir = path.join(projectDir, "runtimes", "go", "nodes", name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "node.go"), src);
}

const conformingNode = (pkg: string, register = "greet") => `package ${pkg}
import blok "github.com/nickincloud/blok-go"
type N struct{}
func (n *N) Execute(ctx *blok.Context, config map[string]interface{}) (interface{}, error) { return nil, nil }
func Register(registry *blok.NodeRegistry) { registry.Register("${register}", &N{}) }
`;

beforeEach(() => {
	projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "blok-go-codegen-"));
	// The build module dir must exist (setup copies the SDK here).
	fs.mkdirSync(path.join(projectDir, ".blok", "runtimes", "go", "cmd", "server"), { recursive: true });
});

afterEach(() => {
	fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("generateGoNodeRegistry", () => {
	it("registers a conforming node and copies its sources into the module", () => {
		writeNode("greet", conformingNode("greet"));
		const file = generateGoNodeRegistry(projectDir);

		const out = fs.readFileSync(file, "utf8");
		expect(out).toContain('usernode0 "github.com/nickincloud/blok-go/usernodes/greet"');
		expect(out).toContain("usernode0.Register(registry)");
		expect(out).toContain("package main");

		// Sources copied into the build module so they compile in-tree.
		const copied = path.join(projectDir, ".blok", "runtimes", "go", "usernodes", "greet", "node.go");
		expect(fs.existsSync(copied)).toBe(true);
	});

	it("emits a valid empty shim when there are no user nodes", () => {
		const out = fs.readFileSync(generateGoNodeRegistry(projectDir), "utf8");
		// blok import is present (used by the param type) so the file compiles;
		// no user imports / calls.
		expect(out).toContain('blok "github.com/nickincloud/blok-go"');
		expect(out).not.toContain("usernodes/");
		expect(out).toContain("func registerUserNodes(registry *blok.NodeRegistry) {");
	});

	it("skips a directory that does not export Register()", () => {
		writeNode("bad", "package bad\nfunc NotRegister() {}\n");
		writeNode("good", conformingNode("good", "good-node"));
		const out = fs.readFileSync(generateGoNodeRegistry(projectDir), "utf8");

		expect(out).toContain("usernodes/good");
		expect(out).not.toContain("usernodes/bad");
		expect(fs.existsSync(path.join(projectDir, ".blok", "runtimes", "go", "usernodes", "bad"))).toBe(false);
	});

	it("wipes stale copied sources from a previous run", () => {
		const usernodes = path.join(projectDir, ".blok", "runtimes", "go", "usernodes");
		fs.mkdirSync(path.join(usernodes, "deleted"), { recursive: true });
		fs.writeFileSync(path.join(usernodes, "deleted", "node.go"), "stale");

		generateGoNodeRegistry(projectDir); // no nodes this run
		expect(fs.existsSync(path.join(usernodes, "deleted"))).toBe(false);
	});
});
