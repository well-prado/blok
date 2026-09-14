/**
 * The Python prop, resolved by the REAL `runtime.python3` sidecar.
 *
 * Everything else in this folder mocks `dashboard-stats` by node ref, which is
 * how you test a cross-runtime step — and which cannot tell you whether the
 * sidecar starts, finds `runtimes/python3/nodes`, or agrees about the wire
 * shape. This one starts the sidecar the way `src/index.ts` does and runs the
 * page against it with NO mock.
 *
 * It SKIPS (it does not fail) when there is no python3 with grpcio on this
 * machine — the prop is `defer(..., { rescue: true })` precisely so that
 * machine still gets a working page.
 */

import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { runPage } from "@blokjs/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findPython, startPythonSidecar, waitForSidecar } from "../src/python-sidecar.js";
import dashboard from "../src/workflows/dashboard.js";

const AUTH = { auth: { id: "u-1", email: "ada@example.com" } };

const python = findPython();
if (python === null) {
	console.warn(
		"[skip] tests/python-stats.test.ts: no python3 that can serve this example's node (3.11+ with grpcio), so the runtime.python3 sidecar cannot start. See the README — `bun run setup:python`, with BLOK_PYTHON pointing at a 3.11+ interpreter — to exercise this suite.",
	);
}

async function freePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const found = typeof address === "object" && address !== null ? address.port : 0;
			probe.close(() => resolve(found));
		});
	});
}

let sidecar: ChildProcess | null = null;

describe.skipIf(python === null)("the Dashboard's Python prop, through the real sidecar", () => {
	beforeAll(async () => {
		// The runner reads this when it builds the python3 gRPC adapter, so a
		// free port keeps the suite off whatever is already on 10007.
		const port = await freePort();
		process.env.RUNTIME_PYTHON3_GRPC_PORT = String(port);
		sidecar = startPythonSidecar({ port, install: false });
		expect(sidecar).not.toBeNull();
		await waitForSidecar(port, 60_000);
	}, 90_000);

	afterAll(() => {
		sidecar?.kill("SIGKILL");
	});

	it("resolves `stats` from Python — not from a mock", async () => {
		const page = await runPage(dashboard, { middleware: AUTH });
		expect(page.props.stats).toBeUndefined(); // deferred: announced, not resolved

		const loaded = await page.loadDeferredProps("dashboard");

		// The numbers come from runtimes/python3/nodes/dashboard_stats/node.py.
		expect(loaded.props.stats).toEqual({ revenue: 42_000, orders: 128 });
		expect(loaded.rescued).toEqual([]);
		// The prop's state slot, same as any other step's. (`run.step(...)` only
		// tracks the steps the harness itself runs; a live sidecar call is not
		// one of them, so `executed` stays false here even on success.)
		expect(loaded.run.state("page.stats")).toEqual({ revenue: 42_000, orders: 128 });
	}, 30_000);

	it("rescues the prop instead of failing the page when the sidecar is gone", async () => {
		sidecar?.kill("SIGKILL");
		sidecar = null;

		const page = await runPage(dashboard, { middleware: AUTH });
		const loaded = await page.loadDeferredProps("dashboard");

		expect(loaded.status).toBe(200);
		expect(loaded.rescued).toEqual(["stats"]);
		expect(loaded.props.stats).toBeUndefined();
		loaded.assert().component("Dashboard").has("auth").etc();
	}, 30_000);
});
