import * as fs from "node:fs";
import * as path from "node:path";
import readline from "node:readline";
import * as p from "@clack/prompts";
import { Command } from "commander";
import figlet from "figlet";
import open from "open";
import color from "picocolors";
import { type OptionValues, program, trackCommandExecution } from "../../services/commander.js";
import { getPreferredEditor } from "../../services/utils.js";
import NodeFileWriter from "./NodeFileWriter.js";
import NodeGenerator, { type NodeInformation } from "./NodeGenerator.js";
import RegisterNode from "./RegisterNode.js";
import RuntimeGenerator, { isSupportedLanguage } from "./RuntimeGenerator.js";
import TriggerGenerator from "./TriggerGenerator.js";
import WorkflowGenerator from "./WorkflowGenerator.js";

// Generate command for AI vibe coding

const create = new Command("generate").description("Generate code snippets using AI");

create
	.command("ai-node")
	.description("Generate a Node.js code snippet using AI")
	.option("-n, --name <value>", "Name of the Node code snippet")
	.option("-p, --prompt <value>", "Prompt for AI code generation")
	.option("-t, --type <value>", "Type of code snippet (default: 'class')")
	.option("-s, --style <value>", "Node style: 'function' (default, defineNode) or 'class' (extends NanoService)")
	.option("-u, --update", "Update existing Node code snippet")
	.option(
		"-k, --api-key <value>",
		"OpenAI API key (optional, uses environment variable OPENAI_API_KEY if not provided)",
	)
	.action(async (options: OptionValues) => {
		await trackCommandExecution({
			command: "generate ai-node",
			args: options,
			execution: async () => {
				console.log(
					figlet.textSync("nanoservice-ts CLI".toUpperCase(), {
						font: "Digital",
						horizontalLayout: "default",
						verticalLayout: "default",
						width: 100,
						whitespaceBreak: true,
					}),
				);
				console.log("");

				if (!options.name) {
					if (!options.update && !options.prompt) {
						console.error("Both --name and --prompt options are required.");
					} else {
						console.error("The --name option is required.");
					}
					process.exit(1);
				}

				if (!options.apiKey && !process.env.OPENAI_API_KEY) {
					console.error(
						"An OpenAI API key is required. Please provide it using --api-key or set the OPENAI_API_KEY environment variable.",
					);
					process.exit(1);
				}

				p.intro(color.inverse(" Create a New Node Code Snippet "));
				const s = p.spinner();

				let node: NodeInformation = <NodeInformation>{};
				let cleaned = "";
				let nodeType = "class";
				const nodeStyle = options.style || "function"; // Default to function-first

				if (!options.update) {
					s.start(`Generating ${nodeStyle === "function" ? "function-first" : "class-based"} Node code snippet...`);
					// Generate the Node code snippet using AI
					const generator = new NodeGenerator();
					node = await generator.generateNode(
						options.name.toLowerCase().replace(/\s+/g, "-"),
						options.prompt,
						options.apiKey || process.env.OPENAI_API_KEY,
						false,
						nodeStyle,
					);
					cleaned = node.code.replace(/^```typescript\s*([\s\S]*?)\s*```$/gm, "$1");
					nodeType = options.type || "class";
				} else {
					const nodeName = options.name.toLowerCase().replace(/\s+/g, "-");
					p.intro(color.inverse(`🛠️  Update Existing Node: ${nodeName}`));

					const rl = readline.createInterface({
						input: process.stdin,
						output: process.stdout,
						terminal: true,
					});

					const lines: string[] = [];
					console.log("\n   Enter your code below:");
					console.log("   - Type 'quit' on a new line to finish");
					console.log("   - Press Ctrl+C to cancel");
					console.log("   ----------------------------------------\n");

					const multilineInput = await new Promise<string>((resolve) => {
						rl.on("line", (input: string) => {
							if (input.trim().toLocaleLowerCase() === "quit") {
								rl.close();
								resolve(lines.join("\n"));
							} else {
								lines.push(input);
								rl.prompt();
							}
						});

						// Handle Ctrl+C to cancel
						rl.on("SIGINT", () => {
							console.log("\nInput cancelled");
							rl.close();
							resolve("");
						});

						// Handle Ctrl+D (EOF)
						rl.on("close", () => {
							if (lines.length > 0) {
								resolve(lines.join("\n"));
							} else {
								resolve("");
							}
						});

						rl.prompt();
					});

					s.start(`Updating ${nodeStyle === "function" ? "function-first" : "class-based"} Node code...`);
					// Generate the Node code snippet using AI
					const generator = new NodeGenerator();
					node = await generator.generateNode(
						options.name.toLowerCase().replace(/\s+/g, "-"),
						multilineInput,
						options.apiKey || process.env.OPENAI_API_KEY,
						true,
						nodeStyle,
					);
					cleaned = node.code.replace(/^```typescript\s*([\s\S]*?)\s*```$/gm, "$1");
					nodeType = options.type || "class";
				}

				// Create the file with the generated code snippet
				const filePath = await new NodeFileWriter().generateFile(
					node.nodeName,
					nodeType,
					cleaned,
					options.apiKey || process.env.OPENAI_API_KEY,
					nodeStyle,
				);

				// Register the new node in Nodes.ts
				s.message(`Registering node "${node.nodeName}" in Nodes.ts...`);
				const register = new RegisterNode();
				const nodesFilePath = await register.generateNodesFile(
					node.nodeName,
					`./nodes/${node.nodeName}`,
					node.code,
					options.apiKey || process.env.OPENAI_API_KEY,
				);

				// Open file in the default editor
				const editor = getPreferredEditor();

				await open(filePath, { app: { name: editor }, wait: false });

				if (!options.update) {
					await open(nodesFilePath, { app: { name: editor }, wait: false });
				}

				s.stop(`Node code snippet "${node.nodeName}" generated and registered successfully!`);

				// Show style-specific success message
				if (nodeStyle === "function") {
					console.log(color.cyan("\n✨ Function-First Node Generated!"));
					console.log("  • Type-safe with Zod validation");
					console.log("  • 60% less boilerplate than class-based");
					console.log("  • AI-friendly for code generation");
					console.log("\n📖 Learn more: https://blok.build/docs/nodes/function-first\n");
				}
			},
		});
	});

// AI Workflow Generation Command
create
	.command("ai-workflow")
	.description("Generate a workflow JSON configuration using AI")
	.option("-n, --name <value>", "Name of the workflow")
	.option("-p, --prompt <value>", "Prompt describing the workflow behavior")
	.option("-t, --trigger <value>", "Trigger type: http, queue, pubsub, cron, webhook, websocket, sse (default: 'auto')")
	.option("-u, --update <value>", "Path to existing workflow JSON to update")
	.option(
		"-k, --api-key <value>",
		"OpenAI API key (optional, uses environment variable OPENAI_API_KEY if not provided)",
	)
	.action(async (options: OptionValues) => {
		await trackCommandExecution({
			command: "generate ai-workflow",
			args: options,
			execution: async () => {
				console.log(
					figlet.textSync("BLOK AI".toUpperCase(), {
						font: "Digital",
						horizontalLayout: "default",
						verticalLayout: "default",
						width: 100,
						whitespaceBreak: true,
					}),
				);
				console.log("");

				if (!options.name) {
					console.error("The --name option is required.");
					process.exit(1);
				}

				if (!options.prompt && !options.update) {
					console.error("The --prompt option is required for new workflows.");
					process.exit(1);
				}

				if (!options.apiKey && !process.env.OPENAI_API_KEY) {
					console.error(
						"An OpenAI API key is required. Please provide it using --api-key or set the OPENAI_API_KEY environment variable.",
					);
					process.exit(1);
				}

				const isUpdate = !!options.update;
				p.intro(color.inverse(isUpdate ? " Update Existing Workflow " : " Generate a New Workflow "));
				const s = p.spinner();

				const workflowName = options.name.toLowerCase().replace(/\s+/g, "-");
				const triggerType = options.trigger || "auto";
				const apiKey = options.apiKey || process.env.OPENAI_API_KEY;

				s.start(
					`Generating workflow "${workflowName}" with ${triggerType === "auto" ? "auto-detected" : triggerType} trigger...`,
				);

				const generator = new WorkflowGenerator();
				const result = await generator.generateWorkflow(
					workflowName,
					options.prompt || "Update this workflow with improvements",
					apiKey,
					triggerType,
					isUpdate,
					isUpdate ? options.update : undefined,
				);

				// Write the workflow JSON file
				const dirPath = process.cwd();
				const workflowsDir = path.join(dirPath, "workflows", "json");

				if (!fs.existsSync(workflowsDir)) {
					fs.mkdirSync(workflowsDir, { recursive: true });
				}

				const filePath = path.join(workflowsDir, `${workflowName}.json`);
				fs.writeFileSync(filePath, result.json, "utf8");

				// Show validation results
				if (result.validationResult) {
					if (result.validationResult.valid) {
						s.stop(`Workflow "${workflowName}" generated successfully!`);
					} else {
						s.stop(`Workflow "${workflowName}" generated with validation warnings.`);
						console.log(color.yellow("\n⚠️  Validation Issues:"));
						for (const error of result.validationResult.errors) {
							console.log(color.red(`  ✗ ${error}`));
						}
					}

					if (result.validationResult.warnings.length > 0) {
						console.log(color.yellow("\n⚠️  Warnings:"));
						for (const warning of result.validationResult.warnings) {
							console.log(color.yellow(`  ! ${warning}`));
						}
					}

					console.log(color.dim(`\n  Attempts: ${result.validationResult.attempts}/${3}`));
				}

				// Open file in editor
				const editor = getPreferredEditor();
				await open(filePath, { app: { name: editor }, wait: false });

				console.log(color.cyan(`\n✨ Workflow Generated: ${filePath}`));
				console.log(`  Trigger: ${result.triggerType}`);
				console.log(`  Name: ${workflowName}`);
				console.log(color.dim("\n  To use this workflow, ensure all referenced nodes are installed or created.\n"));
			},
		});
	});

// AI Trigger Generation Command
create
	.command("ai-trigger")
	.description("Generate a trigger implementation using AI")
	.option("-n, --name <value>", "Name of the trigger")
	.option("-t, --type <value>", "Trigger type: queue, pubsub, cron, webhook, websocket, sse, custom")
	.option("-p, --prompt <value>", "Prompt describing the trigger behavior")
	.option("-u, --update <value>", "Path to existing trigger file to update")
	.option(
		"-k, --api-key <value>",
		"OpenAI API key (optional, uses environment variable OPENAI_API_KEY if not provided)",
	)
	.action(async (options: OptionValues) => {
		await trackCommandExecution({
			command: "generate ai-trigger",
			args: options,
			execution: async () => {
				console.log(
					figlet.textSync("BLOK AI".toUpperCase(), {
						font: "Digital",
						horizontalLayout: "default",
						verticalLayout: "default",
						width: 100,
						whitespaceBreak: true,
					}),
				);
				console.log("");

				if (!options.name) {
					console.error("The --name option is required.");
					process.exit(1);
				}

				if (!options.type) {
					console.error(
						"The --type option is required. Valid types: queue, pubsub, cron, webhook, websocket, sse, custom",
					);
					process.exit(1);
				}

				if (!options.prompt && !options.update) {
					console.error("The --prompt option is required for new triggers.");
					process.exit(1);
				}

				if (!options.apiKey && !process.env.OPENAI_API_KEY) {
					console.error(
						"An OpenAI API key is required. Please provide it using --api-key or set the OPENAI_API_KEY environment variable.",
					);
					process.exit(1);
				}

				const isUpdate = !!options.update;
				p.intro(color.inverse(isUpdate ? " Update Existing Trigger " : " Generate a New Trigger "));
				const s = p.spinner();

				const triggerName = options.name.toLowerCase().replace(/\s+/g, "-");
				const triggerType = options.type.toLowerCase();
				const apiKey = options.apiKey || process.env.OPENAI_API_KEY;

				s.start(`Generating ${triggerType} trigger "${triggerName}"...`);

				const generator = new TriggerGenerator();
				const result = await generator.generateTrigger(
					triggerName,
					triggerType,
					options.prompt || "Update this trigger with improvements",
					apiKey,
					isUpdate,
					isUpdate ? options.update : undefined,
				);

				// Write the trigger file
				const dirPath = process.cwd();
				const triggerDir = path.join(dirPath, "triggers", triggerName, "src");

				if (!fs.existsSync(triggerDir)) {
					fs.mkdirSync(triggerDir, { recursive: true });
				}

				// Generate PascalCase class name
				const className = triggerName
					.split("-")
					.map((part: string) => part.charAt(0).toUpperCase() + part.slice(1))
					.join("");

				const filePath = path.join(triggerDir, `${className}Trigger.ts`);
				const cleaned = result.code.replace(/^```typescript\s*([\s\S]*?)\s*```$/gm, "$1");
				fs.writeFileSync(filePath, cleaned, "utf8");

				// Also create index.ts re-export
				const indexPath = path.join(triggerDir, "index.ts");
				if (!fs.existsSync(indexPath)) {
					fs.writeFileSync(
						indexPath,
						`export { default } from "./${className}Trigger.js";\nexport * from "./${className}Trigger.js";\n`,
						"utf8",
					);
				}

				// Show validation results
				if (result.validationResult) {
					if (result.validationResult.valid) {
						s.stop(`Trigger "${triggerName}" generated successfully!`);
					} else {
						s.stop(`Trigger "${triggerName}" generated with validation warnings.`);
						console.log(color.yellow("\n⚠️  Validation Issues:"));
						for (const error of result.validationResult.errors) {
							console.log(color.red(`  ✗ ${error}`));
						}
					}

					if (result.validationResult.warnings.length > 0) {
						console.log(color.yellow("\n⚠️  Warnings:"));
						for (const warning of result.validationResult.warnings) {
							console.log(color.yellow(`  ! ${warning}`));
						}
					}

					console.log(color.dim(`\n  Attempts: ${result.validationResult.attempts}/${3}`));
				}

				// Open file in editor
				const editor = getPreferredEditor();
				await open(filePath, { app: { name: editor }, wait: false });

				console.log(color.cyan(`\n✨ Trigger Generated: ${filePath}`));
				console.log(`  Type: ${triggerType}`);
				console.log(`  Class: ${className}Trigger`);
				console.log(color.dim("\n  To use this trigger:"));
				console.log(color.dim("  1. Install any required dependencies"));
				console.log(color.dim("  2. Create a server entry point to instantiate and start the trigger"));
				console.log(color.dim(`  3. Configure workflows with trigger type "${triggerType}"\n`));
			},
		});
	});

// AI Runtime Adapter Generation Command
create
	.command("ai-runtime")
	.description("Generate a runtime SDK for a specific programming language")
	.option("-l, --language <value>", "Target language: go, java, rust, python, csharp, php, ruby")
	.option("-p, --prompt <value>", "Additional instructions for the runtime generation")
	.option("-u, --update <value>", "Path to existing runtime directory to update")
	.option(
		"-k, --api-key <value>",
		"OpenAI API key (optional, uses environment variable OPENAI_API_KEY if not provided)",
	)
	.action(async (options: OptionValues) => {
		await trackCommandExecution({
			command: "generate ai-runtime",
			args: options,
			execution: async () => {
				console.log(
					figlet.textSync("BLOK AI".toUpperCase(), {
						font: "Digital",
						horizontalLayout: "default",
						verticalLayout: "default",
						width: 100,
						whitespaceBreak: true,
					}),
				);
				console.log("");

				if (!options.language) {
					console.error(
						"The --language option is required. Valid languages: go, java, rust, python, csharp, php, ruby",
					);
					process.exit(1);
				}

				const language = options.language.toLowerCase();
				if (!isSupportedLanguage(language)) {
					console.error(
						`Unsupported language: "${language}". Valid languages: go, java, rust, python, csharp, php, ruby`,
					);
					process.exit(1);
				}

				if (!options.prompt && !options.update) {
					console.error("The --prompt option is required for new runtimes.");
					process.exit(1);
				}

				if (!options.apiKey && !process.env.OPENAI_API_KEY) {
					console.error(
						"An OpenAI API key is required. Please provide it using --api-key or set the OPENAI_API_KEY environment variable.",
					);
					process.exit(1);
				}

				const isUpdate = !!options.update;
				p.intro(
					color.inverse(
						isUpdate
							? ` Update Existing ${language.toUpperCase()} Runtime `
							: ` Generate ${language.toUpperCase()} Runtime SDK `,
					),
				);
				const s = p.spinner();

				const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
				const userPrompt = options.prompt || "Generate a complete runtime SDK with example nodes";

				s.start(`Generating ${language} runtime SDK...`);

				const generator = new RuntimeGenerator();
				const result = await generator.generateRuntime(
					language,
					userPrompt,
					apiKey,
					isUpdate,
					isUpdate ? options.update : undefined,
				);

				// Write all generated files
				const dirPath = process.cwd();
				const runtimeDir = path.join(dirPath, "runtimes", language);

				let filesWritten = 0;
				for (const file of result.files) {
					const filePath = path.join(runtimeDir, file.path);
					const fileDir = path.dirname(filePath);

					if (!fs.existsSync(fileDir)) {
						fs.mkdirSync(fileDir, { recursive: true });
					}

					fs.writeFileSync(filePath, file.content, "utf8");
					filesWritten++;
				}

				// Show validation results
				if (result.validationResult) {
					if (result.validationResult.valid) {
						s.stop(`${language.toUpperCase()} runtime SDK generated successfully!`);
					} else {
						s.stop(`${language.toUpperCase()} runtime SDK generated with validation warnings.`);
						console.log(color.yellow("\n\u26a0\ufe0f  Validation Issues:"));
						for (const error of result.validationResult.errors) {
							console.log(color.red(`  \u2717 ${error}`));
						}
					}

					if (result.validationResult.warnings.length > 0) {
						console.log(color.yellow("\n\u26a0\ufe0f  Warnings:"));
						for (const warning of result.validationResult.warnings) {
							console.log(color.yellow(`  ! ${warning}`));
						}
					}

					console.log(color.dim(`\n  Attempts: ${result.validationResult.attempts}/${3}`));
				}

				console.log(color.cyan(`\n\u2728 Runtime SDK Generated: ${runtimeDir}`));
				console.log(`  Language: ${language}`);
				console.log(`  Files: ${filesWritten}`);

				if (result.files.length > 0) {
					console.log(color.dim("\n  Generated files:"));
					for (const file of result.files) {
						console.log(color.dim(`    \u2022 ${file.path}`));
					}
				}

				console.log(color.dim("\n  To use this runtime:"));
				console.log(color.dim("  1. cd into the generated directory"));
				console.log(color.dim("  2. Build the runtime (see the generated README or Dockerfile)"));
				console.log(color.dim(`  3. Run: docker build -t blok-runtime-${language} .`));
				console.log(color.dim(`  4. Run: docker run -p 8080:8080 blok-runtime-${language}`));
				console.log(color.dim("  5. Register the Docker adapter in your Blok configuration\n"));
			},
		});
	});

program.addCommand(create);
