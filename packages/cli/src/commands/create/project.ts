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
const GITHUB_REPO_RELEASE_TAG = "v0.6.9";

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
									{ label: "SSE", value: "sse", hint: "Real-time server push (mounts on HTTP port)" },
									{
										label: "WebSocket",
										value: "websocket",
										hint: "Bi-directional real-time (mounts on HTTP port)",
									},
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

		// v0.6.7 — SSE and WebSocket are sub-protocols of HTTP. SSETrigger's
		// constructor takes a Hono app + HttpTrigger handle so it can mount
		// on the shared HTTP server via `addPreCatchAllHook`. Same for
		// WebSocketTrigger (plus `addServerHook` for the upgrade listener).
		// The framework's own design assumes single-process colocation;
		// the multi-process scaffold layout fights that design — the
		// in-process bus (sse-bus.ts) is per-process, so cross-process
		// fan-out (HTTP publishes → SSE clients receive) didn't work.
		// When HTTP is in the trigger set, SSE and WebSocket are mounted
		// on HTTP's process and removed from the spawn list. The trigger
		// entry files (src/triggers/{sse,websocket}/index.ts) are still
		// generated so a user who later peels off HTTP can still run SSE
		// or WS standalone; they just aren't started by `blokctl dev`
		// when HTTP is present.
		const mountedOnHttp = new Set<string>();
		if (selectedTriggers.includes("http")) {
			for (const kind of ["sse", "websocket"]) {
				if (selectedTriggers.includes(kind)) mountedOnHttp.add(kind);
			}
		}
		const spawnedTriggerConfigs: TriggerConfig[] = triggerConfigs.filter((tc) => !mountedOnHttp.has(tc.kind));

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

				if (triggerKind === "sse" || triggerKind === "websocket") {
					// SSE and WebSocket have flat layouts — every .ts at the
					// package root is part of the trigger surface
					// (SSETrigger.ts + bus.ts + lib.ts for SSE,
					// WebSocketTrigger.ts + Backplane.ts for WebSocket).
					// Pre-v0.6.3 the SSE branch cherry-picked individual
					// files and left siblings (bus.ts) behind — breaking
					// internal imports. Whole-dir copy + filter out tests is
					// cleaner + future-proof for both triggers.
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
			const entryContent = generateTriggerEntryFile(triggerKind, selectedTriggers);
			fsExtra.writeFileSync(`${dirPath}/src/triggers/${triggerKind}/index.ts`, entryContent);
		}

		// SSE scaffold needs an SSEServer wrapper that creates a Hono app,
		// passes it to SSETrigger's constructor, registers nodes/workflows,
		// and binds an HTTP listener. Pre-v0.6.7 the SSE entry called
		// `new SSETrigger()` with no args (broken — constructor requires
		// `app: Hono`) and didn't bind a listener, so SSE trigger never
		// actually served traffic. Generated here so it inherits the
		// scaffold's import-path conventions.
		if (selectedTriggers.includes("sse")) {
			const sseServerDir = `${dirPath}/src/triggers/sse/runner`;
			fsExtra.ensureDirSync(sseServerDir);
			fsExtra.writeFileSync(`${sseServerDir}/SSEServer.ts`, generateSSEServerFile());
		}

		// Same pattern for WebSocket: standalone WS scaffolds need a
		// WSServer wrapper that builds a Hono app, instantiates
		// WebSocketTrigger(app), registers WS-triggered workflows, then
		// calls serve() AND injectWebSocket(server) so the WS upgrade
		// listener attaches. When HTTP is also selected, the WS routes
		// instead mount on HTTP's process (see generateTriggerEntryFile
		// for the HTTP branch).
		if (selectedTriggers.includes("websocket")) {
			const wsServerDir = `${dirPath}/src/triggers/websocket/runner`;
			fsExtra.ensureDirSync(wsServerDir);
			fsExtra.writeFileSync(`${wsServerDir}/WSServer.ts`, generateWSServerFile());
		}

		// Copy trigger-specific nodes to shared src/nodes/
		for (const triggerKind of selectedTriggers) {
			const triggerNodesDir = `${repoSource}/triggers/${triggerKind}/src/nodes`;
			if (fsExtra.existsSync(triggerNodesDir)) {
				fsExtra.copySync(triggerNodesDir, `${dirPath}/src/nodes`);
			}
		}

		// v0.6.7 — when `--examples` is set, the Nodes.ts template
		// (Examples.ts:`node_file`) imports chain-init / chain-verify /
		// runtime-bridge / examples nodes from src/nodes/. Those node
		// directories live under `triggers/http/src/nodes/` and only get
		// copied when HTTP is in the trigger list. If a user scaffolds
		// `--triggers sse --examples` (or websocket-only with examples),
		// the imports fail at runtime: "Cannot find module
		// './nodes/chain-init/index'". Copy the HTTP nodes unconditionally
		// when examples are requested — they're harmless when not invoked
		// and the user can delete what they don't want. (Better long-term
		// fix: split examples from HTTP-specific nodes, or scaffold a
		// different Nodes.ts when examples are paired with non-HTTP
		// primary triggers. Not in scope for this patch.)
		if (examples && !selectedTriggers.includes("http")) {
			const httpNodesDir = `${repoSource}/triggers/http/src/nodes`;
			if (fsExtra.existsSync(httpNodesDir)) {
				fsExtra.copySync(httpNodesDir, `${dirPath}/src/nodes`);
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

			// v0.6.7 — `--examples` overrides the generated Nodes.ts with
			// the static `node_file` template (api-call + if-else + the
			// chain-init / chain-verify / runtime-bridge / examples nodes).
			// Pre-v0.6.7 that template was final. But when SSE or WebSocket
			// are also selected, their workflow templates reference helper
			// nodes from @blokjs/helpers (sse-publish, ws-reply, etc.) —
			// without HELPER_NODES spread, the runner fails with
			// "Node @blokjs/sse-publish not found". Merge the helper
			// registry into the examples template when realtime triggers
			// are present so both example workflows AND the SSE/WS demos
			// resolve their dependencies. Cheap (helper nodes are zero-
			// side-effect imports) and consistent with the non-examples
			// branch.
			const needsHelpers = selectedTriggers.includes("sse") || selectedTriggers.includes("websocket");
			const examplesNodesContent = needsHelpers
				? node_file
						.replace(
							`import type { NodeBase } from "@blokjs/shared";`,
							`import type { NodeBase } from "@blokjs/shared";\nimport { HELPER_NODES } from "@blokjs/helpers";`,
						)
						.replace(
							`} = {\n\t"@blokjs/api-call": ApiCall,`,
							`} = {\n\t...HELPER_NODES,\n\t"@blokjs/api-call": ApiCall,`,
						)
				: node_file;
			fsExtra.writeFileSync(`${dirPath}/src/Nodes.ts`, examplesNodesContent);
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
		// v0.6.7: expanded to include EVERY publishable @blokjs/* package so
		// the `--local` install path doesn't fall back to npm for any of
		// them. Pre-v0.6.7 this map omitted @blokjs/helpers + @blokjs/react
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
		const BLOKJS_DEP_RANGE = "^0.6.9";

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
		// v0.6.7 — SSE scaffolds need deps the trigger-sse npm package
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
		// Same rationale for WebSocket — when WS is selected, inject the
		// deps required for the scaffolded WSServer + workflow runtime.
		// @blokjs/helpers provides @blokjs/ws-{broadcast,reply,close}.
		if (selectedTriggers.includes("websocket")) {
			const wsDeps: Record<string, string> = {
				"@blokjs/api-call": localRepoPath
					? `file:${path.resolve(repoSource, "nodes/web/api-call@1.0.0")}`
					: BLOKJS_DEP_RANGE,
				"@blokjs/if-else": localRepoPath
					? `file:${path.resolve(repoSource, "nodes/control-flow/if-else@1.0.0")}`
					: BLOKJS_DEP_RANGE,
				"@blokjs/helpers": localRepoPath
					? `file:${path.resolve(repoSource, "nodes/utility/helpers@1.0.0")}`
					: BLOKJS_DEP_RANGE,
				"@blokjs/trigger-websocket": localRepoPath
					? `file:${path.resolve(repoSource, "triggers/websocket")}`
					: BLOKJS_DEP_RANGE,
				"@hono/node-server": "^1.19.9",
				"@hono/node-ws": "^1.3.1",
				hono: "^4.11.7",
				uuid: "^11.1.0",
				ws: "^8.19.0",
			};
			packageJsonContent.dependencies = {
				...packageJsonContent.dependencies,
				...wsDeps,
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
		writeProjectConfig(dirPath, runtimeConfigs, spawnedTriggerConfigs);

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

		// v0.6.7 chat demo — when --examples is selected, append OPENROUTER
		// env vars. The chat-message workflow reads OPENROUTER_API_KEY +
		// OPENROUTER_MODEL via process.env inside its js/ expressions. Left
		// empty in .env.local; the user populates the key before running
		// the chat demo. Default model is OpenAI's gpt-4o-mini through
		// OpenRouter — cheap, fast, broadly available. Any OpenRouter
		// model works (anthropic/claude-*, google/gemini-*, meta-llama/*,
		// etc.) — just change OPENROUTER_MODEL.
		if (examples) {
			const chatEnvBlock = [
				"",
				"# Chat demo (--examples) — get a free OpenRouter key at https://openrouter.ai/keys",
				"OPENROUTER_API_KEY=",
				"OPENROUTER_MODEL=openai/gpt-4o-mini",
				"",
				"# Redis-memory chat (--examples) — /chat-memory needs Redis reachable at REDIS_URL.",
				"# Start one locally with: docker run --rm -p 6379:6379 redis:7-alpine",
				"# The plain /chat demo works without Redis; only /chat-memory needs it.",
				"REDIS_URL=redis://127.0.0.1:6379",
				"",
				"# Webhook router demo (--examples + --triggers webhook) — secrets per provider.",
				"# Stripe: copy from https://dashboard.stripe.com/webhooks (`whsec_…`).",
				"# GitHub: set in repo Settings → Webhooks → secret field.",
				"# Linear: workspace settings → API → Webhooks → signing secret.",
				"# Until set, signature verification fails with 401 — that's the gate working.",
				"STRIPE_WEBHOOK_SECRET=",
				"GITHUB_WEBHOOK_SECRET=",
				"LINEAR_WEBHOOK_SECRET=",
				"",
				"# Worker fan-out demo (--examples + --triggers worker) — POST /fanout/jobs with",
				"# `{items: [...], tenantId?: '...'}` enqueues N worker jobs onto `fanout-jobs`.",
				"# in-memory adapter works single-process; for cross-process set BLOK_WORKER_ADAPTER",
				"# to nats / redis / bullmq / rabbitmq / sqs / pg-boss / kafka and supply the matching",
				"# connection env (e.g. NATS_SERVERS=nats://127.0.0.1:4222, or REDIS_URL above).",
				"BLOK_WORKER_ADAPTER=in-memory",
				"NATS_SERVERS=nats://127.0.0.1:4222",
				"",
			].join("\n");
			fsExtra.appendFileSync(envLocal, chatEnvBlock);
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
		// Add trigger programs — only the ones that spawn their own process.
		// SSE / WebSocket mounted on HTTP don't need a separate supervisord
		// program; they live inside the HTTP trigger process.
		if (spawnedTriggerConfigs.length > 0) {
			supervisordConfContent += generateTriggerSupervisordConfig(spawnedTriggerConfigs);
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

		// Show trigger health check URLs. SSE / WebSocket mounted on the
		// HTTP process serve their paths on HTTP's port — surface that
		// accurately so the user doesn't curl the unused dedicated port.
		console.log("\nTrigger endpoints:");
		const httpPort = triggerConfigs.find((tc) => tc.kind === "http")?.port;
		for (const tc of triggerConfigs) {
			if (mountedOnHttp.has(tc.kind) && httpPort !== undefined) {
				const samplePath = tc.kind === "sse" ? "/sse/demo" : "/ws/echo";
				console.log(`  ${tc.label}: http://localhost:${httpPort}${samplePath}  (mounted on HTTP)`);
			} else {
				console.log(`  ${tc.label}: http://localhost:${tc.port}/health-check`);
			}
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

	// SSE and WebSocket workflows need helper nodes from @blokjs/helpers:
	// SSE → @blokjs/sse-subscribe, @blokjs/sse-stream, @blokjs/sse-publish
	// WS  → @blokjs/ws-broadcast, @blokjs/ws-reply, @blokjs/ws-close
	// Spread the entire HELPER_NODES registry rather than cherry-picking —
	// the same package exports other reliability helpers (@blokjs/log,
	// @blokjs/expr, @blokjs/audit-log, etc.) that users will reach for
	// from realtime workflows too. Cost is negligible (zero-side-effect
	// imports).
	if (triggers.includes("sse") || triggers.includes("websocket")) {
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
			// v0.6.7 — SSE source ships `src/workflows/events/{stream,publish}-demo.ts`
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
		} else if (trigger === "websocket") {
			// v0.6.7 — WebSocket source ships `src/workflows/events/echo-demo.ts`
			// (copied to `src/workflows/websocket/events/echo-demo.ts`). It
			// echoes received messages back via @blokjs/ws-reply. The
			// scaffold ships this regardless of whether HTTP is selected;
			// when HTTP is also selected, it mounts on the shared port
			// alongside HTTP routes via WebSocketTrigger(app, httpTrigger).
			imports.push('import WSEchoDemo from "./workflows/websocket/events/echo-demo";');
			workflowEntries.push('\t"ws-echo-demo": WSEchoDemo,');
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
function generateTriggerEntryFile(triggerKind: string, selectedTriggers: string[] = [triggerKind]): string {
	if (triggerKind === "http") {
		// v0.6.7 — when SSE is ALSO selected, mount SSETrigger on HTTP's
		// shared Hono app instead of spawning a separate SSE process.
		// SSETrigger is designed to mount on a sibling-trigger's app
		// (see its constructor signature: `app: Hono, httpTrigger?:
		// HttpTriggerLike` + the `addPreCatchAllHook` integration point
		// in HttpTrigger). Single-process bootstrap is the framework's
		// design intent and makes the in-process bus actually carry
		// events from publish-side workflows (HTTP POST) to subscribe-
		// side workflows (SSE streams). With this in place, the
		// stream-demo + publish-demo template pair works end-to-end on
		// `blokctl dev` out of the box.
		//
		// The separate SSE entry (src/triggers/sse/index.ts) still
		// exists for SSE-only scaffolds. blokctl dev's trigger spawn
		// loop skips it when HTTP is also configured (see
		// createTriggerConfig in this same file).
		const sseAlsoSelected = selectedTriggers.includes("sse");
		const wsAlsoSelected = selectedTriggers.includes("websocket");
		// Critical: import SSETrigger / WebSocketTrigger from the npm
		// packages rather than the locally-copied trigger files. The
		// helper nodes (@blokjs/sse-publish, @blokjs/ws-broadcast, etc.)
		// look up the in-process bus / active trigger singleton via the
		// npm package's exports. If the HTTP entry's trigger instance
		// comes from a different module (the local copy), Node treats
		// them as separate modules with separate singletons — events
		// would never cross.
		const needsShared = sseAlsoSelected || wsAlsoSelected;
		const sharedHelperImports = needsShared
			? `\nimport { NodeMap, WorkflowRegistry } from "@blokjs/runner";\nimport sharedNodes from "../../Nodes";\nimport sharedWorkflows from "../../Workflows";`
			: "";
		const sseImports = sseAlsoSelected ? `\nimport SSETrigger from "@blokjs/trigger-sse";` : "";
		const wsImports = wsAlsoSelected ? `\nimport WebSocketTrigger from "@blokjs/trigger-websocket";` : "";
		const sharedBootstrapPrelude = needsShared
			? `\n\n			// Build a NodeMap from the shared Nodes record; both SSE and
			// WebSocket triggers consume this via setNodeMap so they can
			// resolve helper nodes (sse-subscribe, sse-stream, ws-reply,
			// etc.) at workflow run time.
			const subTriggerNodeMap = new NodeMap();
			for (const [key, node] of Object.entries(sharedNodes)) {
				subTriggerNodeMap.addNode(key, node);
			}
			// HttpTrigger.buildFileBasedRoutes() calls WorkflowRegistry.clear()
			// during listen() and re-registers only HTTP-triggered workflows.
			// SSE / WebSocket workflows aren't HTTP routes, so they're missing
			// from the registry by the time the sibling trigger walks it.
			// Add a preCatchAllHook BEFORE the sibling triggers register their
			// hooks — preCatchAllHooks fire in insertion order, so this hook
			// injects SSE + WS workflows into the cleared registry first, and
			// each sibling trigger's hook then sees them and mounts routes.
			this.httpTrigger.addPreCatchAllHook(() => {
				const registry = WorkflowRegistry.getInstance();
				for (const [name, wf] of Object.entries(sharedWorkflows)) {
					const w = wf as {
						name?: string;
						trigger?: { sse?: unknown; websocket?: unknown };
						_config?: { name?: string; trigger?: { sse?: unknown; websocket?: unknown } };
					};
					const triggerCfg = w._config?.trigger ?? w.trigger;
					if (!triggerCfg) continue;
					if (!triggerCfg.sse && !triggerCfg.websocket) continue;
					const resolvedName = w._config?.name ?? w.name ?? name;
					if (registry.get(resolvedName)) continue;
					const kind = triggerCfg.sse ? "sse" : "websocket";
					registry.register({
						name: resolvedName,
						source: \`\${kind}:\${name}\`,
						workflow: (w._config ?? w) as unknown as Parameters<typeof registry.register>[0]["workflow"],
					});
				}
			});`
			: "";
		const sseBootstrap = sseAlsoSelected
			? `\n			// Mount SSE on the HTTP process's shared Hono app. SSETrigger's
			// constructor takes the app + the HttpTrigger for pre-catch-all
			// hook integration; SSE routes register inside that hook so
			// they win Hono's first-match dispatch over HTTP's legacy
			// workflow-name catch-all (\`/:workflow{.+}\`).
			const sseTrigger = new SSETrigger(this.httpTrigger.getApp(), this.httpTrigger);
			sseTrigger.setNodeMap({
				nodes: subTriggerNodeMap,
				workflows: sharedWorkflows as unknown as Parameters<typeof sseTrigger.setNodeMap>[0]["workflows"],
			});
			await sseTrigger.listen();`
			: "";
		const wsBootstrap = wsAlsoSelected
			? `\n			// Mount WebSocket on the HTTP process's shared Hono app.
			// WebSocketTrigger uses TWO HttpTrigger integration points:
			// 1. addPreCatchAllHook — registers WS routes (Hono's upgradeWebSocket
			//    handler) BEFORE the legacy workflow catch-all so /ws/<path>
			//    upgrades cleanly.
			// 2. addServerHook — attaches the WS upgrade listener to the
			//    http.Server returned by HttpTrigger's serve() call.
			const wsTrigger = new WebSocketTrigger(this.httpTrigger.getApp(), this.httpTrigger);
			wsTrigger.setNodeMap({
				nodes: subTriggerNodeMap,
				workflows: sharedWorkflows as unknown as Parameters<typeof wsTrigger.setNodeMap>[0]["workflows"],
			});
			await wsTrigger.listen();`
			: "";
		const fullBootstrap = `${sharedBootstrapPrelude}${sseBootstrap}${wsBootstrap}`;
		return `import { DefaultLogger } from "@blokjs/runner";
import { type Span, metrics, trace } from "@opentelemetry/api";
import HttpTrigger from "./runner/HttpTrigger";${sharedHelperImports}${sseImports}${wsImports}

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
		this.tracer.startActiveSpan("initialization", async (span: Span) => {${fullBootstrap}
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
		// v0.6.7 — SSE entry now drives an `SSEServer` wrapper (mirrors
		// the WorkerServer / PubSubServer pattern). The wrapper creates
		// a Hono app, hands it to SSETrigger's constructor (which
		// REQUIRES it; pre-v0.6.7 the entry called `new SSETrigger()`
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

	if (triggerKind === "websocket") {
		// WS-only entry. When HTTP is ALSO selected, this file is still
		// generated but blokctl dev skips spawning it (see the
		// mountedOnHttp filter in createProject) — the HTTP entry mounts
		// WS on its shared Hono app via the standard constructor
		// integration (`WebSocketTrigger(app, httpTrigger)`).
		return `import { DefaultLogger } from "@blokjs/runner";
import { type Span, metrics, trace } from "@opentelemetry/api";
import WSServer from "./runner/WSServer";

export default class App {
	private wsServer: WSServer = <WSServer>{};
	protected trigger_initializer = 0;
	protected initializer = 0;
	protected tracer = trace.getTracer(
		process.env.PROJECT_NAME || "trigger-websocket-server",
		process.env.PROJECT_VERSION || "0.0.1",
	);
	private logger = new DefaultLogger();
	protected app_cold_start = metrics.getMeter("default").createGauge("initialization", {
		description: "Application cold start",
	});

	constructor() {
		this.initializer = performance.now();
		this.wsServer = new WSServer();
	}

	async run() {
		this.tracer.startActiveSpan("initialization", async (span: Span) => {
			await this.wsServer.listen();
			this.initializer = performance.now() - this.initializer;

			this.logger.log(\`WebSocket trigger initialized in \${(this.initializer).toFixed(2)}ms\`);
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
// Import SSETrigger from the @blokjs/trigger-sse npm package — NOT the
// locally-copied SSETrigger.ts. The @blokjs/sse-publish helper that
// publisher workflows use imports the in-process bus from this exact
// module (\`@blokjs/trigger-sse\`'s \`_getSSEBus\`). If SSEServer uses a
// different module instance (e.g. the local copy), Node treats them
// as separate modules with separate bus singletons — events from the
// helper would never reach subscribers on this trigger.
import SSETrigger from "@blokjs/trigger-sse";
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
 * Generate src/triggers/websocket/runner/WSServer.ts — the wrapper class
 * that bootstraps the WebSocket trigger standalone. Mirrors SSEServer:
 * builds a Hono app, hands it to WebSocketTrigger's constructor, registers
 * WS-triggered workflows in WorkflowRegistry, calls listen() to mount
 * routes, calls serve() to bind the HTTP listener, then attaches the WS
 * upgrade listener to the http.Server via injectWebSocket (private on
 * the trigger; the integration test pattern reaches in via a cast).
 *
 * When HTTP is ALSO in the trigger set, this file is still generated
 * (so a user removing HTTP later can keep the WS scaffold) but
 * `blokctl dev` skips spawning it — the HTTP entry mounts WebSocket
 * on its own shared Hono app via the standard
 * `WebSocketTrigger(app, httpTrigger)` integration. The framework's
 * design assumes single-port colocation; multi-process WebSocket would
 * require a cross-process backplane (the BLOK_WS_BACKPLANE provider
 * exists but isn't the default scaffold).
 */
function generateWSServerFile(): string {
	return `import { serve } from "@hono/node-server";
import { DefaultLogger, NodeMap, WorkflowRegistry } from "@blokjs/runner";
import { Hono } from "hono";
// Import from the @blokjs/trigger-websocket npm package — NOT the
// locally-copied WebSocketTrigger.ts. The WebSocket helper nodes
// (@blokjs/ws-broadcast, @blokjs/ws-reply, @blokjs/ws-close) look up
// the active trigger via the singleton accessor exported from the npm
// package. Using the local copy would create a separate module instance
// with a separate singleton — helpers would broadcast into a void.
import WebSocketTrigger from "@blokjs/trigger-websocket";
import nodes from "../../../Nodes";
import workflows from "../../../Workflows";

type HonoServer = ReturnType<typeof serve>;

/**
 * WSServer — concrete WebSocket trigger implementation.
 *
 * Bootstraps an isolated Hono app for the WebSocket trigger process,
 * hands it to WebSocketTrigger, populates the shared NodeMap, registers
 * WS-triggered workflows with WorkflowRegistry, binds an HTTP listener,
 * and attaches the WebSocket upgrade handler to the http.Server.
 *
 * One WebSocket workflow ships by default (see src/workflows/websocket/
 * events/):
 *   - echo-demo.ts    GET /ws/echo  — on \`connect\` greets the client
 *                                       with \`{event:"connected"}\`; on
 *                                       each message replies with
 *                                       \`{event:"echo", original:<msg>}\`.
 *
 * Test end-to-end with any WS client:
 *   1. Connect:          \`wscat -c ws://localhost:4002/ws/echo\`
 *   2. On connect:       receive \`{"event":"connected","payload":{"ok":true}}\`
 *   3. Send anything:    \`{"event":"hello","data":{"hi":"there"}}\`
 *   4. Receive:          \`{"event":"echo","payload":{"original":...}}\`
 */
export default class WSServer {
	private readonly app: Hono = new Hono();
	private readonly trigger: WebSocketTrigger;
	private readonly logger = new DefaultLogger();
	private httpServer: HonoServer | null = null;

	constructor() {
		this.trigger = new WebSocketTrigger(this.app);

		const nodeMap = new NodeMap();
		for (const [key, node] of Object.entries(nodes)) {
			nodeMap.addNode(key, node);
		}
		this.trigger.setNodeMap({
			nodes: nodeMap,
			workflows: workflows as unknown as Parameters<typeof this.trigger.setNodeMap>[0]["workflows"],
		});

		// Register WS-triggered workflows in WorkflowRegistry. Same
		// rationale as SSEServer: \`workflow({...})\` returns a frozen
		// builder \`{ _blokV2, _config, toJson }\` so the actual trigger
		// config lives at \`_config.trigger.websocket\`. Tolerate both
		// shapes so v1 \`Workflow().addTrigger("websocket")\` authoring
		// also works.
		const registry = WorkflowRegistry.getInstance();
		for (const [name, wf] of Object.entries(workflows)) {
			const w = wf as {
				name?: string;
				trigger?: { websocket?: unknown };
				_config?: { name?: string; trigger?: { websocket?: unknown } };
			};
			const triggerCfg = w._config?.trigger ?? w.trigger;
			if (!triggerCfg?.websocket) continue;
			const resolvedName = w._config?.name ?? w.name ?? name;
			if (registry.get(resolvedName)) continue;
			registry.register({
				name: resolvedName,
				source: \`websocket:\${name}\`,
				workflow: (w._config ?? w) as unknown as Parameters<typeof registry.register>[0]["workflow"],
			});
		}
	}

	async listen(): Promise<void> {
		await this.trigger.listen();
		const port = Number(process.env.TRIGGER_WEBSOCKET_PORT || process.env.PORT || 4002);
		this.httpServer = serve({ fetch: this.app.fetch, port }, () => {
			this.logger.log(\`WebSocket server listening on http://localhost:\${port}\`);
		});
		// Attach WS upgrade listener — WebSocketTrigger sets \`injectWebSocket\`
		// as a private field inside listen(); when no httpTrigger is provided
		// to its constructor, the caller must invoke this on the http.Server
		// after serve() returns.
		const triggerWithInternals = this.trigger as unknown as {
			injectWebSocket?: (server: unknown) => void;
		};
		if (typeof triggerWithInternals.injectWebSocket === "function" && this.httpServer) {
			triggerWithInternals.injectWebSocket(this.httpServer);
		}
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
	} else if (triggerKind === "websocket") {
		fileFixes.push({ file: `${triggerDestDir}/WebSocketTrigger.ts`, up: "../../" });
		// WSServer.ts is generated programmatically (not copied) and
		// already imports `../../../Nodes` / `../../../Workflows` directly.
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
