import { describe, expect, it, vi } from "vitest";
import MessageDecode from "../../src/runner/MessageDecode";

describe("MessageDecode", () => {
	const coder = new MessageDecode();

	describe("requestDecode()", () => {
		it("should decode BASE64 + JSON request", () => {
			const data = { id: "test", request: { body: {} } };
			const encoded = Buffer.from(JSON.stringify(data)).toString("base64");
			const result = coder.requestDecode({ Message: encoded, Encoding: "BASE64", Type: "JSON", Name: "test" });
			expect(result).toEqual(data);
		});

		it("should decode STRING + JSON request", () => {
			const data = { id: "test", request: { body: {} } };
			const result = coder.requestDecode({
				Message: JSON.stringify(data),
				Encoding: "STRING",
				Type: "JSON",
				Name: "test",
			});
			expect(result).toEqual(data);
		});

		it("should throw for unsupported encoding", () => {
			expect(() => coder.requestDecode({ Message: "test", Encoding: "XML", Type: "JSON", Name: "test" })).toThrow(
				"Unsupported encoding: XML",
			);
		});
	});

	describe("responseDecode()", () => {
		it("should decode BASE64 + JSON response", () => {
			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const data = { success: true };
			const encoded = Buffer.from(JSON.stringify(data)).toString("base64");
			const result = coder.responseDecode({ Message: encoded, Encoding: "BASE64", Type: "JSON" } as any);
			expect(result).toEqual(data);
			consoleSpy.mockRestore();
		});

		it("should decode STRING + JSON response", () => {
			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const data = { success: true };
			const result = coder.responseDecode({ Message: JSON.stringify(data), Encoding: "STRING", Type: "JSON" } as any);
			expect(result).toEqual(data);
			consoleSpy.mockRestore();
		});

		it("should throw for unsupported encoding", () => {
			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			expect(() => coder.responseDecode({ Message: "test", Encoding: "BINARY", Type: "JSON" } as any)).toThrow(
				"Unsupported encoding: BINARY",
			);
			consoleSpy.mockRestore();
		});
	});

	describe("decodeType()", () => {
		it("should parse JSON string", () => {
			const result = coder.decodeType('{"key":"value"}', "JSON");
			expect(result).toEqual({ key: "value" });
		});

		it("should throw for unsupported type", () => {
			expect(() => coder.decodeType("<xml/>", "XML")).toThrow("Unsupported type: XML");
		});

		it("should throw for invalid JSON", () => {
			expect(() => coder.decodeType("not json", "JSON")).toThrow();
		});
	});
});
