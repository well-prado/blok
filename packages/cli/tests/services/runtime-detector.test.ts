import { describe, expect, it } from "vitest";
import { parseVersion } from "../../src/services/runtime-detector.js";

// Every sidecar with a version floor must parse its own `--version` output,
// otherwise create/add report "not installed" for an installed toolchain.
describe("parseVersion", () => {
	it.each([
		["java", "openjdk 17.0.11 2024-04-16\nOpenJDK Runtime Environment", "17.0.11"],
		["kotlin", "openjdk 21.0.1 2023-10-17", "21.0.1"],
		["elixir", "Erlang/OTP 27 [erts-15.0] [64-bit]\n\nElixir 1.17.2 (compiled with Erlang/OTP 27)", "1.17.2"],
		["swift", "Apple Swift version 6.1.2 (swiftlang-6.1.2)", "6.1.2"],
		["dart", "Dart SDK version: 3.5.0 (stable)", "3.5.0"],
		["ruby", "ruby 3.3.0 (2023-12-25 revision 5124f9ac75) [arm64-darwin23]", "3.3.0"],
		["php", "PHP 8.2.18 (cli)", "8.2.18"],
	])("%s", (kind, output, expected) => {
		expect(parseVersion(output, kind)).toBe(expected);
	});
});
