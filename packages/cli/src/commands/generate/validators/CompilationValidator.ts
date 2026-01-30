/**
 * CompilationValidator - Quick TypeScript compilation checks
 *
 * Used during AI generation to ensure generated code compiles
 */

import * as fs from "node:fs";
import * as ts from "typescript";

export interface CompilationResult {
	success: boolean;
	errors: string[];
	warnings: string[];
}

/**
 * Check if a file compiles
 */
export function validateFile(filePath: string): CompilationResult {
	const result: CompilationResult = {
		success: true,
		errors: [],
		warnings: [],
	};

	if (!fs.existsSync(filePath)) {
		result.success = false;
		result.errors.push(`File not found: ${filePath}`);
		return result;
	}

	return validateCode(fs.readFileSync(filePath, "utf-8"), filePath);
}

/**
 * Check if code string compiles
 */
export function validateCode(code: string, fileName = "temp.ts"): CompilationResult {
	const result: CompilationResult = {
		success: true,
		errors: [],
		warnings: [],
	};

	try {
		// Create a virtual source file
		const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);

		// Create compiler options
		const compilerOptions: ts.CompilerOptions = {
			target: ts.ScriptTarget.ES2020,
			module: ts.ModuleKind.CommonJS,
			strict: true,
			esModuleInterop: true,
			skipLibCheck: true,
			noEmit: true,
		};

		// Create a compiler host
		const compilerHost = ts.createCompilerHost(compilerOptions);
		const originalGetSourceFile = compilerHost.getSourceFile;

		// Override getSourceFile to include our virtual file
		compilerHost.getSourceFile = (name, languageVersion) => {
			if (name === fileName) {
				return sourceFile;
			}
			return originalGetSourceFile.call(compilerHost, name, languageVersion);
		};

		// Create program
		const program = ts.createProgram([fileName], compilerOptions, compilerHost);

		// Get diagnostics
		const diagnostics = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];

		// Process diagnostics
		for (const diagnostic of diagnostics) {
			// Skip certain errors that are expected in isolated compilation
			const errorCode = diagnostic.code;
			const skipCodes = [
				2307, // Cannot find module (expected when checking isolated code)
				2304, // Cannot find name (might be from @blok/runner)
			];

			if (skipCodes.includes(errorCode)) {
				continue;
			}

			const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");

			if (diagnostic.category === ts.DiagnosticCategory.Error) {
				result.success = false;
				result.errors.push(message);
			} else if (diagnostic.category === ts.DiagnosticCategory.Warning) {
				result.warnings.push(message);
			}
		}
	} catch (error) {
		result.success = false;
		result.errors.push(`Compilation failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	return result;
}

/**
 * Quick check - returns true if code compiles
 */
export function check(code: string): boolean {
	return validateCode(code).success;
}

/**
 * Get formatted error message
 */
export function getErrorMessage(result: CompilationResult): string {
	if (result.success) {
		return "✅ Code compiles successfully";
	}

	const lines = ["❌ Compilation errors:"];
	for (let i = 0; i < result.errors.length; i++) {
		lines.push(`${i + 1}. ${result.errors[i]}`);
	}

	if (result.warnings.length > 0) {
		lines.push("");
		lines.push("⚠️  Warnings:");
		for (let i = 0; i < result.warnings.length; i++) {
			lines.push(`${i + 1}. ${result.warnings[i]}`);
		}
	}

	return lines.join("\n");
}
