import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

describe("Workflow JSON Schema", () => {
	const schemaPath = path.resolve(__dirname, "../../schemas/workflow.schema.json");
	let schema: Record<string, unknown>;

	it("should be valid JSON", () => {
		const content = fs.readFileSync(schemaPath, "utf-8");
		schema = JSON.parse(content);
		expect(schema).toBeDefined();
	});

	it("should have proper $schema reference", () => {
		const content = fs.readFileSync(schemaPath, "utf-8");
		schema = JSON.parse(content);
		expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
	});

	it("should define required properties", () => {
		const content = fs.readFileSync(schemaPath, "utf-8");
		schema = JSON.parse(content);
		const required = schema.required as string[];
		expect(required).toContain("name");
		expect(required).toContain("version");
		expect(required).toContain("trigger");
		expect(required).toContain("steps");
		expect(required).toContain("nodes");
	});

	it("should define all trigger types", () => {
		const content = fs.readFileSync(schemaPath, "utf-8");
		schema = JSON.parse(content);
		const triggerProps = (schema.properties as Record<string, unknown>).trigger as Record<string, unknown>;
		const triggerProperties = triggerProps.properties as Record<string, unknown>;

		const expectedTriggers = [
			"http",
			"grpc",
			"manual",
			"cron",
			"queue",
			"pubsub",
			"worker",
			"webhook",
			"websocket",
			"sse",
		];
		for (const trigger of expectedTriggers) {
			expect(triggerProperties).toHaveProperty(trigger);
		}
	});

	it("should define step structure with required fields", () => {
		const content = fs.readFileSync(schemaPath, "utf-8");
		schema = JSON.parse(content);
		const definitions = schema.definitions as Record<string, unknown>;
		const step = definitions.step as Record<string, unknown>;
		const stepRequired = step.required as string[];

		expect(stepRequired).toContain("name");
		expect(stepRequired).toContain("node");
		expect(stepRequired).toContain("type");
	});

	it("should define valid step types", () => {
		const content = fs.readFileSync(schemaPath, "utf-8");
		schema = JSON.parse(content);
		const definitions = schema.definitions as Record<string, unknown>;
		const step = definitions.step as Record<string, unknown>;
		const stepProps = step.properties as Record<string, unknown>;
		const typeField = stepProps.type as Record<string, unknown>;
		const typeEnum = typeField.enum as string[];

		expect(typeEnum).toContain("local");
		expect(typeEnum).toContain("module");
		expect(typeEnum).toContain("runtime.nodejs");
		expect(typeEnum).toContain("runtime.python3");
		expect(typeEnum).toContain("runtime.go");
		expect(typeEnum).toContain("runtime.java");
		expect(typeEnum).toContain("runtime.rust");
	});

	it("should define valid runtime kinds", () => {
		const content = fs.readFileSync(schemaPath, "utf-8");
		schema = JSON.parse(content);
		const definitions = schema.definitions as Record<string, unknown>;
		const step = definitions.step as Record<string, unknown>;
		const stepProps = step.properties as Record<string, unknown>;
		const runtimeField = stepProps.runtime as Record<string, unknown>;
		const runtimeEnum = runtimeField.enum as string[];

		expect(runtimeEnum).toContain("nodejs");
		expect(runtimeEnum).toContain("python3");
		expect(runtimeEnum).toContain("go");
		expect(runtimeEnum).toContain("java");
		expect(runtimeEnum).toContain("rust");
		expect(runtimeEnum).toContain("docker");
		expect(runtimeEnum).toContain("wasm");
	});

	it("should define HTTP trigger with method and path", () => {
		const content = fs.readFileSync(schemaPath, "utf-8");
		schema = JSON.parse(content);
		const definitions = schema.definitions as Record<string, unknown>;
		const httpTrigger = definitions.httpTrigger as Record<string, unknown>;
		const required = httpTrigger.required as string[];

		expect(required).toContain("method");
		expect(required).toContain("path");

		const props = httpTrigger.properties as Record<string, unknown>;
		const methodField = props.method as Record<string, unknown>;
		const methodEnum = methodField.enum as string[];

		expect(methodEnum).toContain("GET");
		expect(methodEnum).toContain("POST");
		expect(methodEnum).toContain("ANY");
	});

	it("should define cron trigger with schedule", () => {
		const content = fs.readFileSync(schemaPath, "utf-8");
		schema = JSON.parse(content);
		const definitions = schema.definitions as Record<string, unknown>;
		const cronTrigger = definitions.cronTrigger as Record<string, unknown>;
		const required = cronTrigger.required as string[];

		expect(required).toContain("schedule");
	});

	it("should define queue trigger with provider and topic", () => {
		const content = fs.readFileSync(schemaPath, "utf-8");
		schema = JSON.parse(content);
		const definitions = schema.definitions as Record<string, unknown>;
		const queueTrigger = definitions.queueTrigger as Record<string, unknown>;
		const required = queueTrigger.required as string[];

		expect(required).toContain("provider");
		expect(required).toContain("topic");
	});

	it("should define webhook trigger with source and events", () => {
		const content = fs.readFileSync(schemaPath, "utf-8");
		schema = JSON.parse(content);
		const definitions = schema.definitions as Record<string, unknown>;
		const webhookTrigger = definitions.webhookTrigger as Record<string, unknown>;
		const required = webhookTrigger.required as string[];

		expect(required).toContain("source");
		expect(required).toContain("events");
	});

	it("should define condition structure with type enum", () => {
		const content = fs.readFileSync(schemaPath, "utf-8");
		schema = JSON.parse(content);
		const definitions = schema.definitions as Record<string, unknown>;
		const condition = definitions.condition as Record<string, unknown>;
		const required = condition.required as string[];
		expect(required).toContain("type");

		const props = condition.properties as Record<string, unknown>;
		const typeField = props.type as Record<string, unknown>;
		const typeEnum = typeField.enum as string[];
		expect(typeEnum).toContain("if");
		expect(typeEnum).toContain("else");
	});
});
