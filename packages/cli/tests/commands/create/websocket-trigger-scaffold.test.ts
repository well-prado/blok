import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateSharedWorkflowsFile, generateTriggerEntryFile } from "../../../src/commands/create/project.js";
import { agents_md } from "../../../src/commands/create/utils/Examples.js";

/**
 * #733 — `generateTriggerEntryFile('websocket')` carried the same bare
 * `if (process.env.DISABLE_TRIGGER_RUN !== "true")` boot pattern #732 fixed on
 * the http/sse/grpc branches: importing the generated `src/triggers/websocket
 * /index.ts` for introspection (e.g. the source-import gate, or a bundler doing
 * static analysis) booted a real WebSocket server as a side effect. Now carries
 * the identical realpath'd `process.argv[1]` `isMainModule()` guard.
 */
describe("websocket trigger scaffold — boot guard (#733)", () => {
	it("generateTriggerEntryFile('websocket') guards its boot call with isMainModule()", () => {
		const out = generateTriggerEntryFile("websocket");
		expect(out).not.toContain("not yet implemented");
		// #733 (found during empirical verification) — the relative specifier
		// was missing its `.js` extension, which `tsc --module nodenext`
		// (the scaffold's own compiler target, #709) accepts at typecheck time
		// but happily emits verbatim: the COMPILED dist/triggers/websocket/
		// index.js then imports an extensionless "./runner/WSServer" that
		// Node's ESM loader can never resolve — a real, fresh `npm run build
		// && node dist/triggers/websocket/index.js` crashed with
		// ERR_MODULE_NOT_FOUND on every websocket-only scaffold. Fixed
		// alongside the guard since both live on this exact line.
		expect(out).toContain('import WSServer from "./runner/WSServer.js"');
		expect(out).toContain("new WSServer()");
		expect(out).toContain("this.wsServer.listen()");
		expect(out).toContain('if (isMainModule(import.meta.url) && process.env.DISABLE_TRIGGER_RUN !== "true")');
		// The guard helper itself must be present — a stray reference to
		// `isMainModule` with no definition would fail to compile.
		expect(out).toContain("function isMainModule(moduleUrl: string): boolean {");
		expect(out).toContain('import { realpathSync } from "node:fs";');
		expect(out).toContain('import { fileURLToPath } from "node:url";');
	});
});

/** Every `.ts`/`.json` file under `dir`, recursively, absolute paths. */
function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (/\.(ts|json)$/.test(entry.name)) out.push(full);
	}
	return out;
}

/**
 * Regression (#650): a scaffold used to ship TWO workflows bound to
 * `/ws/echo` — a legacy JSON twin (`workflows/json/websocket-echo.json`) and
 * an HTTP-trigger twin (`examples/.../websocket-echo.ts`) both shadowed the
 * featured TS DSL `echo-demo.ts`. Hono's first-registered-wins routing meant
 * a real client got 0 frames on connect. Both twins were deleted; `echo-
 * demo.ts` alone now owns the path. These checks fail if either twin — or
 * any new file bound to the same path — is ever reintroduced.
 */
describe("scaffold ships exactly one /ws/echo workflow (#650)", () => {
	it("the websocket trigger's shipped workflow source tree has exactly one file bound to /ws/echo", () => {
		// `triggers/websocket/src/workflows` is copied verbatim into every
		// websocket-trigger scaffold as `src/workflows/websocket` (see
		// `createProject`'s `${triggerSrcDir}/workflows` copy step). A second
		// file here bound to the same path reproduces #650 in every fresh
		// scaffold, exactly like the original JSON/TS twins did.
		const root = join(__dirname, "../../../../../triggers/websocket/src/workflows");
		const boundToWsEcho = walk(root).filter((f) =>
			/["']?path["']?\s*:\s*["']\/ws\/echo["']/.test(readFileSync(f, "utf8")),
		);
		expect(boundToWsEcho).toEqual([join(root, "events/echo-demo.ts")]);
	});

	it("generateSharedWorkflowsFile registers exactly one websocket workflow entry", () => {
		const out = generateSharedWorkflowsFile(["websocket"]);
		expect(out).toContain('import WSEchoDemo from "./workflows/websocket/events/echo-demo.js";');
		expect(out).toContain('"ws-echo-demo": await WSEchoDemo,');
		// Exactly one import references the websocket workflow tree — a second
		// import here is the registry-side symptom of the same shadowing bug.
		expect(out.split("workflows/websocket/").length - 1).toBe(1);
	});

	it("the scaffold's generated AGENTS.md teaches the real @blokjs/ws-reply shape, not the pre-#650 `message` key", () => {
		// The doc example used to show `{ message: js\`...\` }` — a key that
		// isn't in @blokjs/ws-reply's `{event?, payload, raw?}` schema, zod
		// strips it, and the step throws "nothing to send — set payload". An
		// AI agent or developer following stale docs reproduces #650's exact
		// failure by hand.
		expect(agents_md).not.toMatch(/@blokjs\/ws-reply["')]*,\s*\{\s*message:/);
		expect(agents_md).toContain('step("reply", node("@blokjs/ws-reply"), { event: "echo", payload: conn.body });');
	});
});
