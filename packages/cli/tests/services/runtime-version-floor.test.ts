import { describe, expect, it } from "vitest";
import { getAllRuntimeDefinitions } from "../../src/services/runtime-detector";
import { computeDefaultConstraint, satisfiesConstraint } from "../../src/services/semver-utils";

/**
 * Regression (#644): the interpreted-runtime SDKs pull their gRPC library as a
 * native-build dependency with a hard version floor — the Ruby `grpc` gem needs
 * Ruby 3.x, PHP's roadrunner-grpc needs PHP 8.2+. Declaring a `minVersion` on
 * the runtime definition gives `blokctl` a semantic floor to gate on (skip
 * scaffold setup + fail `blokctl dev` with an actionable message) instead of a
 * cryptic `bundle install` / `composer install` compile error.
 */
describe("interpreted-runtime gRPC version floors (#644)", () => {
	const defs = getAllRuntimeDefinitions();
	const byKind = (k: string) => defs.find((d) => d.kind === k);

	it("Ruby declares a >=3.1 floor (native grpc gem needs Ruby 3.x)", () => {
		const ruby = byKind("ruby");
		expect(ruby?.minVersion).toBe("3.1.0");
		const constraint = computeDefaultConstraint(ruby?.minVersion as string);
		expect(constraint).toBe(">=3.1.0");
		// EOL system Ruby 2.6 is rejected; a modern Ruby passes.
		expect(satisfiesConstraint("2.6.10", constraint)).toBe(false);
		expect(satisfiesConstraint("3.3.0", constraint)).toBe(true);
	});

	it("PHP declares a >=8.2 floor (roadrunner-grpc requires PHP 8.2+)", () => {
		const php = byKind("php");
		expect(php?.minVersion).toBe("8.2.0");
		const constraint = computeDefaultConstraint(php?.minVersion as string);
		expect(constraint).toBe(">=8.2.0");
		expect(satisfiesConstraint("8.1.0", constraint)).toBe(false);
		expect(satisfiesConstraint("8.5.5", constraint)).toBe(true);
	});

	it("compiled runtimes (go/rust/java/csharp) declare no floor — they bundle gRPC", () => {
		for (const k of ["go", "rust", "java", "csharp"]) {
			expect(byKind(k)?.minVersion, k).toBeUndefined();
		}
	});
});
