import path from "node:path";
import { workflow } from "@blokjs/helper";
import { beforeAll, expect, test } from "vitest";
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

/**
 * Builds the helper-side reference workflow as a v2 builder. Mirrors
 * the v2 shape of `workflows/json/countries.json` so the
 * format-equivalence tests below verify JSON / YAML / XML / TOML all
 * deserialize to the same object.
 */
function createLocator(): WorkflowLocator {
	const wf = workflow({
		name: "World Countries",
		version: "1.0.0",
		description: "Workflow description",
		trigger: {
			http: {
				method: "GET",
				path: "/countries",
				accept: "application/json",
			},
		},
		steps: [
			{
				id: "get-countries-api",
				use: "@blokjs/api-call",
				type: "module",
				inputs: {
					url: "https://countriesnow.space/api/v0.1/countries/capital",
					method: "GET",
					headers: { "Content-Type": "application/json" },
					responseType: "application/json",
				},
			},
		],
	});

	locator["countries-helper"] = wf;

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
