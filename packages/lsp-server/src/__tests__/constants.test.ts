import { describe, expect, it } from "vitest";
import {
	FIELD_DOCS,
	NODE_PACKAGES,
	PUBSUB_PROVIDERS,
	QUEUE_PROVIDERS,
	STEP_FIELD_DOCS,
	TRIGGER_DOCS,
	VALID_HTTP_METHODS,
	VALID_RUNTIMES,
	VALID_STEP_TYPES,
	VALID_TRIGGERS,
	WEBHOOK_SOURCES,
} from "../constants";

describe("LSP Constants", () => {
	describe("VALID_TRIGGERS", () => {
		it("should have all 10 trigger types", () => {
			expect(VALID_TRIGGERS).toHaveLength(10);
			expect(VALID_TRIGGERS).toContain("http");
			expect(VALID_TRIGGERS).toContain("grpc");
			expect(VALID_TRIGGERS).toContain("manual");
			expect(VALID_TRIGGERS).toContain("cron");
			expect(VALID_TRIGGERS).toContain("queue");
			expect(VALID_TRIGGERS).toContain("pubsub");
			expect(VALID_TRIGGERS).toContain("worker");
			expect(VALID_TRIGGERS).toContain("webhook");
			expect(VALID_TRIGGERS).toContain("websocket");
			expect(VALID_TRIGGERS).toContain("sse");
		});
	});

	describe("VALID_HTTP_METHODS", () => {
		it("should include standard HTTP methods and ANY", () => {
			expect(VALID_HTTP_METHODS).toContain("GET");
			expect(VALID_HTTP_METHODS).toContain("POST");
			expect(VALID_HTTP_METHODS).toContain("PUT");
			expect(VALID_HTTP_METHODS).toContain("DELETE");
			expect(VALID_HTTP_METHODS).toContain("PATCH");
			expect(VALID_HTTP_METHODS).toContain("ANY");
		});
	});

	describe("VALID_STEP_TYPES", () => {
		it("should include local, module, and runtime types", () => {
			expect(VALID_STEP_TYPES).toContain("local");
			expect(VALID_STEP_TYPES).toContain("module");
			expect(VALID_STEP_TYPES).toContain("runtime.nodejs");
			expect(VALID_STEP_TYPES).toContain("runtime.python3");
			expect(VALID_STEP_TYPES).toContain("runtime.go");
			expect(VALID_STEP_TYPES).toContain("runtime.java");
			expect(VALID_STEP_TYPES).toContain("runtime.rust");
		});
	});

	describe("VALID_RUNTIMES", () => {
		it("should include all 11 runtime kinds", () => {
			expect(VALID_RUNTIMES).toHaveLength(11);
			expect(VALID_RUNTIMES).toContain("nodejs");
			expect(VALID_RUNTIMES).toContain("bun");
			expect(VALID_RUNTIMES).toContain("python3");
			expect(VALID_RUNTIMES).toContain("go");
			expect(VALID_RUNTIMES).toContain("java");
			expect(VALID_RUNTIMES).toContain("rust");
			expect(VALID_RUNTIMES).toContain("docker");
			expect(VALID_RUNTIMES).toContain("wasm");
		});
	});

	describe("TRIGGER_DOCS", () => {
		it("should have documentation for all triggers", () => {
			for (const trigger of VALID_TRIGGERS) {
				expect(TRIGGER_DOCS).toHaveProperty(trigger);
				expect(TRIGGER_DOCS[trigger].title).toBeTruthy();
				expect(TRIGGER_DOCS[trigger].description).toBeTruthy();
			}
		});

		it("should include examples for all trigger docs", () => {
			for (const trigger of VALID_TRIGGERS) {
				expect(TRIGGER_DOCS[trigger].example).toBeTruthy();
			}
		});
	});

	describe("FIELD_DOCS", () => {
		it("should have documentation for core workflow fields", () => {
			expect(FIELD_DOCS).toHaveProperty("name");
			expect(FIELD_DOCS).toHaveProperty("version");
			expect(FIELD_DOCS).toHaveProperty("trigger");
			expect(FIELD_DOCS).toHaveProperty("steps");
			expect(FIELD_DOCS).toHaveProperty("nodes");
			expect(FIELD_DOCS).toHaveProperty("inputs");
			expect(FIELD_DOCS).toHaveProperty("conditions");
			expect(FIELD_DOCS).toHaveProperty("set_var");
		});
	});

	describe("STEP_FIELD_DOCS", () => {
		it("should have documentation for step fields", () => {
			expect(STEP_FIELD_DOCS).toHaveProperty("node");
			expect(STEP_FIELD_DOCS).toHaveProperty("type");
			expect(STEP_FIELD_DOCS).toHaveProperty("runtime");
		});
	});

	describe("NODE_PACKAGES", () => {
		it("should include core node packages", () => {
			const names = NODE_PACKAGES.map((n) => n.name);
			expect(names).toContain("@blokjs/api-call");
			expect(names).toContain("@blokjs/if-else");
			expect(names).toContain("@blokjs/react");
		});
	});

	describe("QUEUE_PROVIDERS", () => {
		it("should include all queue providers", () => {
			expect(QUEUE_PROVIDERS).toContain("kafka");
			expect(QUEUE_PROVIDERS).toContain("rabbitmq");
			expect(QUEUE_PROVIDERS).toContain("sqs");
			expect(QUEUE_PROVIDERS).toContain("redis");
		});
	});

	describe("PUBSUB_PROVIDERS", () => {
		it("should include all pubsub providers", () => {
			expect(PUBSUB_PROVIDERS).toContain("gcp");
			expect(PUBSUB_PROVIDERS).toContain("aws");
			expect(PUBSUB_PROVIDERS).toContain("azure");
			expect(PUBSUB_PROVIDERS).toContain("nats");
		});
	});

	describe("WEBHOOK_SOURCES", () => {
		it("should include all webhook sources", () => {
			expect(WEBHOOK_SOURCES).toContain("github");
			expect(WEBHOOK_SOURCES).toContain("stripe");
			expect(WEBHOOK_SOURCES).toContain("shopify");
			expect(WEBHOOK_SOURCES).toContain("custom");
		});
	});
});
