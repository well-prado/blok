import os from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";
import type { OptionValues } from "commander";
import figlet from "figlet";
import fsExtra from "fs-extra";
import color from "picocolors";
import { isNonInteractive, resolveOrThrow } from "../../services/non-interactive.js";
import { workflow_template } from "./utils/Examples.js";

const HOME_DIR = `${os.homedir()}/.blok`;
const GITHUB_REPO_LOCAL = `${HOME_DIR}/blok`;

export async function createWorkflow(opts: OptionValues, currentPath = false) {
	const nonInteractive = isNonInteractive();
	const isDefault = opts.name !== undefined;
	const skipPrompts = isDefault || nonInteractive;
	let workflowName: string = opts.name ? opts.name : "";

	if (!skipPrompts) {
		console.log(
			figlet.textSync("blok CLI".toUpperCase(), {
				font: "Digital",
				horizontalLayout: "default",
				verticalLayout: "default",
				width: 100,
				whitespaceBreak: true,
			}),
		);
		console.log("");

		const resolveWorkflowName = async (): Promise<string> => {
			if (workflowName !== "") {
				return workflowName;
			}

			return (await p.text({
				message: "Please provide a name for the workflow",
				placeholder: "workflow-name",
				defaultValue: "",
			})) as string;
		};

		p.intro(color.inverse(" Creating a new Workflow "));
		const blokctlNode = await p.group(
			{
				workflowName: () => resolveWorkflowName(),
			},
			{
				onCancel: () => {
					p.cancel("Operation canceled.");
					process.exit(0);
				},
			},
		);

		workflowName = blokctlNode.workflowName;
	} else if (nonInteractive) {
		workflowName = resolveOrThrow("name", opts.name);
	}

	const s = p.spinner();
	if (!skipPrompts) s.start("Creating the workflow...");

	try {
		// Prepare the project
		const mainDirExists = fsExtra.existsSync(GITHUB_REPO_LOCAL);
		if (!mainDirExists)
			throw new Error(
				"The blok repository was not found. Please run 'npx blokctl@latest create project' to clone the repository.",
			);

		let dirPath = process.cwd();
		if (!currentPath) {
			// Validate the project
			const currentDir = `${process.cwd()}/src`;
			const nodeProjectDirExists = fsExtra.existsSync(currentDir);
			if (!nodeProjectDirExists) throw new Error("ops1");

			// Prepare the workflow
			const currentWorkflowsDir = `${dirPath}/workflows`;
			if (!skipPrompts) {
				fsExtra.ensureDirSync(currentWorkflowsDir);
			} else {
				const workflowDirExists = fsExtra.existsSync(currentWorkflowsDir);
				if (!workflowDirExists) throw new Error("ops1");
			}

			dirPath = path.join(currentWorkflowsDir, `${workflowName.replaceAll(" ", "-").toLowerCase()}.ts`);
		} else {
			dirPath = path.join(dirPath, `${workflowName.replaceAll(" ", "-").toLowerCase()}.ts`);
		}

		if (!skipPrompts) s.message("Creating workflow...");

		/// Copy the node files
		if (!currentPath) {
			const workflowDirExists = fsExtra.existsSync(dirPath);
			if (workflowDirExists) throw new Error("ops2");
		}

		// Scaffold the typed-handle DSL workflow (.ts). Give the HTTP trigger an
		// explicit `path` derived from the name so the workflow is REACHABLE:
		// explicit-path-only routing is the default (since v0.4), so a pathless
		// workflow registers but 404s. Slug mirrors the filename (kebab-cased name).
		const slug = workflowName.replaceAll(" ", "-").toLowerCase();
		const workflow_ts = workflow_template
			.replaceAll("{{WORKFLOW_NAME}}", workflowName)
			.replaceAll("{{WORKFLOW_PATH}}", `/${slug}`);
		fsExtra.writeFileSync(dirPath, workflow_ts);

		if (!skipPrompts) s.stop(`Node "${workflowName}" created successfully.`);
		if (!currentPath) console.log("\nNavigate to the workflow directory by running: cd workflows/json");

		console.log("For more documentation, visit https://blok.build/docs/d/core-concepts/workflows");
	} catch (error) {
		if (!skipPrompts) s.stop("An error occurred");

		const message = (error as Error).message;
		if (message === "ops1") {
			console.log(
				"Oops! It seems like you haven't created a project yet... or have you? 🤔\n" +
					"If you already did, you can navigate to it using: cd project-name\n" +
					"Otherwise, you can create a new project with: npx blokctl@latest create project",
			);
		}
		if (message === "ops2") {
			console.log(
				"The workflow you are trying to create already exists in the project.\n" +
					"Please use a different name, or delete the existing workflow to create a new one.",
			);
		}
		if (message !== "ops1" && message !== "ops2") {
			console.log((error as Error).message);
		}
	}
}
