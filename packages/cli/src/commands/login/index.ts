import * as p from "@clack/prompts";
import { type OptionValues, program, trackCommandExecution, withErrorBoundary } from "../../services/commander.js";
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
		// Rethrow instead of exiting: an exported function that calls
		// process.exit() kills any host process that imports it (tests,
		// programmatic callers, Studio embedding) and drops pending work like
		// the telemetry flush (#891). Rethrowing lets trackCommandExecution
		// (posthog.ts) record status:"error", then the command error boundary
		// (#899) prints the message once and sets the exit code.
		p.log.error("Login failed. Please try again.");
		throw error;
	}
}

// Login command
program
	.command("login")
	.description("Login to Bloks")
	.option("-t, --token <value>", "Login with a token")
	.action(
		withErrorBoundary(async (options: OptionValues) => {
			await trackCommandExecution({
				command: "login",
				args: options,
				execution: async () => {
					await login(options);
				},
			});
		}),
	);
