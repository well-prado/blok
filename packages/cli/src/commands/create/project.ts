import child_process from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import util from "node:util";
import * as p from "@clack/prompts";
import type { OptionValues } from "commander";
import figlet from "figlet";
import fsExtra from "fs-extra";
import color from "picocolors";
import simpleGit, { type SimpleGit, type SimpleGitOptions } from "simple-git";
import { isNonInteractive, parseCommaSeparated, resolveOrThrow } from "../../services/non-interactive.js";
import { setupObservabilityStack } from "../../services/obs-setup.js";
import { type ObsStackTier, parseObsTier } from "../../services/obs-tiers.js";
import { rewriteObservabilityEnvBlock } from "../../services/observability-mutations.js";
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
import { computeDefaultConstraint, formatVersionMismatch, satisfiesConstraint } from "../../services/semver-utils.js";
import { resolveObservabilitySelection } from "../observability/apply.js";
import {
	OBSERVABILITY_MODULE_IDS,
	allObservabilityModules,
	getObservabilityModule,
} from "../observability/descriptor.js";
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
const GITHUB_REPO_RELEASE_TAG = "v1.6.1";
// Scaffold assets bundled into the built package by scripts/
// bundle-scaffold-assets.ts — repo-relative layout, so it substitutes for a
// repo checkout. Compiled location: dist/commands/create/project.js →
// dist/scaffold-repo.
const BUNDLED_SCAFFOLD_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scaffold-repo");

/**
 * Cross-runtime hello-world example workflows shipped with `--examples`, keyed
 * by runtime kind → filename under `examples/ts-workflows/`. Each runs that
 * SDK's built-in `hello-world` node over gRPC. Single source of truth shared by
 * the scaffold copy step and `generateSharedWorkflowsFile` so the copied files
 * and the generated imports never drift. Only entries for selected runtimes are
 * copied/registered.
 */
const RUNTIME_HELLO_EXAMPLES: Record<string, string> = {
	go: "runtime-go-hello.ts",
	rust: "runtime-rust-hello.ts",
	java: "runtime-java-hello.ts",
	csharp: "runtime-csharp-hello.ts",
	php: "runtime-php-hello.ts",
	ruby: "runtime-ruby-hello.ts",
	python3: "runtime-python3-hello.ts",
};

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
	// Default to NATS — the only pub/sub provider that runs with zero cloud
	// setup (mirrors the worker trigger's in-memory default), so a scaffolded
	// pubsub trigger is verifiable out of the box against a local broker.
	let pubsubProvider: string = opts.pubsubProvider || "nats";
	let queueProvider: string = opts.queueProvider || "kafka";
	// Whether the user EXPLICITLY chose a worker/queue broker (a --queue-provider
	// flag, or an interactive prompt that actually ran and resolved). When false,
	// the scaffold leaves `this.adapter` undefined so the framework resolves
	// provider → BLOK_WORKER_ADAPTER → in-memory (zero-infra, boots clean) and
	// avoids pulling in broker deps. Only an explicit choice injects an active
	// adapter + its env block + its dependency.
	let explicitQueueProvider: boolean = Boolean(opts.queueProvider);
	// Observability dev stack. BEHAVIOR CHANGE (MO-STACK): the default is now
	// `none` — a fresh project no longer carries the whole Prometheus/Grafana/
	// Loki/Tempo stack. Restore the old behaviour with `--obs-stack full` (or add
	// it later: `blokctl observability add obs-stack`).
	let selectedObsTier: ObsStackTier = opts.obsStack ? parseObsTier(opts.obsStack) : "none";
	// Observability modules to enable at create time (the "choose what to add"
	// half — `blokctl observability add` is the retrofit half). obs-stack is its
	// own `--obs-stack` tier flag, so it's excluded from this set.
	let selectedObsModules: string[] = opts.observability
		? parseCommaSeparated(opts.observability).map((s) => s.trim().toLowerCase())
		: [];
	for (const id of selectedObsModules) {
		if (id !== "obs-stack" && !getObservabilityModule(id)) {
			throw new Error(`Invalid --observability "${id}". Known: ${OBSERVABILITY_MODULE_IDS.join(", ")}.`);
		}
	}

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
									{ label: "MCP", value: "mcp", hint: "Model Context Protocol server (mounts on HTTP port)" },
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
										{ label: "NATS (local, zero cloud setup)", value: "nats" },
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
				obsStack: () =>
					opts.obsStack
						? Promise.resolve(opts.obsStack)
						: p.select({
								message: "Observability dev stack?",
								options: [
									{ label: "None", value: "none", hint: "no infra/metrics — boots standalone (default)" },
									{ label: "Lite", value: "lite", hint: "Prometheus + Grafana only" },
									{ label: "Full", value: "full", hint: "Prometheus, Grafana, Loki, Tempo, Alloy, …" },
								],
								initialValue: "none",
							}),
				observability: () =>
					opts.observability
						? Promise.resolve(parseCommaSeparated(opts.observability))
						: p.multiselect({
								message: "Observability modules (optional — none by default)",
								options: allObservabilityModules()
									.filter((m) => m.id !== "obs-stack")
									.map((m) => ({ value: m.id, label: m.label, hint: m.description })),
								initialValues: [],
								required: false,
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
		pubsubProvider = (blokctlProject.pubsubProvider as string) || "nats";
		// The queueProvider prompt only runs (and resolves to a non-null value)
		// when a `queue` trigger was selected or --queue-provider was passed; a
		// worker-only run never prompts, so it stays implicitly in-memory.
		explicitQueueProvider = blokctlProject.queueProvider != null;
		queueProvider = (blokctlProject.queueProvider as string) || "kafka";
		selectedRuntimeKinds = blokctlProject.runtimes;
		selectedObsTier = parseObsTier(blokctlProject.obsStack as string);
		selectedObsModules = (blokctlProject.observability as string[] | undefined) ?? [];
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

		// Determine the repo source: --local path > assets bundled into the
		// built package (dist/scaffold-repo, see scripts/bundle-scaffold-assets.ts)
		// > git clone (only reachable when running the CLI from source without a
		// build — a published blokctl always carries the bundle). The clone made
		// `create` require network + repo access and broke every machine without
		// it (caught by the v1.3.0 post-publish gate).
		let repoSource: string;
		if (localRepoPath) {
			repoSource = path.resolve(localRepoPath);
			if (!fsExtra.existsSync(repoSource)) {
				throw new Error(`Local repo path not found: ${repoSource}`);
			}
			console.log(color.dim(`  Using local repo: ${repoSource}`));
		} else if (fsExtra.existsSync(BUNDLED_SCAFFOLD_REPO)) {
			repoSource = BUNDLED_SCAFFOLD_REPO;
		} else {
			repoSource = GITHUB_REPO_LOCAL;
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
			for (const kind of ["sse", "websocket", "webhook", "mcp"]) {
				if (selectedTriggers.includes(kind)) mountedOnHttp.add(kind);
			}
		}
		const spawnedTriggerConfigs: TriggerConfig[] = triggerConfigs.filter((tc) => !mountedOnHttp.has(tc.kind));

		// Use the first trigger as the "primary" for base files (package.json, tsconfig, etc.)
		const primaryTrigger = selectedTriggers[0];
		// Pubsub and Queue triggers use template subdirectory
		const primaryTriggerDir =
			primaryTrigger === "pubsub" || primaryTrigger === "queue" || primaryTrigger === "worker"
				? `${repoSource}/triggers/${primaryTrigger === "queue" || primaryTrigger === "worker" ? "worker" : primaryTrigger}/template`
				: `${repoSource}/triggers/${primaryTrigger}`;

		// Copy base config files from primary trigger
		// ponytail: no `vitest.config.ts` — a fresh scaffold ships no internal
		// test infra (the framework's config is full of `src/runner/` excludes
		// meaningless to a user project). Users add their own if they want it.
		const baseFiles = ["package.json", "tsconfig.json", ".env.example", ".gitignore"];
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
			if (triggerKind === "pubsub" || triggerKind === "queue" || triggerKind === "worker") {
				const templatePkgDir = triggerKind === "queue" || triggerKind === "worker" ? "worker" : triggerKind;
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
					} else if (triggerKind === "queue" || triggerKind === "worker") {
						updateQueueProvider(triggerDestDir, queueProvider, explicitQueueProvider);
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
						// Exclude the trigger's OWN dev/test fixtures (registered only by the
						// trigger's in-repo Workflows.ts, which scaffolds don't ship). Copied
						// verbatim they look like working examples but never register (#669).
						const devFixtures = /\/(countries-helper|countries-cats-helper|empty)\.ts$|\/workflows\/eval(\/|$)/;
						fsExtra.copySync(`${triggerSrcDir}/workflows`, `${dirPath}/src/workflows/${triggerKind}`, {
							filter: (src: string) => !devFixtures.test(src),
						});
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
		const sharedWorkflowsContent = generateSharedWorkflowsFile(selectedTriggers, selectedRuntimeKinds, examples);
		fsExtra.writeFileSync(`${dirPath}/src/Workflows.ts`, sharedWorkflowsContent);

		// Generate trigger entry points that import shared nodes/workflows.
		// SKIP triggers whose template/ ships a real `src/index.ts` (worker /
		// queue, pubsub) — overwriting their entry with the generic
		// placeholder breaks the standalone process. SKIP triggers that
		// mount on HTTP (sse, websocket, webhook) when http is in
		// selectedTriggers — the HTTP entry handles them inline and a
		// separate entry is dead code.
		const triggersWithRealTemplate = new Set(["worker", "queue", "pubsub"]);
		for (const triggerKind of selectedTriggers) {
			if (triggersWithRealTemplate.has(triggerKind)) {
				// Template already shipped a real index.ts; preserve it.
				continue;
			}
			if (mountedOnHttp.has(triggerKind)) {
				// HTTP entry mounts this trigger; don't generate a placeholder.
				continue;
			}
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

		// Cron scaffold: CronTrigger is an abstract TriggerBase subclass that
		// consumes `protected nodes`/`protected workflows` and does its own
		// NodeMap + WorkflowRegistry wiring in listen() — the same declarative
		// ABI as WorkerServer/PubSubServer (minus the broker adapter). No
		// template/ ships in triggers/cron, so the thin wrapper is generated
		// inline here (like SSEServer/WSServer) with the scaffold's own
		// `../../../Nodes` import depth.
		if (selectedTriggers.includes("cron")) {
			const cronServerDir = `${dirPath}/src/triggers/cron/runner`;
			fsExtra.ensureDirSync(cronServerDir);
			fsExtra.writeFileSync(`${cronServerDir}/CronServer.ts`, generateCronServerFile());
			// Ship one runnable cron workflow so the trigger has something to
			// schedule out of the box (registered in Workflows.ts below).
			const cronWorkflowDir = `${dirPath}/src/workflows/cron`;
			fsExtra.ensureDirSync(cronWorkflowDir);
			fsExtra.writeFileSync(`${cronWorkflowDir}/heartbeat.ts`, generateCronExampleWorkflowFile());
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

		// Infra — observability dev stack, tiered (default `none`). Was an
		// unconditional copy of the whole infra/metrics stack into every project.
		setupObservabilityStack(repoSource, dirPath, selectedObsTier);
		fsExtra.removeSync(`${dirPath}/public/metric`);

		// Copy development infra (docker-compose with Redis/NATS) if queue/worker trigger is selected
		if (selectedTriggers.includes("queue") || selectedTriggers.includes("worker")) {
			fsExtra.ensureDirSync(`${dirPath}/infra/development`);
			// Broker scaffolds only need Redis/NATS — skip the ~2.6MB Postgres
			// "dvdrental" sample-DB binaries (the .dat dump + schema.sql). Those
			// only matter for the --examples DB demos, which copy infra/development
			// in full below.
			fsExtra.copySync(`${repoSource}/infra/development`, `${dirPath}/infra/development`, {
				filter: (src: string) => !/\.dat$|schema\.sql$/.test(src),
			});
		}

		// Examples

		if (!examples) {
			fsExtra.removeSync(`${nodesDir}/examples`);
			fsExtra.removeSync(`${workflowsDir}`);
			// The TS examples are only copied on the `else` (examples) branch,
			// but remove the dir defensively so no orphan example workflows can
			// ship without a matching registration in the generated Workflows.ts.
			fsExtra.removeSync(`${dirPath}/src/workflows/examples`);
			fsExtra.ensureDirSync(`${workflowsDir}`);
			fsExtra.ensureDirSync(`${workflowsDir}/json`);
			fsExtra.ensureDirSync(`${workflowsDir}/yaml`);
			fsExtra.ensureDirSync(`${workflowsDir}/toml`);
		} else {
			fsExtra.ensureDirSync(`${dirPath}/infra/postgresql`);
			fsExtra.ensureDirSync(`${dirPath}/infra/milvus`);

			fsExtra.copySync(`${repoSource}/infra/development`, `${dirPath}/infra/postgresql`);
			fsExtra.copySync(`${repoSource}/infra/milvus`, `${dirPath}/infra/milvus`);

			// `--examples` overrides the generated Nodes.ts with the static
			// `node_file` template, which registers api-call + if-else + the
			// whole @blokjs/helpers registry (HELPER_NODES) + the example nodes.
			// HELPER_NODES is unconditional: the example workflows and the
			// SSE/WS/MCP demos reference helper nodes (@blokjs/respond,
			// @blokjs/sse-publish, @blokjs/ws-reply, @blokjs/expr, …) — without
			// them the runner fails with "Node @blokjs/<name> not found". This
			// mirrors the non-examples branch (generateSharedNodesFile).
			fsExtra.writeFileSync(`${dirPath}/src/Nodes.ts`, node_file);
			fsExtra.copySync(`${repoSource}/sdk`, `${dirPath}/public/sdk`);

			// Ship TS example workflows that register via the generated
			// src/Workflows.ts (see generateSharedWorkflowsFile): the MCP
			// greeter and one hello-world-over-gRPC workflow per selected
			// runtime. Each file is gated on its trigger/runtime so the
			// generated imports never reference a file that wasn't copied.
			const tsExamplesSrc = `${repoSource}/examples/ts-workflows`;
			const tsExamplesDest = `${dirPath}/src/workflows/examples`;
			if (fsExtra.existsSync(tsExamplesSrc)) {
				fsExtra.ensureDirSync(tsExamplesDest);
				if (selectedTriggers.includes("mcp")) {
					fsExtra.copySync(`${tsExamplesSrc}/mcp-greeter.ts`, `${tsExamplesDest}/mcp-greeter.ts`);
				}
				for (const kind of selectedRuntimeKinds) {
					const file = RUNTIME_HELLO_EXAMPLES[kind];
					if (file && fsExtra.existsSync(`${tsExamplesSrc}/${file}`)) {
						fsExtra.copySync(`${tsExamplesSrc}/${file}`, `${tsExamplesDest}/${file}`);
					}
				}
			}
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
			"@blokjs/trigger-mcp": "triggers/mcp",
			"@blokjs/trigger-sse": "triggers/sse",
			"@blokjs/trigger-webhook": "triggers/webhook",
			"@blokjs/trigger-websocket": "triggers/websocket",
			// "queue" CLI flag scaffolds the trigger-worker package
			// (the monorepo directory + npm package). Pre-v0.6.3 the
			// workspacePackageMap pointed at `@blokjs/trigger-queue` +
			// `triggers/queue/`, neither of which exists in this repo.
			"@blokjs/trigger-worker": "triggers/worker",
			"@blokjs/core": "core/core",
		};

		// The version range scaffolded projects pin @blokjs/* deps at.
		// Bumped alongside major framework releases (0.4 was the
		// explicit-path-only routing release; 0.5 will drop the
		// BLOK_ROUTING_LEGACY escape hatch).
		const BLOKJS_DEP_RANGE = "^1.6.1";

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
				// --local: a @blokjs/* dep declared as a literal range (e.g. "^1.0.0")
				// conflicts with the file: override added below — npm rejects it with
				// EOVERRIDE ("Override for X conflicts with direct dependency"). Pin the
				// direct dep to the SAME file: link so override == dep. (bun tolerates
				// the mismatch; npm does not.)
				if (localRepoPath && workspacePackageMap[pkg] && typeof ver === "string" && /^[~^]?\d/.test(ver)) {
					deps[pkg] = `file:${path.resolve(repoSource, workspacePackageMap[pkg])}`;
					continue;
				}
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
			// npm/pnpm use "overrides", yarn/bun use "resolutions".
			// MERGE rather than replace — the template ships security-motivated
			// overrides (e.g. forcing @hono/node-server to 2.x so a stale peer
			// range can't pull the vulnerable 1.x back in) that must survive
			// local-repo scaffolding too.
			packageJsonContent.overrides = { ...packageJsonContent.overrides, ...fileLinks };
			packageJsonContent.resolutions = { ...packageJsonContent.resolutions, ...fileLinks };
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

		// @blokjs/core — the published typed-handle authoring surface
		// (workflow/step/branch/forEach/switchOn/tryCatch/tpl/http + comparators).
		// Scaffolded TypeScript workflows import from here, so every new project
		// ships with it as a runtime dependency.
		packageJsonContent.dependencies = {
			...packageJsonContent.dependencies,
			"@blokjs/core": localRepoPath ? `file:${path.resolve(repoSource, "core/core")}` : BLOKJS_DEP_RANGE,
		};

		// ponytail: strip the framework's internal test setup so it doesn't bleed
		// into the user's project — no `test`/`test:dev` scripts, no vitest dep.
		packageJsonContent.scripts = Object.fromEntries(
			Object.entries(packageJsonContent.scripts).filter(([s]) => s !== "test" && s !== "test:dev"),
		);
		packageJsonContent.devDependencies = Object.fromEntries(
			Object.entries(packageJsonContent.devDependencies).filter(([d]) => d !== "vitest" && !d.startsWith("@vitest/")),
		);

		// Add provider-specific dependencies for pubsub and queue triggers
		const providerDeps = getProviderDependencies(
			selectedTriggers,
			pubsubProvider,
			queueProvider,
			explicitQueueProvider,
		);
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
		// Accept "queue" (legacy) AND "worker" (v0.6.11+) as aliases for the
		// trigger-worker package. Also pull the package in under --examples
		// even when the worker trigger isn't directly selected — the fanout-
		// enqueue.json scaffold-source workflow calls @blokjs/worker-publish
		// from the HTTP trigger, which lazy-imports @blokjs/trigger-worker;
		// without the dep at the root, the HTTP trigger 500s on /fanout/jobs
		// even though no separate worker process is intended.
		const needsTriggerWorker = selectedTriggers.includes("queue") || selectedTriggers.includes("worker") || examples;
		if (needsTriggerWorker) {
			triggerPackageDeps["@blokjs/trigger-worker"] = localRepoPath
				? `file:${path.resolve(repoSource, "triggers/worker")}`
				: BLOKJS_DEP_RANGE;
		}
		// The cron scaffold's generated runner/CronServer.ts extends CronTrigger
		// from this package. Unlike sse/ws/pubsub/worker it was never added here,
		// so a `--triggers cron` scaffold couldn't resolve the import and
		// `blokctl dev` fell back to the "not yet implemented" stub.
		if (selectedTriggers.includes("cron")) {
			triggerPackageDeps["@blokjs/trigger-cron"] = localRepoPath
				? `file:${path.resolve(repoSource, "triggers/cron")}`
				: BLOKJS_DEP_RANGE;
		}
		// The grpc scaffold's generated src/triggers/grpc/index.ts boots
		// @blokjs/trigger-grpc's GrpcServer with the project's Nodes/Workflows.
		if (selectedTriggers.includes("grpc")) {
			triggerPackageDeps["@blokjs/trigger-grpc"] = localRepoPath
				? `file:${path.resolve(repoSource, "triggers/grpc")}`
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
		// MCP mounts on the HTTP process (like SSE/WS). Inject the trigger
		// package so the generated HTTP entry's `import McpTrigger from
		// "@blokjs/trigger-mcp"` resolves. The trigger package pulls its own
		// SDK deps (@modelcontextprotocol/sdk, zod-to-json-schema) transitively.
		if (selectedTriggers.includes("mcp")) {
			const mcpDeps: Record<string, string> = {
				"@blokjs/trigger-mcp": localRepoPath ? `file:${path.resolve(repoSource, "triggers/mcp")}` : BLOKJS_DEP_RANGE,
				hono: "^4.11.7",
			};
			packageJsonContent.dependencies = {
				...packageJsonContent.dependencies,
				...mcpDeps,
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

				// Gate on the SDK's minimum toolchain version (e.g. Ruby >=3.1 for
				// the native grpc gem, PHP >=8.2 for roadrunner-grpc). Surfacing an
				// actionable message here beats a cryptic native-build failure deep
				// inside `bundle install` / `composer install`.
				if (rt.minVersion) {
					const constraint = computeDefaultConstraint(rt.minVersion);
					if (!rt.version || !satisfiesConstraint(rt.version, constraint)) {
						console.log(`\n${formatVersionMismatch(rt.label, rt.version, constraint, rt.installHint)}`);
						console.log(
							color.yellow(
								`  Skipping ${rt.label} setup. After upgrading, add it with \`blokctl runtime add ${rt.kind}\`.\n`,
							),
						);
						continue;
					}
				}

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

		// Resolve the selected observability modules (+ their dependencies) into a
		// config map + env blocks. obs-stack is handled by --obs-stack, not here.
		const obsSelection = resolveObservabilitySelection(
			selectedObsModules.filter((id) => id !== "obs-stack"),
			{ addedAt: new Date().toISOString(), version, projectDir: dirPath },
		);
		if (obsSelection.added.length > 0) {
			p.log.info(`Auto-enabling required observability dependencies: ${obsSelection.added.join(", ")}`);
		}

		// Write .blok/config.json with triggers, runtimes, and observability modules.
		const obsConfigMap = Object.keys(obsSelection.configMap).length > 0 ? obsSelection.configMap : undefined;
		writeProjectConfig(dirPath, runtimeConfigs, spawnedTriggerConfigs, obsConfigMap);

		// Append the observability env block (fenced, managed) to .env.local.
		if (obsSelection.envBlocks.some((b) => b.trim())) {
			const current = fsExtra.existsSync(envLocal) ? fsExtra.readFileSync(envLocal, "utf8") : "";
			fsExtra.writeFileSync(envLocal, rewriteObservabilityEnvBlock(current, obsSelection.envBlocks));
		}

		// Append trigger env vars to .env.local
		if (triggerConfigs.length > 0) {
			const triggerEnvVars = generateTriggerEnvVars(triggerConfigs);
			fsExtra.appendFileSync(envLocal, triggerEnvVars);
		}

		// Append provider-specific env vars to .env.local
		const providerEnvVars = getProviderEnvVars(selectedTriggers, pubsubProvider, queueProvider, explicitQueueProvider);
		if (providerEnvVars) {
			fsExtra.appendFileSync(envLocal, providerEnvVars);
		}

		// v0.6.7 chat demo — when --examples is selected, append env vars for
		// the bundled demos. Each segment is gated on whether its demo is
		// actually reachable (its trigger was selected) so a plain HTTP
		// --examples project doesn't get webhook secrets or worker adapter vars
		// for triggers it never installed. The chat demos are HTTP-triggered and
		// always present, so the OpenRouter + Redis segment is unconditional
		// under --examples. The chat-message workflow reads OPENROUTER_API_KEY +
		// OPENROUTER_MODEL via process.env inside its js/ expressions; left empty
		// in .env.local for the user to populate. Default model is OpenAI's
		// gpt-4o-mini through OpenRouter — cheap, fast, broadly available. Any
		// OpenRouter model works (anthropic/claude-*, google/gemini-*,
		// meta-llama/*, etc.) — just change OPENROUTER_MODEL.
		if (examples) {
			const exampleEnvLines: string[] = [
				"",
				"# Chat demo (--examples) — get a free OpenRouter key at https://openrouter.ai/keys",
				"OPENROUTER_API_KEY=",
				"OPENROUTER_MODEL=openai/gpt-4o-mini",
				"",
				"# Redis-memory chat (--examples) — /chat-memory needs Redis reachable at REDIS_URL.",
				"# Start one locally with: docker run --rm -p 6379:6379 redis:7-alpine",
				"# The plain /chat demo works without Redis; only /chat-memory needs it.",
				"REDIS_URL=redis://127.0.0.1:6379",
			];

			if (selectedTriggers.includes("webhook")) {
				exampleEnvLines.push(
					"",
					"# Webhook router demo (--examples + --triggers webhook) — secrets per provider.",
					"# Stripe: copy from https://dashboard.stripe.com/webhooks (`whsec_…`).",
					"# GitHub: set in repo Settings → Webhooks → secret field.",
					"# Linear: workspace settings → API → Webhooks → signing secret.",
					"# Until set, signature verification fails with 401 — that's the gate working.",
					"STRIPE_WEBHOOK_SECRET=",
					"GITHUB_WEBHOOK_SECRET=",
					"LINEAR_WEBHOOK_SECRET=",
				);
			}

			if (selectedTriggers.includes("worker") || selectedTriggers.includes("queue")) {
				// BLOK_WORKER_ADAPTER is already written by getProviderEnvVars for
				// any worker/queue project — keep this segment comment-only so the
				// var isn't declared twice.
				exampleEnvLines.push(
					"",
					"# Worker fan-out demo (--examples + --triggers worker) — POST /fanout/jobs with",
					"# `{items: [...], tenantId?: '...'}` enqueues N worker jobs onto `fanout-jobs`.",
					"# in-memory adapter (BLOK_WORKER_ADAPTER above) works single-process; for",
					"# cross-process set it to nats / redis / bullmq / rabbitmq / sqs / pg-boss /",
					"# kafka and supply the matching connection env",
					"# (e.g. NATS_SERVERS=nats://127.0.0.1:4222, or REDIS_URL above).",
				);
			}

			exampleEnvLines.push("");
			fsExtra.appendFileSync(envLocal, exampleEnvLines.join("\n"));
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

		// Create AI context files (AGENTS.md + CLAUDE.md) — the LLM authoring guide.
		// Maintained as real markdown under packages/cli/scaffold-templates/ (present in
		// the --local repoSource and cloned with the release tag), copied verbatim. Falls
		// back to the embedded strings for an older repoSource that predates the templates.
		const docsTemplateDir = `${repoSource}/packages/cli/scaffold-templates`;
		if (fsExtra.existsSync(`${docsTemplateDir}/AGENTS.md`)) {
			fsExtra.copySync(`${docsTemplateDir}/AGENTS.md`, `${dirPath}/AGENTS.md`);
			fsExtra.copySync(`${docsTemplateDir}/CLAUDE.md`, `${dirPath}/CLAUDE.md`);
		} else {
			fsExtra.writeFileSync(`${dirPath}/AGENTS.md`, agents_md.trimStart());
			fsExtra.writeFileSync(`${dirPath}/CLAUDE.md`, claude_md.trimStart());
		}

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
		// Broker-consumer triggers (worker/queue/pubsub) never call serve() or
		// bind an HTTP port — they consume from a broker. Printing a
		// /health-check URL for them points at nothing (connection-refused), so
		// describe the broker source instead.
		const brokerConsumerKinds = new Set(["worker", "queue", "pubsub"]);
		for (const tc of triggerConfigs) {
			if (mountedOnHttp.has(tc.kind) && httpPort !== undefined) {
				const samplePath =
					tc.kind === "sse"
						? "/sse/demo"
						: tc.kind === "mcp"
							? "/mcp/sse"
							: tc.kind === "webhook"
								? "/webhooks"
								: "/ws/echo";
				console.log(`  ${tc.label}: http://localhost:${httpPort}${samplePath}  (mounted on HTTP)`);
			} else if (brokerConsumerKinds.has(tc.kind)) {
				const provider = tc.kind === "pubsub" ? pubsubProvider : explicitQueueProvider ? queueProvider : "in-memory";
				console.log(`  ${tc.label}: consumes via ${provider} (no HTTP endpoint)`);
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

		// Show infrastructure setup instructions for queue/pubsub triggers —
		// only when a broker was EXPLICITLY chosen. The default (in-memory)
		// scaffold needs no infra, so don't tell the user to start Redis/NATS.
		const workerInfraSelected =
			explicitQueueProvider && (selectedTriggers.includes("queue") || selectedTriggers.includes("worker"));
		if (workerInfraSelected && queueProvider === "redis") {
			console.log(color.cyan("\n📦 Redis Setup (for Queue trigger):"));
			console.log("  Start Redis with Docker:");
			console.log(color.dim("    cd infra/development"));
			console.log(color.dim("    docker compose up -d redis redis-commander"));
			console.log("  Redis Commander UI: http://localhost:8081");
		}

		if (workerInfraSelected && queueProvider === "nats") {
			console.log(color.cyan("\n📦 NATS JetStream Setup (for Queue trigger):"));
			console.log("  Start NATS with Docker:");
			console.log(color.dim("    cd infra/development"));
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
		// A failed scaffold must FAIL the process — this catch used to swallow
		// everything (clone 404s, registry lag, install failures) and exit 0,
		// which let CI boot a project that was never created (#648 gate run 1).
		process.exitCode = 1;
	}
}

// ============================================================================
// Helper Functions for Multi-Trigger Project Generation
// ============================================================================

/**
 * Generate shared Nodes.ts that combines nodes from all selected triggers.
 */
export function generateSharedNodesFile(_triggers: string[], _repoSource: string): string {
	const imports = [
		'import { dirname, join } from "node:path";',
		'import { fileURLToPath } from "node:url";',
		'import ApiCall from "@blokjs/api-call";',
		'import IfElse from "@blokjs/if-else";',
		'import { HELPER_NODES } from "@blokjs/helpers";',
		'import { discoverNodes } from "@blokjs/runner";',
		'import type { NodeBase } from "@blokjs/shared";',
	];

	// @blokjs/helpers ships the reliability + control helpers EVERY project needs —
	// @blokjs/respond, @blokjs/throw, @blokjs/log, @blokjs/expr, @blokjs/ctx-publish,
	// @blokjs/audit-log (plus the sse-*/ws-* streaming helpers). Register the whole
	// registry UNCONDITIONALLY: `blokctl create workflow` emits a `@blokjs/respond`
	// step, so even a default HTTP scaffold must have it (otherwise the generated
	// workflow 500s with "Node @blokjs/respond not found"). Cost is negligible —
	// zero-side-effect imports.
	const explicit = [
		"ApiCall as unknown as NodeBase",
		"IfElse as unknown as NodeBase",
		"...(Object.values(HELPER_NODES) as unknown as NodeBase[])",
	];

	return `${imports.join("\n")}

// Published nodes (npm) are registered explicitly below. Your OWN nodes under
// 'nodes/<name>/index.ts' are AUTO-DISCOVERED and registered by their
// defineNode({ name }) — you never edit this file to add a node.
const here = dirname(fileURLToPath(import.meta.url));
const local = await discoverNodes(join(here, "nodes"));

// Map keys are cosmetic — the runner registers each node under its own node.name
// (the canonical 'use:' ref). Duplicate refs throw at startup.
const nodes: { [key: string]: NodeBase } = {};
for (const node of [${explicit.join(", ")}, ...local]) {
\tnodes[(node as { name: string }).name] = node;
}

export default nodes;
`;
}

/**
 * Generate shared Workflows.ts that imports workflows from all trigger directories.
 */
export function generateSharedWorkflowsFile(triggers: string[], runtimeKinds: string[] = [], examples = false): string {
	const imports: string[] = [];
	const workflowEntries: string[] = [];

	// Each trigger contributes the workflows actually shipped by its source
	// tree. Pre-v0.6.3 this list hardcoded paths that didn't match reality
	// for SSE (no notifications workflows in source) and queue (worker
	// template ships `workflows/jobs/process-job.ts`, not `messages/
	// on-message.ts`). Now matches what the copy step actually produces.
	for (const trigger of triggers) {
		if (trigger === "http") {
			// HTTP JSON workflows come in via the file-based router under
			// `workflows/json/` (auto-discovered, not listed here). But the HTTP
			// scaffold ALSO ships one `@blokjs/core` typed-handle-DSL example
			// (src/workflows/http/countries-handle-dsl.ts) so a fresh project has
			// a runnable sample of Blok's lead TS authoring surface — every other
			// shipped workflow is the object/JSON form. The callback DSL resolves
			// async (`workflow(name, opts, build)` returns a Promise), so register
			// the awaited builder; the generated file already uses top-level await
			// in Nodes.ts, so this is consistent.
			imports.push("// HTTP JSON workflows are auto-discovered from workflows/json/");
			imports.push('import CountriesHandleDsl from "./workflows/http/countries-handle-dsl";');
			workflowEntries.push('\t"countries-dsl": await CountriesHandleDsl,');
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
			// `await`: these are @blokjs/core callback-form workflows (async, like
			// countries-dsl). Without it the unresolved Promise carries no readable
			// `_config.trigger`, so SSEServer skips it and the /sse route never mounts.
			imports.push('import SSEStreamDemo from "./workflows/sse/events/stream-demo";');
			workflowEntries.push('\t"sse-stream-demo": await SSEStreamDemo,');
			if (triggers.includes("http")) {
				imports.push('import SSEPublishDemo from "./workflows/sse/events/publish-demo";');
				workflowEntries.push('\t"sse-publish-demo": await SSEPublishDemo,');
			}
		} else if (trigger === "websocket") {
			// v0.6.7 — WebSocket source ships `src/workflows/events/echo-demo.ts`
			// (copied to `src/workflows/websocket/events/echo-demo.ts`). It
			// echoes received messages back via @blokjs/ws-reply. The
			// scaffold ships this regardless of whether HTTP is selected;
			// when HTTP is also selected, it mounts on the shared port
			// alongside HTTP routes via WebSocketTrigger(app, httpTrigger).
			imports.push('import WSEchoDemo from "./workflows/websocket/events/echo-demo";');
			// `await` — callback-form async workflow (see the sse/pubsub notes).
			workflowEntries.push('\t"ws-echo-demo": await WSEchoDemo,');
		} else if (trigger === "pubsub") {
			imports.push('import OnPubSubMessage from "./workflows/pubsub/messages/on-message";');
			// `await`: the @blokjs/core callback-form workflow() resolves async (same
			// as countries-dsl). Registering the unresolved Promise means the pubsub
			// trigger reads no `_config.trigger.pubsub` off it and logs "No workflows
			// with pub/sub triggers found" — the exact symptom this fixes.
			workflowEntries.push('\t"on-pubsub-message": await OnPubSubMessage,');
			// The paired HTTP producer (`POST /orders` → publish to the topic) is
			// only useful when an HTTP trigger is also present to serve it, so a
			// pubsub-only project skips it. Gives a curl-able produce→consume loop.
			if (triggers.includes("http")) {
				imports.push('import PublishOrder from "./workflows/pubsub/publish-order";');
				workflowEntries.push('\t"publish-order": await PublishOrder,');
			}
		} else if (trigger === "queue" || trigger === "worker") {
			// Worker template ships `workflows/jobs/process-job.ts`.
			imports.push(`import ProcessJob from "./workflows/${trigger}/jobs/process-job";`);
			// `await` — callback-form async workflow (see the sse/pubsub notes).
			workflowEntries.push('\t"process-job": await ProcessJob,');
		} else if (trigger === "cron") {
			// Cron discovers its workflows from THIS map (the HTTP JSON auto-scan
			// does not apply to non-HTTP triggers), so the scaffold ships a
			// runnable heartbeat at src/workflows/cron/heartbeat.ts and registers
			// it here. Without it, CronServer.listen() finds no cron workflows and
			// the process exits immediately.
			imports.push('import CronHeartbeat from "./workflows/cron/heartbeat";');
			workflowEntries.push('\t"cron-heartbeat": await CronHeartbeat,');
		}
	}

	// TS example workflows (only with `--examples`). These are copied into
	// `src/workflows/examples/` by the scaffold's example branch — each import
	// here is gated on the SAME condition that gates its copy, so the generated
	// file never references a file that wasn't shipped.
	if (examples) {
		// MCP greeter — exposed as the `greet` MCP tool. Needs the mcp trigger.
		if (triggers.includes("mcp")) {
			imports.push('import McpGreeter from "./workflows/examples/mcp-greeter";');
			workflowEntries.push('\t"mcp-greeter": McpGreeter,');
		}
		// One hello-world-over-gRPC workflow per selected non-node runtime.
		for (const kind of runtimeKinds) {
			const file = RUNTIME_HELLO_EXAMPLES[kind];
			if (!file) continue;
			const fileBase = file.replace(/\.ts$/, "");
			const importName = `Runtime${kind.charAt(0).toUpperCase()}${kind.slice(1)}Hello`;
			imports.push(`import ${importName} from "./workflows/examples/${fileBase}";`);
			workflowEntries.push(`\t"${fileBase}": ${importName},`);
		}
	}

	const importSection = imports.length > 0 ? `${imports.join("\n")}\n` : "";
	const entriesSection = workflowEntries.length > 0 ? workflowEntries.join("\n") : "\t// Add your workflows here";

	// The registry maps workflow keys to `WorkflowV2Builder` instances (the
	// return of the `workflow({…})` factory used by every shipped example).
	// Mirror the framework's own `Workflows` type
	// (triggers/http/src/runner/types/Workflows.ts).
	return `import type { WorkflowV2Builder } from "@blokjs/helper";

${importSection}
const workflows: Record<string, WorkflowV2Builder> = {
${entriesSection}
};

export default workflows;
`;
}

/**
 * Generate trigger entry point that imports shared nodes/workflows.
 * Matches the pattern of the original trigger index.ts files.
 */
export function generateTriggerEntryFile(triggerKind: string, selectedTriggers: string[] = [triggerKind]): string {
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
		const webhookAlsoSelected = selectedTriggers.includes("webhook");
		const mcpAlsoSelected = selectedTriggers.includes("mcp");
		// Critical: import SSETrigger / WebSocketTrigger / WebhookTrigger from the
		// npm packages rather than the locally-copied trigger files. The helper
		// nodes (@blokjs/sse-publish, @blokjs/ws-broadcast, etc.) look up the
		// in-process bus / active trigger singleton via the npm package's
		// exports. If the HTTP entry's trigger instance comes from a different
		// module (the local copy), Node treats them as separate modules with
		// separate singletons — events would never cross.
		const needsShared = sseAlsoSelected || wsAlsoSelected || webhookAlsoSelected || mcpAlsoSelected;
		const sharedHelperImports = needsShared
			? `\nimport { NodeMap, WorkflowRegistry } from "@blokjs/runner";\nimport sharedNodes from "../../Nodes";\nimport sharedWorkflows from "../../Workflows";`
			: "";
		const sseImports = sseAlsoSelected ? `\nimport SSETrigger from "@blokjs/trigger-sse";` : "";
		const wsImports = wsAlsoSelected ? `\nimport WebSocketTrigger from "@blokjs/trigger-websocket";` : "";
		const webhookImports = webhookAlsoSelected ? `\nimport WebhookTrigger from "@blokjs/trigger-webhook";` : "";
		const mcpImports = mcpAlsoSelected ? `\nimport McpTrigger from "@blokjs/trigger-mcp";` : "";
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
					const w = wf as unknown as {
						name?: string;
						trigger?: { sse?: unknown; websocket?: unknown; webhook?: unknown; mcp?: unknown };
						_config?: { name?: string; trigger?: { sse?: unknown; websocket?: unknown; webhook?: unknown; mcp?: unknown } };
					};
					const triggerCfg = w._config?.trigger ?? w.trigger;
					if (!triggerCfg) continue;
					if (!triggerCfg.sse && !triggerCfg.websocket && !triggerCfg.webhook && !triggerCfg.mcp) continue;
					const resolvedName = w._config?.name ?? w.name ?? name;
					if (registry.get(resolvedName)) continue;
					const kind = triggerCfg.sse
						? "sse"
						: triggerCfg.websocket
							? "websocket"
							: triggerCfg.webhook
								? "webhook"
								: "mcp";
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
		const webhookBootstrap = webhookAlsoSelected
			? `\n			// Mount Webhook trigger on the HTTP process's shared Hono app.
			// WebhookTrigger.constructor(app, httpTrigger?) mirrors SSE / WS —
			// when an HttpTrigger is supplied, the webhook trigger registers
			// its /webhooks/<provider> routes inside addPreCatchAllHook so they
			// win Hono's first-match dispatch over the legacy workflow catch-
			// all. The shared @blokjs/trigger-webhook singleton this creates
			// is also what @blokjs/hmac-verify (and other webhook-aware helpers)
			// look up at run time.
			const webhookTrigger = new WebhookTrigger(this.httpTrigger.getApp(), this.httpTrigger);
			webhookTrigger.setNodeMap({
				nodes: subTriggerNodeMap,
				workflows: sharedWorkflows as unknown as Parameters<typeof webhookTrigger.setNodeMap>[0]["workflows"],
			});
			await webhookTrigger.listen();`
			: "";
		const mcpBootstrap = mcpAlsoSelected
			? `\n			// Mount the MCP server on the HTTP process's shared Hono app.
			// McpTrigger.constructor(app, httpTrigger?) mirrors SSE / WS / Webhook —
			// it registers its SSE (/<path>/sse + /<path>/messages) and
			// Streamable-HTTP (/<path>) routes inside addPreCatchAllHook so they
			// win Hono's first-match dispatch over the legacy workflow catch-all.
			// Workflows with \`trigger.mcp\` (registered above) become MCP tools /
			// resources; tools/call runs them through the runner.
			const mcpTrigger = new McpTrigger(this.httpTrigger.getApp(), this.httpTrigger);
			mcpTrigger.setNodeMap({
				nodes: subTriggerNodeMap,
				workflows: sharedWorkflows as unknown as Parameters<typeof mcpTrigger.setNodeMap>[0]["workflows"],
			});
			await mcpTrigger.listen();`
			: "";
		const fullBootstrap = `${sharedBootstrapPrelude}${sseBootstrap}${wsBootstrap}${webhookBootstrap}${mcpBootstrap}`;
		return `import { DefaultLogger } from "@blokjs/runner";
import { type Span, metrics, trace } from "@opentelemetry/api";
import HttpTrigger from "./runner/HttpTrigger";${sharedHelperImports}${sseImports}${wsImports}${webhookImports}${mcpImports}

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

	if (triggerKind === "cron") {
		// Cron is a portless scheduler: CronServer.listen() reads the
		// cron-triggered workflows, schedules a CronJob per workflow, and
		// returns — the job timers keep the event loop alive. Mirrors the
		// pubsub/worker entry shape (no HTTP listener to bind).
		return `import { DefaultLogger } from "@blokjs/runner";
import { type Span, metrics, trace } from "@opentelemetry/api";
import CronServer from "./runner/CronServer";

export default class App {
	private cronServer: CronServer = <CronServer>{};
	protected trigger_initializer = 0;
	protected initializer = 0;
	protected tracer = trace.getTracer(
		process.env.PROJECT_NAME || "trigger-cron-server",
		process.env.PROJECT_VERSION || "0.0.1",
	);
	private logger = new DefaultLogger();
	protected app_cold_start = metrics.getMeter("default").createGauge("initialization", {
		description: "Application cold start",
	});

	constructor() {
		this.initializer = performance.now();
		this.cronServer = new CronServer();
	}

	async run() {
		this.tracer.startActiveSpan("initialization", async (span: Span) => {
			await this.cronServer.listen();
			this.initializer = performance.now() - this.initializer;

			this.logger.log(\`Cron trigger initialized in \${(this.initializer).toFixed(2)}ms\`);
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

	if (triggerKind === "grpc") {
		// The gRPC trigger serves this project's nodes + workflows over HTTP/2
		// (h2c) via the package's GrpcServer, which runs its own tracer span +
		// cold-start metric internally (so no App wrapper here). Pass the
		// scaffold's Nodes/Workflows so clients can invoke the project's nodes —
		// GrpcServer defaults to the package's built-ins when none are injected.
		// GrpcServer reads GRPC_PORT/GRPC_HOST; blokctl dev sets PORT to the
		// trigger's configured port, so fall back through PORT.
		return `import { GrpcServer } from "@blokjs/trigger-grpc";
import nodes from "../../Nodes";
import workflows from "../../Workflows";

const host = process.env.GRPC_HOST || "0.0.0.0";
const port = Number(process.env.GRPC_PORT || process.env.PORT || 4003);

if (process.env.DISABLE_TRIGGER_RUN !== "true") {
	new GrpcServer({ host, port, nodes, workflows }).start();
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
/**
 * Generate src/triggers/cron/runner/CronServer.ts — the thin wrapper that
 * bootstraps the cron trigger. CronTrigger (from @blokjs/trigger-cron) is an
 * abstract TriggerBase subclass that consumes `protected nodes`/`protected
 * workflows` and does all NodeMap + WorkflowRegistry wiring + CronJob
 * scheduling itself inside listen(). So the wrapper is purely declarative —
 * identical to the pubsub/worker Server templates, minus the broker adapter.
 * Generated inline (not copied) because triggers/cron ships no template/ dir;
 * the `../../../Nodes` depth matches its home at src/triggers/cron/runner/.
 */
/**
 * Generate src/workflows/cron/heartbeat.ts — a runnable cron workflow so a
 * fresh `--triggers cron` scaffold has something to schedule out of the box
 * (otherwise CronServer.listen() finds no cron workflows and the process
 * exits immediately, looking like a dead trigger). Cron discovers workflows
 * from src/Workflows.ts, NOT the HTTP JSON auto-scan, so this is registered
 * in generateSharedWorkflowsFile's cron branch. Uses @blokjs/expr (a
 * HELPER_NODE, always registered) so it runs locally with no network.
 */
export function generateCronExampleWorkflowFile(): string {
	return `import { node, step, workflow } from "@blokjs/core";

/**
 * Cron heartbeat — fires on a schedule, NOT on an HTTP request. \`blokctl dev\`
 * boots it via src/triggers/cron/index.ts and it fires every minute. The
 * schedule accepts an optional leading seconds field (e.g. \`* * * * * *\` for
 * every second). Add more cron workflows by exporting them and registering
 * them in src/Workflows.ts.
 */
export default workflow(
	"Cron Heartbeat",
	{ version: "1.0.0", trigger: { cron: { schedule: "* * * * *", timezone: "UTC" } } },
	() => {
		step("heartbeat", node("@blokjs/expr"), { expression: "({ ok: true, at: Date.now() })" }, { ephemeral: true });
	},
);
`;
}

export function generateCronServerFile(): string {
	return `import { CronTrigger } from "@blokjs/trigger-cron";
import nodes from "../../../Nodes";
import workflows from "../../../Workflows";

/**
 * CronServer — the cron trigger for this project.
 *
 * CronTrigger.listen() populates the NodeMap, registers workflows with the
 * WorkflowRegistry, then schedules a CronJob for every workflow whose trigger
 * is \`{ cron: { schedule, timezone? } }\`. There is no port to bind — the
 * scheduled job timers keep the process alive. Non-cron workflows sharing this
 * Workflows.ts are ignored by the scheduler (they run under their own trigger).
 */
export default class CronServer extends CronTrigger {
	protected nodes: Record<string, import("@blokjs/runner").BlokService<unknown>> = nodes;
	protected workflows: Record<string, import("@blokjs/helper").WorkflowV2Builder> = workflows;
}
`;
}

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
			const w = wf as unknown as {
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
			const w = wf as unknown as {
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
	} else if (triggerKind === "queue" || triggerKind === "worker") {
		// "queue" (legacy) and "worker" (v0.6.11+) both → trigger-worker template (WorkerServer.ts)
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
	if (!config) {
		// Providers without a managed-SDK adapter (nats, redis-streams, kafka)
		// resolve at runtime via the workflow's `provider` field / BLOK_PUBSUB_ADAPTER
		// / the "nats" fallback. But the template hardcodes `protected adapter = new
		// GCPPubSubAdapter(...)`, and an ACTIVE `this.adapter` SHORT-CIRCUITS that
		// resolution (PubSubTrigger.resolveAdapterForWorkflow rung 1). So for these
		// providers, drop the GCP default — leave `this.adapter` undefined — exactly
		// like the worker template leaves it undefined for the in-memory default.
		content = content.replace(
			/import \{ GCPPubSubAdapter, PubSubTrigger \} from ["']@blokjs\/trigger-pubsub["'];/,
			'import { PubSubTrigger } from "@blokjs/trigger-pubsub";',
		);
		content = content.replace(/\n\tprotected adapter = new GCPPubSubAdapter\(\{[\s\S]*?\}\);\n/, "");
		fsExtra.writeFileSync(serverPath, content);
		return;
	}

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
export function updateQueueProvider(triggerDestDir: string, provider: string, explicit: boolean): void {
	const serverPath = `${triggerDestDir}/runner/WorkerServer.ts`;
	if (!fsExtra.existsSync(serverPath)) return;

	let content = fsExtra.readFileSync(serverPath, "utf8");

	// No provider was explicitly chosen → leave the commented resolution block
	// in place. `this.adapter` stays undefined, so the framework resolves
	// provider → BLOK_WORKER_ADAPTER → in-memory (boots clean, zero infra).
	if (!explicit) return;

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

	// Add the adapter import alongside the existing WorkerTrigger import.
	content = content.replace(
		/import \{ WorkerTrigger \} from ["']@blokjs\/trigger-worker["'];/,
		`import { ${config.importName}, WorkerTrigger } from "@blokjs/trigger-worker";`,
	);

	// INSERT the active adapter into the class header. The template ships only a
	// commented example (no active `protected adapter = …`), so we match the
	// class declaration and inject the assignment rather than replacing one.
	content = content.replace(
		/(export default class \w+ extends WorkerTrigger \{)/,
		`$1\n\tprotected adapter = ${config.init};\n`,
	);

	fsExtra.writeFileSync(serverPath, content);
}

/**
 * Get provider-specific dependencies for pubsub and queue triggers.
 *
 * Broker deps for the worker/queue trigger are only added when the user
 * EXPLICITLY chose a provider — the default in-memory adapter needs no deps.
 */
export function getProviderDependencies(
	triggers: string[],
	pubsubProvider: string,
	queueProvider: string,
	explicitQueueProvider = false,
): Record<string, string> {
	const deps: Record<string, string> = {};

	const pubsubProviderDeps: Record<string, Record<string, string>> = {
		nats: { nats: "^2.28.0" },
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

	if (
		explicitQueueProvider &&
		(triggers.includes("queue") || triggers.includes("worker")) &&
		queueProviderDeps[queueProvider]
	) {
		Object.assign(deps, queueProviderDeps[queueProvider]);
	}

	return deps;
}

/**
 * Get provider-specific environment variables for pubsub and queue triggers.
 *
 * When a worker/queue trigger is selected but no provider was EXPLICITLY chosen,
 * write `BLOK_WORKER_ADAPTER=in-memory` (the zero-infra dev default) instead of
 * a broker block — matching the scaffolded WorkerServer, which leaves
 * `this.adapter` undefined so the framework resolves to in-memory.
 */
export function getProviderEnvVars(
	triggers: string[],
	pubsubProvider: string,
	queueProvider: string,
	explicitQueueProvider = false,
): string {
	const lines: string[] = [];

	const pubsubEnvVars: Record<string, string> = {
		nats: `
# NATS (local pub/sub broker — zero cloud setup)
NATS_SERVERS=localhost:4222
BLOK_PUBSUB_ADAPTER=nats`,
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

	const hasWorkerTrigger = triggers.includes("queue") || triggers.includes("worker");
	if (hasWorkerTrigger) {
		if (explicitQueueProvider && queueEnvVars[queueProvider]) {
			lines.push(queueEnvVars[queueProvider]);
		} else {
			// No explicit broker → zero-infra in-memory dev default.
			lines.push(
				"\n# Worker adapter — dev default. Set a provider + the matching broker env" +
					"\n# (KAFKA_*, NATS_SERVERS, REDIS_*, etc.) for production.\nBLOK_WORKER_ADAPTER=in-memory",
			);
		}
	}

	return lines.join("\n");
}
