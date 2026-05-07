import { Socket } from "node:net";

/**
 * Try to open a TCP connection to `host:port` within `timeoutMs`. Resolves
 * `true` if the socket connected, `false` for timeout / refused / error.
 *
 * Lifted verbatim from `scripts/dev-full.ts:415-429` so the CLI's gRPC
 * health-probe matches the in-repo orchestrator's behavior. Both use the
 * same primitive so divergence between `bun dev` and `blokctl dev` is
 * impossible by construction.
 */
export function tryConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = new Socket();
		const done = (ok: boolean) => {
			sock.destroy();
			resolve(ok);
		};
		sock.setTimeout(timeoutMs);
		sock
			.once("connect", () => done(true))
			.once("timeout", () => done(false))
			.once("error", () => done(false));
		sock.connect(port, host);
	});
}

/**
 * Poll IPv4 + IPv6 loopback for a TCP listener on `port` until connection
 * succeeds, the optional `proc` exits, or `timeoutMs` elapses.
 *
 * On macOS `localhost` may resolve to IPv6 only; an IPv4-only probe would
 * spuriously fail. Trying both address families closes that gap.
 *
 * If `proc` is supplied and exits before the port becomes reachable,
 * resolves immediately with `false` instead of running out the full
 * timeout — fast-fail when an SDK crashes during boot.
 */
export async function waitForGrpcPort(
	port: number,
	timeoutMs: number,
	proc?: { exitCode: number | null; on(event: "exit", listener: () => void): void },
): Promise<boolean> {
	if (proc && proc.exitCode !== null) return false;

	const start = Date.now();
	let exited = false;
	proc?.on("exit", () => {
		exited = true;
	});

	while (Date.now() - start < timeoutMs) {
		if (exited) return false;
		if (await tryConnect("127.0.0.1", port, 500)) return true;
		if (await tryConnect("::1", port, 500)) return true;
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}
