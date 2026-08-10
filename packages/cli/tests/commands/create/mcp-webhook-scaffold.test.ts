import { describe, expect, it } from "vitest";
import { generateTriggerEntryFile } from "../../../src/commands/create/project.js";

/**
 * Regression (#748): `--triggers mcp` / `--triggers webhook` as the ONLY
 * trigger hit the generic `generateTriggerEntryFile` fallback
 * (`console.log("<kind> trigger not yet implemented")`), so the scaffold
 * installed, compiled, and then exited doing nothing.
 *
 * Both triggers already support standalone operation — their constructors take
 * `(app: Hono, httpTrigger?)` with the HttpTrigger OPTIONAL, and `listen()`
 * has an explicit `else { registerRoutesFromRegistry() }` branch for the
 * no-HttpTrigger case. What was missing was scaffolded-side wiring: own the
 * Hono app, do the WorkflowRegistry registration HttpTrigger normally does,
 * and bind the listener neither trigger binds itself (same shape as the
 * generated SSEServer). Same resolution as #643 took for gRPC.
 */
describe.each([
	{ kind: "mcp", cls: "McpTrigger", pkg: "@blokjs/trigger-mcp", port: "4000" },
	{ kind: "webhook", cls: "WebhookTrigger", pkg: "@blokjs/trigger-webhook", port: "4007" },
])("$kind standalone trigger scaffold (#748)", ({ kind, cls, pkg, port }) => {
	const out = generateTriggerEntryFile(kind);

	it("does not emit the no-op stub", () => {
		expect(out).not.toContain("not yet implemented");
	});

	it("owns a Hono app, the trigger, and the listener", () => {
		expect(out).toContain(`import ${cls} from "${pkg}"`);
		expect(out).toContain('import { serve } from "@hono/node-server"');
		expect(out).toContain('import { Hono } from "hono"');
		expect(out).toContain(`new ${cls}(app)`);
		expect(out).toContain("serve({ fetch: app.fetch, port }");
		expect(out).toContain(`process.env.PORT || ${port}`);
	});

	it("mounts /health-check so the URL `blokctl create` prints is real", () => {
		expect(out).toContain('app.all("/health-check"');
	});

	it("registers this kind's workflows itself (no HttpTrigger in the process)", () => {
		expect(out).toContain('import nodes from "../../Nodes.js"');
		expect(out).toContain('import workflows from "../../Workflows.js"');
		expect(out).toContain("WorkflowRegistry.getInstance()");
		expect(out).toContain(`if (!triggerCfg?.${kind}) continue;`);
		expect(out).toContain("nodeMap.addNode(key, node)");
	});

	it("boots only as the process entry point, and honours DISABLE_TRIGGER_RUN (#721)", () => {
		expect(out).toContain('if (isMainModule(import.meta.url) && process.env.DISABLE_TRIGGER_RUN !== "true")');
	});
});
