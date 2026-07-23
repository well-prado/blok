import * as fs from "node:fs";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import createRuntimeSystemPrompt from "./prompts/create-runtime.system.js";

export type RuntimeInformation = {
	language: string;
	userPrompt: string;
	files: Array<{ path: string; content: string }>;
	rawCode: string;
	validationResult?: {
		valid: boolean;
		errors: string[];
		warnings: string[];
		attempts: number;
	};
};

const SUPPORTED_LANGUAGES = ["go", "java", "rust", "python", "csharp", "php", "ruby"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export function isSupportedLanguage(lang: string): lang is SupportedLanguage {
	return (SUPPORTED_LANGUAGES as readonly string[]).includes(lang.toLowerCase());
}

export default class RuntimeGenerator {
	private readonly MAX_VALIDATION_ATTEMPTS = 3;

	async generateRuntime(
		language: string,
		userPrompt: string,
		apiKey: string,
		update = false,
		existingPath?: string,
	): Promise<RuntimeInformation> {
		const openai = createOpenAI({
			apiKey: apiKey,
		});

		let prompt = createRuntimeSystemPrompt.prompt;

		// Register prompt content for hash tracking

		// If updating, include existing code
		if (update && existingPath) {
			const existingContent = this.readExistingRuntime(existingPath);
			prompt = `${createRuntimeSystemPrompt.updatePrompt}\n\n${existingContent}`;
		}

		// Enhance user prompt with language context
		const enhancedPrompt = this.buildEnhancedPrompt(userPrompt, language);

		// Generation with validation feedback loop
		let attempts = 0;
		let generatedCode = "";
		let validationErrors: string[] = [];
		let validationWarnings: string[] = [];
		let isValid = false;
		const allErrors: string[] = [];

		while (attempts < this.MAX_VALIDATION_ATTEMPTS && !isValid) {
			attempts++;

			// Adjust prompt based on previous validation errors
			let finalPrompt = enhancedPrompt;
			if (attempts > 1 && validationErrors.length > 0) {
				finalPrompt = this.createFeedbackPrompt(enhancedPrompt, generatedCode, validationErrors);
			}

			// Generate runtime code
			const { text } = await generateText({
				model: openai("gpt-4o"),
				system: prompt,
				prompt: finalPrompt,
				temperature: 0.2,
			});

			// Clean up response (remove markdown fences)
			generatedCode = text.replace(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/gm, "$1").trim();

			// Validate the generated code (structural validation)
			const structureResult = this.validateRuntimeStructure(generatedCode, language);
			validationErrors = structureResult.errors;
			validationWarnings = structureResult.warnings;
			isValid = structureResult.valid;

			// Track errors across all attempts
			allErrors.push(...validationErrors);

			// Log attempt
			if (!isValid && attempts < this.MAX_VALIDATION_ATTEMPTS) {
				console.log(
					`\u26a0\ufe0f  Runtime validation failed (attempt ${attempts}/${this.MAX_VALIDATION_ATTEMPTS}). Retrying with feedback...`,
				);
			}
		}

		// Parse generated files
		const files = this.parseFiles(generatedCode, language);

		return {
			language,
			userPrompt,
			files,
			rawCode: generatedCode,
			validationResult: {
				valid: isValid,
				errors: validationErrors,
				warnings: validationWarnings,
				attempts,
			},
		};
	}

	/**
	 * Validate runtime structure based on language
	 */
	validateRuntimeStructure(code: string, language: string): { valid: boolean; errors: string[]; warnings: string[] } {
		const errors: string[] = [];
		const warnings: string[] = [];

		// Check for file markers (must have multiple files)
		const fileCount = (code.match(/\/\/ FILE:/gi) || []).length;
		if (fileCount < 2) {
			errors.push(
				"Runtime must contain multiple files (use // FILE: <path> markers). Expected at least SDK core + server + Dockerfile.",
			);
		}

		// Check for HTTP endpoints
		if (!code.includes("/execute")) {
			errors.push("Missing POST /execute endpoint - required by the Blok Runtime Protocol");
		}
		if (!code.includes("/health")) {
			errors.push("Missing GET /health endpoint - required by the Blok Runtime Protocol");
		}

		// Check for context/request/response types
		if (!code.toLowerCase().includes("context") && !code.toLowerCase().includes("ctx")) {
			errors.push("Missing Context type definition - must map to Blok workflow context");
		}

		// Check for node handler interface/trait
		const handlerPatterns = ["NodeHandler", "node_handler", "Handler", "execute", "Execute"];
		const hasHandler = handlerPatterns.some((p) => code.includes(p));
		if (!hasHandler) {
			errors.push("Missing NodeHandler interface/trait - nodes must implement an execute method");
		}

		// Check for node registry
		const registryPatterns = ["Registry", "registry", "register", "Register"];
		const hasRegistry = registryPatterns.some((p) => code.includes(p));
		if (!hasRegistry) {
			errors.push("Missing NodeRegistry - must provide node registration and dispatch");
		}

		// Check for Dockerfile
		const hasDockerfile = code.toLowerCase().includes("dockerfile") || code.toLowerCase().includes("docker");
		if (!hasDockerfile) {
			warnings.push("Missing Dockerfile - recommended for container deployment");
		}

		// Check for ExecutionResult/ExecutionRequest
		if (!code.includes("success") || !code.includes("data") || !code.includes("errors")) {
			warnings.push("ExecutionResult should include success, data, and errors fields");
		}

		// Language-specific checks
		this.validateLanguageSpecific(code, language, errors, warnings);

		return {
			valid: errors.length === 0,
			errors,
			warnings,
		};
	}

	/**
	 * Parse generated code into separate files
	 */
	parseFiles(code: string, language: string): Array<{ path: string; content: string }> {
		const files: Array<{ path: string; content: string }> = [];
		const fileRegex = /\/\/\s*FILE:\s*(.+?)(?:\n|\r\n)/gi;
		const parts = code.split(fileRegex);

		// parts[0] is before first marker, then alternating path/content
		for (let i = 1; i < parts.length; i += 2) {
			const filePath = parts[i].trim();
			const content = (parts[i + 1] || "").trim();
			if (filePath && content) {
				files.push({ path: filePath, content });
			}
		}

		// If no file markers found, treat entire output as a single file
		if (files.length === 0 && code.trim()) {
			const ext = this.getFileExtension(language);
			files.push({ path: `runtime.${ext}`, content: code.trim() });
		}

		return files;
	}

	/**
	 * Build an enhanced prompt with language context
	 */
	private buildEnhancedPrompt(userPrompt: string, language: string): string {
		const parts = [
			`Generate a complete Blok Runtime SDK for the "${language}" programming language.`,
			"",
			userPrompt,
			"",
			`IMPORTANT: Generate a complete, runnable ${language} runtime SDK with:`,
			"1. Core types (Context, Request, Response, ExecutionRequest, ExecutionResult)",
			"2. NodeHandler interface/trait",
			"3. NodeRegistry for node management",
			"4. HTTP server with POST /execute and GET /health endpoints",
			'5. Example "hello-world" node',
			"6. Dockerfile for containerized deployment",
			"7. Build configuration file (go.mod, pom.xml, Cargo.toml, etc.)",
			"",
			"Use // FILE: <relative-path> to separate each file.",
		];

		switch (language.toLowerCase()) {
			case "go":
				parts.push("\nGenerate a Go module with:");
				parts.push("- sdk/blok.go (core types + registry)");
				parts.push("- server/main.go (HTTP server)");
				parts.push("- nodes/hello-world/main.go (example node)");
				parts.push("- go.mod (module definition)");
				parts.push("- Dockerfile (multi-stage build)");
				break;
			case "java":
				parts.push("\nGenerate a Maven project with:");
				parts.push("- src/main/java/com/blok/runtime/Blok.java (core types)");
				parts.push("- src/main/java/com/blok/runtime/NodeRegistry.java (registry)");
				parts.push("- src/main/java/com/blok/server/RuntimeServer.java (HTTP server)");
				parts.push("- src/main/java/com/blok/nodes/HelloWorldNode.java (example)");
				parts.push("- pom.xml (Maven config)");
				parts.push("- Dockerfile (multi-stage build)");
				break;
			case "rust":
				parts.push("\nGenerate a Cargo project with:");
				parts.push("- src/lib.rs (core types + NodeHandler trait)");
				parts.push("- src/registry.rs (NodeRegistry)");
				parts.push("- src/main.rs (HTTP server with axum or actix-web)");
				parts.push("- src/nodes/hello_world.rs (example node)");
				parts.push("- Cargo.toml (dependencies)");
				parts.push("- Dockerfile (multi-stage build)");
				break;
			case "python":
				parts.push("\nGenerate a Python package with:");
				parts.push("- blok/__init__.py (core types)");
				parts.push("- blok/registry.py (NodeRegistry)");
				parts.push("- server.py (HTTP server with Flask or FastAPI)");
				parts.push("- nodes/hello_world.py (example node)");
				parts.push("- requirements.txt or pyproject.toml");
				parts.push("- Dockerfile");
				break;
			case "csharp":
				parts.push("\nGenerate a .NET project with:");
				parts.push("- Runtime/BlokContext.cs (core types)");
				parts.push("- Runtime/NodeRegistry.cs (registry)");
				parts.push("- Program.cs (minimal API server)");
				parts.push("- Nodes/HelloWorldNode.cs (example)");
				parts.push("- BlokRuntime.csproj");
				parts.push("- Dockerfile");
				break;
			case "php":
				parts.push("\nGenerate a PHP project with:");
				parts.push("- src/Runtime/Context.php (core types)");
				parts.push("- src/Runtime/NodeRegistry.php (registry)");
				parts.push("- src/Nodes/HelloWorldNode.php (example)");
				parts.push("- server.php (HTTP server)");
				parts.push("- composer.json");
				parts.push("- Dockerfile");
				break;
			case "ruby":
				parts.push("\nGenerate a Ruby project with:");
				parts.push("- lib/blok/context.rb (core types)");
				parts.push("- lib/blok/registry.rb (NodeRegistry)");
				parts.push("- lib/blok/nodes/hello_world.rb (example)");
				parts.push("- server.rb (Sinatra or Rack HTTP server)");
				parts.push("- Gemfile");
				parts.push("- Dockerfile");
				break;
		}

		return parts.join("\n");
	}

	/**
	 * Create a feedback prompt with error analysis
	 */
	private createFeedbackPrompt(originalPrompt: string, previousCode: string, errors: string[]): string {
		const analyzedErrors = errors.map((err, i) => {
			const guidance = this.getSemanticGuidance(err);
			return `${i + 1}. ${err}${guidance ? `\n   Fix: ${guidance}` : ""}`;
		});

		return [
			originalPrompt,
			"",
			"\u274c The previous generation had validation errors:",
			"",
			...analyzedErrors,
			"",
			"Previous code:",
			"```",
			previousCode.substring(0, 2000), // Truncate to avoid token limits
			previousCode.length > 2000 ? "\n... (truncated)" : "",
			"```",
			"",
			"Please fix ALL errors and regenerate the complete runtime SDK.",
			"Make sure to:",
			"- Use // FILE: <path> markers to separate each file",
			"- Include POST /execute and GET /health HTTP endpoints",
			"- Define Context, Request, Response, ExecutionRequest, ExecutionResult types",
			"- Implement NodeHandler interface and NodeRegistry",
			"- Include a hello-world example node",
			"- Include a Dockerfile",
		].join("\n");
	}

	/**
	 * Provide semantic guidance for common error patterns
	 */
	private getSemanticGuidance(error: string): string | null {
		const errorLower = error.toLowerCase();

		if (errorLower.includes("file") && errorLower.includes("marker")) {
			return "Separate files with '// FILE: <relative-path>' on its own line before each file's content";
		}
		if (errorLower.includes("/execute")) {
			return "Add an HTTP POST /execute endpoint that receives ExecutionRequest JSON and returns ExecutionResult JSON";
		}
		if (errorLower.includes("/health")) {
			return "Add an HTTP GET /health endpoint that returns {status, version, runtime, nodes[]}";
		}
		if (errorLower.includes("context")) {
			return "Define a Context struct/class with: id, workflow_name, workflow_path, request, response, vars, env";
		}
		if (errorLower.includes("nodehandler") || errorLower.includes("handler")) {
			return "Define an interface/trait with an execute method: execute(context, config) -> result/error";
		}
		if (errorLower.includes("registry")) {
			return "Implement a NodeRegistry with register(name, handler), get(name), execute(request) methods";
		}
		if (errorLower.includes("dockerfile")) {
			return "Add a multi-stage Dockerfile that builds and runs the runtime on port 8080";
		}

		return null;
	}

	/**
	 * Language-specific structural validation
	 */
	private validateLanguageSpecific(code: string, language: string, errors: string[], warnings: string[]): void {
		switch (language.toLowerCase()) {
			case "go":
				if (!code.includes("go.mod") && !code.includes("module")) {
					warnings.push("Missing go.mod - Go module definition recommended");
				}
				if (!code.includes("package")) {
					errors.push("Go code must declare a package");
				}
				break;
			case "java":
				if (!code.includes("pom.xml") && !code.includes("build.gradle")) {
					warnings.push("Missing build configuration (pom.xml or build.gradle)");
				}
				if (!code.includes("class")) {
					errors.push("Java code must define at least one class");
				}
				break;
			case "rust":
				if (!code.includes("Cargo.toml") && !code.includes("[package]")) {
					warnings.push("Missing Cargo.toml - Rust project configuration recommended");
				}
				if (!code.includes("fn ") && !code.includes("fn main")) {
					errors.push("Rust code must define functions");
				}
				break;
			case "python":
				if (!code.includes("requirements.txt") && !code.includes("pyproject.toml")) {
					warnings.push("Missing dependency file (requirements.txt or pyproject.toml)");
				}
				if (!code.includes("def ")) {
					errors.push("Python code must define functions");
				}
				break;
			case "csharp":
				if (!code.includes(".csproj")) {
					warnings.push("Missing .csproj project file");
				}
				break;
			case "php":
				if (!code.includes("composer.json")) {
					warnings.push("Missing composer.json");
				}
				break;
			case "ruby":
				if (!code.includes("Gemfile")) {
					warnings.push("Missing Gemfile");
				}
				break;
		}
	}

	/**
	 * Read existing runtime directory contents
	 */
	private readExistingRuntime(dirPath: string): string {
		if (!fs.existsSync(dirPath)) {
			return "";
		}

		const parts: string[] = [];
		const readDir = (dir: string) => {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = `${dir}/${entry.name}`;
				if (
					entry.isDirectory() &&
					!entry.name.startsWith(".") &&
					entry.name !== "node_modules" &&
					entry.name !== "target" &&
					entry.name !== "build"
				) {
					readDir(fullPath);
				} else if (entry.isFile()) {
					try {
						const content = fs.readFileSync(fullPath, "utf8");
						const relativePath = fullPath.replace(dirPath, "").replace(/^\//, "");
						parts.push(`// FILE: ${relativePath}\n${content}`);
					} catch {
						// Skip unreadable files
					}
				}
			}
		};
		readDir(dirPath);
		return parts.join("\n\n");
	}

	/**
	 * Get file extension for a language
	 */
	private getFileExtension(language: string): string {
		const extensions: Record<string, string> = {
			go: "go",
			java: "java",
			rust: "rs",
			python: "py",
			csharp: "cs",
			php: "php",
			ruby: "rb",
		};
		return extensions[language.toLowerCase()] || "txt";
	}
}
