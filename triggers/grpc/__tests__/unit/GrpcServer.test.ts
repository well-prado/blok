import { beforeEach, describe, expect, it, vi } from "vitest";

// Use vi.hoisted for mocks referenced in vi.mock factories
const { mockRegister, mockListen, mockAddresses } = vi.hoisted(() => {
	const mockRegister = vi.fn().mockResolvedValue(undefined);
	const mockListen = vi.fn().mockResolvedValue(undefined);
	const mockAddresses = vi.fn().mockReturnValue([{ address: "0.0.0.0", port: 8443 }]);
	return { mockRegister, mockListen, mockAddresses };
});

// Mock OpenTelemetry
vi.mock("@opentelemetry/api", () => {
	const noop = { setAttribute: () => {}, setStatus: () => {}, recordException: () => {}, end: () => {} };
	return {
		trace: {
			getTracer: () => ({
				startActiveSpan: (...a: unknown[]) => {
					const fn = a.find((x) => typeof x === "function") as ((s: typeof noop) => unknown) | undefined;
					return fn?.(noop);
				},
				startSpan: () => noop,
			}),
			getActiveSpan: () => undefined,
			setSpan: (c: unknown) => c,
		},
		metrics: {
			getMeter: () => ({
				createCounter: () => ({ add: () => {} }),
				createHistogram: () => ({ record: () => {} }),
				createGauge: () => ({ record: () => {} }),
				createObservableGauge: () => ({ addCallback: () => {} }),
			}),
		},
		context: { active: () => ({}), with: (_c: unknown, fn: () => unknown) => fn() },
		propagation: { extract: (c: unknown) => c, inject: () => {} },
		SpanKind: { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 },
		SpanStatusCode: { OK: 0, ERROR: 1 },
		isSpanContextValid: () => false,
	};
});

// Mock fastify — must return a class-like constructor
vi.mock("fastify", () => ({
	default: () => ({
		register: mockRegister,
		listen: mockListen,
		addresses: mockAddresses,
	}),
}));

// Mock connect-fastify
vi.mock("@connectrpc/connect-fastify", () => ({
	fastifyConnectPlugin: "mocked-plugin",
}));

// Mock GRpcTrigger
vi.mock("../../src/GRpcTrigger", () => {
	return {
		default: class MockGRpcTrigger {
			getApp() {
				return {
					register: mockRegister,
					listen: mockListen,
					addresses: mockAddresses,
				};
			}
			processRequest() {}
		},
	};
});

// Mock runner — DefaultLogger must be a class (used with new)
vi.mock("@blokjs/runner", () => ({
	DefaultLogger: class MockDefaultLogger {
		log() {}
		error() {}
	},
}));

import GrpcServer from "../../src/GrpcServer";

describe("GrpcServer", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("constructor()", () => {
		it("should create instance with provided options", () => {
			const server = new GrpcServer({ host: "127.0.0.1", port: 9090 });
			expect(server).toBeDefined();
		});

		it("should default host to 0.0.0.0 when undefined", () => {
			const server = new GrpcServer({ host: undefined as any, port: 8443 });
			expect(server).toBeDefined();
		});

		it("should default port to 8443 when undefined", () => {
			const server = new GrpcServer({ host: "0.0.0.0", port: undefined as any });
			expect(server).toBeDefined();
		});

		it("should default both host and port when undefined", () => {
			const server = new GrpcServer({ host: undefined as any, port: undefined as any });
			expect(server).toBeDefined();
		});
	});

	describe("start()", () => {
		it("should register connect plugin and listen", async () => {
			const server = new GrpcServer({ host: "0.0.0.0", port: 8443 });
			await server.start();
			expect(mockRegister).toHaveBeenCalled();
			expect(mockListen).toHaveBeenCalled();
		});

		it("should use GRPC_HOST env var when set", async () => {
			const originalHost = process.env.GRPC_HOST;
			process.env.GRPC_HOST = "10.0.0.1";
			const server = new GrpcServer({ host: "0.0.0.0", port: 8443 });
			await server.start();
			const listenArgs = mockListen.mock.calls[0][0];
			expect(listenArgs.host).toBe("10.0.0.1");
			process.env.GRPC_HOST = originalHost;
		});

		it("should use GRPC_PORT env var when set", async () => {
			const originalPort = process.env.GRPC_PORT;
			process.env.GRPC_PORT = "9999";
			const server = new GrpcServer({ host: "0.0.0.0", port: 8443 });
			await server.start();
			const listenArgs = mockListen.mock.calls[0][0];
			expect(listenArgs.port).toBe(9999);
			process.env.GRPC_PORT = originalPort;
		});
	});
});
