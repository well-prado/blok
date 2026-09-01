import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateArchitecture, validateHarnessPullRequest } from "./check-architecture-governance";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixture(adrs: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "blok-architecture-"));
	roots.push(root);
	const architecture = join(root, "docs/architecture");
	const harness = join(architecture, "agent-harness");
	const directory = join(harness, "adr");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(architecture, "README.md"), "[Harness](agent-harness/README.md)\n");
	writeFileSync(
		join(harness, "README.md"),
		Object.keys(adrs)
			.map((name) => `[${name}](adr/${name})`)
			.join("\n"),
	);
	writeFileSync(join(harness, "ROADMAP.md"), "# Roadmap\n");
	for (const [name, content] of Object.entries(adrs)) writeFileSync(join(directory, name), content);
	return root;
}

function validAdr(id = "0001"): string {
	return `# ADR ${id} — Decision\n\n- **Status:** Accepted\n- **Date:** 2026-08-31\n\n## Context\n\nContext.\n\n## Decision\n\nDecision.\n\n## Consequences\n\nConsequences.\n`;
}

describe("architecture files", () => {
	it("accepts the canonical shape and valid relative links", () => {
		const root = fixture({ "0001-decision.md": validAdr() });
		expect(validateArchitecture(root).errors).toEqual([]);
	});

	it("rejects duplicate identifiers and missing required headings", () => {
		const root = fixture({
			"0001-first.md": validAdr(),
			"0001-second.md": validAdr().replace("## Consequences", "## Result"),
		});
		const errors = validateArchitecture(root).errors.join("\n");
		expect(errors).toContain("ADR id 0001 is already used");
		expect(errors).toContain("missing required heading ## Consequences");
	});

	it("rejects a broken local Markdown link", () => {
		const root = fixture({ "0001-decision.md": `${validAdr()}\n[Missing](missing.md)\n` });
		expect(validateArchitecture(root).errors.join("\n")).toContain("broken local Markdown link: missing.md");
	});
});

describe("agent-harness pull requests", () => {
	it("ignores pull requests outside the harness initiative", () => {
		expect(validateHarnessPullRequest({ pull_request: { body: "", labels: [{ name: "bug" }] } }).errors).toEqual([]);
	});

	it("accepts a harness pull request with ADR and evidence", () => {
		const body =
			"## Architecture Conformance\n\nGoverning ADRs: docs/architecture/agent-harness/adr/0001-layered-harness-boundaries.md\n\nConformance evidence: focused tests pass.\n";
		expect(validateHarnessPullRequest({ pull_request: { body, labels: [{ name: "agent-harness" }] } }).errors).toEqual(
			[],
		);
	});

	it("rejects a harness pull request without architecture evidence", () => {
		const errors = validateHarnessPullRequest({
			pull_request: { body: "## Description\nNo evidence.", labels: [{ name: "agent-harness" }] },
		}).errors;
		expect(errors).toHaveLength(4);
	});
});
