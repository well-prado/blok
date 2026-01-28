import { describe, it, expect, beforeEach } from "vitest";
import { GraphQLSchemaGenerator, type GqlWorkflowDefinition } from "../GraphQLSchemaGenerator";

// -- Fixtures --

const getWorkflow: GqlWorkflowDefinition = {
	name: "get-user",
	version: "1.0.0",
	description: "Fetch a user by ID",
	trigger: { http: { method: "GET", path: "/users/:id" } },
	steps: [{ name: "fetch", node: "db-query", type: "local" }],
	nodes: { "db-query": {} },
};

const postWorkflow: GqlWorkflowDefinition = {
	name: "create-user",
	version: "1.0.0",
	description: "Create a new user",
	trigger: { http: { method: "POST", path: "/users" } },
	steps: [
		{ name: "validate", node: "validator", type: "local" },
		{ name: "create", node: "db-insert", type: "local" },
	],
	nodes: { validator: {}, "db-insert": {} },
};

const putWorkflow: GqlWorkflowDefinition = {
	name: "update-user",
	version: "1.0.0",
	trigger: { http: { method: "PUT", path: "/users/:id" } },
	steps: [{ name: "update", node: "db-update", type: "local" }],
	nodes: { "db-update": {} },
};

const deleteWorkflow: GqlWorkflowDefinition = {
	name: "delete-user",
	version: "1.0.0",
	trigger: { http: { method: "DELETE", path: "/users/:id" } },
	steps: [{ name: "delete", node: "db-delete", type: "local" }],
	nodes: { "db-delete": {} },
};

const wsWorkflow: GqlWorkflowDefinition = {
	name: "live-chat",
	version: "1.0.0",
	trigger: { websocket: { path: "/ws/chat" } },
	steps: [{ name: "handle", node: "chat-handler", type: "local" }],
	nodes: { "chat-handler": {} },
};

const sseWorkflow: GqlWorkflowDefinition = {
	name: "live-updates",
	version: "1.0.0",
	trigger: { sse: { path: "/events" } },
	steps: [{ name: "stream", node: "streamer", type: "local" }],
	nodes: { streamer: {} },
};

const grpcWorkflow: GqlWorkflowDefinition = {
	name: "grpc-service",
	version: "1.0.0",
	trigger: { grpc: { service: "UserService", method: "GetUser" } },
	steps: [{ name: "get", node: "user-getter", type: "local" }],
	nodes: { "user-getter": {} },
};

const typedWorkflow: GqlWorkflowDefinition = {
	name: "typed-api",
	version: "1.0.0",
	description: "API with typed inputs/outputs",
	trigger: { http: { method: "POST", path: "/typed" } },
	steps: [{ name: "process", node: "processor", type: "local" }],
	nodes: { processor: {} },
	inputs: {
		name: { type: "string", required: true, description: "User name" },
		age: { type: "integer", required: false, description: "User age" },
		tags: { type: "array", items: { type: "string" } },
		active: { type: "boolean", required: true },
	},
	outputs: {
		id: { type: "string", required: true, description: "Created ID" },
		createdAt: { type: "datetime", required: true, description: "Creation timestamp" },
		score: { type: "float" },
	},
};

const patchWorkflow: GqlWorkflowDefinition = {
	name: "patch-user",
	version: "1.0.0",
	trigger: { http: { method: "PATCH", path: "/users/:id" } },
	steps: [{ name: "patch", node: "db-patch", type: "local" }],
	nodes: { "db-patch": {} },
};

describe("GraphQLSchemaGenerator", () => {
	let gen: GraphQLSchemaGenerator;

	beforeEach(() => {
		gen = new GraphQLSchemaGenerator();
	});

	describe("Constructor", () => {
		it("should create with default config", () => {
			expect(gen).toBeDefined();
		});

		it("should accept custom config", () => {
			const custom = new GraphQLSchemaGenerator({
				schemaName: "MyAPI",
				description: "Custom schema",
				includeSubscriptions: false,
				includeMetadata: false,
				customScalars: [{ name: "URL", description: "A URL string" }],
			});
			expect(custom).toBeDefined();
		});
	});

	describe("generate - empty", () => {
		it("should generate empty schema with health check", () => {
			const schema = gen.generate();

			expect(schema).toContain("scalar JSON");
			expect(schema).toContain("scalar DateTime");
			expect(schema).toContain("type Query");
			expect(schema).toContain("_health: Boolean!");
			expect(schema).toContain("schema {");
			expect(schema).toContain("query: Query");
		});
	});

	describe("generate - GET workflows (Query)", () => {
		it("should generate Query type for GET endpoints", () => {
			gen.addWorkflow(getWorkflow);
			const schema = gen.generate();

			expect(schema).toContain("type Query {");
			expect(schema).toContain("getUser");
			expect(schema).toContain("GetUserResponse");
			expect(schema).toContain("id: String!");
		});

		it("should extract path params as arguments", () => {
			gen.addWorkflow(getWorkflow);
			const schema = gen.generate();

			expect(schema).toContain("getUser(id: String!)");
		});

		it("should generate output type with default fields", () => {
			gen.addWorkflow(getWorkflow);
			const schema = gen.generate();

			expect(schema).toContain("type GetUserResponse {");
			expect(schema).toContain("success: Boolean!");
			expect(schema).toContain("data: JSON");
			expect(schema).toContain("error: BlokError");
		});

		it("should include description from workflow", () => {
			gen.addWorkflow(getWorkflow);
			const schema = gen.generate();

			expect(schema).toContain("Fetch a user by ID");
		});
	});

	describe("generate - POST/PUT/DELETE workflows (Mutation)", () => {
		it("should generate Mutation type for POST endpoints", () => {
			gen.addWorkflow(postWorkflow);
			const schema = gen.generate();

			expect(schema).toContain("type Mutation {");
			expect(schema).toContain("createUser");
			expect(schema).toContain("CreateUserInput");
			expect(schema).toContain("CreateUserResponse");
		});

		it("should generate input type for POST", () => {
			gen.addWorkflow(postWorkflow);
			const schema = gen.generate();

			expect(schema).toContain("input CreateUserInput {");
			expect(schema).toContain("data: JSON");
		});

		it("should handle PUT as mutation", () => {
			gen.addWorkflow(putWorkflow);
			const schema = gen.generate();

			expect(schema).toContain("type Mutation {");
			expect(schema).toContain("updateUser");
		});

		it("should handle DELETE as mutation", () => {
			gen.addWorkflow(deleteWorkflow);
			const schema = gen.generate();

			expect(schema).toContain("type Mutation {");
			expect(schema).toContain("deleteUser");
		});

		it("should handle PATCH as mutation with input", () => {
			gen.addWorkflow(patchWorkflow);
			const schema = gen.generate();

			expect(schema).toContain("type Mutation {");
			expect(schema).toContain("patchUser");
			expect(schema).toContain("PatchUserInput");
		});

		it("should include path params alongside input for PUT", () => {
			gen.addWorkflow(putWorkflow);
			const schema = gen.generate();

			expect(schema).toContain("id: String!");
			expect(schema).toContain("UpdateUserInput");
		});
	});

	describe("generate - WebSocket/SSE workflows (Subscription)", () => {
		it("should generate Subscription type for WebSocket", () => {
			gen.addWorkflow(wsWorkflow);
			const schema = gen.generate();

			expect(schema).toContain("type Subscription {");
			expect(schema).toContain("onLiveChat");
			expect(schema).toContain("LiveChatResponse");
		});

		it("should generate Subscription type for SSE", () => {
			gen.addWorkflow(sseWorkflow);
			const schema = gen.generate();

			expect(schema).toContain("type Subscription {");
			expect(schema).toContain("onLiveUpdates");
		});

		it("should not include subscriptions when disabled", () => {
			const noSub = new GraphQLSchemaGenerator({ includeSubscriptions: false });
			noSub.addWorkflow(wsWorkflow);
			const schema = noSub.generate();

			expect(schema).not.toContain("type Subscription");
			expect(schema).not.toContain("subscription: Subscription");
		});
	});

	describe("generate - gRPC workflows", () => {
		it("should generate Query type for gRPC", () => {
			gen.addWorkflow(grpcWorkflow);
			const schema = gen.generate();

			expect(schema).toContain("type Query {");
			expect(schema).toContain("grpcService");
		});
	});

	describe("generate - Typed inputs/outputs", () => {
		it("should generate typed input fields", () => {
			gen.addWorkflow(typedWorkflow);
			const schema = gen.generate();

			expect(schema).toContain("input TypedApiInput {");
			expect(schema).toContain("name: String!");
			expect(schema).toContain("age: Int");
			expect(schema).toContain("tags: [String]");
			expect(schema).toContain("active: Boolean!");
		});

		it("should generate typed output fields", () => {
			gen.addWorkflow(typedWorkflow);
			const schema = gen.generate();

			expect(schema).toContain("type TypedApiResponse {");
			expect(schema).toContain("id: String!");
			expect(schema).toContain("createdAt: DateTime!");
			expect(schema).toContain("score: Float");
		});

		it("should include field descriptions", () => {
			gen.addWorkflow(typedWorkflow);
			const schema = gen.generate();

			expect(schema).toContain('"""User name"""');
			expect(schema).toContain('"""Created ID"""');
		});
	});

	describe("generate - Combined schema", () => {
		it("should combine Query, Mutation, and Subscription", () => {
			gen.addWorkflows([getWorkflow, postWorkflow, wsWorkflow]);
			const schema = gen.generate();

			expect(schema).toContain("type Query {");
			expect(schema).toContain("type Mutation {");
			expect(schema).toContain("type Subscription {");
			expect(schema).toContain("schema {");
			expect(schema).toContain("query: Query");
			expect(schema).toContain("mutation: Mutation");
			expect(schema).toContain("subscription: Subscription");
		});

		it("should include BlokError type", () => {
			gen.addWorkflow(getWorkflow);
			const schema = gen.generate();

			expect(schema).toContain("type BlokError {");
			expect(schema).toContain("message: String!");
			expect(schema).toContain("origin: String");
			expect(schema).toContain("code: String");
		});

		it("should include WorkflowMetadata type when metadata enabled", () => {
			gen.addWorkflow(getWorkflow);
			const schema = gen.generate();

			expect(schema).toContain("type WorkflowMetadata {");
			expect(schema).toContain("_workflows: [WorkflowMetadata!]!");
		});

		it("should not include WorkflowMetadata when disabled", () => {
			const noMeta = new GraphQLSchemaGenerator({ includeMetadata: false });
			noMeta.addWorkflow(getWorkflow);
			const schema = noMeta.generate();

			expect(schema).not.toContain("type WorkflowMetadata");
			expect(schema).not.toContain("_workflows");
		});

		it("should include custom scalars", () => {
			const custom = new GraphQLSchemaGenerator({
				customScalars: [
					{ name: "URL", description: "A valid URL" },
					{ name: "EmailAddress", description: "An email address" },
				],
			});
			custom.addWorkflow(getWorkflow);
			const schema = custom.generate();

			expect(schema).toContain("scalar URL");
			expect(schema).toContain("scalar EmailAddress");
			expect(schema).toContain('"A valid URL"');
		});

		it("should include workflow count in header", () => {
			gen.addWorkflows([getWorkflow, postWorkflow]);
			const schema = gen.generate();

			expect(schema).toContain("Generated from 2 Blok workflow(s)");
		});
	});

	describe("generate - custom types", () => {
		it("should include custom type definitions", () => {
			gen.addCustomType("Address", 'type Address {\n  street: String!\n  city: String!\n}');
			gen.addWorkflow(getWorkflow);
			const schema = gen.generate();

			expect(schema).toContain("type Address {");
			expect(schema).toContain("street: String!");
		});
	});

	describe("toJSON", () => {
		it("should return JSON representation for GET workflow", () => {
			gen.addWorkflow(getWorkflow);
			const json = gen.toJSON();

			expect(json.schemaName).toBe("BlokAPI");
			expect(json.queries).toHaveLength(1);
			expect(json.queries[0].name).toBe("getUser");
			expect(json.queries[0].type).toBe("GetUserResponse");
			expect(json.mutations).toHaveLength(0);
		});

		it("should return JSON representation for POST workflow", () => {
			gen.addWorkflow(postWorkflow);
			const json = gen.toJSON();

			expect(json.mutations).toHaveLength(1);
			expect(json.mutations[0].name).toBe("createUser");
			expect(json.queries).toHaveLength(0);
		});

		it("should include subscriptions for WebSocket", () => {
			gen.addWorkflow(wsWorkflow);
			const json = gen.toJSON();

			expect(json.subscriptions).toHaveLength(1);
			expect(json.subscriptions[0].name).toBe("onLiveChat");
		});

		it("should include types with fields", () => {
			gen.addWorkflow(getWorkflow);
			const json = gen.toJSON();

			expect(json.types.length).toBeGreaterThanOrEqual(1);
			const outputType = json.types.find((t) => t.name === "GetUserResponse");
			expect(outputType).toBeDefined();
			expect(outputType!.kind).toBe("OBJECT");
			expect(outputType!.fields.length).toBeGreaterThan(0);
		});

		it("should include input types for POST", () => {
			gen.addWorkflow(postWorkflow);
			const json = gen.toJSON();

			const inputType = json.types.find((t) => t.name === "CreateUserInput");
			expect(inputType).toBeDefined();
			expect(inputType!.kind).toBe("INPUT_OBJECT");
		});

		it("should include path params as args", () => {
			gen.addWorkflow(getWorkflow);
			const json = gen.toJSON();

			const query = json.queries[0];
			expect(query.args).toBeDefined();
			expect(query.args!.length).toBe(1);
			expect(query.args![0].name).toBe("id");
			expect(query.args![0].type).toBe("String!");
		});

		it("should handle typed inputs in JSON", () => {
			gen.addWorkflow(typedWorkflow);
			const json = gen.toJSON();

			const inputType = json.types.find((t) => t.name === "TypedApiInput");
			expect(inputType).toBeDefined();
			const nameField = inputType!.fields.find((f) => f.name === "name");
			expect(nameField).toBeDefined();
			expect(nameField!.type).toBe("String!");
		});
	});

	describe("PascalCase and field naming", () => {
		it("should convert kebab-case to PascalCase for types", () => {
			gen.addWorkflow(getWorkflow);
			const schema = gen.generate();

			expect(schema).toContain("GetUserResponse");
			expect(schema).not.toContain("get-userResponse");
		});

		it("should convert kebab-case to camelCase for fields", () => {
			gen.addWorkflow(getWorkflow);
			const schema = gen.generate();

			expect(schema).toContain("getUser(");
		});

		it("should handle underscores in names", () => {
			const underscoreWorkflow: GqlWorkflowDefinition = {
				name: "get_all_users",
				version: "1.0.0",
				trigger: { http: { method: "GET", path: "/users" } },
				steps: [{ name: "list", node: "lister", type: "local" }],
				nodes: { lister: {} },
			};
			gen.addWorkflow(underscoreWorkflow);
			const schema = gen.generate();

			expect(schema).toContain("GetAllUsersResponse");
			expect(schema).toContain("getAllUsers");
		});
	});

	describe("Multiple path params", () => {
		it("should extract multiple path params", () => {
			const multiParam: GqlWorkflowDefinition = {
				name: "get-comment",
				version: "1.0.0",
				trigger: { http: { method: "GET", path: "/users/:userId/posts/:postId/comments/:commentId" } },
				steps: [{ name: "get", node: "getter", type: "local" }],
				nodes: { getter: {} },
			};
			gen.addWorkflow(multiParam);
			const schema = gen.generate();

			expect(schema).toContain("userId: String!");
			expect(schema).toContain("postId: String!");
			expect(schema).toContain("commentId: String!");
		});
	});
});
