import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeInfo } from "../../src/services/runtime-detector.js";
import { setupRuntime } from "../../src/services/runtime-setup.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
	dirs.length = 0;
});

describe("runtime scaffold copy", () => {
	it("keeps lock metadata and excludes Swift and Dart build caches", async () => {
		const source = fs.mkdtempSync(path.join(os.tmpdir(), "blok-runtime-source-"));
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "blok-runtime-project-"));
		dirs.push(source, project);
		const sdk = path.join(source, "sdks", "fixture");
		fs.mkdirSync(path.join(sdk, ".build"), { recursive: true });
		fs.mkdirSync(path.join(sdk, ".dart_tool"), { recursive: true });
		fs.writeFileSync(path.join(sdk, ".build", "artifact"), "build");
		fs.writeFileSync(path.join(sdk, ".dart_tool", "artifact"), "build");
		fs.writeFileSync(path.join(sdk, "Package.resolved"), "swift lock");
		fs.writeFileSync(path.join(sdk, "pubspec.lock"), "dart lock");

		const runtime: RuntimeInfo = {
			kind: "fixture",
			label: "Fixture",
			available: true,
			defaultPort: 1,
			defaultGrpcPort: 2,
			commands: [],
			toolchain: "fixture",
			installHint: "",
			installDeps: "",
			startCmd: "fixture",
			sdkDir: "fixture",
		};
		await setupRuntime(runtime, source, project, { start() {}, stop() {}, message() {} });

		const copied = path.join(project, ".blok", "runtimes", "fixture");
		expect(fs.existsSync(path.join(copied, ".build"))).toBe(false);
		expect(fs.existsSync(path.join(copied, ".dart_tool"))).toBe(false);
		expect(fs.existsSync(path.join(copied, "Package.resolved"))).toBe(true);
		expect(fs.existsSync(path.join(copied, "pubspec.lock"))).toBe(true);
	});
});
