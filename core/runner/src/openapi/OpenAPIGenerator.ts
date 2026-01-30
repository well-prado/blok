/**
 * OpenAPI Schema Generator for Blok Workflows
 *
 * Automatically generates OpenAPI 3.1 specifications from workflow definitions.
 * Introspects HTTP trigger configurations, node schemas, and context types
 * to produce a complete API specification.
 *
 * @example
 * ```typescript
 * const generator = new OpenAPIGenerator({
 *   title: "My Blok API",
 *   version: "1.0.0",
 *   description: "Auto-generated from Blok workflows",
 * });
 *
 * // Add workflows
 * generator.addWorkflow({
 *   name: "get-user",
 *   version: "1.0.0",
 *   trigger: { http: { method: "GET", path: "/users/:id" } },
 *   steps: [...],
 *   nodes: {...},
 * });
 *
 * // Generate OpenAPI spec
 * const spec = generator.generate();
 * console.log(JSON.stringify(spec, null, 2));
 * ```
 */

export interface OpenAPIGeneratorConfig {
	/** API title */
	title: string;
	/** API version */
	version: string;
	/** API description */
	description?: string;
	/** Server URLs */
	servers?: Array<{ url: string; description?: string }>;
	/** Contact information */
	contact?: { name?: string; email?: string; url?: string };
	/** License */
	license?: { name: string; url?: string };
	/** Base path prefix */
	basePath?: string;
	/** Tags to categorize endpoints */
	tags?: Array<{ name: string; description?: string }>;
	/** Include security schemes */
	securitySchemes?: Record<string, OpenAPISecurityScheme>;
}

export interface OpenAPISecurityScheme {
	type: "http" | "apiKey" | "oauth2" | "openIdConnect";
	scheme?: string;
	bearerFormat?: string;
	name?: string;
	in?: "header" | "query" | "cookie";
	description?: string;
}

export interface WorkflowDefinition {
	name: string;
	version: string;
	description?: string;
	trigger: {
		http?: {
			method: string;
			path: string;
			accept?: string;
		};
		grpc?: {
			service: string;
			method: string;
		};
		[key: string]: unknown;
	};
	steps: unknown[];
	nodes: Record<string, unknown>;
}

export interface OpenAPISpec {
	openapi: string;
	info: {
		title: string;
		version: string;
		description?: string;
		contact?: { name?: string; email?: string; url?: string };
		license?: { name: string; url?: string };
	};
	servers?: Array<{ url: string; description?: string }>;
	paths: Record<string, Record<string, OpenAPIOperation>>;
	components: {
		schemas: Record<string, unknown>;
		securitySchemes?: Record<string, OpenAPISecurityScheme>;
	};
	tags?: Array<{ name: string; description?: string }>;
	security?: Array<Record<string, string[]>>;
}

interface OpenAPIOperation {
	summary: string;
	description?: string;
	operationId: string;
	tags?: string[];
	parameters?: OpenAPIParameter[];
	requestBody?: {
		required?: boolean;
		content: Record<string, { schema: unknown }>;
	};
	responses: Record<string, { description: string; content?: Record<string, { schema: unknown }> }>;
	security?: Array<Record<string, string[]>>;
}

interface OpenAPIParameter {
	name: string;
	in: "path" | "query" | "header";
	required: boolean;
	schema: { type: string };
	description?: string;
}

export class OpenAPIGenerator {
	private config: OpenAPIGeneratorConfig;
	private workflows: WorkflowDefinition[] = [];
	private schemas: Map<string, unknown> = new Map();

	constructor(config: OpenAPIGeneratorConfig) {
		this.config = {
			servers: [{ url: "http://localhost:4000", description: "Development server" }],
			...config,
		};
	}

	/**
	 * Add a workflow definition to the generator
	 */
	addWorkflow(workflow: WorkflowDefinition): void {
		this.workflows.push(workflow);
	}

	/**
	 * Add multiple workflows
	 */
	addWorkflows(workflows: WorkflowDefinition[]): void {
		this.workflows.push(...workflows);
	}

	/**
	 * Add a custom schema component
	 */
	addSchema(name: string, schema: unknown): void {
		this.schemas.set(name, schema);
	}

	/**
	 * Generate OpenAPI 3.1 specification
	 */
	generate(): OpenAPISpec {
		const spec: OpenAPISpec = {
			openapi: "3.1.0",
			info: {
				title: this.config.title,
				version: this.config.version,
				description: this.config.description,
				contact: this.config.contact,
				license: this.config.license,
			},
			servers: this.config.servers,
			paths: {},
			components: {
				schemas: {
					ErrorResponse: {
						type: "object",
						properties: {
							error: { type: "string", description: "Error message" },
							origin: { type: "string", description: "Node that caused the error" },
							validation_errors: {
								type: "array",
								items: {
									type: "object",
									properties: {
										path: { type: "array", items: { type: "string" } },
										message: { type: "string" },
										code: { type: "string" },
									},
								},
								description: "Validation error details (if applicable)",
							},
						},
					},
					WorkflowContext: {
						type: "object",
						properties: {
							id: { type: "string", format: "uuid", description: "Request ID" },
							workflow_name: { type: "string" },
							workflow_path: { type: "string" },
						},
					},
					...Object.fromEntries(this.schemas),
				},
			},
			tags: this.config.tags || [],
		};

		// Add security schemes if configured
		if (this.config.securitySchemes) {
			spec.components.securitySchemes = this.config.securitySchemes;
			// Apply security globally
			spec.security = Object.keys(this.config.securitySchemes).map((name) => ({
				[name]: [],
			}));
		}

		// Generate paths from workflows
		for (const workflow of this.workflows) {
			if (!workflow.trigger.http) continue;

			const { method, path: routePath } = workflow.trigger.http;
			const openApiPath = this.convertPath(routePath);
			const httpMethod = (method || "get").toLowerCase();

			if (!spec.paths[openApiPath]) {
				spec.paths[openApiPath] = {};
			}

			spec.paths[openApiPath][httpMethod] = this.buildOperation(workflow);
		}

		// Add default health check and metrics paths
		spec.paths["/health-check"] = {
			get: {
				summary: "Health Check",
				operationId: "healthCheck",
				tags: ["System"],
				responses: {
					"200": {
						description: "Service is healthy",
						content: { "text/plain": { schema: { type: "string" } } },
					},
				},
			},
		};

		spec.paths["/metrics"] = {
			get: {
				summary: "Prometheus Metrics",
				operationId: "getMetrics",
				tags: ["System"],
				responses: {
					"200": {
						description: "Prometheus metrics in text format",
						content: { "text/plain": { schema: { type: "string" } } },
					},
				},
			},
		};

		// Auto-generate tags from workflows
		const workflowTags = new Set<string>();
		for (const workflow of this.workflows) {
			const tag = this.inferTag(workflow);
			workflowTags.add(tag);
		}

		if (!spec.tags || spec.tags.length === 0) {
			spec.tags = [
				...Array.from(workflowTags).map((t) => ({ name: t })),
				{ name: "System", description: "System health and monitoring endpoints" },
			];
		}

		return spec;
	}

	/**
	 * Generate OpenAPI spec as JSON string
	 */
	toJSON(pretty = true): string {
		const spec = this.generate();
		return JSON.stringify(spec, null, pretty ? 2 : undefined);
	}

	/**
	 * Generate OpenAPI spec as YAML string
	 */
	toYAML(): string {
		const spec = this.generate();
		return this.jsonToYaml(spec);
	}

	private buildOperation(workflow: WorkflowDefinition): OpenAPIOperation {
		const httpTrigger = workflow.trigger.http!;
		const method = (httpTrigger.method || "GET").toUpperCase();
		const tag = this.inferTag(workflow);

		const operation: OpenAPIOperation = {
			summary: workflow.name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
			description: workflow.description || `Execute the ${workflow.name} workflow (v${workflow.version})`,
			operationId: this.toOperationId(workflow.name, method),
			tags: [tag],
			parameters: [],
			responses: {
				"200": {
					description: "Successful workflow execution",
					content: {
						[httpTrigger.accept || "application/json"]: {
							schema: this.buildResponseSchema(workflow),
						},
					},
				},
				"400": {
					description: "Validation error",
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/ErrorResponse" },
						},
					},
				},
				"500": {
					description: "Internal server error",
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/ErrorResponse" },
						},
					},
				},
			},
		};

		// Extract path parameters
		const pathParams = this.extractPathParams(httpTrigger.path);
		for (const param of pathParams) {
			operation.parameters!.push({
				name: param,
				in: "path",
				required: true,
				schema: { type: "string" },
			});
		}

		// Add request body for POST/PUT/PATCH
		if (["POST", "PUT", "PATCH"].includes(method)) {
			operation.requestBody = {
				required: true,
				content: {
					"application/json": {
						schema: this.buildRequestSchema(workflow),
					},
				},
			};
		}

		// Add requestId query parameter
		operation.parameters!.push({
			name: "requestId",
			in: "query",
			required: false,
			schema: { type: "string" },
			description: "Custom request ID for tracing",
		});

		return operation;
	}

	private buildRequestSchema(workflow: WorkflowDefinition): Record<string, unknown> {
		// Try to extract input schema from first step's node config
		const firstStepConfig = this.getFirstNodeInputs(workflow);
		if (firstStepConfig) {
			return firstStepConfig;
		}

		return {
			type: "object",
			description: `Input for ${workflow.name} workflow`,
			additionalProperties: true,
		};
	}

	private buildResponseSchema(workflow: WorkflowDefinition): Record<string, unknown> {
		return {
			type: "object",
			description: `Output from ${workflow.name} workflow`,
			additionalProperties: true,
		};
	}

	private getFirstNodeInputs(workflow: WorkflowDefinition): Record<string, unknown> | null {
		if (!workflow.steps || workflow.steps.length === 0) return null;

		const firstStep = workflow.steps[0] as { name?: string };
		if (!firstStep?.name) return null;

		const nodeConfig = workflow.nodes[firstStep.name] as { inputs?: Record<string, unknown> };
		if (!nodeConfig?.inputs) return null;

		// Convert inputs config to JSON schema
		const properties: Record<string, unknown> = {};
		for (const [_key, value] of Object.entries(nodeConfig.inputs)) {
			if (typeof value === "string" && value.startsWith("{{") && value.endsWith("}}")) {
				// Template reference - this is a dynamic input from request body
				const ref = value.slice(2, -2).trim();
				if (ref.startsWith("ctx.request.body.")) {
					const fieldName = ref.replace("ctx.request.body.", "");
					properties[fieldName] = { type: "string" };
				}
			}
		}

		if (Object.keys(properties).length > 0) {
			return { type: "object", properties };
		}

		return null;
	}

	private convertPath(blokPath: string): string {
		// Convert Express-style :param to OpenAPI {param}
		return blokPath.replace(/:(\w+)/g, "{$1}");
	}

	private extractPathParams(path: string): string[] {
		const matches = path.match(/:(\w+)/g);
		if (!matches) return [];
		return matches.map((m) => m.slice(1));
	}

	private toOperationId(name: string, method: string): string {
		const cleanName = name
			.replace(/[^a-zA-Z0-9]/g, " ")
			.trim()
			.split(/\s+/)
			.map((word, i) => (i === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
			.join("");

		return `${method.toLowerCase()}${cleanName.charAt(0).toUpperCase()}${cleanName.slice(1)}`;
	}

	private inferTag(workflow: WorkflowDefinition): string {
		const name = workflow.name;
		// Try to extract a category from workflow name (e.g., "user-create" → "User")
		const parts = name.split(/[-_]/);
		if (parts.length > 1) {
			return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
		}
		return "Default";
	}

	/**
	 * Simple JSON to YAML converter (basic, no external deps)
	 */
	private jsonToYaml(obj: unknown, indent = 0): string {
		const spaces = "  ".repeat(indent);

		if (obj === null || obj === undefined) return "null";
		if (typeof obj === "boolean") return String(obj);
		if (typeof obj === "number") return String(obj);
		if (typeof obj === "string") {
			if (obj.includes("\n") || obj.includes(":") || obj.includes("#") || obj.includes("'")) {
				return `"${obj.replace(/"/g, '\\"')}"`;
			}
			return obj;
		}

		if (Array.isArray(obj)) {
			if (obj.length === 0) return "[]";
			return obj
				.map((item) => {
					const value = this.jsonToYaml(item, indent + 1);
					if (typeof item === "object" && item !== null) {
						return `${spaces}- ${value.trimStart()}`;
					}
					return `${spaces}- ${value}`;
				})
				.join("\n");
		}

		if (typeof obj === "object") {
			const entries = Object.entries(obj as Record<string, unknown>).filter(([, v]) => v !== undefined);
			if (entries.length === 0) return "{}";
			return entries
				.map(([key, value]) => {
					const yamlValue = this.jsonToYaml(value, indent + 1);
					if (typeof value === "object" && value !== null && !Array.isArray(value)) {
						return `${spaces}${key}:\n${yamlValue}`;
					}
					if (Array.isArray(value) && value.length > 0) {
						return `${spaces}${key}:\n${yamlValue}`;
					}
					return `${spaces}${key}: ${yamlValue}`;
				})
				.join("\n");
		}

		return String(obj);
	}
}
