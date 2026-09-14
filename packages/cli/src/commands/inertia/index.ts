import { Command, type OptionValues, program, withErrorBoundary } from "../../services/commander.js";
import { runDoctor } from "./doctor.js";
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

inertia
	.command("doctor")
	.description("Check an Inertia project's shell, pages, secrets, assets, CSRF and SSR wiring")
	.option("--dir <dir>", "Directory holding the workflow modules", "src")
	.action(withErrorBoundary(async (options: OptionValues) => runDoctor({ dir: options.dir as string | undefined })));

program.addCommand(inertia);

export { checkSsr, startSsr, stopSsr } from "./ssr.js";
export { inertiaDoctor, runDoctor } from "./doctor.js";
export type { DoctorCheck, DoctorOptions } from "./doctor.js";
