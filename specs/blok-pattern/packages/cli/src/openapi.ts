// openapi: the HTTP side of the project as an OpenAPI 3.1 document. Nobody writes it: what a route takes
// follows from the node inputs its request is wired into, and what it answers with from its last step.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Entry, type JsonSchema, type Workflow, contract } from "@blokjs/kernel";
import type { Analysis, Paths } from "./analyze.ts";
import type { Report } from "./commands.ts";
// A schema as it goes inside the document: without the "$schema" line every contract starts with, and
// without the bounds the schema library writes on every integer.
import { readable as plain } from "./prompt.ts";

type Doc = Record<string, unknown>;

const camel = (text: string) => text.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());

const SIGNATURE_HEADERS: Record<string, string[]> = {
	standard: ["webhook-id", "webhook-timestamp", "webhook-signature"],
	stripe: ["stripe-signature"],
	github: ["x-hub-signature-256"],
};

const failure = (codes: string[]) => ({
	type: "object",
	required: ["error", "message"],
	properties: {
		error: { enum: codes },
		message: { type: "string" },
		node: { type: "string", description: "The node or workflow that refused." },
	},
});

/** When each error of a workflow happens, as its nodes and its `fail` entries say it. */
function meanings(analysis: Analysis, workflow: Workflow, seen = new Set<Workflow>()): Map<string, string> {
	const out = new Map<string, string>();
	if (seen.has(workflow)) return out;
	seen.add(workflow);
	const add = (code: string, meaning?: string) => {
		if (meaning && !out.has(code)) out.set(code, meaning);
	};
	const walk = (entries: Entry[] = []) => {
		for (const entry of entries) {
			if ("conditions" in entry)
				for (const branch of entry.conditions) walk("else" in branch ? branch.else : branch.steps);
			else if ("parallel" in entry) walk(entry.parallel);
			else if ("fail" in entry) add(entry.fail, entry.message?.includes("${") ? undefined : entry.message);
			else {
				const unit = analysis.nodes.get(entry.node);
				if (unit) for (const [code, meaning] of Object.entries(contract(unit).errorMeanings)) add(code, meaning);
				const used = analysis.workflows.find((other) => other.id === entry.node);
				if (used) for (const [code, meaning] of meanings(analysis, used.workflow, seen)) add(code, meaning);
				walk(entry.onError);
			}
		}
	};
	walk(workflow.steps);
	return out;
}

/** The document, built from the project as it is on disk. */
export function openapiDocument(analysis: Analysis, paths: Paths): Doc {
	let manifest: { name?: string; version?: string; description?: string } = {};
	try {
		manifest = JSON.parse(readFileSync(join(paths.root, "package.json"), "utf8"));
	} catch {}

	const routes: Record<string, Record<string, unknown>> = {};
	for (const { id, name, workflow } of analysis.workflows) {
		const http = workflow.trigger?.http;
		if (!http) continue;
		const shape = analysis.shapes.get(id);
		const part = (which: string): JsonSchema => shape?.request.properties?.[which] ?? {};

		const inPath = [...http.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
		const parameters: unknown[] = inPath.map((key) => ({
			name: key,
			in: "path",
			required: true,
			schema: plain(part("params").properties?.[key] ?? { type: "string" }),
		}));
		for (const [where, which] of [
			["query", "query"],
			["header", "headers"],
		] as const) {
			for (const [key, schema] of Object.entries(part(which).properties ?? {})) {
				const required = (part(which).required ?? []).includes(key);
				parameters.push({ name: key, in: where, required, schema: plain(schema) });
			}
		}
		const signature = http.signature;
		const signedBy = signature ? (SIGNATURE_HEADERS[signature.scheme] ?? [signature.header ?? "signature"]) : [];
		for (const header of signedBy) {
			parameters.push({
				name: header,
				in: "header",
				required: true,
				schema: { type: "string" },
				description: "Part of the request's signature.",
			});
		}

		// Every status this route can answer with, and the error codes behind each.
		const why = meanings(analysis, workflow);
		const byStatus = new Map<number, string[]>([[400, ["invalid_input"]]]);
		if (signature) byStatus.set(401, ["invalid_signature"]);
		for (const code of shape?.errors ?? []) {
			const status = http.errors?.[code] ?? 500;
			byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
		}
		byStatus.set(500, [...new Set([...(byStatus.get(500) ?? []), "unexpected"])]);
		const BUILT_IN: Record<string, string> = {
			invalid_input: "The request lacks something, or has something of the wrong kind.",
			invalid_signature: "The signature does not match the body.",
			unexpected: "Something failed that nobody planned for.",
		};
		const responses: Record<string, unknown> = {
			[String(http.status ?? 200)]: {
				description: "It worked.",
				...(shape?.output ? { content: { "application/json": { schema: plain(shape.output) } } } : {}),
			},
		};
		for (const [status, codes] of [...byStatus].sort((a, b) => a[0] - b[0])) {
			responses[String(status)] = {
				description: codes
					.map((code) => `${code}${(why.get(code) ?? BUILT_IN[code]) ? `: ${why.get(code) ?? BUILT_IN[code]}` : ""}`)
					.join(" "),
				content: { "application/json": { schema: failure(codes) } },
			};
		}

		const body = part("body");
		const hasBody = Object.keys(body.properties ?? {}).length > 0;
		const route = http.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
		routes[route] ??= {};
		routes[route][http.method.toLowerCase()] = {
			operationId: camel(name),
			summary: workflow.name,
			...(workflow.description ? { description: workflow.description } : {}),
			...(parameters.length > 0 ? { parameters } : {}),
			...(hasBody
				? {
						requestBody: {
							required: (body.required ?? []).length > 0,
							content: { "application/json": { schema: plain({ type: "object", ...body }) } },
						},
					}
				: {}),
			responses,
		};
	}
	return {
		openapi: "3.1.0",
		info: {
			title: manifest.name ?? "API",
			version: manifest.version ?? "0.0.0",
			...(manifest.description ? { description: manifest.description } : {}),
		},
		paths: routes,
	};
}

/** `blokctl openapi`: prints the document. `blokctl build` writes the same thing to `.blok/openapi.json`. */
export function openapi(analysis: Analysis, paths: Paths): Report {
	if (analysis.problems.length > 0) {
		const text = `This project has problems, so there is nothing to describe yet:\n${analysis.problems.map((problem) => `- ${problem}`).join("\n")}`;
		return { ok: false, text, data: { ok: false, problems: analysis.problems } };
	}
	const document = openapiDocument(analysis, paths);
	return { ok: true, text: JSON.stringify(document, null, 2), data: document };
}
