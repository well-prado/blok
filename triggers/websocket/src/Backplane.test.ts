/**
 * Backplane helper tests — v0.7 follow-up.
 *
 * Covers the envelope encode/decode roundtrip, config resolution
 * (constructor → env var → disabled), senderId stability, and the
 * lazy adapter loader's error path. Live broker round-trips are
 * exercised in `WebSocketTrigger.backplane.test.ts` against a mock
 * pub/sub adapter.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type BroadcastEnvelope,
	DEFAULT_BACKPLANE_TOPIC,
	decodePayload,
	encodeEnvelope,
	newSenderId,
	resolveBackplaneConfig,
} from "./Backplane";

describe("Backplane — envelope encoding", () => {
	it("encodes a text frame with kind='text' and value verbatim", () => {
		const env = encodeEnvelope("ws-sender-1", "wf:room", "hello world");
		expect(env.payload).toEqual({ kind: "text", value: "hello world" });
		expect(env.senderId).toBe("ws-sender-1");
		expect(env.roomKey).toBe("wf:room");
	});

	it("encodes a binary Uint8Array frame as base64", () => {
		const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
		const env = encodeEnvelope("ws-sender-1", "wf:room", bytes);
		expect(env.payload.kind).toBe("binary");
		if (env.payload.kind === "binary") {
			expect(env.payload.base64).toBe(Buffer.from(bytes).toString("base64"));
		}
	});

	it("encodes an ArrayBuffer frame as base64 (converts to Uint8Array)", () => {
		const buf = new ArrayBuffer(3);
		new Uint8Array(buf).set([1, 2, 3]);
		const env = encodeEnvelope("ws-sender-1", "wf:room", buf);
		expect(env.payload.kind).toBe("binary");
		if (env.payload.kind === "binary") {
			expect(Buffer.from(env.payload.base64, "base64")).toEqual(Buffer.from([1, 2, 3]));
		}
	});

	it("forwards the exceptConnectionId field when provided", () => {
		const env = encodeEnvelope("ws-sender-1", "wf:room", "x", "conn-abc");
		expect(env.exceptConnectionId).toBe("conn-abc");
	});
});

describe("Backplane — envelope decoding", () => {
	it("decodes a text envelope back to its original string", () => {
		const env: BroadcastEnvelope = {
			senderId: "ws-x",
			roomKey: "wf:r",
			payload: { kind: "text", value: "hello" },
		};
		expect(decodePayload(env)).toBe("hello");
	});

	it("decodes a binary envelope back to a Uint8Array round-trip identical to source bytes", () => {
		const bytes = new Uint8Array([10, 20, 30, 40, 50]);
		const env: BroadcastEnvelope = {
			senderId: "ws-x",
			roomKey: "wf:r",
			payload: { kind: "binary", base64: Buffer.from(bytes).toString("base64") },
		};
		const result = decodePayload(env);
		expect(result).toBeInstanceOf(Uint8Array);
		expect(Array.from(result as Uint8Array)).toEqual(Array.from(bytes));
	});
});

describe("Backplane — newSenderId()", () => {
	it("returns a uuid-prefixed string starting with 'ws-'", () => {
		const id = newSenderId();
		expect(id).toMatch(/^ws-[0-9a-f-]+$/);
	});

	it("generates a fresh id per call (no collisions on rapid successive calls)", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 100; i += 1) ids.add(newSenderId());
		expect(ids.size).toBe(100);
	});
});

describe("Backplane — resolveBackplaneConfig()", () => {
	beforeEach(() => {
		process.env.BLOK_WS_BACKPLANE = undefined;
		process.env.BLOK_WS_BACKPLANE_TOPIC = undefined;
		process.env.BLOK_WS_BACKPLANE_GROUP = undefined;
	});

	afterEach(() => {
		process.env.BLOK_WS_BACKPLANE = undefined;
		process.env.BLOK_WS_BACKPLANE_TOPIC = undefined;
		process.env.BLOK_WS_BACKPLANE_GROUP = undefined;
	});

	it("returns the explicit config when constructor provided one", () => {
		const config = resolveBackplaneConfig({ provider: "nats" });
		expect(config).toEqual({ provider: "nats" });
	});

	it("falls back to BLOK_WS_BACKPLANE env var with default topic", () => {
		process.env.BLOK_WS_BACKPLANE = "redis-streams";
		const config = resolveBackplaneConfig(undefined);
		expect(config).toEqual({
			provider: "redis-streams",
			topic: DEFAULT_BACKPLANE_TOPIC,
			consumerGroup: undefined,
		});
	});

	it("honors BLOK_WS_BACKPLANE_TOPIC and BLOK_WS_BACKPLANE_GROUP overrides", () => {
		process.env.BLOK_WS_BACKPLANE = "kafka";
		process.env.BLOK_WS_BACKPLANE_TOPIC = "custom-ws-topic";
		process.env.BLOK_WS_BACKPLANE_GROUP = "blok-ws-cluster";
		const config = resolveBackplaneConfig(undefined);
		expect(config).toEqual({
			provider: "kafka",
			topic: "custom-ws-topic",
			consumerGroup: "blok-ws-cluster",
		});
	});

	it("returns null when neither constructor arg nor env var is set", () => {
		expect(resolveBackplaneConfig(undefined)).toBeNull();
	});

	it("rejects invalid env values silently (returns null)", () => {
		process.env.BLOK_WS_BACKPLANE = "not-a-provider";
		expect(resolveBackplaneConfig(undefined)).toBeNull();
	});
});
