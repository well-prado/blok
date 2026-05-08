import { expect } from "vitest";
import type { CanonicalWorkflow } from "./types";

/**
 * Smallest possible cross-language sanity check: invoke `hello-world` with
 * a tiny inputs map and a tiny request body, assert the standard greeting
 * shape comes back regardless of SDK.
 *
 * Catches:
 * - Wire-shape regressions on the request side (`inputs` unwrapping per §3,
 *   trigger `body` decoding).
 * - Wire-shape regressions on the response side (`data` field encoding,
 *   `success` flag, `errors=null` invariant).
 * - SDK identity drift (every SDK should self-identify via `language` —
 *   the value differs but the field must exist).
 *
 * Why hello-world: every SDK ships it as the canonical example node, so
 * the parity matrix doesn't need to register a custom node per language.
 */
export const smallPayloadWorkflow: CanonicalWorkflow = {
	id: "small-payload",
	description: "hello-world with a 2-byte body produces the canonical greeting shape",
	node: "hello-world",
	stepName: "step-greet",
	inputs: { prefix: "Hi" },
	body: { name: "Blok" },
	expectSuccess: true,
	assertResult(result) {
		expect(result.success).toBe(true);
		expect(result.errors).toBeNull();

		const data = result.data as { message?: unknown; language?: unknown; timestamp?: unknown };
		expect(data).toBeTypeOf("object");
		// The greeting itself must be byte-identical across SDKs — the inputs
		// (`prefix`) and body (`name`) flow into the same template.
		expect(data.message).toBe("Hi, Blok!");
		// `language` differs per SDK ("python3", "go", "rust", …) but must
		// always be present and non-empty.
		expect(typeof data.language).toBe("string");
		expect((data.language as string).length).toBeGreaterThan(0);
		// `timestamp` formatting differs per SDK. We just require it to
		// look like an ISO-8601 prefix.
		expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	},
};
