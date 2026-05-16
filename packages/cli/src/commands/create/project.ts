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
import { computeDefaultConstraint } from "../../services/semver-utils.js";
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
const GITHUB_REPO_RELEASE_TAG = "v0.6.5";

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

		// Build runtime options with detection hints and version pin info
		const runtimeOptions = [
			{ label: "NodeJS", value: "node", hint: "always included" },
			...detectedRuntimes.map((rt) => {
				let hint: string;
				if (rt.available && rt.version) {
					const constraint = computeDefaultConstraint(rt.version);
					hint = `${rt.toolchain} ${rt.version} detected (will pin ${constraint})`;
				} else if (rt.available) {
					hint = `${rt.toolchain} detected`;
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
										{ label: "NATS JetStream", value: "nats" },
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
				? `${repoSource}/triggers/${primaryTrigger === "queue" ? "worker" : primaryTrigger}/template`
				: `${repoSource}/triggers/${primaryTrigger}`;

		// Copy base config files from primary trigger
		const baseFiles = ["package.json", "tsconfig.json", ".env.example", ".gitignore", "vitest.config.ts"];
		for (const file of baseFiles) {
			const src = `${primaryTriggerDir}/${file}`;
			if (fsExtra.existsSync(src)) {
				fsExtra.copySync(src, `${dirPath}/${file}`);
			}
		}

		// `.blok/` houses the SQLite trace database that ships with
		// `blokctl dev` (Prisma-Studio-style: `blokctl studio` opens
		// against this file standalone, no trigger required). Append the
		// directory to .gitignore so users don't accidentally commit
		// trace data, and write a README so they know what's here.
		const gitignorePath = `${dirPath}/.gitignore`;
		const gitignoreLine = "\n# Blok Studio trace data (managed by blokctl)\n.blok/\n";
		if (fsExtra.existsSync(gitignorePath)) {
			const existing = fsExtra.readFileSync(gitignorePath, "utf8");
			if (!existing.includes(".blok/")) {
				fsExtra.appendFileSync(gitignorePath, gitignoreLine);
			}
		} else {
			fsExtra.writeFileSync(gitignorePath, gitignoreLine.trimStart());
		}
		fsExtra.ensureDirSync(`${dirPath}/.blok`);
		fsExtra.writeFileSync(
			`${dirPath}/.blok/README.md`,
			[
				"# .blok/",
				"",
				"Auto-generated by `blokctl dev`. This directory holds the SQLite trace",
				"database that powers Blok Studio (run history, logs, events, dashboards).",
				"",
				"- `trace.db` — SQLite file, persists across restarts",
				"- 7-day retention by default; tune with `BLOK_TRACE_RETENTION_DAYS`",
				"",
				"Open it visually with `blokctl studio` (no trigger required — works",
				"like `prisma studio`). Or wipe everything via the **Clear all data**",
				"button in Settings.",
				"",
				"This directory is gitignored.",
				"",
			].join("\n"),
		);

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

			// Pubsub and Queue use template directories. The "queue" CLI
			// flag scaffolds the trigger-worker template — the monorepo dir
			// is `triggers/worker/` and the npm package is
			// `@blokjs/trigger-worker`. Pre-v0.6.3 the path resolution
			// looked at `triggers/queue/template/` which doesn't exist; the
			// scaffold silently no-op'd on the file copy and the user got
			// an empty `src/triggers/queue/` directory.
			if (triggerKind === "pubsub" || triggerKind === "queue") {
				const templatePkgDir = triggerKind === "queue" ? "worker" : triggerKind;
				const templateDir = `${repoSource}/triggers/${templatePkgDir}/template/src`;
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
				// HTTP and SSE use the regular src directory.
				const triggerSrcDir = `${repoSource}/triggers/${triggerKind}/src`;

				if (triggerKind === "sse") {
					// SSE has a flat layout — every .ts at the package root is
					// part of the trigger surface (SSETrigger.ts + bus.ts + lib.ts
					// + future siblings). Pre-v0.6.3 cherry-picking left bus.ts
					// behind which broke `import { getBus } from "./bus"` inside
					// SSETrigger. Whole-dir copy + filter out tests is cleaner +
					// future-proof.
					const entries = fsExtra.readdirSync(triggerSrcDir, { withFileTypes: true });
					for (const entry of entries) {
						const src = `${triggerSrcDir}/${entry.name}`;
						if (entry.isFile()) {
							if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".integration.test.ts")) {
								continue;
							}
							fsExtra.copySync(src, `${triggerDestDir}/${entry.name}`);
						} else if (entry.isDirectory()) {
							if (entry.name === "__tests__") continue;
							if (entry.name === "workflows") {
								fsExtra.copySync(src, `${dirPath}/src/workflows/${triggerKind}`);
							} else {
								fsExtra.copySync(src, `${triggerDestDir}/${entry.name}`);
							}
						}
					}
				} else {
					// HTTP: cherry-pick the established files. The HTTP scaffold
					// has been the most-validated path since v0.4 — keep its
					// copy strategy stable.
					if (fsExtra.existsSync(`${triggerSrcDir}/runner`)) {
						fsExtra.copySync(`${triggerSrcDir}/runner`, `${triggerDestDir}/runner`);
					}
					if (fsExtra.existsSync(`${triggerSrcDir}/AppRoutes.ts`)) {
						fsExtra.copySync(`${triggerSrcDir}/AppRoutes.ts`, `${triggerDestDir}/AppRoutes.ts`);
					}
					if (fsExtra.existsSync(`${triggerSrcDir}/workflows`)) {
						fsExtra.copySync(`${triggerSrcDir}/workflows`, `${dirPath}/src/workflows/${triggerKind}`);
					}
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

		// SSE scaffold needs an SSEServer wrapper that creates a Hono app,
		// passes it to SSETrigger's constructor, registers nodes/workflows,
		// and binds an HTTP listener. Pre-v0.6.5 the SSE entry called
		// `new SSETrigger()` with no args (broken — constructor requires
		// `app: Hono`) and didn't bind a listener, so SSE trigger never
		// actually served traffic. Generated here so it inherits the
		// scaffold's import-path conventions.
		if (selectedTriggers.includes("sse")) {
			const sseServerDir = `${dirPath}/src/triggers/sse/runner`;
			fsExtra.ensureDirSync(sseServerDir);
			fsExtra.writeFileSync(`${sseServerDir}/SSEServer.ts`, generateSSEServerFile());
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

		// Copy development infra (docker-compose with Redis/NATS) if queue trigger is selected
		if (selectedTriggers.includes("queue")) {
			fsExtra.ensureDirSync(`${dirPath}/infra/development`);
			fsExtra.copySync(`${repoSource}/infra/development`, `${dirPath}/infra/development`);
		}

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
		// v0.6.5: expanded to include EVERY publishable @blokjs/* package so
		// the `--local` install path doesn't fall back to npm for any of
		// them. Pre-v0.6.5 this map omitted @blokjs/helpers + @blokjs/react
		// + the trigger-webhook / trigger-websocket / trigger-cron /
		// trigger-grpc / trigger-sse packages, so scaffolds against `--local`
		// silently let those resolve to whatever was on the registry.
		// Worked while versions were already published; broke during pre-
		// release validation when the registry didn't yet have the new
		// version.
		const workspacePackageMap: Record<string, string> = {
			"@blokjs/api-call": "nodes/web/api-call@1.0.0",
			"@blokjs/helper": "core/workflow-helper",
			"@blokjs/helpers": "nodes/utility/helpers@1.0.0",
			"@blokjs/if-else": "nodes/control-flow/if-else@1.0.0",
			"@blokjs/react": "nodes/web/react@1.0.0",
			"@blokjs/runner": "core/runner",
			"@blokjs/shared": "core/shared",
			"@blokjs/trigger-cron": "triggers/cron",
			"@blokjs/trigger-grpc": "triggers/grpc",
			"@blokjs/trigger-pubsub": "triggers/pubsub",
			"@blokjs/trigger-sse": "triggers/sse",
			"@blokjs/trigger-webhook": "triggers/webhook",
			"@blokjs/trigger-websocket": "triggers/websocket",
			// "queue" CLI flag scaffolds the trigger-worker package
			// (the monorepo directory + npm package). Pre-v0.6.3 the
			// workspacePackageMap pointed at `@blokjs/trigger-queue` +
			// `triggers/queue/`, neither of which exists in this repo.
			"@blokjs/trigger-worker": "triggers/worker",
		};

		// The version range scaffolded projects pin @blokjs/* deps at.
		// Bumped alongside major framework releases (0.4 was the
		// explicit-path-only routing release; 0.5 will drop the
		// BLOK_ROUTING_LEGACY escape hatch).
		const BLOKJS_DEP_RANGE = "^0.6.5";

		for (const depGroup of ["dependencies", "devDependencies", "peerDependencies"]) {
			const deps = packageJsonContent[depGroup];
			if (!deps) continue;

			// Replace @blok/ with @blokjs/ (for old templates)
			for (const pkg of Object.keys(deps)) {
				if (pkg.startsWith("@blok/")) {
					const newPkg = pkg.replace("@blok/", "@blokjs/");
					deps[newPkg] = BLOKJS_DEP_RANGE;
					delete deps[pkg];
				}
			}

			// Replace workspace:* references
			for (const [pkg, ver] of Object.entries(deps)) {
				if (typeof ver === "string" && ver.startsWith("workspace:")) {
					if (localRepoPath && workspacePackageMap[pkg]) {
						deps[pkg] = `file:${path.resolve(repoSource, workspacePackageMap[pkg])}`;
					} else {
						deps[pkg] = BLOKJS_DEP_RANGE;
					}
				}
				// Pre-existing range references — bump if they're below the
				// current floor so the scaffold's `npm install` resolves to
				// the v0.4 surface rather than the stale 0.2.x line.
				else if (
					typeof ver === "string" &&
					(ver === "^0.2.0" ||
						ver === "^0.2" ||
						ver === "0.2.0" ||
						ver.startsWith("^0.2.") ||
						ver.startsWith("0.2.")) &&
					(pkg.startsWith("@blokjs/") || pkg === "blokctl")
				) {
					deps[pkg] = BLOKJS_DEP_RANGE;
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

		// Add trigger packages to dependencies (pubsub and queue need their trigger packages).
		// Pin to BLOKJS_DEP_RANGE so the lockstep release flow keeps them in
		// sync with the rest of the @blokjs/* surface — pre-v0.6.2 these
		// were hardcoded at "^0.2.0", which silently installed the
		// pre-Tier-2 (pre-`workspace:*`) versions even when BLOKJS_DEP_RANGE
		// said "^0.6.0+". Discovered during the v0.6.1 cold-env smoke test.
		const triggerPackageDeps: Record<string, string> = {};
		if (selectedTriggers.includes("pubsub")) {
			triggerPackageDeps["@blokjs/trigger-pubsub"] = localRepoPath
				? `file:${path.resolve(repoSource, "triggers/pubsub")}`
				: BLOKJS_DEP_RANGE;
		}
		if (selectedTriggers.includes("queue")) {
			// "queue" CLI flag → @blokjs/trigger-worker (the monorepo
			// package). The "trigger-queue" name only exists as an old
			// 0.2.x package on npm from a separate publisher; v0.6.x
			// ships everything under trigger-worker.
			triggerPackageDeps["@blokjs/trigger-worker"] = localRepoPath
				? `file:${path.resolve(repoSource, "triggers/worker")}`
				: BLOKJS_DEP_RANGE;
		}
		// v0.6.5 — SSE scaffolds need deps the trigger-sse npm package
		// doesn't list in its production dependencies because the
		// package itself only needs them at dev/test time. When SSE is
		// scaffolded alone (primary trigger), the project inherits
		// trigger-sse/package.json and is missing:
		//   - @hono/node-server  (used by the generated SSEServer to serve())
		//   - @blokjs/helpers    (provides @blokjs/sse-{subscribe,stream,publish})
		//   - @blokjs/api-call   (referenced by generated Nodes.ts)
		//   - @blokjs/if-else    (same)
		//   - @blokjs/trigger-sse (the trigger package itself)
		// HTTP scaffolds already include all of these via trigger-http's
		// own dependencies (HTTP package.json declares them), so the
		// HTTP-as-primary path inherits them naturally. The injection
		// below is a no-op when those deps are already present.
		if (selectedTriggers.includes("sse")) {
			const sseDeps: Record<string, string> = {
				"@blokjs/api-call": localRepoPath
					? `file:${path.resolve(repoSource, "nodes/web/api-call@1.0.0")}`
					: BLOKJS_DEP_RANGE,
				"@blokjs/if-else": localRepoPath
					? `file:${path.resolve(repoSource, "nodes/control-flow/if-else@1.0.0")}`
					: BLOKJS_DEP_RANGE,
				"@blokjs/helpers": localRepoPath
					? `file:${path.resolve(repoSource, "nodes/utility/helpers@1.0.0")}`
					: BLOKJS_DEP_RANGE,
				"@blokjs/trigger-sse": localRepoPath ? `file:${path.resolve(repoSource, "triggers/sse")}` : BLOKJS_DEP_RANGE,
				"@hono/node-server": "^1.19.9",
				hono: "^4.11.7",
				uuid: "^11.1.0",
			};
			packageJsonContent.dependencies = {
				...packageJsonContent.dependencies,
				...sseDeps,
			};
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

		// Show infrastructure setup instructions for queue/pubsub triggers
		if (selectedTriggers.includes("queue") && queueProvider === "redis") {
			console.log(color.cyan("\n📦 Redis Setup (for Queue trigger):"));
			console.log("  Start Redis with Docker:");
			console.log(color.dim("    cd infra/development"));
			console.log(color.dim("    docker network create shared-network"));
			console.log(color.dim("    docker compose up -d redis redis-commander"));
			console.log("  Redis Commander UI: http://localhost:8081");
		}

		if (selectedTriggers.includes("queue") && queueProvider === "nats") {
			console.log(color.cyan("\n📦 NATS JetStream Setup (for Queue trigger):"));
			console.log("  Start NATS with Docker:");
			console.log(color.dim("    cd infra/development"));
			console.log(color.dim("    docker network create shared-network"));
			console.log(color.dim("    docker compose up -d nats"));
			console.log("  NATS Monitoring: http://localhost:8222");
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
	let spreadHelperNodes = false;

	// Always include core nodes
	nodeImports.add('import ApiCall from "@blokjs/api-call";');
	nodeImports.add('import IfElse from "@blokjs/if-else";');
	nodeImports.add('import type { BlokService } from "@blokjs/runner";');
	nodeExports.set("@blokjs/api-call", "ApiCall");
	nodeExports.set("@blokjs/if-else", "IfElse");

	// SSE workflows need the helper nodes that drive the bus pattern
	// (@blokjs/sse-subscribe, @blokjs/sse-stream, @blokjs/sse-publish).
	// Spread the entire HELPER_NODES registry from @blokjs/helpers
	// rather than cherry-picking — the same package exports other
	// reliability helpers (@blokjs/log, @blokjs/expr, @blokjs/audit-log,
	// etc.) that users will reach for from SSE workflows too. Cost is
	// negligible (helper nodes are zero-side-effect imports).
	if (triggers.includes("sse")) {
		nodeImports.add('import { HELPER_NODES } from "@blokjs/helpers";');
		spreadHelperNodes = true;
	}

	const importLines = Array.from(nodeImports).join("\n");
	const exportEntries = Array.from(nodeExports.entries())
		.map(([key, value]) => `\t"${key}": ${value},`)
		.join("\n");

	// When SSE is selected, spread HELPER_NODES first so the explicit
	// core entries above win on any name collision (today there is none
	// — defence in depth).
	const recordBody = spreadHelperNodes ? `\t...HELPER_NODES,\n${exportEntries}` : exportEntries;

	return `${importLines}

const nodes: Record<string, BlokService<unknown>> = {
${recordBody}
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

	// Each trigger contributes the workflows actually shipped by its source
	// tree. Pre-v0.6.3 this list hardcoded paths that didn't match reality
	// for SSE (no notifications workflows in source) and queue (worker
	// template ships `workflows/jobs/process-job.ts`, not `messages/
	// on-message.ts`). Now matches what the copy step actually produces.
	for (const trigger of triggers) {
		if (trigger === "http") {
			// HTTP trigger source doesn't ship TS workflow files — example
			// JSON workflows come in via the file-based router under
			// `workflows/json/`. Skip.
			imports.push("// HTTP workflows are auto-discovered from workflows/json/");
		} else if (trigger === "sse") {
			// v0.6.5 — SSE source ships `src/workflows/events/{stream,publish}-demo.ts`
			// (copied via the scaffold to `src/workflows/sse/events/...`). The
			// stream-demo workflow is the SSE subscriber; the publish-demo
			// workflow is HTTP-triggered and only useful when an HTTP trigger
			// is ALSO selected (otherwise its POST /v07-sse-publish endpoint
			// has no listener). The CLI registers both in this Workflows
			// record regardless — SSEServer filters to SSE-triggered only,
			// and HTTP-only triggers ignore the SSE one. Keeps the file
			// generation simple + lets a future http-only scaffold opt in
			// to the publish workflow as a learning example.
			imports.push('import SSEStreamDemo from "./workflows/sse/events/stream-demo";');
			workflowEntries.push('\t"sse-stream-demo": SSEStreamDemo,');
			if (triggers.includes("http")) {
				imports.push('import SSEPublishDemo from "./workflows/sse/events/publish-demo";');
				workflowEntries.push('\t"sse-publish-demo": SSEPublishDemo,');
			}
		} else if (trigger === "pubsub") {
			imports.push('import OnPubSubMessage from "./workflows/pubsub/messages/on-message";');
			workflowEntries.push('\t"on-pubsub-message": OnPubSubMessage,');
		} else if (trigger === "queue") {
			// Worker template ships `workflows/jobs/process-job.ts`.
			imports.push('import ProcessJob from "./workflows/queue/jobs/process-job";');
			workflowEntries.push('\t"process-job": ProcessJob,');
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
		// v0.6.5 — SSE entry now drives an `SSEServer` wrapper (mirrors
		// the WorkerServer / PubSubServer pattern). The wrapper creates
		// a Hono app, hands it to SSETrigger's constructor (which
		// REQUIRES it; pre-v0.6.5 the entry called `new SSETrigger()`
		// with no args — boots, but every registered SSE route would
		// crash on `this.app.get(...)` because `app` was undefined),
		// registers nodes + workflows, and binds an HTTP listener so
		// `/sse/<path>` requests actually reach the SSE handler.
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

			this.logger.log(\`SSE trigger initialized in \${(this.initializer).toFixed(2)}ms\`);
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
		// The "queue" CLI flag scaffolds the trigger-worker template (the
		// monorepo dir is `triggers/worker/`, and the npm package is
		// `@blokjs/trigger-worker`). The scaffolded file is
		// `runner/WorkerServer.ts`, exporting a class that extends
		// `WorkerTrigger` from `@blokjs/trigger-worker`.
		return `import { DefaultLogger } from "@blokjs/runner";
import { type Span, metrics, trace } from "@opentelemetry/api";
import WorkerServer from "./runner/WorkerServer";

export default class App {
	private workerServer: WorkerServer = <WorkerServer>{};
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
		this.workerServer = new WorkerServer();
	}

	async run() {
		this.tracer.startActiveSpan("initialization", async (span: Span) => {
			await this.workerServer.listen();
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
 * Generate src/triggers/sse/runner/SSEServer.ts — the wrapper class that
 * bootstraps the SSE trigger. Pattern mirrors the queue scaffold's
 * WorkerServer.ts + pubsub's PubSubServer.ts: a thin class the user
 * can extend, providing the constructor-arg + listener wiring SSETrigger
 * doesn't do itself.
 *
 * Why this exists: SSETrigger's constructor takes `app: Hono` (so SSE
 * can mount on a shared HTTP port) and SSETrigger.listen() only
 * registers routes — it doesn't bind a port. Both responsibilities
 * live here in scaffolded user code.
 *
 * Workflow registration: only SSE-triggered workflows are pushed into
 * WorkflowRegistry from this server. HTTP-companion workflows in the
 * same shared Workflows.ts get registered by the HTTP server process
 * (when a multi-trigger scaffold includes HTTP).
 */
function generateSSEServerFile(): string {
	return `import { serve } from "@hono/node-server";
import { DefaultLogger, NodeMap, WorkflowRegistry } from "@blokjs/runner";
import { Hono } from "hono";
import SSETrigger from "../SSETrigger";
import nodes from "../../../Nodes";
import workflows from "../../../Workflows";

type HonoServer = ReturnType<typeof serve>;

/**
 * SSEServer — concrete SSE trigger implementation.
 *
 * Bootstraps an isolated Hono app for the SSE trigger process, hands
 * it to SSETrigger, populates the shared NodeMap, registers
 * SSE-triggered workflows with WorkflowRegistry, then binds an HTTP
 * listener so /<sse-path> requests reach the streamer.
 *
 * Two SSE-triggered workflows ship by default (see
 * src/workflows/sse/events/):
 *   - stream-demo.ts    GET  /sse/demo        — subscribes to the
 *                                                in-process bus channel
 *                                                "sse-demo" and pumps
 *                                                events as SSE frames.
 *   - publish-demo.ts   POST /v07-sse-publish — publishes one event to
 *                                                the "sse-demo" channel
 *                                                (HTTP trigger; only
 *                                                routable when the
 *                                                project also includes
 *                                                an HTTP trigger).
 *
 * Test end-to-end:
 *   1. curl -N http://localhost:4001/sse/demo
 *   2. curl -X POST http://localhost:4000/v07-sse-publish \\
 *           -H 'Content-Type: application/json' \\
 *           -d '{"event":"hello","data":{"msg":"world"}}'
 *   3. Watch (1) — the event arrives instantly.
 */
export default class SSEServer {
	private readonly app: Hono = new Hono();
	private readonly trigger: SSETrigger;
	private readonly logger = new DefaultLogger();
	private httpServer: HonoServer | null = null;

	constructor() {
		this.trigger = new SSETrigger(this.app);

		// Populate the NodeMap with all registered nodes. SSE workflows
		// run their steps through the same runner machinery as HTTP,
		// so they need every node referenced in their step list
		// (sse-subscribe, sse-stream, plus any user-defined nodes).
		const nodeMap = new NodeMap();
		for (const [key, node] of Object.entries(nodes)) {
			nodeMap.addNode(key, node);
		}
		this.trigger.setNodeMap({
			nodes: nodeMap,
			workflows: workflows as unknown as Parameters<SSETrigger["setNodeMap"]>[0]["workflows"],
		});

		// Push SSE-triggered workflows into the WorkflowRegistry.
		// HTTP-companion workflows (e.g., publish-demo) share the same
		// Workflows.ts but get registered by the HTTP trigger process
		// in a multi-trigger scaffold. Filtering here prevents the SSE
		// trigger from trying to mount HTTP routes.
		//
		// Note: \`workflow({...})\` from @blokjs/helper returns a frozen
		// builder { _blokV2, _config, toJson() }. The trigger config we
		// filter on lives at \`_config.trigger.sse\`, not at the top-level
		// (\`.trigger.sse\` is the v1 helper-response shape). Supporting
		// both keeps the registration tolerant of either authoring style.
		const registry = WorkflowRegistry.getInstance();
		for (const [name, wf] of Object.entries(workflows)) {
			const w = wf as {
				name?: string;
				trigger?: { sse?: unknown };
				_config?: { name?: string; trigger?: { sse?: unknown } };
			};
			const triggerCfg = w._config?.trigger ?? w.trigger;
			if (!triggerCfg?.sse) continue;
			const resolvedName = w._config?.name ?? w.name ?? name;
			registry.register({
				name: resolvedName,
				source: \`sse:\${name}\`,
				workflow: (w._config ?? w) as unknown as Parameters<typeof registry.register>[0]["workflow"],
			});
		}
	}

	async listen(): Promise<void> {
		await this.trigger.listen();
		const port = Number(process.env.TRIGGER_SSE_PORT || process.env.PORT || 4001);
		this.httpServer = serve({ fetch: this.app.fetch, port }, () => {
			this.logger.log(\`SSE server listening on http://localhost:\${port}\`);
		});
	}

	async stop(): Promise<void> {
		await this.trigger.stop();
		this.httpServer?.close();
	}
}
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
	// Two file shapes:
	//  - HTTP / PubSub / Queue keep their trigger class inside a `runner/`
	//    subfolder (`src/triggers/<kind>/runner/<X>Server.ts`). Imports of
	//    `../Nodes` / `../Workflows` in those files need three levels
	//    up to reach `src/Nodes.ts` / `src/Workflows.ts`.
	//  - SSE keeps `SSETrigger.ts` at the trigger root (`src/triggers/sse/
	//    SSETrigger.ts`). That's only two levels deep, so its imports of
	//    `../Nodes` / `../Workflows` need two levels up.
	//
	// Pre-v0.6.2 the SSE branch pointed at `runner/SSEServer.ts` (a file
	// that doesn't exist because SSE's source doesn't use that layout) so
	// the SSE scaffold silently skipped this fix-up.
	const fileFixes: Array<{ file: string; up: string }> = [];

	if (triggerKind === "http") {
		fileFixes.push({ file: `${triggerDestDir}/runner/HttpTrigger.ts`, up: "../../../" });
	} else if (triggerKind === "sse") {
		fileFixes.push({ file: `${triggerDestDir}/SSETrigger.ts`, up: "../../" });
		// SSEServer.ts is generated programmatically (not copied) and
		// already uses `../../../Nodes` / `../../../Workflows` directly
		// (matches its location at `src/triggers/sse/runner/`). No
		// rewrite needed, but listed here for documentation alongside
		// the other trigger runner files.
	} else if (triggerKind === "pubsub") {
		fileFixes.push({ file: `${triggerDestDir}/runner/PubSubServer.ts`, up: "../../../" });
	} else if (triggerKind === "queue") {
		// "queue" CLI flag → trigger-worker template (WorkerServer.ts)
		fileFixes.push({ file: `${triggerDestDir}/runner/WorkerServer.ts`, up: "../../../" });
	}

	for (const { file, up } of fileFixes) {
		if (!fsExtra.existsSync(file)) continue;

		let content = fsExtra.readFileSync(file, "utf8");
		content = content.replace(/from ["']\.\.\/Nodes["']/g, `from "${up}Nodes"`);
		content = content.replace(/from ["']\.\.\/Workflows["']/g, `from "${up}Workflows"`);
		fsExtra.writeFileSync(file, content);
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

	// Replace import (handles both orders: {Adapter, PubSubTrigger} or {PubSubTrigger, Adapter})
	content = content.replace(
		/import \{ (\w+), (\w+) \} from ["']@blokjs\/trigger-pubsub["'];/,
		`import { ${config.importName}, PubSubTrigger } from "@blokjs/trigger-pubsub";`,
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
 * Update Queue trigger to use the selected provider adapter. The "queue"
 * CLI flag scaffolds `@blokjs/trigger-worker` under the hood (the npm
 * package the monorepo publishes); the scaffolded file is
 * `WorkerServer.ts` extending `WorkerTrigger`. Pre-v0.6.3 this function
 * targeted `QueueServer.ts` + `QueueTrigger` + `@blokjs/trigger-queue`
 * — none of which match the actual scaffold, so provider selection
 * silently no-op'd.
 */
function updateQueueProvider(triggerDestDir: string, provider: string): void {
	const serverPath = `${triggerDestDir}/runner/WorkerServer.ts`;
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
			// trigger-worker exports BullMQAdapter for Redis-backed queues
			// (and RedisStreamsAdapter for streams). v0.6.x ships BullMQ.
			importName: "BullMQAdapter",
			init: `new BullMQAdapter({
		connection: {
			host: process.env.REDIS_HOST || "localhost",
			port: Number(process.env.REDIS_PORT) || 6379,
		},
	})`,
		},
		nats: {
			// trigger-worker exports NATSWorkerAdapter (was NATSAdapter in
			// the pre-Tier-2 trigger-queue package the CLI used to target).
			importName: "NATSWorkerAdapter",
			init: `new NATSWorkerAdapter({
		servers: (process.env.NATS_SERVERS || "localhost:4222").split(","),
	})`,
		},
	};

	const config = adapterConfigs[provider];
	if (!config) return;

	// Replace import (handles both orders: {Adapter, WorkerTrigger} or {WorkerTrigger, Adapter})
	content = content.replace(
		/import \{ (\w+), (\w+) \} from ["']@blokjs\/trigger-worker["'];/,
		`import { ${config.importName}, WorkerTrigger } from "@blokjs/trigger-worker";`,
	);

	// Replace adapter instantiation (match only actual class property, not JSDoc examples)
	// Look for the pattern inside the class body (starts with tab for indentation)
	content = content.replace(
		/(export default class \w+ extends WorkerTrigger \{[\s\S]*?)\n\tprotected adapter = new \w+\(\{[\s\S]*?\}\);/,
		`$1\n\tprotected adapter = ${config.init};`,
	);

	fsExtra.writeFileSync(serverPath, content);

	// Update the example workflow's provider field to match the selected provider
	const workflowPath = `${triggerDestDir}/workflows/messages/on-message.ts`;
	if (fsExtra.existsSync(workflowPath)) {
		let workflowContent = fsExtra.readFileSync(workflowPath, "utf8");
		workflowContent = workflowContent.replace(/provider: "kafka"/, `provider: "${provider}"`);
		fsExtra.writeFileSync(workflowPath, workflowContent);
	}
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
		gcp: { "@google-cloud/pubsub": "^5.0.0" },
		aws: { "@aws-sdk/client-sns": "^3.980.0", "@aws-sdk/client-sqs": "^3.980.0" },
		azure: { "@azure/service-bus": "^7.9.5" },
	};

	const queueProviderDeps: Record<string, Record<string, string>> = {
		kafka: { kafkajs: "^2.2.4" },
		rabbitmq: { amqplib: "^0.10.9" },
		sqs: { "@aws-sdk/client-sqs": "^3.980.0" },
		redis: { ioredis: "^5.9.2", bullmq: "^5.67.2" },
		nats: { nats: "^2.28.0" },
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
		nats: `
# NATS JetStream
NATS_SERVERS=localhost:4222
NATS_STREAM_NAME=blok-queue`,
	};

	if (triggers.includes("pubsub") && pubsubEnvVars[pubsubProvider]) {
		lines.push(pubsubEnvVars[pubsubProvider]);
	}

	if (triggers.includes("queue") && queueEnvVars[queueProvider]) {
		lines.push(queueEnvVars[queueProvider]);
	}

	return lines.join("\n");
}
