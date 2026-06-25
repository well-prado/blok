import { describe, expect, it } from "vitest";
import { php_node_file } from "../../../src/commands/create/utils/Examples.js";

/** Mirror of node.ts toPascalCase — kept local so the test pins the convention. */
function toPascalCase(name: string): string {
	return name
		.split(/[-_]/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

/**
 * The PHP runtime discovers user nodes by convention (serve.php globs
 * BLOK_NODES_DIR for <name>/src/Nodes/<Pascal>Node.php and instantiates
 * Blok\Blok\Nodes\<Pascal>\<Pascal>Node). This test guards against the
 * template drifting away from that contract — the original bug (#196) was a
 * template that referenced classes the SDK never defined, so nothing loaded.
 */
describe("php_node_file template", () => {
	const nodeName = "my-greeter";
	const pascal = toPascalCase(nodeName); // "MyGreeter"
	const rendered = php_node_file.replace(/\{\{NODE_NAME\}\}/g, nodeName).replace(/\{\{NODE_NAME_PASCAL\}\}/g, pascal);

	it("declares the namespace + class serve.php reconstructs by convention", () => {
		expect(rendered).toContain(`namespace Blok\\Blok\\Nodes\\${pascal};`);
		expect(rendered).toContain(`class ${pascal}Node implements NodeHandler`);
	});

	it("imports the real SDK NodeHandler + Context (not the stale Blok\\NodeHandler)", () => {
		expect(rendered).toContain("use Blok\\Blok\\Node\\NodeHandler;");
		expect(rendered).toContain("use Blok\\Blok\\Types\\Context;");
		expect(rendered).not.toContain("namespace Blok\\Nodes;");
	});

	it("uses the real request accessor (bodyStr), not the removed body[] array access", () => {
		expect(rendered).toContain("$ctx->request->bodyStr('name')");
		expect(rendered).not.toContain("$ctx->request->body[");
	});

	it("leaves no unsubstituted template tokens", () => {
		expect(rendered).not.toMatch(/\{\{NODE_NAME(_PASCAL)?\}\}/);
	});
});
