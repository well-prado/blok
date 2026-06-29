import child_process from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import util from "node:util";
import * as p from "@clack/prompts";

import { Command, type OptionValues, trackCommandExecution } from "../../services/commander.js";
import { tokenManager } from "../../services/local-token-manager.js";
import { isNonInteractive } from "../../services/non-interactive.js";
import { manager as pm } from "../../services/package-manager.js";
import { registryManager } from "../../services/registry-manager.js";

const discoveryNodeRuntime = async (): Promise<string> => {
	return "npm";
};

export async function install(opts: OptionValues) {
	const token = tokenManager.getToken();
	const npmrcFile = `${opts.directory}/.npmrc`;
	const logger = p.spinner();
	try {
		if (!token) throw new Error("Token is invalid.");
		if (!opts.node) throw new Error("Node name is required.");
		// Validate if package.json file exists
		const packageJsonPath = path.resolve(opts.directory, "./package.json");
		if (!fs.existsSync(packageJsonPath)) {
			throw new Error("package.json file does not exist in the specified directory.");
		}

		const availableManagers = await pm.getAvailableManagers();
		let manager = await pm.getManager();

		logger.start("Installing node...");

		const runtime = await discoveryNodeRuntime();

		if (runtime === "npm" && availableManagers.length > 1) {
			if (opts.packageManager) {
				manager = await pm.getManager(opts.packageManager);
			} else if (isNonInteractive()) {
				// In non-interactive mode, use the auto-detected manager
			} else {
				logger.message("Multiple package managers detected. Please select one.");
				const selectedManager = await p.select({
					message: "Select the package manager",
					options: availableManagers.map((manager) => ({
						label: manager,
						value: manager,
					})),
				});
				manager = await pm.getManager(selectedManager as string);
			}
		}

		// Get the registry token
		const registry = await registryManager.getRegistryToken(token);
		if (registry.error) throw new Error("Failed to get registry token.");

		// Create .npmrc file temporarily
		const REGISTRY_URL = `https://${registry.url}`;
		const npmrcContent = `@${registry.namespace}:registry=${REGISTRY_URL}\n//${registry.url}:_authToken=${registry.token}`;
		fs.writeFileSync(npmrcFile, npmrcContent);
		logger.message("Created .npmrc file for authentication.");

		// install the node
		const nodeName = `@${registry.namespace}/${opts.node}`;

		logger.message(`Installing node: ${opts.node}...`);
		const exec = util.promisify(child_process.exec);
		const { stdout, stderr } = await exec(
			manager.INSTALL_NODE({ node: nodeName, registry: REGISTRY_URL, npmrcDir: npmrcFile }),
			{ cwd: opts.directory },
		);

		if (stdout) p.log.info(stdout);
		else if (stderr) throw new Error(stderr);

		p.log.warn(nodeInstallHint(toPascalCase(opts.node), nodeName));

		logger.stop("Node installed successfully.");
	} catch (error) {
		if (fs.existsSync(npmrcFile)) fs.unlinkSync(npmrcFile);
		logger.error((error as Error).message);
	} finally {
		if (fs.existsSync(npmrcFile)) fs.unlinkSync(npmrcFile);
	}
}

function toPascalCase(input: string): string {
	return input.replace(/[^a-zA-Z0-9]+(.)/g, (_, chr) => chr.toUpperCase()).replace(/^./, (s) => s.toLowerCase());
}

export function nodeInstallHint(importName: string, importPath: string): string {
	return `Nodes.ts registration is deprecated. Import the node directly in a handle workflow: import ${importName} from "${importPath}"; then use step("id", ${importName}, inputs).`;
}
// Login command
export default new Command()
	.command("node")
	.description("Install a node from the bloks registry")
	.option("-d, --directory <value>", "Directory to publish")
	.option("-m, --package-manager <value>", "Package manager to use (npm, yarn, pnpm, bun)")
	.argument("<node>", "Node name")
	.action(async (node: string, options: OptionValues) => {
		await trackCommandExecution({
			command: "install",
			args: options,
			execution: async () => {
				options.node = node;
				if (!options.directory) options.directory = process.cwd();
				await install(options);
			},
		});
	});
