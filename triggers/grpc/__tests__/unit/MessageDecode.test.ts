import { beforeEach, describe, expect, it, vi } from "vitest";
import MessageDecode from "../../src/MessageDecode";
import { MessageEncoding, MessageType } from "../../src/gen/workflow_pb";

describe("MessageDecode", () => {
	let decoder: MessageDecode;

	beforeEach(() => {
		decoder = new MessageDecode();
	});

	describe("requestDecode()", () => {
		it("should decode BASE64 + JSON request", () => {
			const payload = { request: { body: { key: "value" } } };
			const base64 = Buffer.from(JSON.stringify(payload)).toString("base64");
			const request = {
				Name: "test",
				Message: base64,
				Encoding: MessageEncoding[MessageEncoding.BASE64],
				Type: MessageType[MessageType.JSON],
			};

			const result = decoder.requestDecode(request as any);
			expect(result).toEqual(payload);
		});

		it("should decode STRING + JSON request", () => {
			const payload = { request: { body: { key: "value" } } };
			const request = {
				Name: "test",
				Message: JSON.stringify(payload),
				Encoding: MessageEncoding[MessageEncoding.STRING],
				Type: MessageType[MessageType.JSON],
			};

			const result = decoder.requestDecode(request as any);
			expect(result).toEqual(payload);
		});

		it("should decode BASE64 + XML request", () => {
			const xml = "<root><key>value</key></root>";
			const base64 = Buffer.from(xml).toString("base64");
			const request = {
				Name: "test",
				Message: base64,
				Encoding: MessageEncoding[MessageEncoding.BASE64],
				Type: MessageType[MessageType.XML],
			};

			const result = decoder.requestDecode(request as any);
			expect(result).toBeDefined();
			expect((result as any).root).toBeDefined();
		});

		it("should decode STRING + XML request", () => {
			const xml = "<root><key>value</key></root>";
			const request = {
				Name: "test",
				Message: xml,
				Encoding: MessageEncoding[MessageEncoding.STRING],
				Type: MessageType[MessageType.XML],
			};

			const result = decoder.requestDecode(request as any);
			expect(result).toBeDefined();
			expect((result as any).root).toBeDefined();
		});

		it("should throw for unsupported encoding", () => {
			const request = {
				Name: "test",
				Message: "data",
				Encoding: "UNKNOWN",
				Type: MessageType[MessageType.JSON],
			};

			expect(() => decoder.requestDecode(request as any)).toThrow("Unsupported encoding: UNKNOWN");
		});
	});

	describe("decodeType()", () => {
		it("should decode JSON string to object", () => {
			const json = '{"key":"value"}';
			const result = decoder.decodeType(json, MessageType[MessageType.JSON]);
			expect(result).toEqual({ key: "value" });
		});

		it("should decode XML string to object", () => {
			const xml = "<root><item>test</item></root>";
			const result = decoder.decodeType(xml, MessageType[MessageType.XML]);
			expect(result).toBeDefined();
			expect((result as any).root).toBeDefined();
		});

		it("should throw for unsupported type", () => {
			expect(() => decoder.decodeType("data", "BINARY")).toThrow("Unsupported type: BINARY");
		});

		it("should throw for TEXT type (not supported in decode)", () => {
			expect(() => decoder.decodeType("data", MessageType[MessageType.TEXT])).toThrow("Unsupported type: TEXT");
		});
	});

	describe("responseEncode()", () => {
		it("should encode response with BASE64 + JSON", () => {
			const ctx = {
				response: {
					data: { result: "ok" },
					contentType: "application/json",
				},
			};

			const result = decoder.responseEncode(
				ctx as any,
				MessageEncoding[MessageEncoding.BASE64],
				MessageType[MessageType.JSON],
			);

			expect(result.Encoding).toBe(MessageEncoding[MessageEncoding.BASE64]);
			expect(result.Type).toBe(MessageType[MessageType.JSON]);
			// The message should be base64 encoded
			const decoded = Buffer.from(result.Message, "base64").toString("utf-8");
			expect(JSON.parse(decoded)).toEqual({ result: "ok" });
		});

		it("should encode response with STRING + JSON", () => {
			const ctx = {
				response: {
					data: { result: "ok" },
					contentType: "application/json",
				},
			};

			const result = decoder.responseEncode(
				ctx as any,
				MessageEncoding[MessageEncoding.STRING],
				MessageType[MessageType.JSON],
			);

			expect(result.Encoding).toBe(MessageEncoding[MessageEncoding.STRING]);
		});

		it("should encode response with TEXT content type", () => {
			const ctx = {
				response: {
					data: "hello world",
					contentType: "text/plain",
				},
			};

			const result = decoder.responseEncode(
				ctx as any,
				MessageEncoding[MessageEncoding.STRING],
				MessageType[MessageType.TEXT],
			);

			expect(result.Encoding).toBe(MessageEncoding[MessageEncoding.STRING]);
			expect(result.Type).toBe(MessageType[MessageType.TEXT]);
		});

		it("should throw for unsupported encoding", () => {
			const ctx = {
				response: {
					data: "test",
					contentType: "text/plain",
				},
			};

			expect(() => decoder.responseEncode(ctx as any, "UNKNOWN", MessageType[MessageType.JSON])).toThrow(
				"Unsupported encoding: UNKNOWN",
			);
		});
	});

	describe("responseErrorEncode()", () => {
		it("should encode error with BASE64", () => {
			const result = decoder.responseErrorEncode(
				"Error occurred",
				MessageEncoding[MessageEncoding.BASE64],
				MessageType[MessageType.TEXT],
			);

			const decoded = Buffer.from(result, "base64").toString("utf-8");
			expect(decoded).toBe("Error occurred");
		});

		it("should encode error with STRING", () => {
			const result = decoder.responseErrorEncode(
				"Error occurred",
				MessageEncoding[MessageEncoding.STRING],
				MessageType[MessageType.TEXT],
			);

			expect(result).toBe("Error occurred");
		});

		it("should encode JSON error with BASE64", () => {
			const error = JSON.stringify({ code: 500, message: "Server error" });
			const result = decoder.responseErrorEncode(
				error,
				MessageEncoding[MessageEncoding.BASE64],
				MessageType[MessageType.JSON],
			);

			const decoded = Buffer.from(result, "base64").toString("utf-8");
			expect(JSON.parse(decoded)).toBe(error);
		});

		it("should throw for unsupported encoding", () => {
			expect(() => decoder.responseErrorEncode("Error", "UNKNOWN", MessageType[MessageType.TEXT])).toThrow(
				"Unsupported encoding: UNKNOWN",
			);
		});
	});

	describe("responseDecode()", () => {
		it("should decode BASE64 + JSON response", () => {
			const data = { result: "ok" };
			const base64 = Buffer.from(JSON.stringify(data)).toString("base64");
			const response = {
				Message: base64,
				Encoding: MessageEncoding[MessageEncoding.BASE64],
				Type: MessageType[MessageType.JSON],
			};

			const result = decoder.responseDecode(response as any);
			expect(result).toEqual(data);
		});

		it("should decode STRING + JSON response", () => {
			const data = { result: "ok" };
			const response = {
				Message: JSON.stringify(data),
				Encoding: MessageEncoding[MessageEncoding.STRING],
				Type: MessageType[MessageType.JSON],
			};

			const result = decoder.responseDecode(response as any);
			expect(result).toEqual(data);
		});

		it("should decode BASE64 + XML response", () => {
			const xml = "<root><key>value</key></root>";
			const base64 = Buffer.from(xml).toString("base64");
			const response = {
				Message: base64,
				Encoding: MessageEncoding[MessageEncoding.BASE64],
				Type: MessageType[MessageType.XML],
			};

			const result = decoder.responseDecode(response as any);
			expect(result).toBeDefined();
		});

		it("should throw for unsupported encoding in response", () => {
			const response = {
				Message: "data",
				Encoding: "UNKNOWN",
				Type: MessageType[MessageType.JSON],
			};

			expect(() => decoder.responseDecode(response as any)).toThrow("Unsupported encoding: UNKNOWN");
		});
	});

	describe("encodeType()", () => {
		it("should encode object to JSON string", () => {
			const result = decoder.encodeType({ key: "value" }, MessageType[MessageType.JSON]);
			expect(result).toBe('{"key":"value"}');
		});

		it("should encode TEXT to string", () => {
			const result = decoder.encodeType("hello", MessageType[MessageType.TEXT]);
			expect(result).toBe("hello");
		});

		it("should encode HTML to string", () => {
			const result = decoder.encodeType("<h1>Hello</h1>", MessageType[MessageType.HTML]);
			expect(result).toBe("<h1>Hello</h1>");
		});

		it("should encode object to XML string", () => {
			const result = decoder.encodeType({ root: { key: "value" } }, MessageType[MessageType.XML]);
			expect(typeof result).toBe("string");
			expect(result).toContain("key");
		});

		it("should throw for unsupported type", () => {
			expect(() => decoder.encodeType("data", "BINARY")).toThrow("Unsupported type: BINARY");
		});
	});

	describe("mapContentType()", () => {
		it("should map application/json to JSON", () => {
			expect(decoder.mapContentType("application/json")).toBe(MessageType.JSON);
		});

		it("should map text/html to HTML", () => {
			expect(decoder.mapContentType("text/html")).toBe(MessageType.HTML);
		});

		it("should map text/xml to XML", () => {
			expect(decoder.mapContentType("text/xml")).toBe(MessageType.XML);
		});

		it("should default to TEXT for unknown content type", () => {
			expect(decoder.mapContentType("text/plain")).toBe(MessageType.TEXT);
		});

		it("should default to TEXT for empty string", () => {
			expect(decoder.mapContentType("")).toBe(MessageType.TEXT);
		});
	});
});
