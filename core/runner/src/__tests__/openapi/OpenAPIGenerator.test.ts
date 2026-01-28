import { describe, expect, it } from "vitest";
import { OpenAPIGenerator, type WorkflowDefinition } from "../../openapi/OpenAPIGenerator";

describe("OpenAPIGenerator", () => {
	const basicWorkflow: WorkflowDefinition = {
		name: "get-user",
		version: "1.0.0",
		description: "Fetch a user by ID",
		trigger: {
			http: { method: "GET", path: "/users/:id" },
		},
		steps: [{ name: "fetch-user", node: "fetch-user@1.0.0", type: "module" }],
		nodes: {
			"fetch-user": {
				inputs: { userId: "{{ctx.request.params.id}}" },
			},
		},
	};

	it("should generate valid OpenAPI 3.1 spec", () => {
		const gen = new OpenAPIGenerator({
			title: "Test API",
			version: "1.0.0",
		});

		gen.addWorkflow(basicWorkflow);
		const spec = gen.generate();

		expect(spec.openapi).toBe("3.1.0");
		expect(spec.info.title).toBe("Test API");
		expect(spec.info.version).toBe("1.0.0");
	});

	it("should convert paths from Express to OpenAPI format", () => {
		const gen = new OpenAPIGenerator({ title: "API", version: "1.0" });
		gen.addWorkflow(basicWorkflow);

		const spec = gen.generate();
		expect(spec.paths["/users/{id}"]).toBeDefined();
		expect(spec.paths["/users/:id"]).toBeUndefined();
	});

	it("should extract path parameters", () => {
		const gen = new OpenAPIGenerator({ title: "API", version: "1.0" });
		gen.addWorkflow(basicWorkflow);

		const spec = gen.generate();
		const operation = spec.paths["/users/{id}"].get;

		expect(operation).toBeDefined();
		const pathParam = operation?.parameters?.find((p) => p.name === "id" && p.in === "path");
		expect(pathParam).toBeDefined();
		expect(pathParam?.required).toBe(true);
	});

	it("should generate correct HTTP methods", () => {
		const gen = new OpenAPIGenerator({ title: "API", version: "1.0" });

		gen.addWorkflow({
			name: "create-user",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/users" } },
			steps: [],
			nodes: {},
		});

		gen.addWorkflow(basicWorkflow);

		const spec = gen.generate();
		expect(spec.paths["/users"]?.post).toBeDefined();
		expect(spec.paths["/users/{id}"]?.get).toBeDefined();
	});

	it("should add request body for POST/PUT/PATCH", () => {
		const gen = new OpenAPIGenerator({ title: "API", version: "1.0" });

		gen.addWorkflow({
			name: "create-user",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/users" } },
			steps: [{ name: "create", node: "create@1.0.0", type: "module" }],
			nodes: {
				create: {
					inputs: {
						name: "{{ctx.request.body.name}}",
						email: "{{ctx.request.body.email}}",
					},
				},
			},
		});

		const spec = gen.generate();
		const operation = spec.paths["/users"]?.post;

		expect(operation?.requestBody).toBeDefined();
		expect(operation?.requestBody?.content["application/json"]).toBeDefined();
	});

	it("should include default health and metrics endpoints", () => {
		const gen = new OpenAPIGenerator({ title: "API", version: "1.0" });
		const spec = gen.generate();

		expect(spec.paths["/health-check"]?.get).toBeDefined();
		expect(spec.paths["/metrics"]?.get).toBeDefined();
	});

	it("should include error responses", () => {
		const gen = new OpenAPIGenerator({ title: "API", version: "1.0" });
		gen.addWorkflow(basicWorkflow);

		const spec = gen.generate();
		const operation = spec.paths["/users/{id}"]?.get;

		expect(operation?.responses["400"]).toBeDefined();
		expect(operation?.responses["500"]).toBeDefined();
	});

	it("should include ErrorResponse schema", () => {
		const gen = new OpenAPIGenerator({ title: "API", version: "1.0" });
		const spec = gen.generate();

		expect(spec.components.schemas.ErrorResponse).toBeDefined();
	});

	it("should support custom server URLs", () => {
		const gen = new OpenAPIGenerator({
			title: "API",
			version: "1.0",
			servers: [
				{ url: "https://api.example.com", description: "Production" },
				{ url: "http://localhost:4000", description: "Development" },
			],
		});

		const spec = gen.generate();
		expect(spec.servers?.length).toBe(2);
		expect(spec.servers?.[0].url).toBe("https://api.example.com");
	});

	it("should support security schemes", () => {
		const gen = new OpenAPIGenerator({
			title: "API",
			version: "1.0",
			securitySchemes: {
				bearerAuth: {
					type: "http",
					scheme: "bearer",
					bearerFormat: "JWT",
				},
				apiKey: {
					type: "apiKey",
					name: "x-api-key",
					in: "header",
				},
			},
		});

		const spec = gen.generate();
		expect(spec.components.securitySchemes?.bearerAuth).toBeDefined();
		expect(spec.components.securitySchemes?.apiKey).toBeDefined();
		expect(spec.security?.length).toBe(2);
	});

	it("should auto-generate tags from workflow names", () => {
		const gen = new OpenAPIGenerator({ title: "API", version: "1.0" });
		gen.addWorkflow({
			name: "user-create",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/users" } },
			steps: [],
			nodes: {},
		});
		gen.addWorkflow({
			name: "order-list",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/orders" } },
			steps: [],
			nodes: {},
		});

		const spec = gen.generate();
		const tagNames = spec.tags?.map((t) => t.name) || [];
		expect(tagNames).toContain("User");
		expect(tagNames).toContain("Order");
		expect(tagNames).toContain("System");
	});

	it("should generate operation IDs", () => {
		const gen = new OpenAPIGenerator({ title: "API", version: "1.0" });
		gen.addWorkflow(basicWorkflow);

		const spec = gen.generate();
		const operation = spec.paths["/users/{id}"]?.get;
		expect(operation?.operationId).toBe("getGetUser");
	});

	it("should skip non-HTTP workflows", () => {
		const gen = new OpenAPIGenerator({ title: "API", version: "1.0" });
		gen.addWorkflow({
			name: "queue-worker",
			version: "1.0.0",
			trigger: { queue: { provider: "kafka", topic: "events" } },
			steps: [],
			nodes: {},
		});

		const spec = gen.generate();
		// Only health-check and metrics
		const pathCount = Object.keys(spec.paths).length;
		expect(pathCount).toBe(2);
	});

	it("should add custom schemas", () => {
		const gen = new OpenAPIGenerator({ title: "API", version: "1.0" });
		gen.addSchema("User", {
			type: "object",
			properties: {
				id: { type: "string" },
				name: { type: "string" },
			},
		});

		const spec = gen.generate();
		expect(spec.components.schemas.User).toBeDefined();
	});

	it("should output JSON string", () => {
		const gen = new OpenAPIGenerator({ title: "API", version: "1.0" });
		const json = gen.toJSON();

		const parsed = JSON.parse(json);
		expect(parsed.openapi).toBe("3.1.0");
	});

	it("should output YAML string", () => {
		const gen = new OpenAPIGenerator({ title: "API", version: "1.0" });
		const yaml = gen.toYAML();

		expect(yaml).toContain("openapi: 3.1.0");
		expect(yaml).toContain("title: API");
	});

	it("should include requestId query parameter", () => {
		const gen = new OpenAPIGenerator({ title: "API", version: "1.0" });
		gen.addWorkflow(basicWorkflow);

		const spec = gen.generate();
		const operation = spec.paths["/users/{id}"]?.get;
		const requestIdParam = operation?.parameters?.find((p) => p.name === "requestId");

		expect(requestIdParam).toBeDefined();
		expect(requestIdParam?.in).toBe("query");
		expect(requestIdParam?.required).toBe(false);
	});

	it("should handle multiple workflows on same path", () => {
		const gen = new OpenAPIGenerator({ title: "API", version: "1.0" });
		gen.addWorkflow({
			name: "list-users",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/users" } },
			steps: [],
			nodes: {},
		});
		gen.addWorkflow({
			name: "create-user",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/users" } },
			steps: [],
			nodes: {},
		});

		const spec = gen.generate();
		expect(spec.paths["/users"]?.get).toBeDefined();
		expect(spec.paths["/users"]?.post).toBeDefined();
	});

	it("should include contact and license info", () => {
		const gen = new OpenAPIGenerator({
			title: "API",
			version: "1.0",
			contact: { name: "Blok Team", email: "team@blok.dev" },
			license: { name: "MIT", url: "https://opensource.org/licenses/MIT" },
		});

		const spec = gen.generate();
		expect(spec.info.contact?.name).toBe("Blok Team");
		expect(spec.info.license?.name).toBe("MIT");
	});
});
