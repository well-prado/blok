import { DefaultLogger } from "@blokjs/runner";
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

			this.logger.log(`Pub/Sub trigger initialized in ${this.initializer.toFixed(2)}ms`);
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
