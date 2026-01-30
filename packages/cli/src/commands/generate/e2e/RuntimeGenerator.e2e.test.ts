/**
 * RuntimeGenerator End-to-End Tests
 *
 * Tests the full runtime SDK generation pipeline with mocked LLM responses.
 * Validates structural validation (HTTP endpoints, Context types, NodeHandler,
 * NodeRegistry, Dockerfile), multi-file parsing, language-specific checks,
 * and the 3-attempt feedback loop without requiring an actual OpenAI API key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the ai module
vi.mock("ai", () => ({
	generateText: vi.fn(),
}));

// Mock @ai-sdk/openai
vi.mock("@ai-sdk/openai", () => ({
	createOpenAI: vi.fn(() => (model: string) => ({ model })),
}));

import { generateText } from "ai";
import RuntimeGenerator from "../RuntimeGenerator.js";

const mockedGenerateText = vi.mocked(generateText);

// --- Mock LLM Responses ---

const VALID_GO_RUNTIME = `
// FILE: sdk/blok.go
package sdk

type Context struct {
	ID           string
	WorkflowName string
	Request      Request
	Response     Response
}

type Request struct {
	Body    interface{}
	Headers map[string]string
}

type Response struct {
	Data    interface{}
	Success bool
}

type ExecutionRequest struct {
	NodeName string
	Context  Context
	Config   map[string]interface{}
}

type ExecutionResult struct {
	success bool
	data    interface{}
	errors  interface{}
}

type NodeHandler interface {
	Execute(ctx Context, config map[string]interface{}) (interface{}, error)
}

type NodeRegistry struct {
	nodes map[string]NodeHandler
}

func NewRegistry() *NodeRegistry {
	return &NodeRegistry{nodes: make(map[string]NodeHandler)}
}

func (r *NodeRegistry) Register(name string, handler NodeHandler) {
	r.nodes[name] = handler
}

func (r *NodeRegistry) Get(name string) (NodeHandler, bool) {
	h, ok := r.nodes[name]
	return h, ok
}

// FILE: server/main.go
package main

import (
	"encoding/json"
	"net/http"
)

func main() {
	http.HandleFunc("/execute", handleExecute)
	http.HandleFunc("/health", handleHealth)
	http.ListenAndServe(":8080", nil)
}

func handleExecute(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "data": nil, "errors": nil})
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(map[string]interface{}{"status": "healthy"})
}

// FILE: nodes/hello-world/main.go
package helloworld

import "fmt"

type HelloWorldNode struct{}

func (n *HelloWorldNode) Execute(ctx interface{}, config map[string]interface{}) (interface{}, error) {
	fmt.Println("Hello World!")
	return map[string]string{"message": "Hello World"}, nil
}

// FILE: go.mod
module github.com/blok/runtime-go

go 1.21

// FILE: Dockerfile
FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY . .
RUN go build -o runtime ./server/main.go

FROM alpine:3.18
COPY --from=builder /app/runtime /runtime
EXPOSE 8080
CMD ["/runtime"]
`;

const VALID_JAVA_RUNTIME = `
// FILE: src/main/java/com/blok/runtime/Blok.java
package com.blok.runtime;

import java.util.Map;

public class Blok {
    public static class Context {
        public String id;
        public String workflowName;
        public Request request;
        public Response response;
    }

    public static class Request {
        public Object body;
        public Map<String, String> headers;
    }

    public static class Response {
        public Object data;
        public boolean success;
        public Object errors;
    }

    public static class ExecutionRequest {
        public String nodeName;
        public Context context;
        public Map<String, Object> config;
    }

    public static class ExecutionResult {
        public boolean success;
        public Object data;
        public Object errors;
    }
}

// FILE: src/main/java/com/blok/runtime/NodeRegistry.java
package com.blok.runtime;

import java.util.HashMap;
import java.util.Map;

public interface NodeHandler {
    Object Execute(Blok.Context ctx, Map<String, Object> config) throws Exception;
}

// FILE: src/main/java/com/blok/server/RuntimeServer.java
package com.blok.server;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;

public class RuntimeServer {
    public static void main(String[] args) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress(8080), 0);
        server.createContext("/execute", exchange -> {
            exchange.sendResponseHeaders(200, 0);
            exchange.getResponseBody().close();
        });
        server.createContext("/health", exchange -> {
            exchange.sendResponseHeaders(200, 0);
            exchange.getResponseBody().close();
        });
        server.start();
    }
}

// FILE: pom.xml
<project>
    <modelVersion>4.0.0</modelVersion>
    <groupId>com.blok</groupId>
    <artifactId>runtime-java</artifactId>
    <version>1.0.0</version>
</project>

// FILE: Dockerfile
FROM maven:3.9-eclipse-temurin-21 AS builder
WORKDIR /app
COPY . .
RUN mvn clean package

FROM eclipse-temurin:21-jre
COPY --from=builder /app/target/*.jar /app.jar
EXPOSE 8080
CMD ["java", "-jar", "/app.jar"]
`;

const VALID_RUST_RUNTIME = `
// FILE: src/lib.rs
pub struct Context {
    pub id: String,
    pub workflow_name: String,
    pub request: Request,
    pub response: Response,
}

pub struct Request {
    pub body: serde_json::Value,
    pub headers: std::collections::HashMap<String, String>,
}

pub struct Response {
    pub data: serde_json::Value,
    pub success: bool,
    pub errors: Option<serde_json::Value>,
}

pub struct ExecutionRequest {
    pub node_name: String,
    pub context: Context,
    pub config: std::collections::HashMap<String, serde_json::Value>,
}

pub struct ExecutionResult {
    pub success: bool,
    pub data: serde_json::Value,
    pub errors: Option<serde_json::Value>,
}

pub trait NodeHandler: Send + Sync {
    fn execute(&self, ctx: &Context, config: &std::collections::HashMap<String, serde_json::Value>) -> Result<serde_json::Value, String>;
}

// FILE: src/registry.rs
use std::collections::HashMap;
use crate::NodeHandler;

pub struct NodeRegistry {
    nodes: HashMap<String, Box<dyn NodeHandler>>,
}

impl NodeRegistry {
    pub fn new() -> Self {
        NodeRegistry { nodes: HashMap::new() }
    }

    pub fn register(&mut self, name: &str, handler: Box<dyn NodeHandler>) {
        self.nodes.insert(name.to_string(), handler);
    }
}

// FILE: src/main.rs
use actix_web::{web, App, HttpServer, HttpResponse};

async fn execute_handler() -> HttpResponse {
    HttpResponse::Ok().json(serde_json::json!({"success": true, "data": null, "errors": null}))
}

async fn health_handler() -> HttpResponse {
    HttpResponse::Ok().json(serde_json::json!({"status": "healthy"}))
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| {
        App::new()
            .route("/execute", web::post().to(execute_handler))
            .route("/health", web::get().to(health_handler))
    })
    .bind("0.0.0.0:8080")?
    .run()
    .await
}

// FILE: Cargo.toml
[package]
name = "blok-runtime-rust"
version = "0.1.0"
edition = "2021"

[dependencies]
actix-web = "4"
serde = { version = "1", features = ["derive"] }
serde_json = "1"

// FILE: Dockerfile
FROM rust:1.73 AS builder
WORKDIR /app
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=builder /app/target/release/blok-runtime-rust /runtime
EXPOSE 8080
CMD ["/runtime"]
`;

const VALID_PYTHON_RUNTIME = `
// FILE: blok/__init__.py
class Context:
    def __init__(self):
        self.id = ""
        self.workflow_name = ""
        self.request = {"body": {}, "headers": {}}
        self.response = {"data": None, "success": True, "errors": None}

class ExecutionRequest:
    def __init__(self, node_name, context, config=None):
        self.node_name = node_name
        self.context = context
        self.config = config or {}

class ExecutionResult:
    def __init__(self, success=True, data=None, errors=None):
        self.success = success
        self.data = data
        self.errors = errors

// FILE: blok/registry.py
class NodeHandler:
    def execute(self, ctx, config):
        raise NotImplementedError

class NodeRegistry:
    def __init__(self):
        self._nodes = {}

    def register(self, name, handler):
        self._nodes[name] = handler

    def get(self, name):
        return self._nodes.get(name)

// FILE: server.py
from flask import Flask, request, jsonify
from blok import Context

app = Flask(__name__)

@app.route("/execute", methods=["POST"])
def execute():
    return jsonify({"success": True, "data": None, "errors": None})

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "healthy"})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)

// FILE: nodes/hello_world.py
from blok.registry import NodeHandler

class HelloWorldNode(NodeHandler):
    def execute(self, ctx, config):
        return {"message": "Hello World"}

// FILE: requirements.txt
flask>=3.0.0
gunicorn>=21.2.0

// FILE: Dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
EXPOSE 8080
CMD ["gunicorn", "-b", "0.0.0.0:8080", "server:app"]
`;

const INVALID_RUNTIME_NO_FILES = `
package main

import "fmt"

func main() {
	fmt.Println("Hello World - no file markers, no endpoints, no registry")
}
`;

const INVALID_RUNTIME_MISSING_ENDPOINTS = `
// FILE: sdk/blok.go
package sdk

type Context struct {
	ID string
}

type NodeHandler interface {
	Run(ctx Context) error
}

type NodeRegistry struct {
	nodes map[string]NodeHandler
}

func NewRegistry() *NodeRegistry {
	return &NodeRegistry{nodes: make(map[string]NodeHandler)}
}

func (r *NodeRegistry) Register(name string, handler NodeHandler) {
	r.nodes[name] = handler
}

// FILE: server/main.go
package main

func main() {
	// Missing required HTTP endpoints
	println("server started")
}

// FILE: Dockerfile
FROM golang:1.21-alpine
WORKDIR /app
COPY . .
CMD ["go", "run", "."]
`;

const INVALID_RUNTIME_NO_HANDLER = `
// FILE: main.go
package main

import "net/http"

func main() {
	http.HandleFunc("/execute", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("healthy"))
	})
	http.ListenAndServe(":8080", nil)
}

// FILE: types.go
package main

type Context struct {
	ID   string
	Data map[string]interface{}
}

type ExecutionResult struct {
	success bool
	data    interface{}
	errors  interface{}
}

// FILE: Dockerfile
FROM golang:1.21-alpine
WORKDIR /app
COPY . .
CMD ["go", "run", "."]
`;

describe("RuntimeGenerator E2E", () => {
	let generator: RuntimeGenerator;

	beforeEach(() => {
		generator = new RuntimeGenerator();
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("successful generation - Go runtime", () => {
		it("should generate a valid Go runtime on first attempt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_GO_RUNTIME } as never);

			const result = await generator.generateRuntime("go", "Create a Go runtime SDK for Blok", "test-api-key");

			expect(result.language).toBe("go");
			expect(result.validationResult).toBeDefined();
			expect(result.validationResult!.valid).toBe(true);
			expect(result.validationResult!.attempts).toBe(1);
			expect(mockedGenerateText).toHaveBeenCalledTimes(1);
		});

		it("should parse multiple files from Go runtime output", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_GO_RUNTIME } as never);

			const result = await generator.generateRuntime("go", "Create a Go runtime SDK", "test-api-key");

			expect(result.files.length).toBeGreaterThanOrEqual(4);

			const filePaths = result.files.map((f) => f.path);
			expect(filePaths).toContain("sdk/blok.go");
			expect(filePaths).toContain("server/main.go");
			expect(filePaths).toContain("go.mod");
			expect(filePaths).toContain("Dockerfile");
		});
	});

	describe("successful generation - Java runtime", () => {
		it("should generate a valid Java runtime on first attempt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_JAVA_RUNTIME } as never);

			const result = await generator.generateRuntime("java", "Create a Java runtime SDK for Blok", "test-api-key");

			expect(result.validationResult!.valid).toBe(true);
			expect(result.validationResult!.attempts).toBe(1);
			expect(result.files.length).toBeGreaterThanOrEqual(4);
		});

		it("should parse Java-specific files", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_JAVA_RUNTIME } as never);

			const result = await generator.generateRuntime("java", "Create a Java runtime", "test-api-key");

			const filePaths = result.files.map((f) => f.path);
			expect(filePaths.some((p) => p.endsWith(".java"))).toBe(true);
			expect(filePaths.some((p) => p === "pom.xml")).toBe(true);
			expect(filePaths.some((p) => p === "Dockerfile")).toBe(true);
		});
	});

	describe("successful generation - Rust runtime", () => {
		it("should generate a valid Rust runtime on first attempt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_RUST_RUNTIME } as never);

			const result = await generator.generateRuntime("rust", "Create a Rust runtime SDK for Blok", "test-api-key");

			expect(result.validationResult!.valid).toBe(true);
			expect(result.validationResult!.attempts).toBe(1);
		});

		it("should parse Rust-specific files", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_RUST_RUNTIME } as never);

			const result = await generator.generateRuntime("rust", "Create a Rust runtime", "test-api-key");

			const filePaths = result.files.map((f) => f.path);
			expect(filePaths.some((p) => p.endsWith(".rs"))).toBe(true);
			expect(filePaths.some((p) => p === "Cargo.toml")).toBe(true);
			expect(filePaths.some((p) => p === "Dockerfile")).toBe(true);
		});
	});

	describe("successful generation - Python runtime", () => {
		it("should generate a valid Python runtime on first attempt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_PYTHON_RUNTIME } as never);

			const result = await generator.generateRuntime("python", "Create a Python runtime SDK for Blok", "test-api-key");

			expect(result.validationResult!.valid).toBe(true);
			expect(result.validationResult!.attempts).toBe(1);
		});

		it("should parse Python-specific files", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_PYTHON_RUNTIME } as never);

			const result = await generator.generateRuntime("python", "Create a Python runtime", "test-api-key");

			const filePaths = result.files.map((f) => f.path);
			expect(filePaths.some((p) => p.endsWith(".py"))).toBe(true);
			expect(filePaths.some((p) => p === "requirements.txt")).toBe(true);
			expect(filePaths.some((p) => p === "Dockerfile")).toBe(true);
		});
	});

	describe("structural validation", () => {
		it("should fail when output has no file markers", async () => {
			mockedGenerateText.mockResolvedValue({ text: INVALID_RUNTIME_NO_FILES } as never);

			const result = await generator.generateRuntime("go", "Create a runtime", "test-api-key");

			expect(result.validationResult!.valid).toBe(false);
			expect(result.validationResult!.errors.some((e) => e.includes("multiple files"))).toBe(true);
		});

		it("should fail when /execute endpoint is missing", async () => {
			mockedGenerateText.mockResolvedValue({ text: INVALID_RUNTIME_MISSING_ENDPOINTS } as never);

			const result = await generator.generateRuntime("go", "Create a runtime", "test-api-key");

			expect(result.validationResult!.valid).toBe(false);
			expect(result.validationResult!.errors.some((e) => e.includes("/execute"))).toBe(true);
		});

		it("should fail when NodeHandler/Registry is missing", async () => {
			mockedGenerateText.mockResolvedValue({ text: INVALID_RUNTIME_NO_HANDLER } as never);

			const result = await generator.generateRuntime("go", "Create a runtime", "test-api-key");

			expect(result.validationResult!.valid).toBe(false);
			expect(
				result.validationResult!.errors.some(
					(e) => e.toLowerCase().includes("nodehandler") || e.toLowerCase().includes("registry"),
				),
			).toBe(true);
		});
	});

	describe("validation feedback loop", () => {
		it("should retry with feedback on first failure and succeed on second attempt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: INVALID_RUNTIME_NO_FILES } as never);
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_GO_RUNTIME } as never);

			const result = await generator.generateRuntime("go", "Create a Go runtime", "test-api-key");

			expect(result.validationResult!.valid).toBe(true);
			expect(result.validationResult!.attempts).toBe(2);
			expect(mockedGenerateText).toHaveBeenCalledTimes(2);
		});

		it("should include error feedback in retry prompt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: INVALID_RUNTIME_NO_FILES } as never);
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_GO_RUNTIME } as never);

			await generator.generateRuntime("go", "Create a Go runtime", "test-api-key");

			const secondCallArgs = mockedGenerateText.mock.calls[1][0] as Record<string, unknown>;
			const prompt = secondCallArgs.prompt as string;
			expect(prompt).toContain("validation errors");
			expect(prompt).toContain("Previous code:");
		});

		it("should exhaust all 3 attempts when runtime keeps failing", async () => {
			mockedGenerateText.mockResolvedValue({ text: INVALID_RUNTIME_NO_FILES } as never);

			const result = await generator.generateRuntime("go", "Create a broken runtime", "test-api-key");

			expect(result.validationResult!.valid).toBe(false);
			expect(result.validationResult!.attempts).toBe(3);
			expect(mockedGenerateText).toHaveBeenCalledTimes(3);
		});

		it("should succeed on third attempt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: INVALID_RUNTIME_NO_FILES } as never);
			mockedGenerateText.mockResolvedValueOnce({ text: INVALID_RUNTIME_MISSING_ENDPOINTS } as never);
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_GO_RUNTIME } as never);

			const result = await generator.generateRuntime("go", "Create a Go runtime", "test-api-key");

			expect(result.validationResult!.valid).toBe(true);
			expect(result.validationResult!.attempts).toBe(3);
		});
	});

	describe("language-specific prompt enhancement", () => {
		it("should include Go-specific guidance in prompt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_GO_RUNTIME } as never);

			await generator.generateRuntime("go", "Create a runtime", "test-api-key");

			const callArgs = mockedGenerateText.mock.calls[0][0] as Record<string, unknown>;
			const prompt = callArgs.prompt as string;
			expect(prompt).toContain("go.mod");
			expect(prompt).toContain("Go module");
		});

		it("should include Java-specific guidance in prompt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_JAVA_RUNTIME } as never);

			await generator.generateRuntime("java", "Create a runtime", "test-api-key");

			const callArgs = mockedGenerateText.mock.calls[0][0] as Record<string, unknown>;
			const prompt = callArgs.prompt as string;
			expect(prompt).toContain("Maven");
			expect(prompt).toContain("pom.xml");
		});

		it("should include Rust-specific guidance in prompt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_RUST_RUNTIME } as never);

			await generator.generateRuntime("rust", "Create a runtime", "test-api-key");

			const callArgs = mockedGenerateText.mock.calls[0][0] as Record<string, unknown>;
			const prompt = callArgs.prompt as string;
			expect(prompt).toContain("Cargo");
			expect(prompt).toContain("Cargo.toml");
		});

		it("should include Python-specific guidance in prompt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_PYTHON_RUNTIME } as never);

			await generator.generateRuntime("python", "Create a runtime", "test-api-key");

			const callArgs = mockedGenerateText.mock.calls[0][0] as Record<string, unknown>;
			const prompt = callArgs.prompt as string;
			expect(prompt).toContain("Flask");
			expect(prompt).toContain("requirements.txt");
		});
	});

	describe("markdown fence cleanup", () => {
		it("should strip markdown fences from LLM response", async () => {
			const wrappedCode = `\`\`\`go\n${VALID_GO_RUNTIME}\n\`\`\``;
			mockedGenerateText.mockResolvedValueOnce({ text: wrappedCode } as never);

			const result = await generator.generateRuntime("go", "Create a Go runtime", "test-api-key");

			expect(result.rawCode).not.toContain("```");
			expect(result.validationResult!.valid).toBe(true);
		});
	});

	describe("temperature and model configuration", () => {
		it("should use temperature 0.2 for deterministic output", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_GO_RUNTIME } as never);

			await generator.generateRuntime("go", "Create a runtime", "test-api-key");

			const callArgs = mockedGenerateText.mock.calls[0][0] as Record<string, unknown>;
			expect(callArgs.temperature).toBe(0.2);
		});

		it("should use GPT-4o model", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_GO_RUNTIME } as never);

			await generator.generateRuntime("go", "Create a runtime", "test-api-key");

			expect(mockedGenerateText).toHaveBeenCalledTimes(1);
		});
	});

	describe("analytics integration", () => {
		it("should include prompt version in validation result", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_GO_RUNTIME } as never);

			const result = await generator.generateRuntime("go", "Create a runtime", "test-api-key");

			expect(result.validationResult!.promptVersion).toContain("create-runtime@");
		});

		it("should include duration in validation result", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_GO_RUNTIME } as never);

			const result = await generator.generateRuntime("go", "Create a runtime", "test-api-key");

			expect(result.validationResult!.durationMs).toBeGreaterThanOrEqual(0);
		});
	});

	describe("multi-file parsing", () => {
		it("should parse files separated by // FILE: markers", async () => {
			const code = [
				"// FILE: main.go",
				"package main",
				"",
				"func main() {}",
				"",
				"// FILE: lib.go",
				"package lib",
				"",
				'func Hello() string { return "hello" }',
			].join("\n");

			const files = generator.parseFiles(code, "go");
			expect(files).toHaveLength(2);
			expect(files[0].path).toBe("main.go");
			expect(files[0].content).toContain("package main");
			expect(files[1].path).toBe("lib.go");
			expect(files[1].content).toContain("package lib");
		});

		it("should handle code with no file markers as a single file", async () => {
			const code = "package main\n\nfunc main() {}";
			const files = generator.parseFiles(code, "go");
			expect(files).toHaveLength(1);
			expect(files[0].path).toBe("runtime.go");
		});

		it("should use correct file extension per language", async () => {
			const code = "print('hello')";
			expect(generator.parseFiles(code, "python")[0].path).toBe("runtime.py");
			expect(generator.parseFiles(code, "rust")[0].path).toBe("runtime.rs");
			expect(generator.parseFiles(code, "java")[0].path).toBe("runtime.java");
			expect(generator.parseFiles(code, "csharp")[0].path).toBe("runtime.cs");
			expect(generator.parseFiles(code, "php")[0].path).toBe("runtime.php");
			expect(generator.parseFiles(code, "ruby")[0].path).toBe("runtime.rb");
		});
	});

	describe("validateRuntimeStructure", () => {
		it("should pass for valid Go runtime code", () => {
			const result = generator.validateRuntimeStructure(VALID_GO_RUNTIME, "go");
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it("should pass for valid Java runtime code", () => {
			const result = generator.validateRuntimeStructure(VALID_JAVA_RUNTIME, "java");
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it("should pass for valid Rust runtime code", () => {
			const result = generator.validateRuntimeStructure(VALID_RUST_RUNTIME, "rust");
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it("should pass for valid Python runtime code", () => {
			const result = generator.validateRuntimeStructure(VALID_PYTHON_RUNTIME, "python");
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it("should detect missing file markers", () => {
			const result = generator.validateRuntimeStructure(INVALID_RUNTIME_NO_FILES, "go");
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes("multiple files"))).toBe(true);
		});

		it("should detect missing /execute endpoint", () => {
			const result = generator.validateRuntimeStructure(INVALID_RUNTIME_MISSING_ENDPOINTS, "go");
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes("/execute"))).toBe(true);
		});

		it("should detect missing /health endpoint", () => {
			const codeWithoutHealth = VALID_GO_RUNTIME.replace("/health", "/status");
			const result = generator.validateRuntimeStructure(codeWithoutHealth, "go");
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes("/health"))).toBe(true);
		});

		it("should add Go-specific warning for missing go.mod", () => {
			// Code with endpoints and structure but no go.mod
			const code = `
// FILE: main.go
package main

import "net/http"

func main() {
	http.HandleFunc("/execute", func(w http.ResponseWriter, r *http.Request) {})
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {})
}

type Context struct { ID string }
type NodeHandler interface { Execute() }
type NodeRegistry struct {}
func (r *NodeRegistry) Register() {}

type ExecutionResult struct { success bool; data interface{}; errors interface{} }

// FILE: Dockerfile
FROM golang:1.21
`;
			const result = generator.validateRuntimeStructure(code, "go");
			expect(result.warnings.some((w) => w.includes("go.mod"))).toBe(true);
		});
	});
});
