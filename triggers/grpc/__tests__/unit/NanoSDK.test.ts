import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Use vi.hoisted for mocks referenced inside vi.mock factories
const { mockCall } = vi.hoisted(() => {
	const mockCall = vi.fn().mockResolvedValue({
		Message: Buffer.from(JSON.stringify({ result: "ok" })).toString("base64"),
		Encoding: "BASE64",
		Type: "JSON",
	});
	return { mockCall };
});

vi.mock("../../src/GrpcClient", () => {
	class MockGrpcClient {
		call = mockCall;
	}
	return {
		default: MockGrpcClient,
		HttpVersionEnum: { HTTP1: "1.1", HTTP2: "2" },
		TransportEnum: { GRPC: "grpc", GRPC_WEB: "grpc-web", CONNECT: "connect" },
	};
});

vi.mock("../../src/MessageDecode", () => {
	class MockMessageDecode {
		responseDecode() {
			return { result: "ok" };
		}
	}
	return { default: MockMessageDecode };
});

import NanoSDK, { NanoSDKClient } from "../../src/NanoSDK";

describe("NanoSDK", () => {
	let sdk: NanoSDK;

	beforeEach(() => {
		sdk = new NanoSDK();
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("createClient()", () => {
		it("should create client with explicit host and token", () => {
			const client = sdk.createClient("localhost:8433", "my-token");
			expect(client).toBeDefined();
			expect(client).toBeInstanceOf(NanoSDKClient);
		});

		it("should create client with host only (empty token)", () => {
			const client = sdk.createClient("myhost:9090");
			expect(client).toBeDefined();
		});

		it("should read nanosdk.json when no host provided", () => {
			vi.spyOn(fs, "existsSync").mockReturnValue(true);
			vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ host: "127.0.0.1:5000", token: "file-token" }));

			const client = sdk.createClient();
			expect(fs.existsSync).toHaveBeenCalled();
			expect(fs.readFileSync).toHaveBeenCalled();
			expect(client).toBeDefined();
		});

		it("should use default host when no host and no nanosdk.json", () => {
			vi.spyOn(fs, "existsSync").mockReturnValue(false);

			const client = sdk.createClient();
			expect(client).toBeDefined();
		});

		it("should throw for host without port and without protocol", () => {
			expect(() => sdk.createClient("invalidhost")).toThrow(
				"Invalid host format. The host must have the format domain:port",
			);
		});

		it("should accept host with http:// prefix", () => {
			const client = sdk.createClient("http://localhost");
			expect(client).toBeDefined();
		});

		it("should accept host with https:// prefix", () => {
			const client = sdk.createClient("https://myserver");
			expect(client).toBeDefined();
		});
	});
});

describe("NanoSDKClient", () => {
	let client: NanoSDKClient;

	beforeEach(() => {
		vi.clearAllMocks();
		const sdk = new NanoSDK();
		client = sdk.createClient("localhost:8433", "test-token");
	});

	describe("python3()", () => {
		it("should build correct request for Python3 node", async () => {
			const result = await client.python3("my-node", { url: "http://example.com" });
			expect(mockCall).toHaveBeenCalled();
			const callArgs = mockCall.mock.calls[0];
			const request = callArgs[0];
			expect(request.Name).toBe("my-node");
			expect(request.Encoding).toBe("BASE64");
			expect(request.Type).toBe("JSON");
			const decoded = JSON.parse(Buffer.from(request.Message, "base64").toString("utf-8"));
			expect(decoded.workflow.steps[0].type).toBe("runtime.python3");
			expect(decoded.workflow.steps[0].node).toBe("my-node");
		});

		it("should pass inputs to the workflow node config", async () => {
			const inputs = { url: "http://api.com", method: "POST" };
			await client.python3("api-call", inputs);
			const request = mockCall.mock.calls[0][0];
			const decoded = JSON.parse(Buffer.from(request.Message, "base64").toString("utf-8"));
			expect(decoded.workflow.nodes.node.inputs).toEqual(inputs);
		});

		it("should return decoded response", async () => {
			const result = await client.python3("my-node", {});
			expect(result).toEqual({ result: "ok" });
		});
	});

	describe("nodejs()", () => {
		it("should build correct request for Node.js node", async () => {
			await client.nodejs("my-node", { data: "test" });
			const request = mockCall.mock.calls[0][0];
			const decoded = JSON.parse(Buffer.from(request.Message, "base64").toString("utf-8"));
			expect(decoded.workflow.steps[0].type).toBe("module");
			expect(decoded.workflow.steps[0].node).toBe("my-node");
		});

		it("should use custom type parameter", async () => {
			await client.nodejs("my-node", {}, "local");
			const request = mockCall.mock.calls[0][0];
			const decoded = JSON.parse(Buffer.from(request.Message, "base64").toString("utf-8"));
			expect(decoded.workflow.steps[0].type).toBe("local");
		});

		it("should include http trigger in workflow", async () => {
			await client.nodejs("my-node", {});
			const request = mockCall.mock.calls[0][0];
			const decoded = JSON.parse(Buffer.from(request.Message, "base64").toString("utf-8"));
			expect(decoded.workflow.trigger.http).toBeDefined();
			expect(decoded.workflow.trigger.http.method).toBe("GET");
		});

		it("should pass authorization header", async () => {
			await client.nodejs("my-node", {});
			const callOpts = mockCall.mock.calls[0][1];
			expect(callOpts.headers.Authorization).toBe("Bearer test-token");
		});
	});
});
