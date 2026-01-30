/**
 * OpenAPI Schema Generation for Blok
 *
 * Auto-generates OpenAPI 3.1 specifications from workflow definitions.
 *
 * @example
 * ```typescript
 * import { OpenAPIGenerator } from "@blok/runner";
 *
 * const generator = new OpenAPIGenerator({
 *   title: "My API",
 *   version: "1.0.0",
 * });
 *
 * generator.addWorkflow(workflowDef);
 * const spec = generator.generate();
 * ```
 */

export { OpenAPIGenerator } from "./OpenAPIGenerator";
export type {
	OpenAPIGeneratorConfig,
	OpenAPISecurityScheme,
	WorkflowDefinition,
	OpenAPISpec,
} from "./OpenAPIGenerator";
