import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateCSharpNodeRegistry } from "../../src/services/runtime-setup.js";

let projectDir: string;

function writeNode(name: string, file: string, src: string): void {
	const dir = path.join(projectDir, "runtimes", "csharp", "nodes", name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, file), src);
}

const conformingNode = (className: string, register: string) => `using System.Text.Json;
using Blok.Core.Node;
using Blok.Core.Types;

namespace Blok.Core.Nodes;

public class ${className} : INodeHandler
{
    public Task<JsonElement> ExecuteAsync(Context ctx, Dictionary<string, JsonElement> config)
        => Task.FromResult(JsonSerializer.SerializeToElement(new { register = "${register}" }));
}
`;

beforeEach(() => {
	projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "blok-csharp-codegen-"));
	// The build module dir must exist (setup copies the SDK here).
	fs.mkdirSync(path.join(projectDir, ".blok", "runtimes", "csharp", "src", "Blok.Core"), {
		recursive: true,
	});
});

afterEach(() => {
	fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("generateCSharpNodeRegistry", () => {
	it("registers a conforming node and copies its sources into the module", () => {
		writeNode("greet", "GreetNode.cs", conformingNode("GreetNode", "greet"));
		const file = generateCSharpNodeRegistry(projectDir);

		const out = fs.readFileSync(file, "utf8");
		expect(out).toContain('registry.Register("greet", new Blok.Core.Nodes.GreetNode());');
		expect(out).toContain("namespace Blok.Core;");
		expect(out).toContain("public static class UserNodeRegistry");

		// Sources copied into the build module so they compile in-tree.
		const copied = path.join(
			projectDir,
			".blok",
			"runtimes",
			"csharp",
			"src",
			"Blok.Core",
			"Nodes",
			"UserNodes",
			"greet",
			"GreetNode.cs",
		);
		expect(fs.existsSync(copied)).toBe(true);
	});

	it("emits a compilable empty shim when there are no user nodes", () => {
		const out = fs.readFileSync(generateCSharpNodeRegistry(projectDir), "utf8");
		expect(out).toContain("public static void RegisterUserNodes(NodeRegistry registry)");
		expect(out).not.toContain("registry.Register(");
	});

	it("skips a directory that has no INodeHandler class", () => {
		writeNode("bad", "NotANode.cs", "namespace Blok.Core.Nodes; public class Helper {}");
		writeNode("good", "GoodNode.cs", conformingNode("GoodNode", "good-node"));
		const out = fs.readFileSync(generateCSharpNodeRegistry(projectDir), "utf8");

		expect(out).toContain("GoodNode");
		expect(out).not.toContain("NotANode");
		expect(
			fs.existsSync(
				path.join(projectDir, ".blok", "runtimes", "csharp", "src", "Blok.Core", "Nodes", "UserNodes", "bad"),
			),
		).toBe(false);
	});

	it("skips a duplicate class name across nodes (single namespace)", () => {
		writeNode("first", "GreetNode.cs", conformingNode("GreetNode", "first"));
		writeNode("second", "GreetNode.cs", conformingNode("GreetNode", "second"));
		const out = fs.readFileSync(generateCSharpNodeRegistry(projectDir), "utf8");

		// Only one registration for the colliding class name.
		expect(out.match(/Blok\.Core\.Nodes\.GreetNode/g)?.length).toBe(1);
	});

	it("wipes stale copied sources from a previous run", () => {
		const usernodes = path.join(projectDir, ".blok", "runtimes", "csharp", "src", "Blok.Core", "Nodes", "UserNodes");
		fs.mkdirSync(path.join(usernodes, "deleted"), { recursive: true });
		fs.writeFileSync(path.join(usernodes, "deleted", "OldNode.cs"), "stale");

		generateCSharpNodeRegistry(projectDir); // no nodes this run
		expect(fs.existsSync(path.join(usernodes, "deleted"))).toBe(false);
	});
});
