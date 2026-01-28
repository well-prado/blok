import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock factories are hoisted — cannot reference top-level variables.
// Use vi.hoisted() to define shared mocks.
const { mockExecuteWorkflow, mockCreateClient } = vi.hoisted(() => {
	const mockExecuteWorkflow = vi.fn().mockResolvedValue({ Message: "response", Encoding: "BASE64", Type: "JSON" });
	const mockCreateClient = vi.fn().mockReturnValue({ executeWorkflow: mockExecuteWorkflow });
	return { mockExecuteWorkflow, mockCreateClient };
});

vi.mock("@connectrpc/connect", () => ({
	createClient: mockCreateClient,
}));

vi.mock("@connectrpc/connect-node", () => ({
	createGrpcTransport: vi.fn().mockReturnValue({ type: "grpc" }),
	createGrpcWebTransport: vi.fn().mockReturnValue({ type: "grpc-web" }),
	createConnectTransport: vi.fn().mockReturnValue({ type: "connect" }),
}));

import { createConnectTransport, createGrpcTransport, createGrpcWebTransport } from "@connectrpc/connect-node";
import GrpcClient, { TransportEnum, HttpVersionEnum, type RpcOptions } from "../../src/GrpcClient";

describe("GrpcClient", () => {
	const defaultOpts: RpcOptions = {
		host: "localhost",
		port: 8433,
		protocol: "http",
		httpVersion: HttpVersionEnum.HTTP2,
		transport: TransportEnum.GRPC,
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("constructor()", () => {
		it("should store options", () => {
			const client = new GrpcClient(defaultOpts);
			expect(client).toBeDefined();
		});
	});

	describe("transport()", () => {
		it("should create gRPC transport for GRPC type", () => {
			const client = new GrpcClient({ ...defaultOpts, transport: TransportEnum.GRPC });
			const transport = client.transport();
			expect(createGrpcTransport).toHaveBeenCalledWith({
				baseUrl: "http://localhost:8433/",
				interceptors: [],
			});
			expect(transport).toEqual({ type: "grpc" });
		});

		it("should create gRPC-Web transport for GRPC_WEB type", () => {
			const client = new GrpcClient({ ...defaultOpts, transport: TransportEnum.GRPC_WEB });
			const transport = client.transport();
			expect(createGrpcWebTransport).toHaveBeenCalledWith({
				baseUrl: "http://localhost:8433/",
				httpVersion: HttpVersionEnum.HTTP2,
				interceptors: [],
			});
			expect(transport).toEqual({ type: "grpc-web" });
		});

		it("should create Connect transport for CONNECT type", () => {
			const client = new GrpcClient({ ...defaultOpts, transport: TransportEnum.CONNECT });
			const transport = client.transport();
			expect(createConnectTransport).toHaveBeenCalledWith({
				baseUrl: "http://localhost:8433/",
				httpVersion: HttpVersionEnum.HTTP2,
				interceptors: [],
			});
			expect(transport).toEqual({ type: "connect" });
		});

		it("should throw for invalid transport type", () => {
			const client = new GrpcClient({ ...defaultOpts, transport: "invalid" as TransportEnum });
			expect(() => client.transport()).toThrow("Invalid transport type");
		});

		it("should use correct baseUrl with custom protocol and port", () => {
			const client = new GrpcClient({
				...defaultOpts,
				protocol: "https",
				host: "api.example.com",
				port: 9090,
				transport: TransportEnum.GRPC,
			});
			client.transport();
			expect(createGrpcTransport).toHaveBeenCalledWith({
				baseUrl: "https://api.example.com:9090/",
				interceptors: [],
			});
		});
	});

	describe("call()", () => {
		it("should create client and execute workflow", async () => {
			const client = new GrpcClient(defaultOpts);
			const message = {
				Name: "test",
				Message: "data",
				Encoding: "BASE64",
				Type: "JSON",
			};

			const result = await client.call(message as any);
			expect(mockCreateClient).toHaveBeenCalled();
			expect(mockExecuteWorkflow).toHaveBeenCalledWith(message, undefined);
			expect(result).toEqual({ Message: "response", Encoding: "BASE64", Type: "JSON" });
		});

		it("should pass call options with headers", async () => {
			const client = new GrpcClient(defaultOpts);
			const message = { Name: "test", Message: "data", Encoding: "BASE64", Type: "JSON" };
			const opts = { headers: { Authorization: "Bearer token123" } };

			await client.call(message as any, opts);
			expect(mockExecuteWorkflow).toHaveBeenCalledWith(message, opts);
		});
	});

	describe("TransportEnum", () => {
		it("should have correct values", () => {
			expect(TransportEnum.GRPC).toBe("grpc");
			expect(TransportEnum.GRPC_WEB).toBe("grpc-web");
			expect(TransportEnum.CONNECT).toBe("connect");
		});
	});

	describe("HttpVersionEnum", () => {
		it("should have correct values", () => {
			expect(HttpVersionEnum.HTTP1).toBe("1.1");
			expect(HttpVersionEnum.HTTP2).toBe("2");
		});
	});
});
