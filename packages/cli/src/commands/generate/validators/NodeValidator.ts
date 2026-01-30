/**
 * NodeValidator - Validates AI-generated nodes for correctness
 *
 * Validation checks:
 * 1. TypeScript compilation
 * 2. defineNode structure
 * 3. Zod schema presence
 * 4. Required exports
 * 5. Type safety
 */

import * as fs from "node:fs";
import * as ts from "typescript";

export interface ValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
	suggestions: string[];
}

export interface NodeValidationContext {
	filePath: string;
	nodeStyle: "function" | "class";
	content: string;
}

/**
 * Validate a node file completely
 */
export async function validate(context: NodeValidationContext): Promise<ValidationResult> {
	const result: ValidationResult = {
		valid: true,
		errors: [],
		warnings: [],
		suggestions: [],
	};

	// 1. Check file exists
	if (!fs.existsSync(context.filePath)) {
		result.valid = false;
		result.errors.push(`File does not exist: ${context.filePath}`);
		return result;
	}

	// 2. Validate TypeScript compilation
	const compilationResult = validateCompilation(context);
	result.errors.push(...compilationResult.errors);
	result.warnings.push(...compilationResult.warnings);
	if (!compilationResult.valid) {
		result.valid = false;
	}

	// 3. Validate node structure based on style
	if (context.nodeStyle === "function") {
		const structureResult = validateFunctionFirstStructure(context);
		result.errors.push(...structureResult.errors);
		result.warnings.push(...structureResult.warnings);
		result.suggestions.push(...structureResult.suggestions);
		if (!structureResult.valid) {
			result.valid = false;
		}
	} else {
		const structureResult = validateClassBasedStructure(context);
		result.errors.push(...structureResult.errors);
		result.warnings.push(...structureResult.warnings);
		if (!structureResult.valid) {
			result.valid = false;
		}
	}

	// 4. Validate exports
	const exportsResult = validateExports(context);
	result.errors.push(...exportsResult.errors);
	result.warnings.push(...exportsResult.warnings);
	if (!exportsResult.valid) {
		result.valid = false;
	}

	return result;
}

/**
 * Validate TypeScript compilation
 */
export function validateCompilation(context: NodeValidationContext): ValidationResult {
	const result: ValidationResult = {
		valid: true,
		errors: [],
		warnings: [],
		suggestions: [],
	};

	try {
		// Create a compiler host
		const compilerOptions: ts.CompilerOptions = {
			target: ts.ScriptTarget.ES2020,
			module: ts.ModuleKind.CommonJS,
			strict: true,
			esModuleInterop: true,
			skipLibCheck: true,
			forceConsistentCasingInFileNames: true,
			noEmit: true,
		};

		// Create program
		const program = ts.createProgram([context.filePath], compilerOptions);

		// Get diagnostics
		const diagnostics = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];

		// Process diagnostics
		for (const diagnostic of diagnostics) {
			const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");

			if (diagnostic.category === ts.DiagnosticCategory.Error) {
				result.valid = false;
				result.errors.push(`TypeScript Error: ${message}`);
			} else if (diagnostic.category === ts.DiagnosticCategory.Warning) {
				result.warnings.push(`TypeScript Warning: ${message}`);
			}
		}

		if (result.valid) {
			result.suggestions.push("✅ TypeScript compilation successful");
		}
	} catch (error) {
		result.valid = false;
		result.errors.push(`Compilation check failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	return result;
}

/**
 * Validate function-first node structure
 */
export function validateFunctionFirstStructure(context: NodeValidationContext): ValidationResult {
	const result: ValidationResult = {
		valid: true,
		errors: [],
		warnings: [],
		suggestions: [],
	};

	const content = context.content;

	// Check for defineNode import
	if (!content.includes("import") || !content.includes("defineNode")) {
		result.valid = false;
		result.errors.push("Missing 'defineNode' import from '@blok/runner'");
	}

	// Check for Zod import
	if (!content.includes("import") || !content.includes("zod")) {
		result.valid = false;
		result.errors.push("Missing 'zod' import - required for schema validation");
	}

	// Check for defineNode call
	if (!content.includes("defineNode({")) {
		result.valid = false;
		result.errors.push("Missing 'defineNode()' call");
	}

	// Check for required properties
	const requiredProps = ["name:", "description:", "input:", "output:", "execute"];
	for (const prop of requiredProps) {
		if (!content.includes(prop)) {
			result.valid = false;
			result.errors.push(`Missing required property: ${prop.replace(":", "")}`);
		}
	}

	// Check for z.object usage
	if (!content.includes("z.object(")) {
		result.warnings.push("No Zod schema detected - ensure input/output use z.object()");
	}

	// Check for async execute
	if (!content.includes("async execute") && !content.includes("async (ctx")) {
		result.warnings.push("Execute function should be async for consistent error handling");
	}

	// Check for Context type
	if (!content.includes("Context") && !content.includes("ctx")) {
		result.warnings.push("Context parameter (ctx) not found in execute function");
	}

	// Positive feedback
	if (result.valid) {
		result.suggestions.push("✅ Function-first structure looks good");
	}

	return result;
}

/**
 * Validate class-based node structure
 */
export function validateClassBasedStructure(context: NodeValidationContext): ValidationResult {
	const result: ValidationResult = {
		valid: true,
		errors: [],
		warnings: [],
		suggestions: [],
	};

	const content = context.content;

	// Check for BlokService import
	if (!content.includes("BlokService")) {
		result.valid = false;
		result.errors.push("Missing 'BlokService' import from '@blok/runner'");
	}

	// Check for class declaration
	if (!content.includes("class ") || !content.includes("extends BlokService")) {
		result.valid = false;
		result.errors.push("Missing class declaration extending BlokService");
	}

	// Check for handle method
	if (!content.includes("async handle(")) {
		result.valid = false;
		result.errors.push("Missing 'async handle()' method");
	}

	// Check for schemas
	if (!content.includes("inputSchema") || !content.includes("outputSchema")) {
		result.warnings.push("Missing inputSchema or outputSchema in constructor");
	}

	if (result.valid) {
		result.suggestions.push("✅ Class-based structure looks good");
		result.suggestions.push("💡 Consider migrating to function-first pattern for better DX");
	}

	return result;
}

/**
 * Validate exports
 */
export function validateExports(context: NodeValidationContext): ValidationResult {
	const result: ValidationResult = {
		valid: true,
		errors: [],
		warnings: [],
		suggestions: [],
	};

	const content = context.content;

	// Check for default export
	if (!content.includes("export default")) {
		result.valid = false;
		result.errors.push("Missing default export");
	}

	if (result.valid) {
		result.suggestions.push("✅ Export structure is correct");
	}

	return result;
}

/**
 * Quick validation - just check if it compiles
 */
export async function quickValidate(filePath: string): Promise<boolean> {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const context: NodeValidationContext = {
			filePath,
			nodeStyle: content.includes("defineNode") ? "function" : "class",
			content,
		};

		const result = await validate(context);
		return result.valid;
	} catch {
		return false;
	}
}

/**
 * Format validation result for display
 */
export function formatResult(result: ValidationResult): string {
	const lines: string[] = [];

	if (result.errors.length > 0) {
		lines.push("❌ Errors:");
		for (const err of result.errors) {
			lines.push(`  - ${err}`);
		}
		lines.push("");
	}

	if (result.warnings.length > 0) {
		lines.push("⚠️  Warnings:");
		for (const warn of result.warnings) {
			lines.push(`  - ${warn}`);
		}
		lines.push("");
	}

	if (result.suggestions.length > 0) {
		lines.push("💡 Suggestions:");
		for (const sug of result.suggestions) {
			lines.push(`  - ${sug}`);
		}
		lines.push("");
	}

	if (result.valid) {
		lines.push("✅ Validation passed!");
	} else {
		lines.push("❌ Validation failed. Please fix the errors above.");
	}

	return lines.join("\n");
}
