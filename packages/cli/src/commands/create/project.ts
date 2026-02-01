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
import { isNonInteractive, parseCommaSeparated, resolveOrThrow } from "../../services/non-interactive.js";
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
	agents_md,
	claude_md,
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
const GITHUB_REPO_RELEASE_TAG = "v0.0.1-beta.5";

fsExtra.ensureDirSync(HOME_DIR);
const options: Partial<SimpleGitOptions> = {
	baseDir: HOME_DIR,
	binary: "git",
	maxConcurrentProcesses: 6,
	trimmed: false,
};

const git: SimpleGit = simpleGit(options);

export async function createProject(opts: OptionValues, version: string, currentPath = false, localRepoPath?: string) {
	const availableManagers = await pm.getAvailableManagers();
	let manager = await pm.getManager();
	const nonInteractive = isNonInteractive();
	const isDefault = opts.name !== undefined;
	const skipPrompts = isDefault || nonInteractive;

	// Initialize from flags or defaults
	let projectName: string = opts.name ? opts.name : "";
	let trigger: string = opts.trigger || "http";
	let examples: boolean = opts.examples ?? false;
	let selectedRuntimeKinds: string[] = opts.runtimes ? parseCommaSeparated(opts.runtimes) : ["node"];
	let selectedManager: string = opts.packageManager || "npm";

	// Detect available runtimes on the machine
	let detectedRuntimes: RuntimeInfo[] = [];

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
			if (opts.packageManager) {
				return opts.packageManager;
			}
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
					opts.trigger
						? Promise.resolve(opts.trigger)
						: p.select({
								message: "Select the trigger to install",
								options: [
									{ label: "HTTP", value: "http", hint: "recommended" },
									//{ label: "GRPC", value: "grpc" }
								],
							}),
				runtimes: () =>
					opts.runtimes
						? Promise.resolve(parseCommaSeparated(opts.runtimes))
						: p.multiselect({
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
					opts.examples !== undefined
						? Promise.resolve(opts.examples)
						: p.select({
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
	} else if (nonInteractive) {
		// Validate required fields in non-interactive mode
		projectName = resolveOrThrow("name", opts.name);

		// Detect runtimes if non-node runtimes requested
		if (selectedRuntimeKinds.some((k) => k !== "node")) {
			detectedRuntimes = await detectRuntimes();
		}
	}

	const s = p.spinner();
	if (!skipPrompts) s.start("Creating the project...");

	try {
		// Prepare the project
		const dirPath = !currentPath ? path.join(process.cwd(), projectName) : process.cwd();

		if (!skipPrompts) s.message("Gathering project files");

		// Determine the repo source: local path or cloned remote
		const repoSource = localRepoPath ? path.resolve(localRepoPath) : GITHUB_REPO_LOCAL;

		if (localRepoPath) {
			if (!fsExtra.existsSync(repoSource)) {
				throw new Error(`Local repo path not found: ${repoSource}`);
			}
			console.log(color.dim(`  Using local repo: ${repoSource}`));
		} else {
			const githubLocalExists = fsExtra.existsSync(GITHUB_REPO_LOCAL);
			if (githubLocalExists) {
				fsExtra.removeSync(GITHUB_REPO_LOCAL);
			}
			if (GITHUB_REPO_RELEASE_TAG) {
				await git.clone(GITHUB_REPO_REMOTE, GITHUB_REPO_LOCAL, ["--branch", GITHUB_REPO_RELEASE_TAG, "--depth", "1"]);
			} else {
				await git.clone(GITHUB_REPO_REMOTE, GITHUB_REPO_LOCAL);
			}
		}

		if (!skipPrompts) s.message("Copying project files...");

		/// Copy the project files
		if (!currentPath) {
			const projectDirExists = fsExtra.existsSync(dirPath);
			if (projectDirExists) {
				throw new Error("A project already exists in the current directory. Please remove it and try again.");
			}
		}

		fsExtra.copySync(`${repoSource}/triggers/${trigger}`, dirPath);

		if (!skipPrompts) {
			s.message("Installing example workflows and nodes");
		}
		const nodesDir = `${dirPath}/src/nodes`;
		const workflowsDir = `${dirPath}/workflows`;

		fsExtra.ensureDirSync(nodesDir);
		fsExtra.copySync(`${repoSource}/workflows`, workflowsDir);

		// Add permissions to the directory
		try {
			fsExtra.chownSync(dirPath, os.userInfo().uid, os.userInfo().gid);
		} catch (error) {
			console.error(`Failed to change ownership of directory ${dirPath}:`, error);
		}

		// Infra

		fsExtra.ensureDirSync(`${dirPath}/infra`);
		fsExtra.ensureDirSync(`${dirPath}/infra/metrics`);
		fsExtra.copySync(`${repoSource}/infra/metrics`, `${dirPath}/infra/metrics`);
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

			fsExtra.copySync(`${repoSource}/infra/development`, `${dirPath}/infra/postgresql`);
			fsExtra.copySync(`${repoSource}/infra/milvus`, `${dirPath}/infra/milvus`);

			fsExtra.writeFileSync(`${dirPath}/src/Nodes.ts`, node_file);
			fsExtra.copySync(`${repoSource}/sdk`, `${dirPath}/public/sdk`);
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

		// Replace workspace:* references that only work inside the monorepo
		const workspacePackageMap: Record<string, string> = {
			"@blok/api-call": "nodes/web/api-call@1.0.0",
			"@blok/helper": "core/workflow-helper",
			"@blok/if-else": "nodes/control-flow/if-else@1.0.0",
			"@blok/runner": "core/runner",
			"@blok/shared": "core/shared",
		};

		for (const depGroup of ["dependencies", "devDependencies", "peerDependencies"]) {
			const deps = packageJsonContent[depGroup];
			if (!deps) continue;
			for (const [pkg, ver] of Object.entries(deps)) {
				if (typeof ver === "string" && ver.startsWith("workspace:")) {
					if (localRepoPath && workspacePackageMap[pkg]) {
						deps[pkg] = `file:${path.resolve(repoSource, workspacePackageMap[pkg])}`;
					} else {
						deps[pkg] = "^0.1.0";
					}
				}
			}
		}

		// When using local repo, add overrides so the package manager resolves
		// transitive workspace:* deps (e.g. @blok/runner -> @blok/shared) via file: links
		if (localRepoPath) {
			const overrides: Record<string, string> = {};
			for (const [pkg, relativePath] of Object.entries(workspacePackageMap)) {
				overrides[pkg] = `file:${path.resolve(repoSource, relativePath)}`;
			}
			packageJsonContent.overrides = overrides;
		}

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
			const blokctlRef = localRepoPath ? `file:${path.resolve(repoSource, "packages/cli")}` : `^${version}`;
			packageJsonContent.devDependencies = {
				...packageJsonContent.devDependencies,
				blokctl: blokctlRef,
			};

			for (const kind of nonNodeRuntimes) {
				const rt = detectedRuntimes.find((r) => r.kind === kind);
				if (!rt) continue;

				try {
					const config = await setupRuntime(rt, repoSource, dirPath, s);
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

		// Create AI context files (AGENTS.md and CLAUDE.md)
		fsExtra.writeFileSync(`${dirPath}/AGENTS.md`, agents_md.trimStart());
		fsExtra.writeFileSync(`${dirPath}/CLAUDE.md`, claude_md.trimStart());

		// Install Packages
		s.message("Installing packages...");
		const cmd_install_ts_response = await exec(manager.INSTALL, { cwd: dirPath });
		s.message("Packages installed successfully!");
		console.log("\n", cmd_install_ts_response.stdout);

		if (!fsExtra.existsSync(`${dirPath}/node_modules`)) {
			throw new Error("Failed to install packages. Please check your internet connection and try again.");
		}

		// Create a new project
		if (!skipPrompts) s.stop(`Project "${projectName}" created successfully.`);
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
		if (!skipPrompts) s.stop((error as Error).message);
		if (skipPrompts) console.log((error as Error).message);
	}
}
