// The AI loop, run for real: one design pass, then one agent per node, each on its own git branch,
// then every branch merged and the result checked. This script does everything except be the agents.
//
//   bun factory/factory.ts start <run>      a new app in its own git repository, with the packages installed
//   (the design agent works in <run>/app, with the brief from `blokctl prompt design`)
//   bun factory/factory.ts fan-out <run> [n]  commit the design, then one branch per empty node, dealt to n agents
//   (one build agent per job in <run>/jobs.json, each in its own worktree)
//   bun factory/factory.ts join <run>       commit each agent's work, merge every branch, check, and report
//
// <run> is a name. Runs live in .blok/factory/, which git and Biome both ignore.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dirname, "..");
const [command, name, agentCount] = process.argv.slice(2);
if (!command || !name) throw new Error("Usage: bun factory/factory.ts start|refresh|fan-out|join <run> [agents]");
const run = join(repo, ".blok", "factory", name);
const app = join(run, "app");
const blokctl = join(app, "node_modules", ".bin", "blokctl");

function sh(cwd: string, bin: string, ...args: string[]): { ok: boolean; out: string } {
	const result = spawnSync(bin, args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, npm_config_user_agent: "bun/1.3.0" },
	});
	return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}
function must(cwd: string, bin: string, ...args: string[]): string {
	const result = sh(cwd, bin, ...args);
	if (!result.ok) throw new Error(`"${bin} ${args.join(" ")}" failed in ${cwd}:\n${result.out}`);
	return result.out;
}
const git = (cwd: string, ...args: string[]) =>
	must(cwd, "git", "-c", "user.name=factory", "-c", "user.email=factory@example.invalid", ...args);
const json = (cwd: string, ...args: string[]) => JSON.parse(sh(cwd, blokctl, ...args, "--json").out);

interface Job {
	id: string;
	branch: string;
	/** The agent's own copy of the app. */
	worktree: string;
	/** The one folder it may change, inside the worktree. */
	folder: string;
	brief: string;
}
const jobsFile = join(run, "jobs.json");

/** Packs the two packages as they would be published, so the app is a real install and not a link into this repo. */
function pack(): { cli: string; kernel: string } {
	must(repo, "bun", "run", "build");
	const packed = join(run, "tarballs");
	rmSync(packed, { recursive: true, force: true });
	mkdirSync(packed, { recursive: true });
	for (const pkg of ["kernel", "cli"]) {
		must(join(repo, "packages", pkg), "bun", "pm", "pack", "--destination", packed, "--quiet");
	}
	const [cli, kernel] = readdirSync(packed)
		.sort()
		.map((file) => join(packed, file));
	return { cli, kernel };
}

if (command === "start") {
	if (existsSync(run)) throw new Error(`${run} already exists. Pick another name, or delete it.`);
	mkdirSync(run, { recursive: true });
	const { cli, kernel } = pack();

	must(run, "node", join(repo, "packages", "cli", "dist", "cli.js"), "init", "app");
	// The sample node and workflow are not part of what gets designed.
	rmSync(join(app, "nodes", "hello"), { recursive: true });
	rmSync(join(app, "workflows", "hello.pkl"));
	const manifestFile = join(app, "package.json");
	const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
	manifest.name = name;
	manifest.dependencies["@blokjs/kernel"] = `file:${kernel}`;
	manifest.devDependencies.blokctl = `file:${cli}`;
	manifest.overrides = { "@blokjs/kernel": `file:${kernel}` };
	writeFileSync(manifestFile, `${JSON.stringify(manifest, null, "\t")}\n`);
	must(app, "bun", "install");
	git(app, "init", "-q", "-b", "main");
	git(app, "add", "-A");
	git(app, "commit", "-q", "-m", "Scaffold");
	writeFileSync(join(run, "design-brief.md"), `${must(app, blokctl, "prompt", "design")}\n\n`);
	console.log(
		`The app is at ${app}\nThe design brief is at ${join(run, "design-brief.md")}. Add the description of the app to it.`,
	);
}

// The tool changed while a run was under way: install the current build into the app, and refresh its rules page.
if (command === "refresh") {
	pack();
	rmSync(join(app, "node_modules"), { recursive: true, force: true });
	rmSync(join(app, "bun.lock"), { force: true });
	must(app, "bun", "install");
	must(app, blokctl, "init");
	console.log(sh(app, blokctl, "check").out);
}

if (command === "fan-out") {
	const status = json(app, "status");
	const problems: string[] = [...status.problems];
	if (status.total === 0) problems.push("The design has no nodes.");
	if (status.unlocked.length > 0) problems.push(`These nodes are not locked: ${status.unlocked.join(", ")}.`);
	const written = status.nodes.filter((node: { empty: boolean }) => !node.empty).map((node: { id: string }) => node.id);
	if (problems.length > 0) throw new Error(`The design is not ready to fan out:\n- ${problems.join("\n- ")}`);

	git(app, "add", "-A");
	git(app, "commit", "-q", "-m", `Design: ${status.total} nodes, all contracts locked`);
	const jobs: Job[] = [];
	for (const id of status.empty as string[]) {
		const slug = id.replaceAll("/", "-").replace("@", "-v");
		const worktree = join(run, "wt", slug);
		git(app, "worktree", "add", "-q", worktree, "-b", `node/${slug}`);
		// One install serves every copy. The link is never committed: join only commits the node's own folder.
		symlinkSync(join(app, "node_modules"), join(worktree, "node_modules"), "dir");
		const built = JSON.parse(sh(worktree, blokctl, "prompt", "build", id, "--json").out);
		jobs.push({ id, branch: `node/${slug}`, worktree, folder: built.folder, brief: built.prompt });
	}
	writeFileSync(jobsFile, `${JSON.stringify(jobs, null, "\t")}\n`);
	console.log(
		`${jobs.length} jobs, one per empty node, in ${jobsFile}.${written.length > 0 ? ` Already written by the design pass: ${written.join(", ")}.` : ""}`,
	);

	// Each brief in a file of its own, and the jobs dealt out to the agents. The jobs are in id order,
	// so an agent that gets more than one gets neighbours, which are usually nodes of the same module.
	mkdirSync(join(run, "briefs"), { recursive: true });
	for (const job of jobs) writeFileSync(join(run, "briefs", `${job.branch.slice("node/".length)}.md`), job.brief);
	const agents = Math.min(jobs.length, Number(agentCount) || jobs.length);
	const dealt: Array<{ agent: number; jobs: Array<{ id: string; worktree: string; brief: string }> }> = [];
	let next = 0;
	for (let agent = 1; agent <= agents; agent++) {
		// The first few agents take one more when the jobs do not divide evenly.
		const size = Math.floor(jobs.length / agents) + (agent <= jobs.length % agents ? 1 : 0);
		dealt.push({
			agent,
			jobs: jobs.slice(next, next + size).map((job) => ({
				id: job.id,
				worktree: job.worktree,
				brief: join(run, "briefs", `${job.branch.slice("node/".length)}.md`),
			})),
		});
		next += size;
	}
	writeFileSync(join(run, "agents.json"), `${JSON.stringify(dealt, null, "\t")}\n`);
	for (const { agent, jobs: mine } of dealt)
		console.log(`  agent ${String(agent).padStart(2)}: ${mine.map((job) => job.id).join(", ")}`);
}

if (command === "join") {
	const jobs: Job[] = JSON.parse(readFileSync(jobsFile, "utf8"));
	const report = {
		run: name,
		nodes: jobs.length,
		/** Per node, before anything is merged: did the agent finish it, and did it stay in its folder? */
		jobs: [] as Array<{ id: string; done: boolean; outside: string[]; problems: string[] }>,
		merges: { clean: 0, conflicted: [] as string[] },
		after: { check: "", build: "", empty: [] as string[] },
	};

	for (const job of jobs) {
		// What the agent changed. Anything outside its own folder is recorded and left out of the commit.
		// Read raw: each line starts with a two-letter state that may be a space, so the text must not be trimmed.
		const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
			cwd: job.worktree,
			encoding: "utf8",
		});
		const changed = (status.stdout ?? "")
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => line.slice(3).replace(/^"|"$/g, ""))
			.filter((file) => file !== "node_modules");
		const outside = changed.filter((file) => !file.startsWith(`${job.folder}/`));
		const gate = json(job.worktree, "check", job.id);
		report.jobs.push({ id: job.id, done: gate.ok === true, outside, problems: gate.ok ? [] : gate.problems });
		if (changed.some((file) => file.startsWith(`${job.folder}/`))) {
			git(job.worktree, "add", "--", job.folder);
			git(job.worktree, "commit", "-q", "-m", `Write ${job.id}`);
		}
	}

	// One merge per branch, in order. A conflict is counted and that branch is left out.
	for (const job of jobs) {
		const merged = sh(
			app,
			"git",
			"-c",
			"user.name=factory",
			"-c",
			"user.email=factory@example.invalid",
			"merge",
			"--no-ff",
			"--no-edit",
			"-q",
			job.branch,
		);
		if (merged.ok) report.merges.clean++;
		else {
			report.merges.conflicted.push(job.id);
			sh(app, "git", "merge", "--abort");
		}
	}

	const check = sh(app, blokctl, "check", "--tests");
	report.after.check = check.out;
	report.after.build = sh(app, blokctl, "build").out;
	report.after.empty = json(app, "status").empty;
	writeFileSync(join(run, "report.json"), `${JSON.stringify(report, null, "\t")}\n`);

	const done = report.jobs.filter((job) => job.done).length;
	const strayed = report.jobs.filter((job) => job.outside.length > 0);
	console.log(`Nodes written and passing their own gate: ${done} of ${jobs.length}`);
	for (const job of report.jobs.filter((entry) => !entry.done))
		console.log(`  not done: ${job.id}\n    ${job.problems.join("\n    ").split("\n").slice(0, 6).join("\n")}`);
	console.log(`Agents that changed a file outside their folder: ${strayed.length}`);
	for (const job of strayed) console.log(`  ${job.id}: ${job.outside.join(", ")}`);
	console.log(
		`Merges: ${report.merges.clean} clean, ${report.merges.conflicted.length} conflicted${report.merges.conflicted.length > 0 ? ` (${report.merges.conflicted.join(", ")})` : ""}`,
	);
	console.log(`After merging, "blokctl check --tests" says:\n${check.out.replace(/^/gm, "  ")}`);
	console.log(`"blokctl build" says:\n${report.after.build.replace(/^/gm, "  ")}`);
	console.log(`The full report is at ${join(run, "report.json")}`);
}
