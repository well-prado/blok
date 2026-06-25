import { describe, expect, it } from "vitest";
import { ruby_node_file } from "../../../src/commands/create/utils/Examples.js";

/** Mirror of node.ts toPascalCase — kept local so the test pins the convention. */
function toPascalCase(name: string): string {
	return name
		.split(/[-_]/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

/**
 * The Ruby runtime discovers user nodes by fs-scanning runtimes/ruby/nodes/<name>/node.rb
 * at boot (BLOK_NODES_DIR) and registering NodeHandler subclasses. This test pins the
 * template to that contract — the original bug (#196) was a template that subclassed a
 * nonexistent base and used removed accessors, so nothing loaded.
 */
describe("ruby_node_file template", () => {
	const nodeName = "add-numbers";
	const pascal = toPascalCase(nodeName); // "AddNumbers"
	const rendered = ruby_node_file.replace(/\{\{NODE_NAME_PASCAL\}\}/g, pascal).replace(/\{\{NODE_NAME\}\}/g, nodeName);

	it("subclasses the real base class the discovery rule registers", () => {
		expect(rendered).toContain(`class ${pascal}Node < Blok::Node::NodeHandler`);
	});

	it("uses the real request + vars accessors (not the removed ctx.vars[])", () => {
		expect(rendered).toContain('ctx.request.body_str("name")');
		expect(rendered).toContain('ctx.set_var("greeting"');
		expect(rendered).not.toContain("ctx.vars[");
	});

	it("is a discoverable library node (no require_relative — the runtime preloads blok)", () => {
		expect(rendered).not.toContain("require_relative");
	});

	it("leaves no unsubstituted template tokens", () => {
		expect(rendered).not.toMatch(/\{\{NODE_NAME(_PASCAL)?\}\}/);
	});
});
