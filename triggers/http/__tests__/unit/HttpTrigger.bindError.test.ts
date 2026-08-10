/**
 * #752 — `listen()` must be able to FAIL, not just hang.
 *
 * `listen()` resolves from inside the `serve()` listening callback. That
 * callback never fires when the socket can't be bound (EADDRINUSE, EACCES),
 * and nothing was watching the server's `error` event, so the returned promise
 * settled NEITHER way: a Blok app whose port was taken hung at boot forever
 * with no error and no exit, and every boot-path test that awaited `listen()`
 * burned its full `testTimeout` reporting only "Test timed out in 10000ms" —
 * the exact shape of the release-run failure in #752.
 *
 * NOTE: this suite deliberately does NOT mock `@hono/node-server` — the bind is
 * the thing under test. Every other boot suite mocks it, which is why none of
 * them ever exercised this path.
 */

import { type Server, createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import HttpTrigger from "../../src/runner/HttpTrigger.js";

let blocker: Server | undefined;
const ORIGINAL_PORT = process.env.PORT;

afterEach(async () => {
	if (blocker) await new Promise<void>((r) => blocker?.close(() => r()));
	blocker = undefined;
	if (ORIGINAL_PORT === undefined) {
		// biome-ignore lint/performance/noDelete: restore literal absence, not the string "undefined"
		delete process.env.PORT;
	} else process.env.PORT = ORIGINAL_PORT;
});

describe("#752 · HttpTrigger.listen() surfaces a bind failure instead of hanging", () => {
	it("rejects with an actionable EADDRINUSE error when the port is already held", async () => {
		blocker = createServer(() => {});
		await new Promise<void>((r) => blocker?.listen(0, () => r()));
		const port = (blocker.address() as { port: number }).port;

		process.env.PORT = String(port);
		const trigger = new HttpTrigger();

		// Before the fix this promise NEVER settles and the assertion below dies
		// on the suite's 10s testTimeout instead.
		await expect(trigger.listen()).rejects.toThrow(/already in use/i);
	});
});
