import child_process from "node:child_process";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import * as p from "@clack/prompts";
import type { OptionValues } from "commander";
import figlet from "figlet";
import fsExtra from "fs-extra";
import color from "picocolors";
import simpleGit, { type SimpleGit, type SimpleGitOptions } from "simple-git";
import { manager as pm } from "../../services/package-manager.js";
import { type RuntimeInfo, detectRuntimes } from "../../services/runtime-detector.js";
import {
	type RuntimeConfig,
	generateRuntimeEnvVars,
	generateSupervisordConfig,
	setupRuntime,
	writeProjectConfig,
} from "../../services/runtime-setup.js";
import {
	examples_url,
	node_file,
	package_dependencies,
	package_dev_dependencies,
	supervisord_nodejs,
} from "./utils/Examples.js";

const exec = util.promisify(child_process.exec);

const HOME_DIR = `${os.homedir()}/.blok`;
const GITHUB_REPO_LOCAL = `${HOME_DIR}/blok`;
const GITHUB_REPO_REMOTE = "https://github.com/well-prado/blok.git";
const GITHUB_REPO_RELEASE_TAG = "v0.0.1-beta.1";

fsExtra.ensureDirSync(HOME_DIR);
const options: Partial<SimpleGitOptions> = {
	baseDir: HOME_DIR,
	binary: "git",
	maxConcurrentProcesses: 6,
	trimmed: false,
};

const git: SimpleGit = simpleGit(options);

export async function createProject(opts: OptionValues, version: string, currentPath = false) {
	const availableManagers = await pm.getAvailableManagers();
	let manager = await pm.getManager();
	const isDefault = opts.name !== undefined;
	let projectName: string = opts.name ? opts.name : "";
	let trigger = "http";
	let examples = false;
	let selectedRuntimeKinds: string[] = ["node"];
	let selectedManager = "npm";

	// Detect available runtimes on the machine
	let detectedRuntimes: RuntimeInfo[] = [];

	if (!isDefault) {
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
		p.intro(color.inverse(" Create a New Project "));

		// Detect installed language toolchains
		const detectSpinner = p.spinner();
		detectSpinner.start("Detecting installed language runtimes...");
		detectedRuntimes = await detectRuntimes();
		detectSpinner.stop("Runtime detection complete.");

		// Get the project name and trigger

		const resolveProjectName = async (): Promise<string> => {
			if (projectName !== "") {
				return projectName;
			}

			return (await p.text({
				message: "Please provide a name for the project",
				placeholder: "blok-service",
				defaultValue: "blok-service",
			})) as string;
		};

		const resolveSelectedManager = async (): Promise<string> => {
			if (availableManagers.length === 1) {
				return availableManagers[0];
			}
			return (await p.select({
				message: "Select the package manager",
				options: availableManagers.map((manager) => ({
					label: manager,
					value: manager,
				})),
			})) as string;
		};

		// Build runtime options with detection hints
		const runtimeOptions = [
			{ label: "NodeJS", value: "node", hint: "always included" },
			...detectedRuntimes.map((rt) => {
				let hint: string;
				if (rt.available) {
					hint = `${rt.toolchain} ${rt.version || ""} detected`.trim();
				} else if (rt.secondaryTool && !rt.secondaryTool.available) {
					hint = `${rt.secondaryTool.name} not found - will be skipped`;
				} else {
					hint = `${rt.toolchain} not found - will be skipped`;
				}
				return { label: rt.label, value: rt.kind, hint };
			}),
		];

		const blokctlProject = await p.group(
			{
				projectName: () => resolveProjectName(),
				trigger: () =>
					p.select({
						message: "Select the trigger to install",
						options: [
							{ label: "HTTP", value: "http", hint: "recommended" },
							//{ label: "GRPC", value: "grpc" }
						],
					}),
				runtimes: () =>
					p.multiselect({
						message: "Select the runtimes to install",
						options: runtimeOptions,
						initialValues: ["node"],
						required: true,
					}),
				selectedManager: () => resolveSelectedManager(),
			},
			{
				onCancel: () => {
					p.cancel("Operation canceled.");
					process.exit(0);
				},
			},
		);

		projectName = blokctlProject.projectName;
		trigger = blokctlProject.trigger;
		selectedRuntimeKinds = blokctlProject.runtimes;
		selectedManager = blokctlProject.selectedManager;

		// Warn about unavailable runtimes
		const unavailableSelected = selectedRuntimeKinds.filter((kind) => {
			if (kind === "node") return false;
			const rt = detectedRuntimes.find((r) => r.kind === kind);
			return rt && !rt.available;
		});

		if (unavailableSelected.length > 0) {
			console.log("");
			for (const kind of unavailableSelected) {
				const rt = detectedRuntimes.find((r) => r.kind === kind);
				if (rt) {
					console.log(color.yellow(`  ${rt.label}: ${rt.toolchain} not found. Skipping setup.`));
					if (rt.secondaryTool && !rt.secondaryTool.available) {
						console.log(color.yellow(`    ${rt.secondaryTool.installHint}`));
					} else {
						console.log(color.yellow(`    ${rt.installHint}`));
					}
				}
			}
			console.log("");

			// Filter out unavailable runtimes
			selectedRuntimeKinds = selectedRuntimeKinds.filter((kind) => {
				if (kind === "node") return true;
				const rt = detectedRuntimes.find((r) => r.kind === kind);
				return rt?.available ?? false;
			});
		}

		const blokctlExamplesProject = await p.group(
			{
				examples: () =>
					p.select({
						message: "Install the examples?",
						options: [
							{ label: "NO", value: false, hint: "recommended" },
							{ label: "YES", value: true },
						],
					}),
			},
			{
				onCancel: () => {
					p.cancel("Operation canceled.");
					process.exit(0);
				},
			},
		);

		examples = blokctlExamplesProject.examples;
	}

	const s = p.spinner();
	if (!isDefault) s.start("Creating the project...");

	try {
		// Prepare the project
		const dirPath = !currentPath ? path.join(process.cwd(), projectName) : process.cwd();

		if (!isDefault) s.message("Gathering project files");

		const githubLocalExists = fsExtra.existsSync(GITHUB_REPO_LOCAL);
		if (githubLocalExists) {
			fsExtra.removeSync(GITHUB_REPO_LOCAL);
		}
		if (GITHUB_REPO_RELEASE_TAG) {
			await git.clone(GITHUB_REPO_REMOTE, GITHUB_REPO_LOCAL, ["--branch", GITHUB_REPO_RELEASE_TAG, "--depth", "1"]);
		} else {
			await git.clone(GITHUB_REPO_REMOTE, GITHUB_REPO_LOCAL);
		}

		if (!isDefault) s.message("Copying project files...");

		/// Copy the project files
		if (!currentPath) {
			const projectDirExists = fsExtra.existsSync(dirPath);
			if (projectDirExists) {
				throw new Error("A project already exists in the current directory. Please remove it and try again.");
			}
		}

		fsExtra.copySync(`${GITHUB_REPO_LOCAL}/triggers/${trigger}`, dirPath);

		if (!isDefault) {
			s.message("Installing example workflows and nodes");
		}
		const nodesDir = `${dirPath}/src/nodes`;
		const workflowsDir = `${dirPath}/workflows`;

		fsExtra.ensureDirSync(nodesDir);
		fsExtra.copySync(`${GITHUB_REPO_LOCAL}/workflows`, workflowsDir);

		// Add permissions to the directory
		try {
			fsExtra.chownSync(dirPath, os.userInfo().uid, os.userInfo().gid);
		} catch (error) {
			console.error(`Failed to change ownership of directory ${dirPath}:`, error);
		}

		// Infra

		fsExtra.ensureDirSync(`${dirPath}/infra`);
		fsExtra.ensureDirSync(`${dirPath}/infra/metrics`);
		fsExtra.copySync(`${GITHUB_REPO_LOCAL}/infra/metrics`, `${dirPath}/infra/metrics`);
		fsExtra.removeSync(`${dirPath}/public/metric`);

		// Examples

		if (!examples) {
			fsExtra.removeSync(`${nodesDir}/examples`);
			fsExtra.removeSync(`${workflowsDir}`);
			fsExtra.ensureDirSync(`${workflowsDir}`);
			fsExtra.ensureDirSync(`${workflowsDir}/json`);
			fsExtra.ensureDirSync(`${workflowsDir}/yaml`);
			fsExtra.ensureDirSync(`${workflowsDir}/toml`);
		} else {
			fsExtra.ensureDirSync(`${dirPath}/infra/postgresql`);
			fsExtra.ensureDirSync(`${dirPath}/infra/milvus`);

			fsExtra.copySync(`${GITHUB_REPO_LOCAL}/infra/development`, `${dirPath}/infra/postgresql`);
			fsExtra.copySync(`${GITHUB_REPO_LOCAL}/infra/milvus`, `${dirPath}/infra/milvus`);

			fsExtra.writeFileSync(`${dirPath}/src/Nodes.ts`, node_file);
			fsExtra.copySync(`${GITHUB_REPO_LOCAL}/sdk`, `${dirPath}/public/sdk`);
		}

		// Create .env.local file

		const envExample = `${dirPath}/.env.example`;
		const envLocal = `${dirPath}/.env.local`;

		const envContent = fsExtra.readFileSync(envExample, "utf8");
		const result = envContent.replaceAll("PROJECT_PATH", dirPath);
		fsExtra.writeFileSync(envLocal, result);

		// Change package.json
		const packageJson = `${dirPath}/package.json`;
		const packageJsonContent = JSON.parse(fsExtra.readFileSync(packageJson, "utf8"));
		packageJsonContent.name = projectName;
		packageJsonContent.version = "1.0.0";
		packageJsonContent.author = "";

		// Get the package manager
		manager = await pm.getManager(selectedManager as string);

		// Setup non-NodeJS runtimes
		const nonNodeRuntimes = selectedRuntimeKinds.filter((kind) => kind !== "node");
		const runtimeConfigs: RuntimeConfig[] = [];

		if (nonNodeRuntimes.length > 0) {
			// Add blokctl dev script and devDependency for multi-runtime dev server
			packageJsonContent.scripts = {
				...packageJsonContent.scripts,
				dev: "blokctl dev",
			};
			packageJsonContent.devDependencies = {
				...packageJsonContent.devDependencies,
				blokctl: `^${version}`,
			};

			for (const kind of nonNodeRuntimes) {
				const rt = detectedRuntimes.find((r) => r.kind === kind);
				if (!rt) continue;

				try {
					const config = await setupRuntime(rt, GITHUB_REPO_LOCAL, dirPath, s);
					runtimeConfigs.push(config);
				} catch (error) {
					console.log(color.yellow(`\n  Warning: Failed to setup ${rt.label} runtime: ${(error as Error).message}`));
					console.log(color.yellow("  You can set it up manually later.\n"));
				}
			}

			// Write .blok/config.json
			if (runtimeConfigs.length > 0) {
				writeProjectConfig(dirPath, runtimeConfigs);
			}

			// Append runtime env vars to .env.local
			if (runtimeConfigs.length > 0) {
				const envVars = generateRuntimeEnvVars(runtimeConfigs);
				fsExtra.appendFileSync(envLocal, envVars);
			}
		}

		// Examples

		if (examples) {
			packageJsonContent.dependencies = {
				...packageJsonContent.dependencies,
				...package_dependencies,
			};
			packageJsonContent.devDependencies = {
				...packageJsonContent.devDependencies,
				...package_dev_dependencies,
			};
		}

		fsExtra.writeFileSync(packageJson, JSON.stringify(packageJsonContent, null, 2));

		// Create supervisord.conf
		const supervisordConfPath = `${dirPath}/supervisord.conf`;
		let supervisordConfContent = supervisord_nodejs;
		if (runtimeConfigs.length > 0) {
			supervisordConfContent += generateSupervisordConfig(runtimeConfigs);
		}
		fsExtra.writeFileSync(supervisordConfPath, supervisordConfContent);

		// Install Packages
		s.message("Installing packages...");
		const cmd_install_ts_response = await exec(manager.INSTALL, { cwd: dirPath });
		s.message("Packages installed successfully!");
		console.log("\n", cmd_install_ts_response.stdout);

		if (!fsExtra.existsSync(`${dirPath}/node_modules`)) {
			throw new Error("Failed to install packages. Please check your internet connection and try again.");
		}

		// Create a new project
		if (!isDefault) s.stop(`Project "${projectName}" created successfully.`);
		console.log(`\nTrigger: ${trigger.toUpperCase()}`);

		// Show runtime summary
		const installedRuntimes = ["NodeJS", ...runtimeConfigs.map((rc) => rc.label)];
		console.log(`Runtimes: ${installedRuntimes.join(", ")}\n`);

		if (!currentPath) console.log(`Change to the project directory: cd ${projectName}`);
		console.log(`Run the command "npm run dev" to start the development server.`);
		console.log("You can test the project in your browser at http://localhost:4000/health-check");

		// Show runtime health check URLs
		if (runtimeConfigs.length > 0) {
			console.log("\nRuntime health checks:");
			for (const rc of runtimeConfigs) {
				console.log(`  ${rc.label}: http://localhost:${rc.port}/health`);
			}
		}

		console.log("\nFor more documentation, visit https://blok.build/");

		if (examples) {
			console.log(examples_url);
		}
	} catch (error) {
		if (!isDefault) s.stop((error as Error).message);
		if (isDefault) console.log((error as Error).message);
	}
}
