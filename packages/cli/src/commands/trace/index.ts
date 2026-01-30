import { type OptionValues, program, trackCommandExecution } from "../../services/commander.js";
import { startStudio } from "./startStudio.js";

program
	.command("trace")
	.alias("studio")
	.description("Open Blok Studio — real-time workflow trace UI")
	.option("-p, --port <port>", "Studio UI port", "5555")
	.option("-u, --url <url>", "Blok backend URL", "http://localhost:4000")
	.option("--workflow <name>", "Open specific workflow")
	.option("--run <id>", "Open specific run")
	.option("--no-open", "Don't auto-open browser")
	.action(async (options: OptionValues) => {
		await trackCommandExecution({
			command: "trace",
			args: options,
			execution: async () => {
				await startStudio({
					port: Number.parseInt(options.port as string, 10),
					url: options.url as string,
					workflow: options.workflow as string | undefined,
					run: options.run as string | undefined,
					open: options.open as boolean,
				});
			},
		});
	});
