/**
 * gRPC utilities for Python3 integration tests
 *
 * Manages Python3 gRPC server lifecycle:
 * - Start/stop Python3 server process
 * - Health checking
 * - Port management
 * - Process cleanup
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";

export interface GrpcServerOptions {
	/** Port for gRPC server (default: 50051) */
	port?: number;
	/** Timeout for server startup in ms (default: 5000) */
	startupTimeout?: number;
	/** Whether to log server output (default: false) */
	verbose?: boolean;
}

export interface GrpcServerHandle {
	/** Process ID */
	pid: number;
	/** Server port */
	port: number;
	/** Server process */
	process: ChildProcess;
	/** Stop the server */
	stop: () => Promise<void>;
}

/**
 * Start Python3 gRPC server
 *
 * @param options - Server configuration options
 * @returns Handle to control the server
 */
export async function startPython3Server(options: GrpcServerOptions = {}): Promise<GrpcServerHandle> {
	const port = options.port || 50051;
	const startupTimeout = options.startupTimeout || 5000;
	const verbose = options.verbose || false;

	// Start Python3 server
	const serverProcess = spawn("python3", ["server.py"], {
		cwd: "../../runtimes/python3",
		env: {
			...process.env,
			SERVER_PORT: port.toString(),
		},
		stdio: verbose ? "inherit" : "pipe",
	});

	if (!serverProcess.pid) {
		throw new Error("Failed to start Python3 server: no PID");
	}

	// Capture errors
	if (!verbose && serverProcess.stderr) {
		serverProcess.stderr.on("data", (data) => {
			console.error(`Python3 server error: ${data.toString()}`);
		});
	}

	// Wait for server to be ready
	const isReady = await waitForServer(port, startupTimeout);
	if (!isReady) {
		serverProcess.kill();
		throw new Error(`Python3 server failed to start within ${startupTimeout}ms`);
	}

	if (verbose) {
		console.log(`\n✅ Python3 gRPC server started on port ${port} (PID: ${serverProcess.pid})`);
	}

	return {
		pid: serverProcess.pid,
		port,
		process: serverProcess,
		stop: async () => {
			await stopPython3Server(serverProcess, verbose);
		},
	};
}

/**
 * Stop Python3 gRPC server
 */
async function stopPython3Server(process: ChildProcess, verbose: boolean): Promise<void> {
	if (!process.pid) {
		return;
	}

	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			process.kill("SIGKILL");
			resolve();
		}, 3000);

		process.on("exit", () => {
			clearTimeout(timeout);
			if (verbose) {
				console.log(`\n✅ Python3 gRPC server stopped (PID: ${process.pid})`);
			}
			resolve();
		});

		process.kill("SIGTERM");
	});
}

/**
 * Wait for gRPC server to be ready
 *
 * Polls the server until it responds or timeout is reached
 */
async function waitForServer(port: number, timeout: number): Promise<boolean> {
	const startTime = Date.now();
	const pollInterval = 100;

	while (Date.now() - startTime < timeout) {
		const isReady = await checkServerReady(port);
		if (isReady) {
			return true;
		}
		await sleep(pollInterval);
	}

	return false;
}

/**
 * Check if gRPC server is ready to accept connections
 */
async function checkServerReady(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = new net.Socket();
		socket.setTimeout(1000);

		socket.on("connect", () => {
			socket.destroy();
			resolve(true);
		});

		socket.on("error", () => {
			socket.destroy();
			resolve(false);
		});

		socket.on("timeout", () => {
			socket.destroy();
			resolve(false);
		});

		socket.connect(port, "localhost");
	});
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
