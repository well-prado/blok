import * as p from "@clack/prompts";
import { type OptionValues, program, trackCommandExecution } from "../../services/commander.js";
import { isNonInteractive } from "../../services/non-interactive.js";

import { BLOK_URL } from "../../services/constants.js";
import { tokenManager } from "../../services/local-token-manager.js";

async function verifyToken(token: string) {
	const response = await fetch(`${BLOK_URL}/login`, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${token}`,
		},
	});

	if (!response.ok) throw new Error(response.statusText);
	const responseJson = await response.json();

	return responseJson;
}

export async function login(opts: OptionValues) {
	let token = tokenManager.getToken();
	const BLOKS_TOKEN = process.env.BLOKS_TOKEN as string;

	const resolveToken = async (): Promise<string> => {
		let token = process.env.BLOKS_TOKEN;
		if (token) return token;
		token = (await p.password({
			message:
				"Please provide the token for authentication. You can create it on https://atomic.deskree.com/auth/access/token",
		})) as string;

		if (p.isCancel(token)) {
			p.cancel("Authentication cancelled.");
			process.exit(0);
		}

		return token;
	};

	try {
		if (!token && !BLOKS_TOKEN && !opts.token) {
			if (isNonInteractive()) {
				throw new Error(
					"Missing required flag --token or BLOKS_TOKEN env var (non-interactive mode). " +
						"Run without --non-interactive to use interactive prompts, or provide --token.",
				);
			}
			token = await resolveToken();
		} else if (opts.token) {
			token = opts.token;
		} else if (BLOKS_TOKEN) {
			token = BLOKS_TOKEN;
		}

		if (!token) throw new Error("Token is required.");

		const isTokenValid = await verifyToken(token);
		if (!isTokenValid.active) throw new Error("Token is inactive.");

		p.log.success("Login successful.");

		const isStored = tokenManager.storeToken(token);
		if (!isStored) throw new Error("Failed to store the token.");
		p.log.info("You can now use the CLI commands. For help, run: blokctl --help");
	} catch (error) {
		p.log.error("Login failed. Please try again.");
		p.log.error((error as Error).message);
		// Signal failure instead of exiting: an exported function that calls
		// process.exit() kills any host process that imports it (tests,
		// programmatic callers, Studio embedding) and drops pending work like
		// the telemetry flush below (#891). process.exitCode marks the exit
		// status without forcing an immediate exit; rethrowing lets
		// trackCommandExecution (posthog.ts) record status:"error" before the
		// command boundary below decides what to do with it.
		process.exitCode = 1;
		throw error;
	}
}

// Login command
program
	.command("login")
	.description("Login to Bloks")
	.option("-t, --token <value>", "Login with a token")
	.action(async (options: OptionValues) => {
		try {
			await trackCommandExecution({
				command: "login",
				args: options,
				execution: async () => {
					await login(options);
				},
			});
		} catch {
			// login() already logged the failure and set process.exitCode = 1.
			// Swallow the rethrow here — this action callback is the CLI
			// boundary; without this catch the rejection would be unhandled
			// (Commander's program.parse() doesn't await async actions), and
			// Node would report it as an uncaught exception instead of the
			// clean non-zero exit already set above.
		}
	});
