import { describe, expect, it } from "vitest";
import { generateTriggerEntryFile } from "../../../src/commands/create/project.js";

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
