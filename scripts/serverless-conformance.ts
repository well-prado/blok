import fs from "node:fs";
import path from "node:path";
import { type ServerlessHttpTrigger, createVercelHandler } from "../triggers/http/src/serverless.ts";

type CaseResult = { name: string; passed: boolean; detail?: string };

async function main(): Promise<void> {
	const results: CaseResult[] = [];
	const record = async (name: string, check: () => Promise<void>): Promise<void> => {
		try {
			await check();
			results.push({ name, passed: true });
		} catch (error) {
			results.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) });
		}
	};

	let prepared = 0;
	let requests = 0;
	const trigger: ServerlessHttpTrigger = {
		prepare: async () => {
			prepared++;
		},
		fetch: async (request) => {
			requests++;
			return Response.json({ method: request.method, contentType: request.headers.get("content-type") });
		},
	};
	const handler = createVercelHandler({ createTrigger: () => trigger });
	await record("cold-start-preparation", async () => {
		const responses = await Promise.all([
			handler(new Request("https://conformance.test/one")),
			handler(new Request("https://conformance.test/two")),
		]);
		if (responses.some((response) => response.status !== 200) || prepared !== 1) throw new Error("not single-flight");
	});
	await record("get-request", async () => {
		if ((await handler(new Request("https://conformance.test/health"))).status !== 200) throw new Error("GET failed");
	});
	await record("json-post", async () => {
		const response = await handler(
			new Request("https://conformance.test/api", {
				method: "POST",
				body: "{}",
				headers: { "content-type": "application/json" },
			}),
		);
		if (response.status !== 200) throw new Error("JSON POST failed");
	});
	await record("form-post", async () => {
		const response = await handler(
			new Request("https://conformance.test/api", {
				method: "POST",
				body: "name=blok",
				headers: { "content-type": "application/x-www-form-urlencoded" },
			}),
		);
		if (response.status !== 200) throw new Error("form POST failed");
	});
	await record("cookie-forwarding", async () => {
		const response = await handler(
			new Request("https://conformance.test/api", { headers: { cookie: "session=opaque" } }),
		);
		if (response.status !== 200) throw new Error("cookie failed");
	});
	await record("warm-reuse", async () => {
		await handler(new Request("https://conformance.test/warm"));
		if (prepared !== 1 || requests < 5) throw new Error("warm instance was not reused");
	});
	await record("request-response-preservation", async () => {
		const response = await handler(new Request("https://conformance.test/preserve"));
		if (!(response instanceof Response)) throw new Error("response was not preserved");
	});
	await record("machine-readable-errors", async () => {
		const failing = createVercelHandler({
			createTrigger: () => ({
				prepare: async () => {},
				fetch: async () => {
					throw new Error("secret-not-returned");
				},
			}),
			logError: () => {},
		});
		const response = await failing(new Request("https://conformance.test/fail"));
		const body = await response.json();
		if (response.status !== 500 || body.code !== "BLOK_SERVERLESS_REQUEST_FAILED" || body.failure !== "Error")
			throw new Error("error contract failed");
	});

	const report = {
		version: 1,
		runtime: process.versions.bun ? "bun" : "node",
		cases: results,
		passed: results.filter((result) => result.passed).length,
		failed: results.filter((result) => !result.passed).length,
	};
	const output = path.resolve("artifacts/serverless-conformance.json");
	fs.mkdirSync(path.dirname(output), { recursive: true });
	fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify(report, null, 2));
	if (report.failed > 0) process.exitCode = 1;
}

await main();
