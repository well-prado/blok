#! /usr/bin/env node
import child_process from "node:child_process";
import os from "node:os";
import util from "node:util";
import * as p from "@clack/prompts";
import fsExtra from "fs-extra";
import color from "picocolors";
import { createNode } from "./commands/create/node.js";
import { createProject } from "./commands/create/project.js";
import { createWorkflow } from "./commands/create/workflow.js";
import { devProject } from "./commands/dev/index.js";
import { type OptionValues, program } from "./services/commander.js";
import { PosthogAnalytics } from "./services/posthog.js";
import { getPackageVersion } from "./services/utils.js";

// Commands
import "./commands/login/index.js";
import "./commands/logout/index.js";
import "./commands/build/index.js";
import "./commands/deploy/index.js";
import "./commands/monitor/index.js";
import "./commands/publish/index.js";
import "./commands/install/index.js";
import "./commands/search/index.js";
import "./commands/generate/index.js";
import "./commands/config/index.js";
import "./commands/migrate/index.js";
import "./commands/graph/index.js";
import "./commands/profile/index.js";
import "./commands/cost/index.js";
import "./commands/trace/index.js";
import { Command } from "commander";

const version = await getPackageVersion();
const exec = util.promisify(child_process.exec);

export const CLI_NAME = "blokctl";

const validateVersion = async (
	currentVersion: string,
): Promise<{ currentVersion: string; latestVersion: string; isLatest: boolean }> => {
	let latestVersion: string;
	try {
		const execResponse = await exec(`npm view ${CLI_NAME} version`);
		latestVersion = execResponse.stdout.trim();
	} catch {
		// Package not yet published to npm — skip version check
		return { currentVersion, latestVersion: currentVersion, isLatest: true };
	}
	const [latestMajor, latestMinor, latestPatch] = latestVersion.split(".").map(Number);
	const [currentMajor, currentMinor, currentPatch] = currentVersion.split(".").map(Number);

	let isLatest = true;

	if (
		latestMajor > currentMajor ||
		(latestMajor === currentMajor && latestMinor > currentMinor) ||
		(latestMajor === currentMajor && latestMinor === currentMinor && latestPatch > currentPatch)
	) {
		p.log.warn(
			`A new version of ${CLI_NAME} CLI is available.\nPlease update to the latest version.\nVersion:\t${color.red(currentVersion)} > ${color.green(latestVersion)}`,
		);
		isLatest = false;
	}

	return {
		currentVersion,
		latestVersion,
		isLatest,
	};
};

async function main() {
	try {
		const HOME_DIR = `${os.homedir()}/.blok`;
		const cliConfigPath = `${HOME_DIR}/blokctl.json`;

		fsExtra.ensureDirSync(HOME_DIR);

		const analytics = new PosthogAnalytics({
			version: version,
			cliConfigPath: cliConfigPath,
		});

		program.version(`${version}`, "-v, --version").description(`Blok CLI ${version}`);

		await validateVersion(version);

		const create = new Command("create").description("Create a new blok component");

		const project = new Command("project")
			.description("Create a new Project")
			.option("-n, --name <value>", "Create a default Project")
			.option("-l, --local <path>", "Use a local repo path instead of cloning from remote")
			.action(async (options: OptionValues) => {
				await analytics.trackCommandExecution({
					command: "create project",
					args: options,
					execution: async () => {
						createProject(options, version, false, options.local);
					},
				});
			});

		project
			.command(".")
			.description("Create a new Project")
			.action(async (options: OptionValues) => {
				await analytics.trackCommandExecution({
					command: "create project .",
					args: options,
					execution: async () => {
						createProject(options, version, true, project.opts().local);
					},
				});
			});

		const node = new Command("node")
			.description("Create a new Node")
			.option("-n, --name <value>", "Create a default Node")
			.option("-s, --style <value>", "Node style: 'function' (recommended) or 'class'")
			.action(async (options: OptionValues) => {
				await analytics.trackCommandExecution({
					command: "create node",
					args: options,
					execution: async () => {
						createNode(options, false);
					},
				});
			});

		node
			.command(".")
			.description("Create a new Node")
			.option("-s, --style <value>", "Node style: 'function' (recommended) or 'class'")
			.action(async (options: OptionValues) => {
				await analytics.trackCommandExecution({
					command: "create node",
					args: options,
					execution: async () => {
						createNode(options, true);
					},
				});
			});

		const workflow = new Command("workflow")
			.description("Create a new Workflow")
			.option("-n, --name <value>", "Create a default Workflow")
			.action(async (options: OptionValues) => {
				await analytics.trackCommandExecution({
					command: "create workflow",
					args: options,
					execution: async () => {
						createWorkflow(options, false);
					},
				});
			});

		workflow
			.command(".")
			.description("Create a new Workflow")
			.action(async (options: OptionValues) => {
				await analytics.trackCommandExecution({
					command: "create workflow",
					args: options,
					execution: async () => {
						createWorkflow(options, true);
					},
				});
			});

		create.addCommand(project);
		create.addCommand(node);
		create.addCommand(workflow);

		program.addCommand(create);

		// Dev server

		program
			.command("dev")
			.description("Start the development server")
			.action(async (options: OptionValues) => {
				await analytics.trackCommandExecution({
					command: "dev",
					args: options,
					execution: async () => {
						devProject(options);
					},
				});
			});

		program.parse(process.argv);
	} catch (err) {
		console.log((err as Error).message);
	}
}

main();
