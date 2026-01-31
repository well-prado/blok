import * as p from "@clack/prompts";
import { Command, type OptionValues, trackCommandExecution } from "../../services/commander.js";
import { BLOK_URL } from "../../services/constants.js";
import { tokenManager } from "../../services/local-token-manager.js";
import { isNonInteractive } from "../../services/non-interactive.js";

import { install } from "../install/node.js";

interface Package {
	package: string;
	format: string;
	namespace: string;
}
interface PackageOption extends Package {
	label: string;
	value: string;
}

async function searchPkg(opts: OptionValues) {
	const response = await fetch(`${BLOK_URL}/package-list?searchTerm=${opts.node}&format=${opts.format}`, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${opts.token}`,
		},
	});
	if (!response.ok) throw new Error(response.statusText);

	const pkgList = await response.json();

	return pkgList.packages;
}

export async function search(opts: OptionValues) {
	const token = tokenManager.getToken();
	const logger = p.spinner();
	try {
		if (!token) throw new Error("Token is required.");
		if (!opts.node) throw new Error("Node name is required.");
		opts.token = token;

		logger.start("Searching for packages...");

		const pkgList = await searchPkg(opts);

		if (pkgList.length === 0) {
			throw new Error("No packages found.");
		}

		// --list flag: print results and exit without prompting
		if (opts.list || (isNonInteractive() && !opts.install)) {
			logger.stop(`Found ${pkgList.length} package(s):`);
			for (const pkg of pkgList as Package[]) {
				p.log.info(pkg.package);
			}
			return;
		}

		// --install flag: install a specific package by name without prompting
		if (opts.install) {
			const pkgInfo = pkgList.find((pkg: Package) => pkg.package === opts.install);
			if (!pkgInfo) throw new Error(`Package "${opts.install}" not found in search results.`);
			logger.stop(`Starting installation of ${pkgInfo.package}...`);
			await trackCommandExecution({
				command: "install",
				args: opts,
				execution: async () => {
					opts.node = pkgInfo.package;
					if (!opts.directory) opts.directory = process.cwd();
					await install(opts);
				},
			});
			return;
		}

		const selectedPkg: PackageOption | Package | symbol = await p.select<PackageOption>({
			message: "Select a package to install",
			options: pkgList.map((pkg: Package) => ({
				label: pkg.package,
				value: pkg,
			})),
		});

		if (!selectedPkg || typeof selectedPkg === "symbol") throw new Error("No package selected.");
		// Find the full package info from pkgList
		const pkgInfo = pkgList.find((pkg: Package) => pkg.package === (selectedPkg as Package).package);
		if (!pkgInfo) throw new Error("Selected package not found.");

		logger.stop(`Starting installation of ${pkgInfo.package}...`);
		await trackCommandExecution({
			command: "install",
			args: opts,
			execution: async () => {
				opts.node = pkgInfo.package;
				if (!opts.directory) opts.directory = process.cwd();
				await install(opts);
			},
		});
	} catch (error) {
		logger.error((error as Error).message);
	}
}

export default new Command()
	.command("node")
	.description("Publish a node to the registry")
	.option("-f, --format <value>", "Package format", "npm")
	.option("-i, --install <value>", "Package name to auto-install (skip select prompt)")
	.option("-l, --list", "List results without prompting to install")
	.argument("<node>", "Node name")
	.action(async (node: string, options: OptionValues) => {
		await trackCommandExecution({
			command: "search node",
			args: options,
			execution: async () => {
				options.node = node;
				await search(options);
			},
		});
	});
