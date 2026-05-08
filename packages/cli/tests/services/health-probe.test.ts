import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tryConnect, waitForGrpcPort } from "../../src/services/health-probe.js";

let servers: net.Server[] = [];

function startServer(host: "127.0.0.1" | "::1"): Promise<{ server: net.Server; port: number }> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, host, () => {
			const address = server.address();
			if (typeof address === "string" || !address) {
				reject(new Error("server.address() returned unexpected shape"));
				return;
			}
			servers.push(server);
			resolve({ server, port: address.port });
		});
	});
}

afterEach(async () => {
	await Promise.all(
		servers.map(
			(s) =>
				new Promise<void>((resolve) => {
					s.close(() => resolve());
				}),
		),
	);
	servers = [];
});

describe("tryConnect", () => {
	it("resolves true when the port is reachable on IPv4", async () => {
		const { port } = await startServer("127.0.0.1");
		expect(await tryConnect("127.0.0.1", port, 500)).toBe(true);
	});

	it("resolves false for a refused port", async () => {
		// Port 1 is privileged + extremely unlikely to be listening.
		expect(await tryConnect("127.0.0.1", 1, 200)).toBe(false);
	});

	it("resolves false within timeoutMs when the host blackholes", async () => {
		// 192.0.2.0/24 is reserved (TEST-NET-1) and routes nowhere.
		const start = Date.now();
		const result = await tryConnect("192.0.2.1", 12345, 250);
		const elapsed = Date.now() - start;
		expect(result).toBe(false);
		expect(elapsed).toBeLessThan(2000);
	});
});

describe("waitForGrpcPort", () => {
	it("resolves true once the port becomes reachable on IPv4", async () => {
		const { port } = await startServer("127.0.0.1");
		expect(await waitForGrpcPort(port, 2000)).toBe(true);
	});

	it("falls back to IPv6 (::1) when IPv4 is unbound", async () => {
		// Skip if the test host has no IPv6 loopback at all.
		let ipv6Available = true;
		try {
			const { port } = await startServer("::1");
			expect(await waitForGrpcPort(port, 2000)).toBe(true);
		} catch (err) {
			const msg = (err as NodeJS.ErrnoException).code;
			if (msg === "EADDRNOTAVAIL" || msg === "EAFNOSUPPORT") ipv6Available = false;
			else throw err;
		}
		// Sanity: make the test fail loudly if we silently skipped.
		expect(ipv6Available).toBe(true);
	});

	it("resolves false when nothing binds before the timeout", async () => {
		const start = Date.now();
		const result = await waitForGrpcPort(1, 800);
		const elapsed = Date.now() - start;
		expect(result).toBe(false);
		expect(elapsed).toBeGreaterThanOrEqual(700);
		expect(elapsed).toBeLessThan(2500);
	});

	it("fast-fails when the owning process exits before the port binds", async () => {
		// Synthesize a process-like object that already exited.
		const fakeProc = {
			exitCode: 1 as number | null,
			on: () => {
				/* no-op */
			},
		};
		const start = Date.now();
		const result = await waitForGrpcPort(1, 5000, fakeProc);
		const elapsed = Date.now() - start;
		expect(result).toBe(false);
		expect(elapsed).toBeLessThan(100);
	});
});
