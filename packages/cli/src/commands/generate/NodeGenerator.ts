import * as fs from "node:fs";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import createNodeSystemPrompt from "./prompts/create-node.system.js";
import createFnNodeSystemPrompt from "./prompts/create-fn-node.system.js";

type NodeInformation = {
	nodeName: string;
	userPrompt: string;
	code: string;
};

export type { NodeInformation };

export default class NodeGenerator {
	async generateNode(nodeName: string, userPrompt: string, apiKey: string, update = false, nodeStyle = "function"): Promise<NodeInformation> {
		const openai = createOpenAI({
			compatibility: "strict",
			apiKey: apiKey,
		});

		// Select the appropriate prompt based on node style
		const promptTemplate = nodeStyle === "function" ? createFnNodeSystemPrompt : createNodeSystemPrompt;
		let prompt = promptTemplate.prompt;

		if (update) {
			// Read existing file and get the code
			const dirName = nodeName.toLowerCase().replace(/\s+/g, "-");
			const dirPath = process.cwd();
			const nodeDir = `${dirPath}/src/nodes`;
			const currentDir = `${nodeDir}/${dirName}`;
			const filePath = `${currentDir}/index.ts`;

			const code = fs.readFileSync(filePath, "utf8");
			prompt = `${promptTemplate.updatePrompt} \n\n ${code}`;
		}

		const { text } = await generateText({
			model: openai("gpt-4o"),
			system: prompt,
			prompt: userPrompt,
			temperature: 0.2,
		});

		return {
			nodeName,
			userPrompt,
			code: text,
		};
	}
}
