import { Command, type OptionValues, program, withErrorBoundary } from "../../services/commander.js";
import { checkSsr, startSsr, stopSsr } from "./ssr.js";

const inertia = new Command("inertia").description("Manage the Inertia integration");

inertia
	.command("start-ssr")
	.description("Start the built Inertia SSR server")
	.option("--runtime <runtime>", "Runtime binary: node, bun, or an absolute path")
	.option("--port <port>", "SSR server port", "13714")
	.option("--host <host>", "SSR server host", "127.0.0.1")
	.option("--cluster", "Enable Inertia's clustered SSR server")
	.action(withErrorBoundary(async (options: OptionValues) => startSsr(options)));

inertia
	.command("stop-ssr")
	.description("Stop the Inertia SSR server")
	.action(withErrorBoundary(async () => stopSsr()));

inertia
	.command("check-ssr")
	.description("Check the Inertia SSR server health")
	.action(
		withErrorBoundary(async () => {
			if (!(await checkSsr())) throw new Error("Inertia SSR server is not running.");
			console.log("OK");
		}),
	);

program.addCommand(inertia);

export { checkSsr, startSsr, stopSsr } from "./ssr.js";
