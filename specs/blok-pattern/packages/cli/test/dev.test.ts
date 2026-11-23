import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, NODE, cleanUp, project, write } from "./helpers.ts";

afterAll(cleanUp);

async function until(what: string, holds: () => boolean, seen: () => string) {
	const deadline = Date.now() + 15_000;
	while (!holds()) {
		if (Date.now() > deadline) throw new Error(`Still waiting for ${what}. Output so far:\n${seen()}`);
		await new Promise((done) => setTimeout(done, 50));
	}
}
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("dev rebuilds on a change, restarts the app on a good build, and keeps it running on a bad one", async () => {
	const dir = project();
	// The "app" says which path it was built with and writes down its pid, then waits.
	write(
		dir,
		"app.mjs",
		`import { readFileSync, writeFileSync } from "node:fs";
const path = JSON.parse(readFileSync(".blok/workflows/hello.json", "utf8")).trigger.http.path;
writeFileSync("app.pid", String(process.pid));
console.log("APP " + path);
setInterval(() => {}, 1000);
`,
	);
	let output = "";
	const dev = spawn(NODE, [CLI, "dev", "--", NODE, "app.mjs"], { cwd: dir });
	dev.stdout.on("data", (chunk) => {
		output += chunk;
	});
	dev.stderr.on("data", (chunk) => {
		output += chunk;
	});
	const seen = () => output;
	try {
		await until("the first start", () => output.includes("APP /hello"), seen);
		const firstPid = Number(readFileSync(join(dir, "app.pid"), "utf8"));

		// A good change: rebuilt, and the app is a new process that sees it.
		const hello = readFileSync(join(dir, "workflows/hello.pkl"), "utf8");
		writeFileSync(join(dir, "workflows/hello.pkl"), hello.replace('path = "/hello"', 'path = "/hi"'));
		await until("the restart", () => output.includes("APP /hi"), seen);
		const secondPid = Number(readFileSync(join(dir, "app.pid"), "utf8"));
		expect(secondPid).not.toBe(firstPid);
		expect(alive(firstPid)).toBe(false);

		// A bad change: the problem is printed and the last good app is left alone.
		writeFileSync(join(dir, "workflows/hello.pkl"), hello.replace("greeting.outputs.at", "greeting.outputs.time"));
		await until("the report", () => output.includes("The app keeps running on the last good build."), seen);
		expect(output).toContain("Cannot find property `time`");
		expect(alive(secondPid)).toBe(true);

		// Fixing the mistake starts a new app on the new build.
		writeFileSync(join(dir, "workflows/hello.pkl"), hello.replace('path = "/hello"', 'path = "/hey"'));
		await until("the recovery", () => output.includes("APP /hey"), seen);
		const thirdPid = Number(readFileSync(join(dir, "app.pid"), "utf8"));

		// Stopping dev stops the app with it.
		const gone = new Promise((done) => dev.once("exit", done));
		dev.kill("SIGTERM");
		await gone;
		await until("the app to stop", () => !alive(thirdPid), seen);
	} finally {
		dev.kill("SIGKILL");
	}
}, 60_000);
