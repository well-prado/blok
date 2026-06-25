import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateRustNodeRegistry } from "../../src/services/runtime-setup.js";

let projectDir: string;

function writeNode(name: string, src: string, file = "node.rs"): void {
	const dir = path.join(projectDir, "runtimes", "rust", "nodes", name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, file), src);
}

const conformingNode = (register = "greet") => `use async_trait::async_trait;
use blok::registry::NodeRegistry;
use blok::{Context, NodeHandler};
use std::collections::HashMap;
struct N;
#[async_trait]
impl NodeHandler for N {
    async fn execute(&self, _ctx: &mut Context, _config: &HashMap<String, serde_json::Value>) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> { Ok(serde_json::Value::Null) }
}
pub fn register(registry: &mut NodeRegistry) { registry.register("${register}", N); }
`;

beforeEach(() => {
	projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "blok-rust-codegen-"));
	// The build module dir must exist (setup copies the SDK here).
	fs.mkdirSync(path.join(projectDir, ".blok", "runtimes", "rust", "src"), { recursive: true });
});

afterEach(() => {
	fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("generateRustNodeRegistry", () => {
	it("registers a conforming node and copies its source into the module", () => {
		writeNode("greet", conformingNode());
		const file = generateRustNodeRegistry(projectDir);

		const out = fs.readFileSync(file, "utf8");
		expect(out).toContain("pub mod greet;");
		expect(out).toContain("greet::register(registry);");
		expect(out).toContain("use blok::registry::NodeRegistry;");

		// Source copied into the build module as the node's mod.rs so it compiles in-tree.
		const copied = path.join(projectDir, ".blok", "runtimes", "rust", "src", "user_nodes", "greet", "mod.rs");
		expect(fs.existsSync(copied)).toBe(true);
	});

	it("emits a valid empty shim when there are no user nodes", () => {
		const out = fs.readFileSync(generateRustNodeRegistry(projectDir), "utf8");
		// blok import is present (used by the param type) so the file compiles;
		// no user mods / calls, and the param is underscored to avoid unused warnings.
		expect(out).toContain("use blok::registry::NodeRegistry;");
		expect(out).not.toContain("pub mod ");
		expect(out).toContain("pub fn register_user_nodes(_registry: &mut NodeRegistry) {");
	});

	it("sanitizes dashed node names to valid module idents while keeping the registry name", () => {
		writeNode("my-cool-node", conformingNode("my-cool-node"));
		const out = fs.readFileSync(generateRustNodeRegistry(projectDir), "utf8");
		expect(out).toContain("pub mod my_cool_node;");
		expect(out).toContain("my_cool_node::register(registry);");
		expect(
			fs.existsSync(path.join(projectDir, ".blok", "runtimes", "rust", "src", "user_nodes", "my_cool_node", "mod.rs")),
		).toBe(true);
	});

	it("skips a directory that does not export fn register()", () => {
		writeNode("bad", "pub fn not_register() {}\n");
		writeNode("good", conformingNode("good-node"));
		const out = fs.readFileSync(generateRustNodeRegistry(projectDir), "utf8");

		expect(out).toContain("pub mod good;");
		expect(out).not.toContain("pub mod bad;");
		expect(fs.existsSync(path.join(projectDir, ".blok", "runtimes", "rust", "src", "user_nodes", "bad"))).toBe(false);
	});

	it("wipes stale copied sources from a previous run", () => {
		const usernodes = path.join(projectDir, ".blok", "runtimes", "rust", "src", "user_nodes");
		fs.mkdirSync(path.join(usernodes, "deleted"), { recursive: true });
		fs.writeFileSync(path.join(usernodes, "deleted", "mod.rs"), "stale");

		generateRustNodeRegistry(projectDir); // no nodes this run
		expect(fs.existsSync(path.join(usernodes, "deleted"))).toBe(false);
	});
});
