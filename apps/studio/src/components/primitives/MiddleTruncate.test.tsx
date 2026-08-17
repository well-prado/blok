import { MiddleTruncate, middleTruncate } from "@/components/primitives/MiddleTruncate";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("middleTruncate", () => {
	it("leaves text that already fits alone", () => {
		expect(middleTruncate("run_d1f7", 24)).toBe("run_d1f7");
	});

	it("keeps both ends of a long id and never exceeds maxLength", () => {
		const out = middleTruncate("run_d1f7dca71dbe8f3a2c", 12);
		expect(out).toBe("run_d1…f3a2c");
		expect(out).toHaveLength(12);
	});

	it("does not leak the whole string when nothing is left for the tail", () => {
		// `"abc".slice(-0)` is `"abc"` — the bug this case pins.
		expect(middleTruncate("abcdefgh", 2)).toBe("a…");
	});
});

describe("MiddleTruncate", () => {
	it("shows the ellipsis but announces the full id", () => {
		render(<MiddleTruncate text="run_d1f7dca71dbe8f3a2c" maxLength={12} data-testid="id" />);
		expect(screen.getByTestId("id")).toHaveTextContent("run_d1…f3a2c");
		// The full value is present for assistive tech, and the visible copy is hidden from it.
		expect(screen.getByTestId("id").querySelector(".sr-only")).toHaveTextContent("run_d1f7dca71dbe8f3a2c");
		expect(screen.getByTestId("id").querySelector("[aria-hidden]")).toHaveTextContent("run_d1…f3a2c");
	});
});
