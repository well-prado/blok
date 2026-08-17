import color from "picocolors";
import { type OptionValues, program, trackCommandExecution, withErrorBoundary } from "../../services/commander.js";
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
	.action(
		withErrorBoundary(async (options: OptionValues) => {
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
					// KEEP the process.exit here (#899 allow-list): `watch` streams
					// until interrupted, and this is the terminal step of its
					// SIGINT/SIGTERM handler. Aborting alone leaves the reader
					// unwinding while the user has already asked to stop.
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
							// Throwing here propagates out of connectEventStream (every
							// onError call site is followed by a return, not swallowed),
							// so the boundary prints it once and sets the exit code.
							onError: (err) => {
								throw new Error(
									`stream error: ${err.message}\n` +
										`Is a Blok server running at ${url}? In production the trace API requires auth — pass --token.`,
								);
							},
						},
					);
				},
			});
		}),
	);
