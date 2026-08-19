import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DefaultLogger } from "@blokjs/runner";
import { type Span, metrics, trace } from "@opentelemetry/api";
import WorkerServer from "./runner/WorkerServer.js";

// #721 — see triggers/http/src/index.ts for why this compares realpath'd
// paths instead of `import.meta.main` (Node only unflagged it in v22.18.0;
// this template ships to scaffolded projects with engines >=18).
function isMainModule(moduleUrl: string): boolean {
	if (!process.argv[1]) return false;
	try {
		return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(process.argv[1]);
	} catch {
		return false;
	}
}

export default class App {
	private workerServer: WorkerServer = <WorkerServer>{};
	protected trigger_initializer = 0;
	protected initializer = 0;
	protected tracer = trace.getTracer(
		process.env.PROJECT_NAME || "trigger-worker-server",
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

			this.logger.log(`Worker trigger initialized in ${this.initializer.toFixed(2)}ms`);
			this.app_cold_start.record(this.initializer, {
				pid: process.pid,
				env: process.env.NODE_ENV,
				app: process.env.APP_NAME,
			});
			span.end();
		});
	}
}

if (isMainModule(import.meta.url) && process.env.DISABLE_TRIGGER_RUN !== "true") {
	new App().run();
}
