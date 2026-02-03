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
	type TriggerConfig,
	createTriggerConfig,
	generateRuntimeEnvVars,
	generateSupervisordConfig,
	generateTriggerEnvVars,
	generateTriggerSupervisordConfig,
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
} from "./utils/Examples.js";

const exec = util.promisify(child_process.exec);

const HOME_DIR = `${os.homedir()}/.blok`;
const GITHUB_REPO_LOCAL = `${HOME_DIR}/blok`;
const GITHUB_REPO_REMOTE = "https://github.com/well-prado/blok.git";
const GITHUB_REPO_RELEASE_TAG = "v0.2.0";

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
	// Support both --trigger (single, backwards compat) and --triggers (multi)
	let selectedTriggers: string[] = opts.triggers
		? parseCommaSeparated(opts.triggers)
		: opts.trigger
			? [opts.trigger]
			: ["http"];
	let examples: boolean = opts.examples ?? false;
	let selectedRuntimeKinds: string[] = opts.runtimes ? parseCommaSeparated(opts.runtimes) : ["node"];
	let selectedManager: string = opts.packageManager || "npm";
	let pubsubProvider: string = opts.pubsubProvider || "gcp";
	let queueProvider: string = opts.queueProvider || "kafka";

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
				triggers: () =>
					opts.triggers || opts.trigger
						? Promise.resolve(opts.triggers ? parseCommaSeparated(opts.triggers) : [opts.trigger])
						: p.multiselect({
								message: "Select triggers to install",
								options: [
									{ label: "HTTP", value: "http", hint: "REST APIs (port 4000)" },
									{ label: "SSE", value: "sse", hint: "Real-time push (port 4001)" },
									{ label: "Queue", value: "queue", hint: "Kafka/RabbitMQ/SQS/Redis (port 4005)" },
									{ label: "Pub/Sub", value: "pubsub", hint: "GCP/AWS/Azure messaging (port 4006)" },
									//{ label: "GRPC", value: "grpc", hint: "RPC (port 4003)" }
								],
								initialValues: ["http"],
								required: true,
							}),
				pubsubProvider: ({ results }) =>
					opts.pubsubProvider
						? Promise.resolve(opts.pubsubProvider)
						: results.triggers?.includes("pubsub")
							? p.select({
									message: "Select Pub/Sub provider",
									options: [
										{ label: "Google Cloud Pub/Sub", value: "gcp" },
										{ label: "AWS SNS/SQS", value: "aws" },
										{ label: "Azure Service Bus", value: "azure" },
									],
								})
							: Promise.resolve(null),
				queueProvider: ({ results }) =>
					opts.queueProvider
						? Promise.resolve(opts.queueProvider)
						: results.triggers?.includes("queue")
							? p.select({
									message: "Select Queue provider",
									options: [
										{ label: "Apache Kafka", value: "kafka" },
										{ label: "RabbitMQ", value: "rabbitmq" },
										{ label: "AWS SQS", value: "sqs" },
										{ label: "Redis/BullMQ", value: "redis" },
									],
								})
							: Promise.resolve(null),
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
		selectedTriggers = blokctlProject.triggers;
		pubsubProvider = (blokctlProject.pubsubProvider as string) || "gcp";
		queueProvider = (blokctlProject.queueProvider as string) || "kafka";
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

		// Create base project structure
		fsExtra.ensureDirSync(dirPath);
		fsExtra.ensureDirSync(`${dirPath}/src`);
		fsExtra.ensureDirSync(`${dirPath}/src/triggers`);
		fsExtra.ensureDirSync(`${dirPath}/src/nodes`);
		fsExtra.ensureDirSync(`${dirPath}/src/workflows`);

		// Build trigger configs for all selected triggers
		const triggerConfigs: TriggerConfig[] = selectedTriggers.map((kind) => createTriggerConfig(kind));

		// Use the first trigger as the "primary" for base files (package.json, tsconfig, etc.)
		const primaryTrigger = selectedTriggers[0];
		// Pubsub and Queue triggers use template subdirectory
		const primaryTriggerDir =
			primaryTrigger === "pubsub" || primaryTrigger === "queue"
				? `${repoSource}/triggers/${primaryTrigger}/template`
				: `${repoSource}/triggers/${primaryTrigger}`;

		// Copy base config files from primary trigger
		const baseFiles = ["package.json", "tsconfig.json", ".env.example", ".gitignore", "vitest.config.ts"];
		for (const file of baseFiles) {
			const src = `${primaryTriggerDir}/${file}`;
			if (fsExtra.existsSync(src)) {
				fsExtra.copySync(src, `${dirPath}/${file}`);
			}
		}

		// Copy Dockerfiles from primary trigger
		if (fsExtra.existsSync(`${primaryTriggerDir}/Dockerfile`)) {
			fsExtra.copySync(`${primaryTriggerDir}/Dockerfile`, `${dirPath}/Dockerfile`);
		}
		if (fsExtra.existsSync(`${primaryTriggerDir}/Dockerfile.dev`)) {
			fsExtra.copySync(`${primaryTriggerDir}/Dockerfile.dev`, `${dirPath}/Dockerfile.dev`);
		}

		// Copy each trigger's files to src/triggers/{kind}/
		for (const triggerKind of selectedTriggers) {
			const triggerDestDir = `${dirPath}/src/triggers/${triggerKind}`;
			fsExtra.ensureDirSync(triggerDestDir);

			// Pubsub and Queue use template directories
			if (triggerKind === "pubsub" || triggerKind === "queue") {
				const templateDir = `${repoSource}/triggers/${triggerKind}/template/src`;
				if (fsExtra.existsSync(templateDir)) {
					// Copy the entire template src directory
					fsExtra.copySync(templateDir, triggerDestDir);

					// Copy workflows to shared workflows directory
					if (fsExtra.existsSync(`${templateDir}/workflows`)) {
						fsExtra.copySync(`${templateDir}/workflows`, `${dirPath}/src/workflows/${triggerKind}`);
						// Remove from trigger dir (it's now in shared)
						fsExtra.removeSync(`${triggerDestDir}/workflows`);
					}

					// Remove trigger-specific Nodes.ts and Workflows.ts (we use shared ones)
					// The runner imports from ../../../Nodes and ../../../Workflows
					fsExtra.removeSync(`${triggerDestDir}/Nodes.ts`);
					fsExtra.removeSync(`${triggerDestDir}/Workflows.ts`);

					// Update provider-specific adapter
					if (triggerKind === "pubsub") {
						updatePubSubProvider(triggerDestDir, pubsubProvider);
					} else if (triggerKind === "queue") {
						updateQueueProvider(triggerDestDir, queueProvider);
					}
				}
			} else {
				// HTTP and SSE use the regular src directory
				const triggerSrcDir = `${repoSource}/triggers/${triggerKind}/src`;

				// Copy runner folder (contains the trigger server implementation)
				if (fsExtra.existsSync(`${triggerSrcDir}/runner`)) {
					fsExtra.copySync(`${triggerSrcDir}/runner`, `${triggerDestDir}/runner`);
				}

				// Copy AppRoutes.ts
				if (fsExtra.existsSync(`${triggerSrcDir}/AppRoutes.ts`)) {
					fsExtra.copySync(`${triggerSrcDir}/AppRoutes.ts`, `${triggerDestDir}/AppRoutes.ts`);
				}

				// Copy trigger-specific workflow files
				if (fsExtra.existsSync(`${triggerSrcDir}/workflows`)) {
					fsExtra.copySync(`${triggerSrcDir}/workflows`, `${dirPath}/src/workflows/${triggerKind}`);
				}

				// For SSE, also copy the base SSETrigger.ts
				if (triggerKind === "sse" && fsExtra.existsSync(`${triggerSrcDir}/SSETrigger.ts`)) {
					fsExtra.copySync(`${triggerSrcDir}/SSETrigger.ts`, `${triggerDestDir}/SSETrigger.ts`);
				}

				// Copy lib.ts if exists (for SSE package exports)
				if (fsExtra.existsSync(`${triggerSrcDir}/lib.ts`)) {
					fsExtra.copySync(`${triggerSrcDir}/lib.ts`, `${triggerDestDir}/lib.ts`);
				}
			}
		}

		// Fix import paths in copied runner files (they import from ../Nodes, need ../../Nodes)
		for (const triggerKind of selectedTriggers) {
			const triggerDestDir = `${dirPath}/src/triggers/${triggerKind}`;
			fixRunnerImportPaths(triggerDestDir, triggerKind);
		}

		// Replace @blok/ with @blokjs/ in all TypeScript files (for old templates)
		replaceBlokImportsInDirectory(`${dirPath}/src`);

		// Generate shared Nodes.ts by merging from all triggers
		const sharedNodesContent = generateSharedNodesFile(selectedTriggers, repoSource);
		fsExtra.writeFileSync(`${dirPath}/src/Nodes.ts`, sharedNodesContent);

		// Generate shared Workflows.ts
		const sharedWorkflowsContent = generateSharedWorkflowsFile(selectedTriggers);
		fsExtra.writeFileSync(`${dirPath}/src/Workflows.ts`, sharedWorkflowsContent);

		// Generate trigger entry points that import shared nodes/workflows
		for (const triggerKind of selectedTriggers) {
			const entryContent = generateTriggerEntryFile(triggerKind);
			fsExtra.writeFileSync(`${dirPath}/src/triggers/${triggerKind}/index.ts`, entryContent);
		}

		// Copy trigger-specific nodes to shared src/nodes/
		for (const triggerKind of selectedTriggers) {
			const triggerNodesDir = `${repoSource}/triggers/${triggerKind}/src/nodes`;
			if (fsExtra.existsSync(triggerNodesDir)) {
				fsExtra.copySync(triggerNodesDir, `${dirPath}/src/nodes`);
			}
		}

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
			"@blokjs/api-call": "nodes/web/api-call@1.0.0",
			"@blokjs/helper": "core/workflow-helper",
			"@blokjs/if-else": "nodes/control-flow/if-else@1.0.0",
			"@blokjs/runner": "core/runner",
			"@blokjs/shared": "core/shared",
			"@blokjs/trigger-pubsub": "triggers/pubsub",
			"@blokjs/trigger-queue": "triggers/queue",
		};

		for (const depGroup of ["dependencies", "devDependencies", "peerDependencies"]) {
			const deps = packageJsonContent[depGroup];
			if (!deps) continue;

			// Replace @blok/ with @blokjs/ (for old templates)
			for (const pkg of Object.keys(deps)) {
				if (pkg.startsWith("@blok/")) {
					const newPkg = pkg.replace("@blok/", "@blokjs/");
					deps[newPkg] = "^0.2.0";
					delete deps[pkg];
				}
			}

			// Replace workspace:* references
			for (const [pkg, ver] of Object.entries(deps)) {
				if (typeof ver === "string" && ver.startsWith("workspace:")) {
					if (localRepoPath && workspacePackageMap[pkg]) {
						deps[pkg] = `file:${path.resolve(repoSource, workspacePackageMap[pkg])}`;
					} else {
						deps[pkg] = "^0.2.0";
					}
				}
			}
		}

		// When using local repo, add overrides/resolutions so the package manager resolves
		// transitive workspace:* deps (e.g. @blokjs/runner -> @blokjs/shared) via file: links
		if (localRepoPath) {
			const fileLinks: Record<string, string> = {};
			for (const [pkg, relativePath] of Object.entries(workspacePackageMap)) {
				fileLinks[pkg] = `file:${path.resolve(repoSource, relativePath)}`;
			}
			// npm/pnpm use "overrides", yarn/bun use "resolutions"
			packageJsonContent.overrides = fileLinks;
			packageJsonContent.resolutions = fileLinks;
		}

		// Get the package manager
		manager = await pm.getManager(selectedManager as string);

		// Add trigger-specific scripts to package.json
		const triggerScripts: Record<string, string> = {
			dev: "blokctl dev",
		};
		for (const tc of triggerConfigs) {
			triggerScripts[`start:${tc.kind}`] = tc.startCmd;
		}
		packageJsonContent.scripts = {
			...packageJsonContent.scripts,
			...triggerScripts,
		};

		// Add blokctl as devDependency for multi-trigger dev server
		const blokctlRef = localRepoPath ? `file:${path.resolve(repoSource, "packages/cli")}` : `^${version}`;
		packageJsonContent.devDependencies = {
			...packageJsonContent.devDependencies,
			blokctl: blokctlRef,
		};

		// Add provider-specific dependencies for pubsub and queue triggers
		const providerDeps = getProviderDependencies(selectedTriggers, pubsubProvider, queueProvider);
		if (Object.keys(providerDeps).length > 0) {
			packageJsonContent.dependencies = {
				...packageJsonContent.dependencies,
				...providerDeps,
			};
		}

		// Add trigger packages to dependencies (pubsub and queue need their trigger packages)
		const triggerPackageDeps: Record<string, string> = {};
		if (selectedTriggers.includes("pubsub")) {
			triggerPackageDeps["@blokjs/trigger-pubsub"] = localRepoPath
				? `file:${path.resolve(repoSource, "triggers/pubsub")}`
				: "^0.2.0";
		}
		if (selectedTriggers.includes("queue")) {
			triggerPackageDeps["@blokjs/trigger-queue"] = localRepoPath
				? `file:${path.resolve(repoSource, "triggers/queue")}`
				: "^0.2.0";
		}
		if (Object.keys(triggerPackageDeps).length > 0) {
			packageJsonContent.dependencies = {
				...packageJsonContent.dependencies,
				...triggerPackageDeps,
			};
		}

		// Setup non-NodeJS runtimes
		const nonNodeRuntimes = selectedRuntimeKinds.filter((kind) => kind !== "node");
		const runtimeConfigs: RuntimeConfig[] = [];

		if (nonNodeRuntimes.length > 0) {
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

			// Append runtime env vars to .env.local
			if (runtimeConfigs.length > 0) {
				const envVars = generateRuntimeEnvVars(runtimeConfigs);
				fsExtra.appendFileSync(envLocal, envVars);
			}
		}

		// Write .blok/config.json with both triggers and runtimes
		writeProjectConfig(dirPath, runtimeConfigs, triggerConfigs);

		// Append trigger env vars to .env.local
		if (triggerConfigs.length > 0) {
			const triggerEnvVars = generateTriggerEnvVars(triggerConfigs);
			fsExtra.appendFileSync(envLocal, triggerEnvVars);
		}

		// Append provider-specific env vars to .env.local
		const providerEnvVars = getProviderEnvVars(selectedTriggers, pubsubProvider, queueProvider);
		if (providerEnvVars) {
			fsExtra.appendFileSync(envLocal, providerEnvVars);
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

		// Create supervisord.conf with triggers and runtimes
		const supervisordConfPath = `${dirPath}/supervisord.conf`;
		let supervisordConfContent = "[supervisord]\nnodaemon=true\n";
		// Add trigger programs
		if (triggerConfigs.length > 0) {
			supervisordConfContent += generateTriggerSupervisordConfig(triggerConfigs);
		}
		// Add runtime programs
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

		// Show trigger summary
		const triggerNames = triggerConfigs.map((tc) => tc.label).join(", ");
		console.log(`\nTriggers: ${triggerNames}`);

		// Show runtime summary
		const installedRuntimes = ["NodeJS", ...runtimeConfigs.map((rc) => rc.label)];
		console.log(`Runtimes: ${installedRuntimes.join(", ")}\n`);

		if (!currentPath) console.log(`Change to the project directory: cd ${projectName}`);
		console.log(`Run the command "npm run dev" to start the development server.`);

		// Show trigger health check URLs
		console.log("\nTrigger endpoints:");
		for (const tc of triggerConfigs) {
			console.log(`  ${tc.label}: http://localhost:${tc.port}/health-check`);
		}

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

// ============================================================================
// Helper Functions for Multi-Trigger Project Generation
// ============================================================================

/**
 * Generate shared Nodes.ts that combines nodes from all selected triggers.
 */
function generateSharedNodesFile(triggers: string[], _repoSource: string): string {
	// Collect unique node imports from all triggers
	const nodeImports: Set<string> = new Set();
	const nodeExports: Map<string, string> = new Map();

	// Always include core nodes
	nodeImports.add('import ApiCall from "@blokjs/api-call";');
	nodeImports.add('import IfElse from "@blokjs/if-else";');
	nodeImports.add('import type { BlokService } from "@blokjs/runner";');
	nodeExports.set("@blokjs/api-call", "ApiCall");
	nodeExports.set("@blokjs/if-else", "IfElse");

	// Add trigger-specific nodes
	for (const trigger of triggers) {
		if (trigger === "sse") {
			nodeImports.add('import WelcomeMessage from "./nodes/welcome-message/index";');
			nodeExports.set("welcome-message", "WelcomeMessage");
		}
		// Add more trigger-specific nodes here as triggers are added
	}

	const importLines = Array.from(nodeImports).join("\n");
	const exportEntries = Array.from(nodeExports.entries())
		.map(([key, value]) => `\t"${key}": ${value},`)
		.join("\n");

	return `${importLines}

const nodes: Record<string, BlokService<unknown>> = {
${exportEntries}
};

export default nodes;
`;
}

/**
 * Generate shared Workflows.ts that imports workflows from all trigger directories.
 */
function generateSharedWorkflowsFile(triggers: string[]): string {
	const imports: string[] = [];
	const workflowEntries: string[] = [];

	for (const trigger of triggers) {
		if (trigger === "http") {
			// HTTP trigger typically has example workflows
			imports.push("// Import HTTP workflows here");
		} else if (trigger === "sse") {
			imports.push('import OnConnect from "./workflows/sse/notifications/on-connect";');
			imports.push('import OnSubscribe from "./workflows/sse/notifications/on-subscribe";');
			workflowEntries.push('\t"on-connect": OnConnect,');
			workflowEntries.push('\t"on-subscribe": OnSubscribe,');
		} else if (trigger === "pubsub") {
			imports.push('import OnPubSubMessage from "./workflows/pubsub/messages/on-message";');
			workflowEntries.push('\t"on-pubsub-message": OnPubSubMessage,');
		} else if (trigger === "queue") {
			imports.push('import OnQueueMessage from "./workflows/queue/messages/on-message";');
			workflowEntries.push('\t"on-queue-message": OnQueueMessage,');
		}
	}

	const importSection = imports.length > 0 ? `${imports.join("\n")}\n` : "";
	const entriesSection = workflowEntries.length > 0 ? workflowEntries.join("\n") : "\t// Add your workflows here";

	return `import type { HelperResponse } from "@blokjs/helper";

${importSection}
const workflows: Record<string, HelperResponse> = {
${entriesSection}
};

export default workflows;
`;
}

/**
 * Generate trigger entry point that imports shared nodes/workflows.
 * Matches the pattern of the original trigger index.ts files.
 */
function generateTriggerEntryFile(triggerKind: string): string {
	if (triggerKind === "http") {
		return `import { DefaultLogger } from "@blokjs/runner";
import { type Span, metrics, trace } from "@opentelemetry/api";
import HttpTrigger from "./runner/HttpTrigger";

export default class App {
	private httpTrigger: HttpTrigger = <HttpTrigger>{};
	protected trigger_initializer = 0;
	protected initializer = 0;
	protected tracer = trace.getTracer(
		process.env.PROJECT_NAME || "trigger-http-server",
		process.env.PROJECT_VERSION || "0.0.1",
	);
	private logger = new DefaultLogger();
	protected app_cold_start = metrics.getMeter("default").createGauge("initialization", {
		description: "Application cold start",
	});

	constructor() {
		this.initializer = performance.now();
		this.httpTrigger = new HttpTrigger();
	}

	async run() {
		this.tracer.startActiveSpan("initialization", async (span: Span) => {
			await this.httpTrigger.listen();
			this.initializer = performance.now() - this.initializer;

			this.logger.log(\`Server initialized in \${(this.initializer).toFixed(2)}ms\`);
			this.app_cold_start.record(this.initializer, {
				pid: process.pid,
				env: process.env.NODE_ENV,
				app: process.env.APP_NAME,
			});
			span.end();
		});
	}

	getHttpApp() {
		return this.httpTrigger.getApp();
	}
}

if (process.env.DISABLE_TRIGGER_RUN !== "true") {
	new App().run();
}
`;
	}

	if (triggerKind === "sse") {
		return `import { DefaultLogger } from "@blokjs/runner";
import { type Span, metrics, trace } from "@opentelemetry/api";
import SSEServer from "./runner/SSEServer";

export default class App {
	private sseServer: SSEServer = <SSEServer>{};
	protected trigger_initializer = 0;
	protected initializer = 0;
	protected tracer = trace.getTracer(
		process.env.PROJECT_NAME || "trigger-sse-server",
		process.env.PROJECT_VERSION || "0.0.1",
	);
	private logger = new DefaultLogger();
	protected app_cold_start = metrics.getMeter("default").createGauge("initialization", {
		description: "Application cold start",
	});

	constructor() {
		this.initializer = performance.now();
		this.sseServer = new SSEServer();
	}

	async run() {
		this.tracer.startActiveSpan("initialization", async (span: Span) => {
			await this.sseServer.listen();
			this.initializer = performance.now() - this.initializer;

			this.logger.log(\`Server initialized in \${(this.initializer).toFixed(2)}ms\`);
			this.app_cold_start.record(this.initializer, {
				pid: process.pid,
				env: process.env.NODE_ENV,
				app: process.env.APP_NAME,
			});
			span.end();
		});
	}

	getApp() {
		return this.sseServer.getApp();
	}
}

 {
	new App().run();
}
`;
	}

	if (triggerKind === "pubsub") {
		return `import { DefaultLogger } from "@blokjs/runner";
import { type Span, metrics, trace } from "@opentelemetry/api";
import PubSubServer from "./runner/PubSubServer";

export default class App {
	private pubsubServer: PubSubServer = <PubSubServer>{};
	protected trigger_initializer = 0;
	protected initializer = 0;
	protected tracer = trace.getTracer(
		process.env.PROJECT_NAME || "trigger-pubsub-server",
		process.env.PROJECT_VERSION || "0.0.1",
	);
	private logger = new DefaultLogger();
	protected app_cold_start = metrics.getMeter("default").createGauge("initialization", {
		description: "Application cold start",
	});

	constructor() {
		this.initializer = performance.now();
		this.pubsubServer = new PubSubServer();
	}

	async run() {
		this.tracer.startActiveSpan("initialization", async (span: Span) => {
			await this.pubsubServer.listen();
			this.initializer = performance.now() - this.initializer;

			this.logger.log(\`Pub/Sub trigger initialized in \${(this.initializer).toFixed(2)}ms\`);
			this.app_cold_start.record(this.initializer, {
				pid: process.pid,
				env: process.env.NODE_ENV,
				app: process.env.APP_NAME,
			});
			span.end();
		});
	}
}

if (process.env.DISABLE_TRIGGER_RUN !== "true") {
	new App().run();
}
`;
	}

	if (triggerKind === "queue") {
		return `import { DefaultLogger } from "@blokjs/runner";
import { type Span, metrics, trace } from "@opentelemetry/api";
import QueueServer from "./runner/QueueServer";

export default class App {
	private queueServer: QueueServer = <QueueServer>{};
	protected trigger_initializer = 0;
	protected initializer = 0;
	protected tracer = trace.getTracer(
		process.env.PROJECT_NAME || "trigger-queue-server",
		process.env.PROJECT_VERSION || "0.0.1",
	);
	private logger = new DefaultLogger();
	protected app_cold_start = metrics.getMeter("default").createGauge("initialization", {
		description: "Application cold start",
	});

	constructor() {
		this.initializer = performance.now();
		this.queueServer = new QueueServer();
	}

	async run() {
		this.tracer.startActiveSpan("initialization", async (span: Span) => {
			await this.queueServer.listen();
			this.initializer = performance.now() - this.initializer;

			this.logger.log(\`Queue trigger initialized in \${(this.initializer).toFixed(2)}ms\`);
			this.app_cold_start.record(this.initializer, {
				pid: process.pid,
				env: process.env.NODE_ENV,
				app: process.env.APP_NAME,
			});
			span.end();
		});
	}
}

if (process.env.DISABLE_TRIGGER_RUN !== "true") {
	new App().run();
}
`;
	}

	// Generic fallback for other triggers
	return `// Entry point for ${triggerKind} trigger
// Implement trigger-specific initialization here
console.log("${triggerKind} trigger not yet implemented");
`;
}

/**
 * Recursively replace @blok/ with @blokjs/ in all TypeScript files.
 * This handles old templates that still use the @blok/ package scope.
 */
function replaceBlokImportsInDirectory(dirPath: string): void {
	const files = fsExtra.readdirSync(dirPath, { withFileTypes: true });

	for (const file of files) {
		const fullPath = path.join(dirPath, file.name);

		if (file.isDirectory()) {
			// Skip node_modules and .blok directories
			if (file.name !== "node_modules" && file.name !== ".blok") {
				replaceBlokImportsInDirectory(fullPath);
			}
		} else if (file.name.endsWith(".ts") || file.name.endsWith(".tsx")) {
			let content = fsExtra.readFileSync(fullPath, "utf8");

			// Replace @blok/ with @blokjs/ in imports
			if (content.includes("@blok/")) {
				content = content.replace(/@blok\//g, "@blokjs/");
				fsExtra.writeFileSync(fullPath, content);
			}
		}
	}
}

/**
 * Fix import paths in runner files after copying to src/triggers/{kind}/.
 * The original files import from "../Nodes" but in the new structure
 * we need "../../../Nodes" (going up from src/triggers/http/runner/ to src/).
 * Path: runner/ -> http/ -> triggers/ -> src/
 */
function fixRunnerImportPaths(triggerDestDir: string, triggerKind: string): void {
	// Files that need path fixes
	const filesToFix: string[] = [];

	if (triggerKind === "http") {
		filesToFix.push(`${triggerDestDir}/runner/HttpTrigger.ts`);
	} else if (triggerKind === "sse") {
		filesToFix.push(`${triggerDestDir}/runner/SSEServer.ts`);
	} else if (triggerKind === "pubsub") {
		filesToFix.push(`${triggerDestDir}/runner/PubSubServer.ts`);
	} else if (triggerKind === "queue") {
		filesToFix.push(`${triggerDestDir}/runner/QueueServer.ts`);
	}

	for (const filePath of filesToFix) {
		if (!fsExtra.existsSync(filePath)) continue;

		let content = fsExtra.readFileSync(filePath, "utf8");

		// Replace imports from "../Nodes" and "../Workflows" with "../../../Nodes" and "../../../Workflows"
		// Path: src/triggers/http/runner/ -> ../../../ = src/
		content = content.replace(/from ["']\.\.\/Nodes["']/g, 'from "../../../Nodes"');
		content = content.replace(/from ["']\.\.\/Workflows["']/g, 'from "../../../Workflows"');

		fsExtra.writeFileSync(filePath, content);
	}
}

/**
 * Update Pub/Sub trigger to use the selected provider adapter.
 */
function updatePubSubProvider(triggerDestDir: string, provider: string): void {
	const serverPath = `${triggerDestDir}/runner/PubSubServer.ts`;
	if (!fsExtra.existsSync(serverPath)) return;

	let content = fsExtra.readFileSync(serverPath, "utf8");

	const adapterConfigs: Record<string, { importName: string; init: string }> = {
		gcp: {
			importName: "GCPPubSubAdapter",
			init: `new GCPPubSubAdapter({
		projectId: process.env.GCP_PROJECT_ID || "my-project",
	})`,
		},
		aws: {
			importName: "AWSSNSAdapter",
			init: `new AWSSNSAdapter({
		region: process.env.AWS_REGION || "us-east-1",
	})`,
		},
		azure: {
			importName: "AzureServiceBusAdapter",
			init: `new AzureServiceBusAdapter({
		connectionString: process.env.AZURE_SERVICE_BUS_CONNECTION_STRING || "",
	})`,
		},
	};

	const config = adapterConfigs[provider];
	if (!config) return;

	// Replace import
	content = content.replace(
		/import \{ PubSubTrigger, \w+ \} from "@blok\/trigger-pubsub";/,
		`import { PubSubTrigger, ${config.importName} } from "@blokjs/trigger-pubsub";`,
	);

	// Replace adapter instantiation (match only actual class property, not JSDoc examples)
	// Look for the pattern inside the class body (starts with tab for indentation)
	content = content.replace(
		/(export default class \w+ extends PubSubTrigger \{[\s\S]*?)\n\tprotected adapter = new \w+\(\{[\s\S]*?\}\);/,
		`$1\n\tprotected adapter = ${config.init};`,
	);

	fsExtra.writeFileSync(serverPath, content);
}

/**
 * Update Queue trigger to use the selected provider adapter.
 */
function updateQueueProvider(triggerDestDir: string, provider: string): void {
	const serverPath = `${triggerDestDir}/runner/QueueServer.ts`;
	if (!fsExtra.existsSync(serverPath)) return;

	let content = fsExtra.readFileSync(serverPath, "utf8");

	const adapterConfigs: Record<string, { importName: string; init: string }> = {
		kafka: {
			importName: "KafkaAdapter",
			init: `new KafkaAdapter({
		brokers: (process.env.KAFKA_BROKERS || "localhost:9092").split(","),
		clientId: process.env.KAFKA_CLIENT_ID || "blok-queue-trigger",
	})`,
		},
		rabbitmq: {
			importName: "RabbitMQAdapter",
			init: `new RabbitMQAdapter({
		url: process.env.RABBITMQ_URL || "amqp://localhost",
	})`,
		},
		sqs: {
			importName: "SQSAdapter",
			init: `new SQSAdapter({
		region: process.env.AWS_REGION || "us-east-1",
	})`,
		},
		redis: {
			importName: "RedisAdapter",
			init: `new RedisAdapter({
		host: process.env.REDIS_HOST || "localhost",
		port: Number(process.env.REDIS_PORT) || 6379,
	})`,
		},
	};

	const config = adapterConfigs[provider];
	if (!config) return;

	// Replace import
	content = content.replace(
		/import \{ QueueTrigger, \w+ \} from "@blok\/trigger-queue";/,
		`import { QueueTrigger, ${config.importName} } from "@blokjs/trigger-queue";`,
	);

	// Replace adapter instantiation (match only actual class property, not JSDoc examples)
	// Look for the pattern inside the class body (starts with tab for indentation)
	content = content.replace(
		/(export default class \w+ extends QueueTrigger \{[\s\S]*?)\n\tprotected adapter = new \w+\(\{[\s\S]*?\}\);/,
		`$1\n\tprotected adapter = ${config.init};`,
	);

	fsExtra.writeFileSync(serverPath, content);
}

/**
 * Get provider-specific dependencies for pubsub and queue triggers.
 */
function getProviderDependencies(
	triggers: string[],
	pubsubProvider: string,
	queueProvider: string,
): Record<string, string> {
	const deps: Record<string, string> = {};

	const pubsubProviderDeps: Record<string, Record<string, string>> = {
		gcp: { "@google-cloud/pubsub": "^4.0.0" },
		aws: { "@aws-sdk/client-sns": "^3.980.0", "@aws-sdk/client-sqs": "^3.980.0" },
		azure: { "@azure/service-bus": "^7.9.5" },
	};

	const queueProviderDeps: Record<string, Record<string, string>> = {
		kafka: { kafkajs: "^2.2.4" },
		rabbitmq: { amqplib: "^0.10.9" },
		sqs: { "@aws-sdk/client-sqs": "^3.980.0" },
		redis: { ioredis: "^5.9.2", bullmq: "^5.67.2" },
	};

	if (triggers.includes("pubsub") && pubsubProviderDeps[pubsubProvider]) {
		Object.assign(deps, pubsubProviderDeps[pubsubProvider]);
	}

	if (triggers.includes("queue") && queueProviderDeps[queueProvider]) {
		Object.assign(deps, queueProviderDeps[queueProvider]);
	}

	return deps;
}

/**
 * Get provider-specific environment variables for pubsub and queue triggers.
 */
function getProviderEnvVars(triggers: string[], pubsubProvider: string, queueProvider: string): string {
	const lines: string[] = [];

	const pubsubEnvVars: Record<string, string> = {
		gcp: `
# Google Cloud Pub/Sub
GCP_PROJECT_ID=my-project
GOOGLE_APPLICATION_CREDENTIALS=./credentials.json`,
		aws: `
# AWS SNS/SQS
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=`,
		azure: `
# Azure Service Bus
AZURE_SERVICE_BUS_CONNECTION_STRING=`,
	};

	const queueEnvVars: Record<string, string> = {
		kafka: `
# Apache Kafka
KAFKA_BROKERS=localhost:9092
KAFKA_CLIENT_ID=blok-queue-trigger
KAFKA_GROUP_ID=blok-consumer-group`,
		rabbitmq: `
# RabbitMQ
RABBITMQ_URL=amqp://localhost`,
		sqs: `
# AWS SQS
AWS_REGION=us-east-1
SQS_QUEUE_URL=`,
		redis: `
# Redis/BullMQ
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=`,
	};

	if (triggers.includes("pubsub") && pubsubEnvVars[pubsubProvider]) {
		lines.push(pubsubEnvVars[pubsubProvider]);
	}

	if (triggers.includes("queue") && queueEnvVars[queueProvider]) {
		lines.push(queueEnvVars[queueProvider]);
	}

	return lines.join("\n");
}
