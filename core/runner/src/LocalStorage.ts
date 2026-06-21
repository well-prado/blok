// @ts-ignore
import fs from "node:fs";
import { XMLParser } from "fast-xml-parser";
import { parse } from "smol-toml";
import YAML from "yaml";
import ResolverBase from "./ResolverBase";
import type Config from "./types/Config";
import type { WorkflowLocator } from "./types/GlobalOptions";

export default class LocalStorage extends ResolverBase {
	protected fileTypes: string[] = ["json", "yaml", "xml", "toml"];

	async get(name: string, workflowLocator: WorkflowLocator, fileType?: string): Promise<Config> {
		const rootPath = process.env.VITE_WORKFLOWS_PATH || process.env.WORKFLOWS_PATH;
		let workflowFileType = fileType || process.env.VITE_WORKFLOWS_FILE_TYPE || process.env.WORKFLOWS_FILE_TYPE;
		if (workflowFileType === undefined) workflowFileType = "json";

		let name_fixed = name;

		if (name_fixed.indexOf(".") !== -1) {
			// A dot only denotes a file path when the trailing segment is a
			// supported file extension (json/yaml/xml/toml). Otherwise the dot
			// is part of a dotted `domain.action` workflow NAME — strip nothing,
			// keep the default file type, and let the lookup fall through to the
			// in-memory `workflowLocator` fallback or the accurate
			// `Workflow not found` error. Bug 03 (defense-in-depth): previously
			// any non-extension tail threw `File type not supported`, which broke
			// the framework's own recommended dotted-name convention on the
			// worker resolver path.
			const parts = name.split(".");
			const maybeExt = parts[parts.length - 1].toLowerCase();

			if (this.fileTypes.includes(maybeExt)) {
				workflowFileType = maybeExt;
				name_fixed = parts.slice(0, -1).join(".");
			}
		}

		const workflowPathJson = `${rootPath}/${workflowFileType}/${name_fixed}.${workflowFileType}`;

		const fileExists = fs.existsSync(workflowPathJson);
		if (fileExists) {
			if (workflowFileType === "json") {
				return JSON.parse(fs.readFileSync(workflowPathJson, "utf8"));
			}

			if (workflowFileType === "yaml") {
				const yaml = fs.readFileSync(workflowPathJson, "utf8");
				return YAML.parse(yaml);
			}

			if (workflowFileType === "xml") {
				const xml = fs.readFileSync(workflowPathJson, "utf8");
				const json = new XMLParser({ isArray: (tag: string) => tag === "steps" }).parse(xml);

				return json;
			}

			if (workflowFileType === "toml") {
				const toml = fs.readFileSync(workflowPathJson, "utf8");
				const json = parse(toml);

				return json as unknown as Config;
			}
		}

		if (workflowLocator !== undefined) {
			const helperExists = workflowLocator[name] !== undefined;
			if (helperExists) {
				const json = JSON.parse(workflowLocator[name].toJson());
				return json as Config;
			}
		}

		throw new Error(`Workflow not found: ${name}`);
	}
}
