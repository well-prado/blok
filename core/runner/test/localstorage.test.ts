import { type HelperResponse, Workflow } from "@nanoservice-ts/helper";
import { beforeAll, expect, test } from "vitest";
import path from "node:path";
import LocalStorage from "../src/LocalStorage";
import type { WorkflowLocator } from "../src/types/GlobalOptions";

let locator: WorkflowLocator = <WorkflowLocator>{};
const storage: LocalStorage = new LocalStorage();

beforeAll(async () => {
	// Set WORKFLOWS_PATH to the http trigger workflows directory for tests
	const workflowsPath = path.resolve(__dirname, "../../../triggers/http/workflows");
	process.env.WORKFLOWS_PATH = workflowsPath;
	locator = createLocator();
});

function createLocator(): WorkflowLocator {
	const step1Inputs = {
		url: "https://countriesnow.space/api/v0.1/countries/capital",
		method: "GET",
		headers: {
			"Content-Type": "application/json",
		},
		responseType: "application/json",
	};

	const step = Workflow({
		name: "World Countries",
		version: "1.0.0",
		description: "Workflow description",
	})
		.addTrigger("http", {
			method: "GET",
			path: "/",
			accept: "application/json",
		})
		.addStep({
			name: "get-countries-api",
			node: "@nanoservice-ts/api-call",
			type: "module",
			inputs: step1Inputs,
		}) as HelperResponse;

	locator["countries-helper"] = step;

	return locator;
}

test("Load JSON example", async () => {
	// Test that loading countries from JSON doesn't throw
	const result = await storage.get("countries", locator, "json");
	expect(result).toBeDefined();
	expect(result.name).toBeDefined();
});

test("Load Helper example", async () => {
	// Test that loading countries-helper from locator doesn't throw
	const result = await storage.get("countries-helper", locator);
	expect(result).toBeDefined();
	expect(result.name).toBeDefined();
});

test("Compare JSON vs Helper", async () => {
	const json = await storage.get("countries", locator, "json");
	const helper = await storage.get("countries-helper", locator);

	expect(json).toEqual(helper);
});

test("Load YAML example", async () => {
	// Test that loading countries from YAML doesn't throw
	const result = await storage.get("countries", locator, "yaml");
	expect(result).toBeDefined();
	expect(result.name).toBeDefined();
});

test("Compare YAML vs Helper", async () => {
	const yaml = await storage.get("countries", locator, "yaml");
	const json = await storage.get("countries", locator, "json");

	expect(json).toEqual(yaml);
});

test("Load XML example", async () => {
	// Test that loading countries from XML doesn't throw
	const result = await storage.get("countries", locator, "xml");
	expect(result).toBeDefined();
	expect(result.name).toBeDefined();
});

test("Compare XML vs Helper", async () => {
	const xml = await storage.get("countries", locator, "xml");
	const json = await storage.get("countries", locator, "json");

	expect(json).toEqual(xml);
});

test("Load TOML example", async () => {
	// Test that loading countries from TOML doesn't throw
	const result = await storage.get("countries", locator, "toml");
	expect(result).toBeDefined();
	expect(result.name).toBeDefined();
});

test("Compare TOML vs Helper", async () => {
	const toml = await storage.get("countries", locator, "toml");
	const json = await storage.get("countries", locator, "json");

	expect(json).toEqual(toml);
});
