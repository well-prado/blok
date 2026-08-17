import path from "node:path";
import fsExtra from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";
import { createProject } from "../../../src/commands/create/project.js";
import { setNonInteractive } from "../../../src/services/non-interactive.js";

/**
 * #864 — a generated app must not silently inherit the FRAMEWORK's license.
 *
 * The base manifest is copied from the PRIMARY trigger's own package.json,
 * and the two possible sources actively DISAGREED: `Apache-2.0` for a
 * trigger's own package (http, cron, mcp, …) but `MIT` for the pubsub/worker
 * `template/package.json` — which license a generated app claimed depended on
 * which trigger the user happened to pick first, and neither was ever a
 * statement about the user's own code. `combos.sh` never caught the
 * divergence because pubsub/worker were never exercised as the PRIMARY
 * trigger there (see `tests/e2e/scaffold-smoke/combos.sh`, the "pubsub" and
 * "worker" rows added alongside this fix).
 *
 * Per the maintainer's recommendation on #864 (matching #751's earlier
 * finding): a generated project is a private application, not a redistributed
 * library — `create-react-app` / `create-next-app` both omit `license` too,
 * and the scaffold already ships `private: true` (#747). So `license` is
 * dropped from the seeded manifest outright, regardless of which of the two
 * divergent sources it came from.
 *
 * Real end-to-end (`--local`, so npm resolves @blokjs/* via `file:` links —
 * no git clone, no waiting on the npm registry for internal packages).
 */
describe("scaffolded package.json — no inherited license (#864)", () => {
	const REPO_ROOT = path.resolve(__dirname, "../../../../..");
	const created: string[] = [];

	afterEach(() => {
		for (const dir of created.splice(0)) {
			fsExtra.removeSync(dir);
		}
	});

	async function scaffold(name: string, triggers: string) {
		setNonInteractive(true);
		try {
			await createProject({ name, triggers, packageManager: "npm" }, "0.0.0-test", false, REPO_ROOT);
		} finally {
			setNonInteractive(false);
		}
		const dir = path.join(process.cwd(), name);
		created.push(dir);
		return JSON.parse(fsExtra.readFileSync(path.join(dir, "package.json"), "utf8"));
	}

	it("drops license when the primary trigger reads its OWN package.json (the Apache-2.0 source)", async () => {
		const pkg = await scaffold("test-license-http", "http");
		expect(pkg).not.toHaveProperty("license");
	});

	it("drops license when the primary trigger reads the template/ package.json (the MIT source)", async () => {
		const pkg = await scaffold("test-license-worker", "worker");
		expect(pkg).not.toHaveProperty("license");
	});
});
