import { type Hover, MarkupKind, Position, Range } from "vscode-languageserver";
import { FIELD_DOCS, type HoverDoc, STEP_FIELD_DOCS, TRIGGER_DOCS } from "./constants";

/**
 * Provides hover documentation for Blok workflow JSON files via LSP.
 *
 * Shows contextual documentation when hovering over:
 * - Trigger type keys (http, grpc, cron, queue, etc.)
 * - Workflow fields (name, version, steps, nodes, etc.)
 * - Node configuration fields (inputs, conditions, set_var)
 * - Step fields (node, type, runtime)
 * - HTTP method values, runtime type values, node packages
 */
export function getHover(text: string, line: number, character: number): Hover | null {
	const lines = text.split("\n");
	if (line >= lines.length) return null;

	const lineText = lines[line];

	// Find the quoted word at the cursor position
	const wordInfo = findQuotedWordAt(lineText, character);
	if (!wordInfo) return null;

	const { word, startChar, endChar } = wordInfo;
	const range = Range.create(Position.create(line, startChar), Position.create(line, endChar));

	// Check if it's a key (followed by colon)
	const afterWord = lineText.substring(endChar).trimStart();
	const isKey = afterWord.startsWith(":");

	if (isKey) {
		// Trigger type documentation
		if (TRIGGER_DOCS[word]) {
			return createDocHover(TRIGGER_DOCS[word], range);
		}

		// Field documentation
		if (FIELD_DOCS[word]) {
			return createDocHover(FIELD_DOCS[word], range);
		}

		// Step field documentation
		if (STEP_FIELD_DOCS[word]) {
			return createDocHover(STEP_FIELD_DOCS[word], range);
		}
	}

	// Value-based hover
	if (!isKey) {
		// HTTP methods
		if (["GET", "POST", "PUT", "DELETE", "PATCH", "ANY"].includes(word)) {
			return {
				contents: {
					kind: MarkupKind.Markdown,
					value: `**HTTP Method: ${word}**\n\nHTTP request method that will trigger this workflow.`,
				},
				range,
			};
		}

		// Runtime type values (runtime.go, runtime.python3, etc.)
		if (word.startsWith("runtime.")) {
			const lang = word.replace("runtime.", "");
			return {
				contents: {
					kind: MarkupKind.Markdown,
					value: `**Runtime Type: ${lang}**\n\nExecutes this node using the ${lang} runtime adapter. The node code must be written in ${lang} and served via the Blok runtime protocol (HTTP/gRPC).`,
				},
				range,
			};
		}

		// Common node packages
		if (word === "@nanoservice-ts/api-call") {
			return {
				contents: {
					kind: MarkupKind.Markdown,
					value:
						"**@nanoservice-ts/api-call**\n\nMakes HTTP API calls to external services.\n\n**Inputs:** `url`, `method`, `headers`, `body`, `responseType`",
				},
				range,
			};
		}
		if (word === "@nanoservice-ts/if-else") {
			return {
				contents: {
					kind: MarkupKind.Markdown,
					value:
						"**@nanoservice-ts/if-else**\n\nConditional branching node. Evaluates JavaScript conditions against the workflow context.\n\nConfigure conditions in the `nodes` section using the `conditions` array.",
				},
				range,
			};
		}
	}

	return null;
}

function findQuotedWordAt(
	line: string,
	character: number,
): { word: string; startChar: number; endChar: number } | null {
	// Find all quoted strings in the line and check if cursor is inside one
	const regex = /"([^"]*)"/g;

	for (const match of line.matchAll(regex)) {
		const start = match.index; // position of opening quote
		const end = match.index + match[0].length; // position after closing quote

		if (character >= start && character <= end) {
			return {
				word: match[1],
				startChar: start,
				endChar: end,
			};
		}
	}

	return null;
}

function createDocHover(doc: HoverDoc, range: Range): Hover {
	let value = `**${doc.title}**\n\n${doc.description}\n\n`;
	if (doc.example) {
		value += "```json\n" + doc.example + "\n```";
	}

	return {
		contents: {
			kind: MarkupKind.Markdown,
			value,
		},
		range,
	};
}
