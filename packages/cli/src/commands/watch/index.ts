import color from "picocolors";
import { type OptionValues, program, trackCommandExecution } from "../../services/commander.js";
import { tokenManager } from "../../services/local-token-manager.js";
import { formatEvent } from "./format.js";
import { connectEventStream } from "./sse.js";

program
	.command("watch")
	.description("Watch workflow executions live in the terminal (streams /__blok/stream)")
	.option("-u, --url <url>", "Blok backend URL", "http://localhost:4000")
	.option("--token <token>", "Auth token for the trace API (required in production)")
	.option("-w, --workflow <names>", "Comma-separated workflow names to watch (default: all)")
	.option("--verbose", "Also show node-started / skipped / scheduling events")
	.option("--no-color", "Disable ANSI colors (pipe-friendly)")
	.action(async (options: OptionValues) => {
		await trackCommandExecution({
			command: "watch",
			args: options,
			execution: async () => {
				const url = (options.url as string) || "http://localhost:4000";
				const token = (options.token as string | undefined) ?? tokenManager.getToken() ?? undefined;
				const useColor = options.color !== false;
				const verbose = Boolean(options.verbose);
				const workflows = options.workflow
					? String(options.workflow)
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean)
					: undefined;

				const controller = new AbortController();
				const stop = (code: number) => {
					controller.abort();
					process.stdout.write("\n");
					process.exit(code);
				};
				process.once("SIGINT", () => stop(0));
				process.once("SIGTERM", () => stop(0));

				const where = workflows ? ` (workflows: ${workflows.join(", ")})` : "";
				process.stdout.write(color.dim(`Watching ${url}/__blok/stream${where} — Ctrl-C to stop\n\n`));

				await connectEventStream(
					url,
					{ token, workflows, signal: controller.signal },
					{
						onEvent: (event) => {
							const line = formatEvent(event, { color: useColor, verbose });
							if (line) process.stdout.write(`${line}\n`);
						},
						onError: (err) => {
							process.stderr.write(color.red(`\nstream error: ${err.message}\n`));
							process.stderr.write(
								color.dim(
									`Is a Blok server running at ${url}? In production the trace API requires auth — pass --token.\n`,
								),
							);
							process.exit(1);
						},
					},
				);
			},
		});
	});
