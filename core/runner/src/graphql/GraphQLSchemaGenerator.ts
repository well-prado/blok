/**
 * GraphQL Schema Generator for Blok Workflows
 *
 * Automatically generates GraphQL schema definitions (SDL) from workflow definitions.
 * Introspects HTTP trigger configurations and node structures to produce
 * Query/Mutation types with appropriate input/output types.
 *
 * @example
 * ```typescript
 * const generator = new GraphQLSchemaGenerator({
 *   schemaName: "BlokAPI",
 *   includeSubscriptions: true,
 * });
 *
 * generator.addWorkflow({
 *   name: "get-user",
 *   version: "1.0.0",
 *   trigger: { http: { method: "GET", path: "/users/:id" } },
 *   steps: [{ name: "fetch", node: "db-query", type: "local" }],
 *   nodes: { "db-query": {} },
 * });
 *
 * console.log(generator.generate());
 * ```
 */

export interface GraphQLGeneratorConfig {
	/** Schema name used in documentation */
	schemaName?: string;
	/** Description for the schema */
	description?: string;
	/** Include subscription types for WebSocket/SSE workflows */
	includeSubscriptions?: boolean;
	/** Include workflow metadata in type descriptions */
	includeMetadata?: boolean;
	/** Custom scalar definitions */
	customScalars?: Array<{ name: string; description: string }>;
}

export interface GqlWorkflowDefinition {
	name: string;
	version: string;
	description?: string;
	trigger: {
		http?: { method: string; path: string };
		grpc?: { service: string; method: string };
		websocket?: { path?: string };
		sse?: { path?: string };
		[key: string]: unknown;
	};
	steps: Array<{
		name: string;
		node: string;
		type?: string;
		runtime?: string;
	}>;
	nodes: Record<string, unknown>;
	inputs?: Record<string, GqlFieldDef>;
	outputs?: Record<string, GqlFieldDef>;
}

export interface GqlFieldDef {
	type: string;
	required?: boolean;
	description?: string;
	items?: GqlFieldDef;
	fields?: Record<string, GqlFieldDef>;
}

interface ResolvedType {
	typeName: string;
	isQuery: boolean;
	isMutation: boolean;
	isSubscription: boolean;
	inputTypeName: string | null;
	outputTypeName: string;
	description: string;
	pathParams: string[];
}

export class GraphQLSchemaGenerator {
	private config: Required<GraphQLGeneratorConfig>;
	private workflows: GqlWorkflowDefinition[] = [];
	private customTypes: Map<string, string> = new Map();

	constructor(config?: GraphQLGeneratorConfig) {
		this.config = {
			schemaName: config?.schemaName ?? "BlokAPI",
			description: config?.description ?? "Auto-generated GraphQL schema from Blok workflows",
			includeSubscriptions: config?.includeSubscriptions ?? true,
			includeMetadata: config?.includeMetadata ?? true,
			customScalars: config?.customScalars ?? [],
		};
	}

	addWorkflow(workflow: GqlWorkflowDefinition): void {
		this.workflows.push(workflow);
	}

	addWorkflows(workflows: GqlWorkflowDefinition[]): void {
		this.workflows.push(...workflows);
	}

	addCustomType(name: string, definition: string): void {
		this.customTypes.set(name, definition);
	}

	/**
	 * Generate GraphQL Schema Definition Language (SDL)
	 */
	generate(): string {
		if (this.workflows.length === 0) {
			return this.emptySchema();
		}

		const lines: string[] = [];
		const queries: string[] = [];
		const mutations: string[] = [];
		const subscriptions: string[] = [];
		const typeDefinitions: string[] = [];

		// Schema header
		lines.push(`# ${this.config.description}`);
		lines.push(`# Generated from ${this.workflows.length} Blok workflow(s)`);
		lines.push("");

		// Custom scalars
		lines.push("scalar JSON");
		lines.push("scalar DateTime");
		for (const scalar of this.config.customScalars) {
			lines.push(`"""${scalar.description}"""`);
			lines.push(`scalar ${scalar.name}`);
		}
		lines.push("");

		// Process each workflow
		for (const workflow of this.workflows) {
			const resolved = this.resolveWorkflow(workflow);

			// Generate input type if needed
			if (resolved.inputTypeName) {
				typeDefinitions.push(this.generateInputType(workflow, resolved));
			}

			// Generate output type
			typeDefinitions.push(this.generateOutputType(workflow, resolved));

			// Add to appropriate root type
			const fieldDef = this.generateFieldDefinition(workflow, resolved);

			if (resolved.isQuery) {
				queries.push(fieldDef);
			}
			if (resolved.isMutation) {
				mutations.push(fieldDef);
			}
			if (resolved.isSubscription) {
				subscriptions.push(this.generateSubscriptionField(workflow, resolved));
			}
		}

		// Custom types
		for (const [, definition] of this.customTypes) {
			typeDefinitions.push(definition);
		}

		// Output type definitions
		for (const typeDef of typeDefinitions) {
			lines.push(typeDef);
			lines.push("");
		}

		// Common error type
		lines.push("type BlokError {");
		lines.push('  """Error message"""');
		lines.push("  message: String!");
		lines.push('  """Node that caused the error"""');
		lines.push("  origin: String");
		lines.push('  """Error code"""');
		lines.push("  code: String");
		lines.push("}");
		lines.push("");

		// Workflow metadata type
		if (this.config.includeMetadata) {
			lines.push("type WorkflowMetadata {");
			lines.push("  name: String!");
			lines.push("  version: String!");
			lines.push("  description: String");
			lines.push("  trigger: String!");
			lines.push("  stepCount: Int!");
			lines.push("}");
			lines.push("");
		}

		// Query type
		if (queries.length > 0) {
			lines.push("type Query {");
			for (const q of queries) {
				lines.push(`  ${q}`);
			}
			if (this.config.includeMetadata) {
				lines.push('  """List all available workflows"""');
				lines.push("  _workflows: [WorkflowMetadata!]!");
			}
			lines.push("}");
			lines.push("");
		}

		// Mutation type
		if (mutations.length > 0) {
			lines.push("type Mutation {");
			for (const m of mutations) {
				lines.push(`  ${m}`);
			}
			lines.push("}");
			lines.push("");
		}

		// Subscription type
		if (this.config.includeSubscriptions && subscriptions.length > 0) {
			lines.push("type Subscription {");
			for (const s of subscriptions) {
				lines.push(`  ${s}`);
			}
			lines.push("}");
			lines.push("");
		}

		// Schema definition
		const schemaFields: string[] = [];
		if (queries.length > 0) schemaFields.push("  query: Query");
		if (mutations.length > 0) schemaFields.push("  mutation: Mutation");
		if (this.config.includeSubscriptions && subscriptions.length > 0) {
			schemaFields.push("  subscription: Subscription");
		}

		if (schemaFields.length > 0) {
			lines.push("schema {");
			lines.push(schemaFields.join("\n"));
			lines.push("}");
		}

		return lines.join("\n");
	}

	/**
	 * Generate an introspection-friendly JSON representation
	 */
	toJSON(): GraphQLSchemaJSON {
		const types: GraphQLTypeInfo[] = [];
		const queries: GraphQLFieldInfo[] = [];
		const mutations: GraphQLFieldInfo[] = [];
		const subscriptions: GraphQLFieldInfo[] = [];

		for (const workflow of this.workflows) {
			const resolved = this.resolveWorkflow(workflow);

			types.push({
				name: resolved.outputTypeName,
				kind: "OBJECT",
				fields: this.inferOutputFields(workflow),
			});

			if (resolved.inputTypeName) {
				types.push({
					name: resolved.inputTypeName,
					kind: "INPUT_OBJECT",
					fields: this.inferInputFields(workflow, resolved),
				});
			}

			const fieldInfo: GraphQLFieldInfo = {
				name: this.toFieldName(workflow.name),
				type: resolved.outputTypeName,
				description: resolved.description,
				args: resolved.inputTypeName
					? [{ name: "input", type: resolved.inputTypeName + "!" }]
					: resolved.pathParams.map((p) => ({ name: p, type: "String!" })),
			};

			if (resolved.isQuery) queries.push(fieldInfo);
			if (resolved.isMutation) mutations.push(fieldInfo);
			if (resolved.isSubscription) {
				subscriptions.push({
					...fieldInfo,
					name: `on${this.toPascalCase(workflow.name)}`,
				});
			}
		}

		return {
			schemaName: this.config.schemaName,
			types,
			queries,
			mutations,
			subscriptions,
		};
	}

	// -- Internal helpers --

	private resolveWorkflow(workflow: GqlWorkflowDefinition): ResolvedType {
		const triggerType = this.getTriggerType(workflow.trigger);
		const typeName = this.toPascalCase(workflow.name);
		const pathParams = this.extractPathParams(workflow.trigger.http?.path || "");

		const isGet = workflow.trigger.http?.method === "GET";
		const hasBody =
			workflow.trigger.http?.method === "POST" ||
			workflow.trigger.http?.method === "PUT" ||
			workflow.trigger.http?.method === "PATCH";
		const isDelete = workflow.trigger.http?.method === "DELETE";

		const isQuery =
			isGet ||
			triggerType === "grpc" ||
			triggerType === "manual" ||
			(!workflow.trigger.http && !workflow.trigger.websocket && !workflow.trigger.sse);
		const isMutation = hasBody || isDelete;
		const isSubscription = triggerType === "websocket" || triggerType === "sse";

		const needsInput = hasBody || (workflow.inputs && Object.keys(workflow.inputs).length > 0);

		let description = workflow.description || `${typeName} workflow`;
		if (this.config.includeMetadata) {
			description += ` (v${workflow.version}, trigger: ${triggerType})`;
		}

		return {
			typeName,
			isQuery: isQuery && !isMutation,
			isMutation,
			isSubscription,
			inputTypeName: needsInput ? `${typeName}Input` : null,
			outputTypeName: `${typeName}Response`,
			description,
			pathParams,
		};
	}

	private generateInputType(workflow: GqlWorkflowDefinition, resolved: ResolvedType): string {
		const lines: string[] = [];
		lines.push(`"""Input for ${workflow.name}"""`);
		lines.push(`input ${resolved.inputTypeName} {`);

		if (workflow.inputs && Object.keys(workflow.inputs).length > 0) {
			for (const [name, field] of Object.entries(workflow.inputs)) {
				const gqlType = this.fieldDefToGraphQLType(field);
				if (field.description) {
					lines.push(`  """${field.description}"""`);
				}
				lines.push(`  ${name}: ${gqlType}`);
			}
		} else {
			lines.push('  """Request payload as JSON"""');
			lines.push("  data: JSON");
		}

		lines.push("}");
		return lines.join("\n");
	}

	private generateOutputType(workflow: GqlWorkflowDefinition, resolved: ResolvedType): string {
		const lines: string[] = [];
		lines.push(`"""Response from ${workflow.name}"""`);
		lines.push(`type ${resolved.outputTypeName} {`);

		if (workflow.outputs && Object.keys(workflow.outputs).length > 0) {
			for (const [name, field] of Object.entries(workflow.outputs)) {
				const gqlType = this.fieldDefToGraphQLType(field);
				if (field.description) {
					lines.push(`  """${field.description}"""`);
				}
				lines.push(`  ${name}: ${gqlType}`);
			}
		} else {
			lines.push('  """Whether the operation succeeded"""');
			lines.push("  success: Boolean!");
			lines.push('  """Response data"""');
			lines.push("  data: JSON");
			lines.push('  """Error information"""');
			lines.push("  error: BlokError");
		}

		lines.push("}");
		return lines.join("\n");
	}

	private generateFieldDefinition(workflow: GqlWorkflowDefinition, resolved: ResolvedType): string {
		const fieldName = this.toFieldName(workflow.name);
		const args: string[] = [];

		// Path params become required args
		for (const param of resolved.pathParams) {
			args.push(`${param}: String!`);
		}

		// Input type
		if (resolved.inputTypeName) {
			args.push(`input: ${resolved.inputTypeName}!`);
		}

		const argStr = args.length > 0 ? `(${args.join(", ")})` : "";
		const desc = `"""${resolved.description}"""`;

		return `${desc}\n  ${fieldName}${argStr}: ${resolved.outputTypeName}!`;
	}

	private generateSubscriptionField(workflow: GqlWorkflowDefinition, resolved: ResolvedType): string {
		const fieldName = `on${this.toPascalCase(workflow.name)}`;
		const desc = `"""Subscribe to ${workflow.name} events"""`;
		return `${desc}\n  ${fieldName}: ${resolved.outputTypeName}!`;
	}

	private inferOutputFields(workflow: GqlWorkflowDefinition): GraphQLFieldInfo[] {
		if (workflow.outputs && Object.keys(workflow.outputs).length > 0) {
			return Object.entries(workflow.outputs).map(([name, field]) => ({
				name,
				type: this.fieldDefToGraphQLType(field),
				description: field.description,
			}));
		}
		return [
			{ name: "success", type: "Boolean!" },
			{ name: "data", type: "JSON" },
			{ name: "error", type: "BlokError" },
		];
	}

	private inferInputFields(workflow: GqlWorkflowDefinition, resolved: ResolvedType): GraphQLFieldInfo[] {
		if (workflow.inputs && Object.keys(workflow.inputs).length > 0) {
			return Object.entries(workflow.inputs).map(([name, field]) => ({
				name,
				type: this.fieldDefToGraphQLType(field),
				description: field.description,
			}));
		}
		return [{ name: "data", type: "JSON" }];
	}

	private fieldDefToGraphQLType(field: GqlFieldDef): string {
		let baseType: string;

		switch (field.type) {
			case "string":
				baseType = "String";
				break;
			case "number":
			case "float":
				baseType = "Float";
				break;
			case "integer":
			case "int":
				baseType = "Int";
				break;
			case "boolean":
				baseType = "Boolean";
				break;
			case "array":
				if (field.items) {
					baseType = `[${this.fieldDefToGraphQLType(field.items)}]`;
				} else {
					baseType = "[JSON]";
				}
				break;
			case "object":
				baseType = "JSON";
				break;
			case "datetime":
			case "date":
				baseType = "DateTime";
				break;
			default:
				baseType = field.type.charAt(0).toUpperCase() + field.type.slice(1);
				break;
		}

		return field.required ? `${baseType}!` : baseType;
	}

	private getTriggerType(trigger: GqlWorkflowDefinition["trigger"]): string {
		if (trigger.http) return "http";
		if (trigger.grpc) return "grpc";
		if (trigger.websocket) return "websocket";
		if (trigger.sse) return "sse";
		return "other";
	}

	private extractPathParams(path: string): string[] {
		const params: string[] = [];
		const regex = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
		for (const match of path.matchAll(regex)) {
			params.push(match[1]);
		}
		return params;
	}

	private toPascalCase(name: string): string {
		return name
			.split(/[-_.\s]+/)
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join("");
	}

	private toFieldName(name: string): string {
		const pascal = this.toPascalCase(name);
		return pascal.charAt(0).toLowerCase() + pascal.slice(1);
	}

	private emptySchema(): string {
		return [
			`# ${this.config.description}`,
			"# No workflows registered",
			"",
			"scalar JSON",
			"scalar DateTime",
			"",
			"type Query {",
			'  """Health check"""',
			"  _health: Boolean!",
			"}",
			"",
			"schema {",
			"  query: Query",
			"}",
		].join("\n");
	}
}

export interface GraphQLSchemaJSON {
	schemaName: string;
	types: GraphQLTypeInfo[];
	queries: GraphQLFieldInfo[];
	mutations: GraphQLFieldInfo[];
	subscriptions: GraphQLFieldInfo[];
}

export interface GraphQLTypeInfo {
	name: string;
	kind: "OBJECT" | "INPUT_OBJECT" | "ENUM" | "SCALAR";
	fields: GraphQLFieldInfo[];
}

export interface GraphQLFieldInfo {
	name: string;
	type: string;
	description?: string;
	args?: Array<{ name: string; type: string }>;
}
