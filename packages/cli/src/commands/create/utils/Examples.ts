const node_file = `import ApiCall from "@blokjs/api-call";
import IfElse from "@blokjs/if-else";
import type { NodeBase } from "@blokjs/shared";
import ChainInit from "./nodes/chain-init/index";
import ChainVerify from "./nodes/chain-verify/index";
import ExampleNodes from "./nodes/examples/index";
import RuntimeBridge from "./nodes/runtime-bridge/index";

const nodes: {
	[key: string]: NodeBase;
} = {
	"@blokjs/api-call": ApiCall,
	"@blokjs/if-else": IfElse,
	"chain-init": ChainInit,
	"chain-verify": ChainVerify,
	"runtime-bridge": RuntimeBridge,
	...ExampleNodes,
};

export default nodes;
`;

const package_dependencies = {
	ai: "^4.1.50",
	"@ai-sdk/openai": "^1.2.0",
	ejs: "^3.1.10",
	pg: "^8.13.3",
	mongodb: "^6.14.2",
	// v0.6.7 chat demo — @blokjs/llm-stream uses the official openai SDK
	// pointed at OpenRouter's OpenAI-compatible Chat Completions endpoint.
	openai: "^4.77.0",
	// v0.6.8 chat-memory demo — @blokjs/redis-kv lazy-imports ioredis.
	// Declared as a hard dep so the memory chat workflows boot cleanly
	// the moment a Redis instance is reachable at REDIS_URL. Pinned to
	// the same range @blokjs/helpers already declares so deduping picks
	// the same install on both sides.
	ioredis: "^5.10.1",
};

const package_dev_dependencies = {
	"@types/ejs": "^3.1.5",
	"@types/pg": "^8.11.11",
};

const python3_file = `
from core.blok import BlokService
from core.types.context import Context
from core.types.blok_response import BlokResponse
from core.types.global_error import GlobalError
from typing import Any, Dict
import traceback

class Node(BlokService):
    def __init__(self):
        BlokService.__init__(self)
        self.input_schema = {}
        self.output_schema = {}

    async def handle(self, ctx: Context, inputs: Dict[str, Any]) -> BlokResponse:
        response = BlokResponse()

        try:
            response.setSuccess({ "message": "Hello World from Python3!" })
        except Exception as error:
            err = GlobalError(error)
            err.setCode(500)
            err.setName(self.name)

            stack_trace = traceback.format_exc()
            err.setStack(stack_trace)
            response.success = False
            response.setError(err)

        return response
`;

const examples_url = `
Examples:
1- Open "workflow-docs.json" in your browser at http://localhost:4000/workflow-docs
2- Open "db-manager.json" in your browser at http://localhost:4000/db-manager
3- Open "dashboard-gen.json" in your browser at http://localhost:4000/dashboard-gen
4- Open "countries.json" in your browser at http://localhost:4000/countries
5- Open "chat.json" in your browser at http://localhost:4000/chat (set OPENROUTER_API_KEY first)
6- Open "chat-memory.json" in your browser at http://localhost:4000/chat-memory (needs OPENROUTER_API_KEY + Redis at REDIS_URL)
7- Webhook router: POST /webhooks/{stripe,github,linear} with signed bodies — set the matching *_WEBHOOK_SECRET env vars (needs --triggers webhook)
8- LLM agent w/ tool calls: open http://localhost:4000/agent — model picks between get_weather and calculate tools (needs OPENROUTER_API_KEY + Redis)
9- Worker fan-out: POST /fanout/jobs with body '{items:[...], tenantId?:"..."}' to enqueue N worker jobs (needs --triggers worker; BLOK_WORKER_ADAPTER=in-memory works single-process)

For more documentation, visit src/nodes/examples/README.md. The first three examples require a PostgreSQL database to function.
`;

// v2 workflow template — LLM- and human-friendly. Every step's output
// auto-persists to ctx.state[id]. Reference earlier outputs via
// $.state.<id> in inputs (compiles to "js/ctx.state.<id>" at runtime).
// Opt out of persistence with "ephemeral": true.
const workflow_template = `
{
	"name": "My Workflow",
	"description": "What this workflow does",
	"version": "1.0.0",
	"trigger": {
		"http": {
			"method": "GET",
			"accept": "application/json"
		}
	},
	"steps": [
		{
			"id": "echo",
			"use": "@blokjs/respond",
			"inputs": {
				"body": "$.req.body"
			}
		}
	]
}
`;

const supervisord_nodejs = `
[supervisord]
nodaemon=true

[program:nodejs_app]
command=npm start
directory=/app
autostart=true
autorestart=true
stderr_logfile=/var/log/nodejs.err.log
stdout_logfile=/var/log/nodejs.out.log
`;

const supervisord_python = `
[program:python_app]
command=python3 /app/.blok/runtimes/python3/server.py
directory=/app
autostart=true
autorestart=true
stderr_logfile=/var/log/python.err.log
stdout_logfile=/var/log/python.out.log
`;

const go_node_file = `package main

import (
	"github.com/blok/sdk"
)

type HelloWorldNode struct{}

func (n *HelloWorldNode) Execute(ctx *sdk.Context, config map[string]interface{}) (*sdk.ExecutionResult, error) {
	// Access request body
	name := "World"
	if body, ok := ctx.Request.Body.(map[string]interface{}); ok {
		if nameVal, ok := body["name"].(string); ok {
			name = nameVal
		}
	}

	// Access configuration
	prefix := "Hello"
	if prefixVal, ok := config["prefix"].(string); ok {
		prefix = prefixVal
	}

	// Store result in context for downstream nodes
	ctx.Vars["greeting"] = prefix + ", " + name + "!"

	// Return successful result
	return &sdk.ExecutionResult{
		Success: true,
		Data: map[string]interface{}{
			"message": prefix + ", " + name + "!",
			"timestamp": sdk.GetCurrentTimestamp(),
			"language": "Go",
		},
		Errors: nil,
	}, nil
}

func main() {
	// Register node
	registry := sdk.NewNodeRegistry()
	registry.Register("{{NODE_NAME}}", &HelloWorldNode{})

	// Start HTTP server
	server := sdk.NewHTTPServer(registry, ":8080")
	if err := server.Start(); err != nil {
		panic(err)
	}
}
`;

const go_mod_file = `module github.com/blok/nodes/{{NODE_NAME}}

go 1.21

require github.com/blok/sdk v1.0.0
`;

const go_dockerfile = `FROM golang:1.21-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /node main.go

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=builder /node .

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["./node"]
`;

const java_node_file = `package com.blok.nodes;

import com.blok.runtime.Blok;
import com.blok.runtime.NodeRegistry;
import com.blok.server.RuntimeServer;
import java.util.HashMap;
import java.util.Map;

public class HelloWorldNode implements Blok.NodeHandler {
    @Override
    public Blok.ExecutionResult execute(Blok.Context ctx, Map<String, Object> config) {
        try {
            // Access request body
            String name = "World";
            if (ctx.request.body != null && ctx.request.body.containsKey("name")) {
                name = (String) ctx.request.body.get("name");
            }

            // Access configuration
            String prefix = "Hello";
            if (config != null && config.containsKey("prefix")) {
                prefix = (String) config.get("prefix");
            }

            // Store result in context for downstream nodes
            String greeting = prefix + ", " + name + "!";
            ctx.vars.put("greeting", greeting);

            // Build response data
            Map<String, Object> data = new HashMap<>();
            data.put("message", greeting);
            data.put("timestamp", System.currentTimeMillis());
            data.put("language", "Java");

            // Return successful result
            return new Blok.ExecutionResult(true, data, null, null, null);
        } catch (Exception e) {
            return new Blok.ExecutionResult(false, null, e.getMessage(), null, null);
        }
    }

    public static void main(String[] args) {
        try {
            // Register node
            NodeRegistry registry = new NodeRegistry();
            registry.register("{{NODE_NAME}}", new HelloWorldNode());

            // Start HTTP server
            RuntimeServer server = new RuntimeServer(registry, 8080);
            server.start();
        } catch (Exception e) {
            e.printStackTrace();
            System.exit(1);
        }
    }
}
`;

const java_pom_file = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0
         http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.blok</groupId>
    <artifactId>{{NODE_NAME}}</artifactId>
    <version>1.0.0</version>

    <properties>
        <maven.compiler.source>17</maven.compiler.source>
        <maven.compiler.target>17</maven.compiler.target>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
        <dependency>
            <groupId>com.google.code.gson</groupId>
            <artifactId>gson</artifactId>
            <version>2.10.1</version>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-shade-plugin</artifactId>
                <version>3.5.0</version>
                <executions>
                    <execution>
                        <phase>package</phase>
                        <goals>
                            <goal>shade</goal>
                        </goals>
                        <configuration>
                            <transformers>
                                <transformer implementation="org.apache.maven.plugins.shade.resource.ManifestResourceTransformer">
                                    <mainClass>com.blok.nodes.HelloWorldNode</mainClass>
                                </transformer>
                            </transformers>
                        </configuration>
                    </execution>
                </executions>
            </plugin>
        </plugins>
    </build>
</project>
`;

const java_dockerfile = `FROM maven:3.9-eclipse-temurin-17 AS builder

WORKDIR /app
COPY pom.xml .
RUN mvn dependency:go-offline

COPY src ./src
RUN mvn clean package -DskipTests

FROM eclipse-temurin:17-jre-alpine

WORKDIR /root/
COPY --from=builder /app/target/{{NODE_NAME}}-1.0.0.jar ./app.jar

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["java", "-jar", "app.jar"]
`;

const rust_node_file = `use async_trait::async_trait;
use blok::{NodeHandler, NodeRegistry, Context};
use std::collections::HashMap;

/// {{NODE_NAME}} - A Blok node implemented in Rust
struct {{NODE_NAME_PASCAL}};

#[async_trait]
impl NodeHandler for {{NODE_NAME_PASCAL}} {
    async fn execute(
        &self,
        ctx: &mut Context,
        config: &HashMap<String, serde_json::Value>,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        // Access request body
        let name = ctx.request.body
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("World");

        // Access configuration
        let prefix = config
            .get("prefix")
            .and_then(|v| v.as_str())
            .unwrap_or("Hello");

        let message = format!("{}, {}!", prefix, name);

        // Store in context vars for downstream nodes
        ctx.vars.insert(
            "greeting".to_string(),
            serde_json::Value::String(message.clone()),
        );

        // Return response
        Ok(serde_json::json!({
            "message": message,
            "language": "Rust"
        }))
    }
}

#[tokio::main]
async fn main() {
    // Initialize tracing
    tracing_subscriber::fmt::init();

    // Register nodes
    let mut registry = NodeRegistry::new("1.0.0");
    registry.register("{{NODE_NAME}}", {{NODE_NAME_PASCAL}});

    // Start HTTP server
    blok::server::serve(registry, 8080).await.unwrap();
}
`;

const rust_cargo_file = `[package]
name = "{{NODE_NAME}}"
version = "1.0.0"
edition = "2021"

[[bin]]
name = "{{NODE_NAME}}"
path = "src/main.rs"

[dependencies]
blok = { path = "../../sdk" }
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
async-trait = "0.1"
tracing = "0.1"
tracing-subscriber = "0.3"
`;

const rust_dockerfile = `FROM rust:1.77-alpine AS builder

RUN apk add --no-cache musl-dev

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs && \\
    cargo build --release 2>/dev/null || true && rm -rf src

COPY . .
RUN cargo build --release

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=builder /app/target/release/{{NODE_NAME}} .

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["./{{NODE_NAME}}"]
`;

const csharp_node_file = `using System.Text.Json;
using Blok.Runtime;

namespace Blok.Runtime.Nodes;

public class {{NODE_NAME_PASCAL}}Node : INodeHandler
{
    public Task<JsonElement> ExecuteAsync(Context ctx, Dictionary<string, JsonElement> config)
    {
        // Access request body
        var name = "World";
        if (ctx.Request.Body.ValueKind == JsonValueKind.Object &&
            ctx.Request.Body.TryGetProperty("name", out var nameEl) &&
            nameEl.ValueKind == JsonValueKind.String)
        {
            name = nameEl.GetString() ?? "World";
        }

        // Access configuration
        var prefix = "Hello";
        if (config.TryGetValue("prefix", out var prefixEl) &&
            prefixEl.ValueKind == JsonValueKind.String)
        {
            prefix = prefixEl.GetString() ?? "Hello";
        }

        var message = $"{prefix}, {name}!";

        // Store in context for downstream nodes
        ctx.Vars["greeting"] = JsonSerializer.SerializeToElement(message);

        // Return response
        var result = JsonSerializer.SerializeToElement(new
        {
            message,
            timestamp = DateTime.UtcNow.ToString("o"),
            language = "C#"
        });

        return Task.FromResult(result);
    }
}
`;

const csharp_csproj_file = `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <RootNamespace>Blok.Runtime</RootNamespace>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
`;

const csharp_dockerfile = `FROM mcr.microsoft.com/dotnet/sdk:8.0 AS builder
WORKDIR /app
COPY *.csproj .
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /out

FROM mcr.microsoft.com/dotnet/aspnet:8.0-alpine
WORKDIR /app
COPY --from=builder /out .

EXPOSE 8080
ENV PORT=8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["dotnet", "BlokRuntime.dll"]
`;

const php_node_file = `<?php

namespace Blok\\Nodes;

use Blok\\NodeHandler;
use Blok\\Context;

class {{NODE_NAME_PASCAL}}Node implements NodeHandler
{
    public function execute(Context $ctx, array $config): mixed
    {
        // Access request body
        $name = $ctx->request->body['name'] ?? 'World';

        // Access configuration
        $prefix = $config['prefix'] ?? 'Hello';

        $message = "$prefix, $name!";

        // Store in context for downstream nodes
        $ctx->vars['greeting'] = $message;

        // Return response
        return [
            'message' => $message,
            'timestamp' => date('c'),
            'language' => 'PHP',
        ];
    }
}
`;

const php_composer_file = `{
    "name": "blok/{{NODE_NAME}}",
    "type": "project",
    "require": {
        "php": ">=8.2",
        "react/http": "^1.9",
        "react/socket": "^1.15"
    },
    "autoload": {
        "psr-4": {
            "Blok\\\\": "src/"
        }
    }
}
`;

const php_dockerfile = `FROM php:8.2-cli-alpine AS builder
WORKDIR /app
COPY --from=composer:latest /usr/bin/composer /usr/bin/composer
COPY composer.json .
RUN composer install --no-dev --optimize-autoloader
COPY . .

FROM php:8.2-cli-alpine
WORKDIR /app
COPY --from=builder /app .

EXPOSE 8080
ENV PORT=8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["php", "index.php"]
`;

const ruby_node_file = `require_relative '../../lib/blok'

module Blok
  module Nodes
    class {{NODE_NAME_PASCAL}}Node < Blok::NodeHandler
      def execute(ctx, config)
        # Access request body
        name = ctx.request.body.is_a?(Hash) ? ctx.request.body['name'] : nil
        name ||= 'World'

        # Access configuration
        prefix = config['prefix'] || 'Hello'

        message = "#{prefix}, #{name}!"

        # Store in context for downstream nodes
        ctx.vars['greeting'] = message

        # Return response
        {
          'message' => message,
          'timestamp' => Time.now.utc.iso8601,
          'language' => 'Ruby'
        }
      end
    end
  end
end
`;

const ruby_gemfile = `source 'https://rubygems.org'

ruby '>= 3.1'

gem 'sinatra', '~> 4.0'
gem 'puma', '~> 6.4'
gem 'rackup', '~> 2.1'
`;

const ruby_dockerfile = `FROM ruby:3.2-alpine AS builder
RUN apk add --no-cache build-base
WORKDIR /app
COPY Gemfile Gemfile.lock ./
RUN bundle install --without development test

FROM ruby:3.2-alpine
RUN apk --no-cache add ca-certificates wget
WORKDIR /app
COPY --from=builder /usr/local/bundle /usr/local/bundle
COPY . .

EXPOSE 8080
ENV PORT=8080
ENV RACK_ENV=production
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["bundle", "exec", "puma", "-b", "tcp://0.0.0.0:8080"]
`;

const agents_md = `# Blok Project

Blok is a TypeScript-first workflow orchestration framework. It executes declarative workflows (JSON or TypeScript DSL) composed of steps (nodes) that run across 8 language runtimes: NodeJS, Python3, Go, Rust, Java, C#, PHP, and Ruby.

## Project Structure

\`\`\`
├── src/
│   └── nodes/             # TypeScript node implementations
├── runtimes/              # Non-NodeJS runtime nodes (Go, Python3, etc.)
│   └── {lang}/nodes/      # Language-specific node implementations
├── workflows/
│   ├── json/              # Workflow definitions (JSON)
│   ├── yaml/              # Workflow definitions (YAML)
│   └── toml/              # Workflow definitions (TOML)
├── .blok/
│   ├── config.json        # Runtime configuration (ports, start commands)
│   └── runtimes/          # Auto-generated runtime scaffolds
├── .env.local             # Environment variables (ports, paths)
└── supervisord.conf       # Process management config
\`\`\`

## Commands

\`\`\`bash
npm run dev                # Start dev server (or blokctl dev for multi-runtime)
npm run build              # Build project
npm test                   # Run tests
blokctl create node <name> # Scaffold a new node
blokctl create workflow <n># Scaffold a new workflow
blokctl trace              # Open Blok Studio (trace visualization)
blokctl studio             # Alias for blokctl trace
\`\`\`

## Context — Critical Data Flow

The Context type is the central execution state passed through every step.

\`\`\`typescript
type Context = {
  id: string;                      // Unique request ID
  request: RequestContext;          // Incoming request (body, headers, params, query)
  response: ResponseContext;       // Current step output — OVERWRITTEN every step
  vars?: VarsContext;              // Persistent variables — PERSISTS across workflow
  config: ConfigContext;           // Node config (inputs resolved by Mapper)
  env?: EnvContext;                // process.env access
  logger: LoggerContext;
  error: ErrorContext;
};
\`\`\`

### The Two Critical Rules

**Rule 1: \\\`ctx.prev\\\` carries the immediately previous step's output.**
Each step's output replaces \\\`ctx.prev\\\`. Use it for adjacent-step access only.

**Rule 2: \\\`ctx.state[id]\\\` PERSISTS across the entire workflow.**
Every step's output is auto-stored at \\\`ctx.state[<step-id>]\\\` (the v2 default-store rule). Downstream steps reference it via \\\`$.state.<id>\\\` (TS DSL) or \\\`"$.state.<id>"\\\` / \\\`"js/ctx.state.<id>"\\\` (JSON). Opt out per step with \\\`ephemeral: true\\\`.

### Data Flow Example

\`\`\`
Step 1: id "fetch-user"
  → ctx.state["fetch-user"] = { id: "123", name: "Alice" }
  → ctx.prev = { id: "123", name: "Alice" }

Step 2: id "transform"
  → ctx.state["transform"] = { result: "done" }
  → ctx.prev = { result: "done" }              ← Step 1 output GONE from prev
  → ctx.state["fetch-user"] still available

Step 3: id "output"
  → Can read ctx.state["fetch-user"].name      ← still "Alice"
\`\`\`

### Blueprint Mapper — Expression Resolution

Node inputs support dynamic expressions resolved BEFORE node execution:

\`\`\`json
{
  "inputs": {
    "userId": "js/ctx.request.body.userId",
    "chain": "js/ctx.vars['previous-step'].chain",
    "previous": "js/ctx.response.data.result"
  }
}
\`\`\`

Available in js/ expressions: \\\`ctx\\\` (full context), \\\`data\\\` (ctx.prev.data), \\\`func\\\` (ctx.func), \\\`vars\\\` (alias for ctx.state).

---

## Creating Nodes with defineNode

Use \\\`defineNode()\\\` for all new nodes. Never use the legacy class-based pattern.

\`\`\`typescript
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "fetch-user",
  description: "Fetches user by ID",

  input: z.object({
    userId: z.string().uuid(),
  }),

  output: z.object({
    user: z.object({
      id: z.string(),
      name: z.string(),
      email: z.string().email(),
    }),
  }),

  async execute(ctx, input) {
    const user = await fetchUser(input.userId);
    return { user };
  },
});
\`\`\`

### Key Behaviors

- Zod input/output validation runs automatically
- ZodError is mapped to GlobalError with HTTP 400
- \\\`flow: true\\\` nodes return NodeBase[] for conditional execution
- \\\`contentType\\\` sets response Content-Type (e.g., "text/html")
- Always \\\`export default defineNode(...)\\\`

---

## Workflow Structure (JSON)

\`\`\`json
{
  "name": "My Workflow",
  "version": "1.0.0",
  "trigger": {
    "http": { "method": "POST", "path": "/api/process", "accept": "application/json" }
  },
  "steps": [
    { "id": "fetch",   "use": "@blokjs/api-call", "inputs": { "url": "https://api.example.com", "method": "GET" } },
    { "id": "process", "use": "my-node",         "inputs": { "data": "$.state.fetch" } },
    { "id": "go-step", "use": "chain-test", "type": "runtime.go", "inputs": { "processed": "$.state.process" } }
  ]
}
\`\`\`

### Workflow Naming

Every workflow's \\\`name\\\` must be UNIQUE across the project. The
\\\`WorkflowRegistry\\\` rejects duplicate names at boot, so a collision
means only one of the colliding workflows ever registers.

Prefer a dotted \\\`domain.action\\\` convention for the workflow
\\\`name\\\` — \\\`countries.list\\\`, \\\`users.create\\\`,
\\\`orders.refund\\\`. The typed client (\\\`@blokjs/client\\\`) and
\\\`blokctl gen app-types\\\` nest workflows by their dotted name, so a clean
name surfaces as \\\`blok.countries.list(...)\\\` instead of a quoted
\\\`blok["World Countries"]\\\` accessor. Duplicate names also make
\\\`gen app-types\\\` report a collision and DROP one workflow from the
generated \\\`BlokApp\\\` type.

The dotted convention applies to the workflow \\\`name\\\` only. Keep the
\\\`Workflows.ts\\\` map KEYS dot-free (e.g. \\\`"refund-order"\\\`, not
\\\`"orders.refund"\\\`) — the worker resolver treats the first dot in a map
key as a file-extension delimiter, so a dotted key fails to resolve at load.

### Step Types

| Type | Description |
|------|-------------|
| \\\`module\\\` | TypeScript node from registered modules |
| \\\`local\\\` | TypeScript node from filesystem (NODES_PATH) |
| \\\`runtime.python3\\\` | Python3 SDK container (port 9007) |
| \\\`runtime.go\\\` | Go SDK container (port 9001) |
| \\\`runtime.rust\\\` | Rust SDK container (port 9002) |
| \\\`runtime.java\\\` | Java SDK container (port 9003) |
| \\\`runtime.csharp\\\` | C# SDK container (port 9004) |
| \\\`runtime.php\\\` | PHP SDK container (port 9005) |
| \\\`runtime.ruby\\\` | Ruby SDK container (port 9006) |

### Conditional Workflow (if-else)

\`\`\`json
{
  "steps": [
    {
      "id": "filter-request",
      "branch": {
        "when": "ctx.request.query.active === \\\\"true\\\\"",
        "then": [{ "id": "active-path", "use": "handle-active", "type": "module" }],
        "else": [{ "id": "default-path", "use": "handle-default", "type": "module" }]
      }
    }
  ]
}
\`\`\`

---

## Trigger Types

| Trigger | Example Config |
|---------|---------------|
| \\\`http\\\` | \\\`{ "method": "GET", "path": "/", "accept": "application/json" }\\\` |
| \\\`grpc\\\` | \\\`{ "service": "UserService", "method": "GetUser" }\\\` |
| \\\`cron\\\` | \\\`{ "schedule": "0 * * * *", "timezone": "UTC" }\\\` |
| \\\`pubsub\\\` | \\\`{ "provider": "gcp", "topic": "updates" }\\\` |
| \\\`webhook\\\` | \\\`{ "source": "github", "events": ["push"] }\\\` |
| \\\`websocket\\\` | \\\`{ "events": ["message"], "path": "/ws" }\\\` |
| \\\`sse\\\` | \\\`{ "events": ["update"], "path": "/stream" }\\\` |
| \\\`worker\\\` | \\\`{ "queue": "jobs", "concurrency": 5, "retries": 3 }\\\` |

### Worker Trigger

The worker trigger processes background jobs from a queue with retry logic and concurrency control.

\\\`\\\`\\\`typescript
import { workflow, $ } from "@blokjs/helper";

export default workflow({
  name: "Process Job",
  version: "1.0.0",
  trigger: { worker: { queue: "background-jobs", concurrency: 5, retries: 3 } },
  steps: [
    {
      id: "process",
      use: "my-processor",
      inputs: { payload: $.req.body, jobId: $.req.params.jobId },
    },
  ],
});
\\\`\\\`\\\`

Job context: \\\`ctx.request.body\\\` = payload, \\\`ctx.request.params.queue\\\` = queue name, \\\`ctx.request.params.jobId\\\` = job ID, \\\`ctx.request.params.attempt\\\` = attempt count, \\\`ctx.vars._worker_job\\\` = full metadata.

Worker providers: \\\`in-memory\\\` (dev default, zero infra), \\\`nats\\\`, \\\`bullmq\\\`, \\\`rabbitmq\\\`, \\\`sqs\\\`, \\\`kafka\\\`, \\\`redis\\\`, \\\`pg-boss\\\`. Resolved per-workflow via \\\`trigger.worker.provider\\\`, then \\\`BLOK_WORKER_ADAPTER\\\`, then \\\`in-memory\\\`.

### NATS JetStream

Recommended queue/worker backend. Environment variables:
\\\`\\\`\\\`
NATS_SERVERS=localhost:4222
NATS_STREAM_NAME=blok-queue     # or blok-worker for worker trigger
NATS_TOKEN=                      # optional auth
\\\`\\\`\\\`

Queue providers: \\\`kafka\\\`, \\\`rabbitmq\\\`, \\\`sqs\\\`, \\\`redis\\\`, \\\`beanstalk\\\`, \\\`nats\\\`

### Standalone Workers (Go, Rust, Python)

Go, Rust, and Python SDKs include standalone NATS workers that connect directly to NATS without the TypeScript runner:

\\\`\\\`\\\`
WORKER_CONCURRENCY=1             # Max concurrent jobs
WORKER_MAX_RETRIES=3             # Max delivery attempts
WORKER_QUEUES=queue1,queue2      # Queues to consume
\\\`\\\`\\\`

---

## Testing Utilities

\\\`@blokjs/runner\\\` provides testing utilities for nodes and workflows.

### NodeTestHarness — Unit test a single node:
\\\`\\\`\\\`typescript
import { NodeTestHarness } from "@blokjs/runner";
const harness = new NodeTestHarness(myNode);
const result = await harness.execute({ input: "data" });
harness.assertSuccess(result);
harness.assertOutput(result, { expected: "output" });
\\\`\\\`\\\`

### WorkflowTestRunner — Integration test a workflow:
\\\`\\\`\\\`typescript
import { WorkflowTestRunner } from "@blokjs/runner";
const runner = new WorkflowTestRunner({ verbose: true });
runner.registerNode("validate", ValidateNode);
runner.mockNode("external-api", async (input) => ({ result: "mocked" }));
runner.loadWorkflow(workflowDefinition);
const result = await runner.execute({ input: "data" });
// result.success, result.output, result.trace, result.nodeResults
\\\`\\\`\\\`

---

## Runtime Adapter System

All non-NodeJS SDKs communicate via HTTP:
- **POST /execute** — Execute node with context
- **GET /health** — Health check

Environment variables: \\\`RUNTIME_{LANG}_HOST\\\` / \\\`RUNTIME_{LANG}_PORT\\\`

Runtime nodes auto-save \\\`result.data\\\` to \\\`ctx.vars[stepName]\\\`.

---

## Blok Studio

Real-time workflow trace visualization UI.

- Launch: \\\`blokctl trace\\\` or \\\`blokctl studio\\\`
- API: \\\`/__blok/runs\\\`, \\\`/__blok/runs/:id\\\`, \\\`/__blok/runs/:id/stream\\\` (SSE)
- Disable: \\\`BLOK_TRACE_ENABLED=false\\\`

---

## Do NOT

- Do NOT rely on \\\`ctx.response.data\\\` for data from non-previous steps — it gets overwritten
- Do NOT create class-based nodes — use \\\`defineNode()\\\` instead
- Do NOT use \\\`any\\\` type — use \\\`unknown\\\` and narrow with Zod
- Do NOT hardcode runtime ports — use environment variables
- Do NOT skip Zod input/output schemas
- Do NOT edit files in \\\`.blok/runtimes/\\\` — they are auto-generated

## Do

- Use \\\`$.state.<id>\\\` (or \\\`js/ctx.state.<id>\\\`) to pass data between non-adjacent steps — every step default-stores its output there
- Opt out per step with \\\`ephemeral: true\\\` when the step is a side effect only
- Use Zod schemas for all input/output validation
- Use \\\`defineNode()\\\` for all new nodes
- Handle errors via GlobalError with appropriate HTTP status codes
- Keep nodes focused — one responsibility per node
`;

const claude_md = `# Blok Project — Claude Code Guide

Read \\\`AGENTS.md\\\` for full architecture and API details. This file contains Claude-specific guidance.

## Quick Commands

\\\`\\\`\\\`bash
npm run dev                        # Start dev server
blokctl dev                        # Multi-runtime dev server
blokctl create node <name>         # Scaffold new node
blokctl create workflow <name>     # Scaffold new workflow
blokctl trace                      # Open Blok Studio
npm test                           # Run tests
\\\`\\\`\\\`

## Context Rules (Memorize These)

1. **\\\`ctx.prev\\\` is the immediately previous step's output.** Overwritten every step.
2. **\\\`ctx.state[<id>]\\\` PERSISTS across the workflow.** Every step default-stores its output there; reference via \\\`$.state.<id>\\\` or \\\`js/ctx.state.<id>\\\`. Opt out with \\\`ephemeral: true\\\`.
3. **Blueprint Mapper resolves \\\`$.<path>\\\` and \\\`js/\\\` expressions BEFORE node execution.**

When users have data flow issues, check these three things first.

## Workflow Naming

Workflow \\\`name\\\` must be UNIQUE across the project — the
\\\`WorkflowRegistry\\\` rejects duplicates at boot. Use a dotted
\\\`domain.action\\\` convention (\\\`countries.list\\\`, \\\`users.create\\\`)
so the typed client (\\\`@blokjs/client\\\`) and \\\`blokctl gen app-types\\\`
expose clean nested accessors like \\\`blok.countries.list(...)\\\`. Duplicate
names make \\\`gen app-types\\\` flag a collision and drop one workflow from
the generated \\\`BlokApp\\\` type.

## Debugging Workflows

1. **Verify structure**: Every step has an \\\`id\\\` and a \\\`use\\\` (v2). v1's \\\`name\\\` + \\\`nodes{}\\\` still works but is normalized at load time.
2. **Trace data flow**: Does the target step reference the correct source id (\\\`$.state.<id>\\\`)? Did the source step have \\\`ephemeral: true\\\` accidentally?
3. **Check runtimes**: SDK containers running? \\\`GET http://localhost:{port}/health\\\`
4. **Check Studio traces**: \\\`/__blok/runs/:id\\\` shows step-by-step inputs/outputs/errors

### Common Errors

| Error | Fix |
|-------|-----|
| \\\`Node type X not found\\\` | Wrong \\\`type\\\` in step — use module, local, or runtime.* |
| \\\`Validation failed\\\` | Zod schema mismatch — check input schema vs actual data |
| \\\`Runtime execution error\\\` | SDK container not running — check health endpoint |
| \\\`ctx.state['X'] undefined\\\` | Source step has \\\`ephemeral: true\\\`, or the id doesn't match what's referenced in \\\`$.state.<id>\\\` |
| \\\`set_var, which was removed in v0.5\\\` | Drop \\\`set_var: true\\\` (it's the default) or replace \\\`set_var: false\\\` with \\\`ephemeral: true\\\`. Run \\\`blokctl migrate workflows\\\`. |

## Generating Code

Always use \\\`defineNode()\\\`. Never class-based BlokService.

\\\`\\\`\\\`typescript
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "node-name",
  description: "What this node does",
  input: z.object({ /* Zod schema */ }),
  output: z.object({ /* Zod schema */ }),
  async execute(ctx, input) {
    return { /* must match output schema */ };
  },
});
\\\`\\\`\\\`

### Checklist:
- Zod input schema covers all inputs
- Zod output schema matches execute() return
- Node name matches workflow references
- No \\\`any\\\` types — use \\\`z.unknown()\\\` if dynamic
- \\\`export default defineNode(...)\\\`

## Worker Workflows

Worker trigger processes background jobs from a queue:

\\\`\\\`\\\`typescript
import { workflow, $ } from "@blokjs/helper";

export default workflow({
  name: "Process Job",
  version: "1.0.0",
  trigger: { worker: { queue: "background-jobs" } },
  steps: [
    { id: "process", use: "my-processor",
      inputs: { payload: $.req.body, jobId: $.req.params.jobId } },
  ],
});
\\\`\\\`\\\`

Job data: \\\`ctx.request.body\\\` = payload, \\\`ctx.request.params.queue/jobId/attempt\\\` = metadata.
Providers: \\\`in-memory\\\` (dev default), \\\`nats\\\`, \\\`bullmq\\\`, \\\`rabbitmq\\\`, \\\`sqs\\\`, \\\`kafka\\\`, \\\`redis\\\`, \\\`pg-boss\\\` — set via \\\`trigger.worker.provider\\\` or \\\`BLOK_WORKER_ADAPTER\\\`.

## Testing

\\\`\\\`\\\`typescript
import { NodeTestHarness, WorkflowTestRunner } from "@blokjs/runner";

// Unit test a node
const harness = new NodeTestHarness(myNode);
const result = await harness.execute({ input: "data" });
harness.assertSuccess(result);

// Integration test a workflow
const runner = new WorkflowTestRunner({ mockAllNodes: true });
runner.loadWorkflow(definition);
const wfResult = await runner.execute({ input: "data" });
\\\`\\\`\\\`

## Blok Studio Help

- Launch: \\\`blokctl trace\\\` or navigate to \\\`/__blok\\\`
- "No output" → Node not returning data or Zod output validation failed
- "Step error" → Expand error — check if 400 (validation) or 500 (runtime)
- "State not passing" → Source step has \\\`ephemeral: true\\\`, OR target's \\\`$.state.<id>\\\` references a non-existent step id

## Debugging Workers

- NATS not reachable → Check \\\`NATS_SERVERS\\\` env var, ensure NATS is running
- Job timeout → Increase \\\`timeout\\\` in trigger config or optimize node
- Max retries exceeded → Check node errors, job moves to DLQ

## Do NOT

- Do NOT suggest class-based BlokService for new nodes
- Do NOT generate code with \\\`any\\\` types
- Do NOT assume \\\`ctx.response.data\\\` persists across steps
- Do NOT skip Zod schemas when creating nodes
- Do NOT edit files in \\\`.blok/runtimes/\\\`
`;

const function_first_node_file = `import { defineNode } from "@blokjs/runner";
import { z } from "zod";

/**
 * A function-first node that demonstrates the modern defineNode pattern.
 * This node is type-safe, validated, and requires 60% less boilerplate.
 */
export default defineNode({
	name: "{{NODE_NAME}}",
	description: "A function-first node with Zod validation",

	// Input schema using Zod - automatically validated
	input: z.object({
		message: z.string().optional().default("Hello World"),
	}),

	// Output schema using Zod - automatically validated
	output: z.object({
		message: z.string(),
		timestamp: z.string(),
	}),

	// Execute function - type-safe with inferred types from Zod schemas
	async execute(ctx, input) {
		// Your business logic here
		// - ctx.vars: Access workflow variables
		// - ctx.request: Access HTTP request data
		// - ctx.logger: Log messages
		// - ctx.env: Access environment variables

		// Example: Store data for downstream nodes
		ctx.vars["processed-message"] = input.message;

		// Return type-safe output (validated automatically)
		return {
			message: \`Processed: \${input.message}\`,
			timestamp: new Date().toISOString(),
		};
	},
});
`;

export {
	node_file,
	package_dependencies,
	package_dev_dependencies,
	python3_file,
	examples_url,
	workflow_template,
	supervisord_nodejs,
	supervisord_python,
	go_node_file,
	go_mod_file,
	go_dockerfile,
	java_node_file,
	java_pom_file,
	java_dockerfile,
	rust_node_file,
	rust_cargo_file,
	rust_dockerfile,
	csharp_node_file,
	csharp_csproj_file,
	csharp_dockerfile,
	php_node_file,
	php_composer_file,
	php_dockerfile,
	ruby_node_file,
	ruby_gemfile,
	ruby_dockerfile,
	function_first_node_file,
	agents_md,
	claude_md,
};
