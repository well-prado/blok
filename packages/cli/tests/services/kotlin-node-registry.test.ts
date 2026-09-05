import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKotlinNodeRegistry } from "../../src/services/runtime-setup.js";

let projectDir: string;

function writeNode(name: string, className: string, source: string): void {
	const dir = path.join(projectDir, "runtimes", "kotlin", "nodes", name, "src", "main", "kotlin", "user", "nodes");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${className}.kt`), source);
}

const conformingNode = (className: string) => `package user.nodes
import com.blok.kotlin.NodeContext
import com.blok.kotlin.NodeHandler
import kotlinx.serialization.json.JsonObject
class ${className} : NodeHandler {
    override val name = "fixture"
    override suspend fun execute(ctx: NodeContext, input: JsonObject) = input
}
`;

beforeEach(() => {
	projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "blok-kotlin-codegen-"));
	fs.mkdirSync(path.join(projectDir, ".blok", "runtimes", "kotlin", "src", "main", "kotlin", "com", "blok", "kotlin"), {
		recursive: true,
	});
});

afterEach(() => fs.rmSync(projectDir, { recursive: true, force: true }));

describe("generateKotlinNodeRegistry", () => {
	it("registers a conforming node and copies its source tree", () => {
		writeNode("greet-user", "GreetUserNode", conformingNode("GreetUserNode"));
		const file = generateKotlinNodeRegistry(projectDir);

		const out = fs.readFileSync(file, "utf8");
		expect(out).toContain("registry.register(user.nodes.GreetUserNode())");
		expect(out).toContain("object UserNodeRegistry");
		expect(
			fs.existsSync(
				path.join(
					projectDir,
					".blok",
					"runtimes",
					"kotlin",
					"src",
					"main",
					"kotlin",
					"usernodes",
					"greet-user",
					"GreetUserNode.kt",
				),
			),
		).toBe(true);
	});

	it("skips non-node directories and removes stale copies", () => {
		const stale = path.join(projectDir, ".blok", "runtimes", "kotlin", "src", "main", "kotlin", "usernodes", "stale");
		fs.mkdirSync(stale, { recursive: true });
		fs.writeFileSync(path.join(stale, "Old.kt"), "stale");
		writeNode("not-a-node", "NotANode", "package user.nodes\nclass NotANode\n");

		const out = fs.readFileSync(generateKotlinNodeRegistry(projectDir), "utf8");
		expect(out).not.toContain("NotANode");
		expect(fs.existsSync(stale)).toBe(false);
	});
});
