#!/usr/bin/env bun
/**
 * Repository-owned architecture governance for issue #914.
 *
 * Local mode validates the canonical harness ADR set. When GITHUB_EVENT_PATH
 * points at a pull_request event, agent-harness-labelled pull requests must
 * also carry the Architecture Conformance section from the PR template and
 * cite at least one governing harness ADR.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ValidationResult {
	errors: string[];
}

const ADR_FILE = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const REQUIRED_HEADINGS = ["## Context", "## Decision", "## Consequences"];
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)]+)\)/g;
const HARNESS_ADR_CITATION = /docs\/architecture\/agent-harness\/adr\/\d{4}-[a-z0-9-]+\.md/;

function localMarkdownLinks(markdown: string): string[] {
	const links: string[] = [];
	for (const match of markdown.matchAll(MARKDOWN_LINK)) {
		const raw = (match[1] ?? "").trim();
		if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
		const target = raw.split("#", 1)[0]?.split("?", 1)[0];
		if (target && extname(target) === ".md") links.push(target);
	}
	return links;
}

function validateLocalLinks(file: string, markdown: string, errors: string[]): void {
	for (const target of localMarkdownLinks(markdown)) {
		const resolved = resolve(dirname(file), target);
		if (!existsSync(resolved)) errors.push(`${file}: broken local Markdown link: ${target}`);
	}
}

export function validateArchitecture(root: string): ValidationResult {
	const errors: string[] = [];
	const architectureDir = join(root, "docs/architecture");
	const harnessDir = join(architectureDir, "agent-harness");
	const adrDir = join(harnessDir, "adr");
	const requiredFiles = [
		join(architectureDir, "README.md"),
		join(harnessDir, "README.md"),
		join(harnessDir, "ROADMAP.md"),
	];

	for (const file of requiredFiles) {
		if (!existsSync(file)) errors.push(`${file}: required architecture file is missing`);
	}
	if (!existsSync(adrDir)) {
		errors.push(`${adrDir}: required ADR directory is missing`);
		return { errors };
	}

	const seenIds = new Map<string, string>();
	const adrFiles = readdirSync(adrDir)
		.filter((name) => name.endsWith(".md"))
		.sort();
	if (adrFiles.length === 0) errors.push(`${adrDir}: at least one ADR is required`);

	for (const name of adrFiles) {
		const match = ADR_FILE.exec(name);
		const file = join(adrDir, name);
		if (!match) {
			errors.push(`${file}: ADR filename must match NNNN-kebab-case.md`);
			continue;
		}
		const id = match[1] as string;
		const prior = seenIds.get(id);
		if (prior) errors.push(`${file}: ADR id ${id} is already used by ${prior}`);
		else seenIds.set(id, file);

		const markdown = readFileSync(file, "utf8");
		if (!new RegExp(`^# ADR ${id}\\s+[—-]\\s+.+$`, "m").test(markdown)) {
			errors.push(`${file}: first heading must identify ADR ${id}`);
		}
		if (!/^- \*\*Status:\*\*\s+\S.+$/m.test(markdown)) errors.push(`${file}: missing non-empty Status metadata`);
		if (!/^- \*\*Date:\*\*\s+\d{4}-\d{2}-\d{2}\s*$/m.test(markdown)) {
			errors.push(`${file}: missing ISO Date metadata`);
		}
		for (const heading of REQUIRED_HEADINGS) {
			if (!markdown.includes(heading)) errors.push(`${file}: missing required heading ${heading}`);
		}
		validateLocalLinks(file, markdown, errors);
	}

	for (const file of requiredFiles.filter(existsSync)) {
		validateLocalLinks(file, readFileSync(file, "utf8"), errors);
	}

	const overview = join(harnessDir, "README.md");
	if (existsSync(overview)) {
		const markdown = readFileSync(overview, "utf8");
		for (const name of adrFiles.filter((candidate) => ADR_FILE.test(candidate))) {
			if (!markdown.includes(`adr/${name}`)) errors.push(`${overview}: does not link ADR ${name}`);
		}
	}

	return { errors };
}

interface PullRequestEvent {
	pull_request?: {
		body?: string | null;
		labels?: Array<{ name?: string }>;
	};
}

export function validateHarnessPullRequest(event: PullRequestEvent): ValidationResult {
	const errors: string[] = [];
	const pullRequest = event.pull_request;
	if (!pullRequest) return { errors };
	const labels = new Set((pullRequest.labels ?? []).map((label) => label.name));
	if (!labels.has("agent-harness")) return { errors };

	const body = pullRequest.body ?? "";
	if (!/^## Architecture Conformance\s*$/m.test(body)) {
		errors.push("agent-harness pull requests must include the '## Architecture Conformance' section");
	}
	if (!/^Governing ADRs:\s*\S.+$/m.test(body)) {
		errors.push("agent-harness pull requests must provide a non-empty 'Governing ADRs:' line");
	}
	if (!HARNESS_ADR_CITATION.test(body)) {
		errors.push("agent-harness pull requests must cite docs/architecture/agent-harness/adr/NNNN-*.md");
	}
	if (!/^Conformance evidence:\s*\S.+$/m.test(body)) {
		errors.push("agent-harness pull requests must provide non-empty 'Conformance evidence:'");
	}
	return { errors };
}

function printAndExit(results: ValidationResult[]): void {
	const errors = results.flatMap((result) => result.errors);
	if (errors.length > 0) {
		for (const error of errors) console.error(`✗ ${error}`);
		console.error(`\nArchitecture governance failed with ${errors.length} error(s).`);
		process.exitCode = 1;
		return;
	}
	console.log("✓ Architecture files and pull-request conformance are valid.");
}

if (import.meta.main) {
	const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	const results = [validateArchitecture(repositoryRoot)];
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (eventPath && existsSync(eventPath)) {
		const event = JSON.parse(readFileSync(eventPath, "utf8")) as PullRequestEvent;
		results.push(validateHarnessPullRequest(event));
	}
	printAndExit(results);
}
