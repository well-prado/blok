/**
 * `blokctl add <thing>` — wire an optional layer into an EXISTING Blok project,
 * as opposed to `blokctl create`, which makes a new one. First member: `spa`
 * (#999).
 */
import {
	Command,
	type OptionValues,
	program,
	trackCommandExecution,
	withErrorBoundary,
} from "../../services/commander.js";
import { addSpa } from "../create/spa.js";

const add = new Command("add").description("Add a capability to an existing Blok project");

add
	.command("spa")
	.description("Add an Inertia SPA client (client/) and wire it into this Blok project")
	.option("-f, --framework <value>", "Frontend framework: react, vue, svelte")
	.option("--blok-url <url>", "Blok server the dev proxy forwards to (default: http://localhost:4000)")
	.option("--pm <value>", "Package manager: npm, yarn, pnpm, bun")
	.option("--no-install", "Skip installing dependencies")
	.option("--ssr", "Also scaffold the Inertia SSR entry and the build:ssr script")
	.option("--kit <value>", "Starter kit to include: auth (sessions, sign-in/up/reset pages)")
	.option("-l, --local <path>", "Link @blokjs/* from a local repo checkout instead of npm")
	.action(
		withErrorBoundary(async (options: OptionValues) => {
			await trackCommandExecution({
				command: "add spa",
				args: options,
				execution: async () => {
					await addSpa(options, "", options.local);
				},
			});
		}),
	);

program.addCommand(add);
