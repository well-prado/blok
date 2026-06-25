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

const python3_file = `from pydantic import BaseModel

from blok import node
from blok.types.context import Context


class Input(BaseModel):
    """Validated inputs for the {{NODE_NAME}} node."""

    name: str = "world"


class Output(BaseModel):
    message: str


@node("{{NODE_NAME}}", "Describe what {{NODE_NAME}} does")
def run(ctx: Context, input: Input) -> Output:
    # \`input\` is already validated against Input; the return is validated
    # against Output and serialized for you.
    return Output(message=f"Hello, {input.name}!")
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
10- Trigger references (NOT http): workflows/json/{cron-heartbeat,pubsub-on-order,websocket-echo}.json demonstrate the cron, pubsub, and websocket triggers — read AGENTS.md "Choosing a trigger" to pick the right one by intent instead of defaulting to HTTP.

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

// Go user-node template. A *library* package — the Go runtime discovers it
// under runtimes/go/nodes/, generates a registration shim, and serves it over
// the shared gRPC port alongside the built-in nodes (same model as Python).
// Run `blokctl dev` to load it; no per-node server or Dockerfile.
const go_node_file = `// {{NODE_NAME}} — a Blok node for the Go runtime.
package {{NODE_PKG}}

import (
	blok "github.com/nickincloud/blok-go"
)

// {{NODE_NAME_PASCAL}}Node implements blok.NodeHandler.
type {{NODE_NAME_PASCAL}}Node struct{}

// Execute runs the node. Input arrives on ctx.Request; config holds the step's
// inputs from the workflow. Return any JSON-serialisable value (or an error).
func (n *{{NODE_NAME_PASCAL}}Node) Execute(ctx *blok.Context, config map[string]interface{}) (interface{}, error) {
	name := "World"
	if body := ctx.Request.BodyMap(); body != nil {
		if v, ok := body["name"].(string); ok {
			name = v
		}
	}

	prefix := "Hello"
	if v, ok := config["prefix"].(string); ok {
		prefix = v
	}

	return map[string]interface{}{
		"message":  prefix + ", " + name + "!",
		"language": "Go",
	}, nil
}

// Register wires this node into the runtime registry. The generated
// register_user_nodes.go calls it for every node under runtimes/go/nodes.
func Register(registry *blok.NodeRegistry) {
	registry.Register("{{NODE_NAME}}", &{{NODE_NAME_PASCAL}}Node{})
}
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

const agents_md = `
# AGENTS.md — Blok Framework AI Context

Blok is a **multi-trigger, multi-runtime workflow framework**. A workflow is a declarative list of steps; each step runs a node; the runner resolves data between steps and persists state. Two facts shape everything you author here:

- **HTTP is ONE of 9 triggers, NOT the default.** Every workflow declares exactly one trigger. Picking \`http\` reflexively is the most common mistake — start with the decision table below.
- **Nodes can be written in 8 runtimes.** TypeScript runs in-process; the other 7 (\`go\`, \`rust\`, \`java\`, \`csharp\`, \`php\`, \`ruby\`, \`python3\`) run as gRPC sidecar processes. A step routes to a sidecar via \`type: "runtime.<lang>"\`.

The 9 trigger types: \`http\`, \`worker\`, \`cron\`, \`pubsub\`, \`sse\`, \`websocket\`, \`webhook\`, \`mcp\`, \`grpc\`.
The 8 runtimes: \`typescript\` (in-process), \`go\`, \`rust\`, \`java\`, \`csharp\`, \`php\`, \`ruby\`, \`python3\`.

The canonical workflow form is \`workflow({ name, version, trigger, steps })\` from \`@blokjs/helper\`. The same shape works for all 9 triggers — only the \`trigger:\` block changes.

---

## 1. CHOOSING A TRIGGER (do this first, every time)

**Before writing \`trigger: { http: ... }\`, read this table and pick by intent.**

| Intent / what you're building | Trigger | Why NOT http |
|---|---|---|
| Respond to an HTTP/REST request; JSON API; HTML page; file download | **\`http\`** | — |
| Process a background / queued / async job; offload slow work | **\`worker\`** | http blocks the caller; jobs need a queue + retries + DLQ |
| Run on a schedule / recurring time-based job (nightly, hourly, cron) | **\`cron\`** | http only fires on a request; nothing calls it on a timer |
| React to messages on a cloud topic/subscription (cross-service events) | **\`pubsub\`** | http isn't subscribed to a broker; events would be dropped |
| Stream / push live updates one-way to a browser (tokens, progress, feed) | **\`sse\`** | a plain http response is one-shot; it can't keep pushing |
| Bidirectional realtime (chat rooms, live cursors, client↔server messages) | **\`websocket\`** | http is half-duplex request/response, no server push back-channel |
| Receive a signed provider webhook (Stripe / GitHub / Slack / Shopify / Svix / custom HMAC) | **\`webhook\`** | http won't verify the HMAC signature or do replay protection |
| Expose a workflow as a tool/resource to an AI/LLM client (Cursor, Claude) | **\`mcp\`** | http isn't MCP; the client can't discover or call it as a tool |
| High-throughput typed RPC between services with a proto contract | **\`grpc\`** | http/REST overhead is too high; no typed contract |

**Tie-breakers:**
- **One-way stream → \`sse\`; two-way → \`websocket\`.** SSE is cheaper and simpler; reach for \`websocket\` only when the client must send messages back over the same connection.
- **In-process pub/sub (single Node process, HTTP+SSE chains) → the \`sse\` bus, NOT \`pubsub\`.** \`pubsub\` is the multi-process / multi-cloud sibling backed by an external broker.
- **Queue consumer → \`worker\`, never \`queue\`.** \`trigger.queue\` is **DEAD** — it has a schema but no runtime and throws at workflow construction time. Always use \`worker\` (\`{ worker: { queue: "<name>" } }\`).

### Read \`.blok/config.json\` first

The project records which triggers and runtimes were actually scaffolded in **\`.blok/config.json\`**. **Author for those — do not assume HTTP.** If the project was scaffolded with the worker trigger and the Go runtime, the user almost certainly wants a worker workflow and/or a Go node, not an HTTP endpoint. When in doubt, read that file and match the existing workflows under \`src/workflows/\`.

### Same-port vs cross-process families

- **Same-port family** — \`http\`, \`sse\`, \`websocket\`, \`webhook\`, \`mcp\` all mount on the **same Hono HTTP server / port** (default 4000) and share an in-process event bus.
- **Cross-process family** — \`worker\`, \`cron\`, \`pubsub\`, \`grpc\` each run in their **own Node process** and coordinate via external brokers / their own ports.

Regardless of kind, every trigger populates \`ctx.request.{body,headers,params,query,method}\`, so the workflow body is structurally identical across triggers — only the \`trigger:\` block differs.

---

## 2. THE 9 TRIGGERS

Each trigger below: one-line purpose, USE-WHEN / DON'T, config shape, and a canonical \`workflow({...})\` example.

### 2.1 HTTP — \`trigger: { http: {...} }\`

**Purpose:** Turn a workflow into an inbound HTTP/REST endpoint. Owns the listening server (default port 4000) that sse/websocket/webhook/mcp mount onto.

**USE WHEN:** synchronous request→response; JSON APIs; HTML UI (\`accept: "text/html"\`); file downloads. **DON'T USE FOR:** background jobs (→\`worker\`), scheduled work (→\`cron\`), broker events (→\`pubsub\`), live push (→\`sse\`/\`websocket\`), signed callbacks (→\`webhook\`).

\`\`\`ts
trigger: { http: {
  method: "GET"|"POST"|"PUT"|"DELETE"|"PATCH"|"HEAD"|"OPTIONS"|"ANY",  // required; use "ANY" not "*"
  path?: string,                       // optional; omit → derived from file path
  accept?: string,                     // default "application/json"; "text/html" for UI
  headers?: Record<string,string>,     // required-headers gate; missing → 400 before any step
  middleware?: string[],
  // shared concurrency/scheduling: concurrencyKey, concurrencyLimit, onLimit, delay, ttl, debounce
}}
\`\`\`

\`\`\`ts
import { workflow, $ } from "@blokjs/helper";

export default workflow({
  name: "Get User", version: "1.0.0",
  trigger: { http: { method: "GET", path: "/users/:id" } },
  steps: [
    { id: "lookup", use: "@blokjs/api-call",
      inputs: { url: "js/\`https://internal/users/\${ctx.request.params.id}\`" } },
    { id: "respond", use: "@blokjs/respond", inputs: { body: $.state.lookup }, ephemeral: true },
  ],
});
\`\`\`

### 2.2 WORKER — \`trigger: { worker: {...} }\`

**Purpose:** Consume background jobs from a queue, one workflow run per delivery. Runs in its own Node process. **This is the trigger to use whenever you'd reach for a queue — \`queue\` is dead.**

**USE WHEN:** offloading slow/async work; queue consumers; fan-out job processing. **DON'T USE FOR:** synchronous responses (→\`http\`); time schedules (→\`cron\`); cloud fan-out topics (→\`pubsub\`).

\`\`\`ts
trigger: { worker: {
  queue: string,                       // required — queue/topic/stream name
  provider?: "in-memory"|"nats"|"bullmq"|"kafka"|"rabbitmq"|"sqs"|"redis"|"pg-boss",  // default in-memory
  concurrency?: number,                // default 1 — concurrent jobs per process
  timeout?: number,                    // ms — per-attempt hard timeout
  retries?: number,                    // default 3 — then DLQ
  priority?: number, consumerGroup?: string, ack?: boolean,
  deadLetterQueue?: string, fromBeginning?: boolean,
  // shared concurrency/scheduling: concurrencyKey, concurrencyLimit, onLimit, delay, ttl, debounce, middleware
}}
\`\`\`

\`\`\`ts
import { workflow } from "@blokjs/helper";

export default workflow({
  name: "Process Background Job", version: "1.0.0",
  trigger: { worker: { queue: "background-jobs" } },
  steps: [
    { id: "process-job", use: "@blokjs/api-call", type: "module",
      inputs: { url: "https://example.com/process", method: "POST", body: "js/ctx.request.body" } },
  ],
});
\`\`\`

**Worker context mapping:** \`ctx.request.body\` → job payload; \`ctx.request.params.{queue,jobId,attempt}\` → job metadata; \`ctx.vars._worker_job\` → full job record. Producers enqueue with \`@blokjs/worker-publish\`. Non-\`in-memory\` providers need their client as a peer dep (\`nats\`, \`bullmq\`+\`ioredis\`, \`ioredis\`, \`@aws-sdk/client-sqs\`, \`kafkajs\`, \`amqplib\`, \`pg-boss\`).

### 2.3 CRON — \`trigger: { cron: {...} }\`

**Purpose:** Run a workflow on a time schedule (standard cron expression). Dedicated process.

**USE WHEN:** recurring/scheduled work — nightly cleanup, hourly polls, daily digests, periodic syncs. **DON'T USE FOR:** anything triggered by an external event or request.

\`\`\`ts
trigger: { cron: {
  schedule: string,        // required — "m h dom mon dow", e.g. "0 2 * * *"
  timezone?: string,       // default "UTC" — IANA tz e.g. "America/New_York"
  overlap?: boolean,       // default false — allow overlapping executions
  // also: concurrencyKey, concurrencyLimit, middleware
}}
\`\`\`

\`\`\`ts
import { workflow } from "@blokjs/helper";

export default workflow({
  name: "Daily Cleanup", version: "1.0.0",
  trigger: { cron: { schedule: "0 2 * * *", timezone: "America/New_York" } },
  steps: [
    { id: "purge-stale", use: "@blokjs/api-call",
      inputs: { url: "https://api.example.com/cleanup", method: "POST" } },
  ],
});
\`\`\`

\`ctx.request.body\` is \`{}\`; fire metadata is on \`ctx.request.params.{schedule,firedAt}\`. To serialize overlapping runs use \`concurrencyKey: "self"\`, \`concurrencyLimit: 1\`.

### 2.4 PUBSUB — \`trigger: { pubsub: {...} }\`

**Purpose:** Consume messages from a cloud/broker pub-sub topic, one run per delivery. Dedicated process. Fan-out (1:N) by default; competing-consumer (1-of-N) when \`consumerGroup\` is set.

**USE WHEN:** cross-service / multi-process event handling over a real broker (GCP Pub/Sub, AWS SNS+SQS, Azure Service Bus, NATS, Redis Streams, Kafka). **DON'T USE FOR:** in-process pub/sub for HTTP+SSE chains (→\`sse\` bus); plain job queues with competing consumers + retries (→\`worker\`).

\`\`\`ts
trigger: { pubsub: {
  provider?: "nats"|"redis-streams"|"kafka"|"gcp"|"aws"|"azure",  // default BLOK_PUBSUB_ADAPTER
  topic: string,                       // required — topic/subject/stream (wildcards ok: "orders.*.created")
  subscription?: string,               // required for gcp/aws/azure; derived from consumerGroup otherwise
  consumerGroup?: string,              // set → competing-consumer; unset → fan-out
  durable?: boolean, startFrom?: "earliest"|"latest"|{seq:number}|{timestamp:number},
  ack?: boolean,            // default true
  maxMessages?: number,     // default 10
  ackDeadline?: number,     // default 30 (s)
  deadLetterTopic?: string, filter?: string,
}}
\`\`\`

\`\`\`ts
import { workflow } from "@blokjs/helper";

export default workflow({
  name: "On Order Placed", version: "1.0.0",
  trigger: { pubsub: { provider: "gcp", topic: "orders.placed", subscription: "fulfillment-svc" } },
  steps: [
    { id: "fulfill", use: "@blokjs/api-call",
      idempotencyKey: "js/ctx.request.params.messageId",   // dedup redeliveries
      inputs: { url: "https://fulfillment.internal/api/orders", method: "POST", body: "js/ctx.request.body" } },
  ],
});
\`\`\`

\`messageId\` on \`ctx.request.params\` is the natural \`idempotencyKey\`. Provider env vars — GCP: \`GOOGLE_APPLICATION_CREDENTIALS\`+\`PUBSUB_PROJECT_ID\`; AWS: standard credential chain (\`topic\`=SNS ARN, \`subscription\`=SQS URL); Azure: \`AZURE_SERVICEBUS_CONNECTION_STRING\`.

### 2.5 SSE — \`trigger: { sse: {...} }\`

**Purpose:** One-way server→browser streaming via \`EventSource\`. Mounts on the shared HTTP port; pumps in-process bus events to connected clients.

**USE WHEN:** pushing live updates one-way — token streaming from an LLM, progress feeds, notification streams. **DON'T USE FOR:** client→server messages (→\`websocket\`); one-shot JSON responses (→\`http\`).

\`\`\`ts
trigger: { sse: {
  path?: string,                  // URL path; supports :params (e.g. "/sse/chat/:sessionId")
  events?: string[],              // default ["*"]
  channels?: string[],
  maxConnections?: number,        // default 10000
  heartbeatInterval?: number,     // default 30000 ms
  retryInterval?: number,         // default 3000 ms (browser reconnect hint)
  // also: concurrencyKey, concurrencyLimit
}}
\`\`\`

\`\`\`ts
import { workflow } from "@blokjs/helper";

export default workflow({
  name: "Clock Stream", version: "1.0.0",
  trigger: { sse: { path: "/sse/clock", heartbeatInterval: 15000 } },
  steps: [
    { id: "sub", use: "@blokjs/sse-subscribe", inputs: { channels: ["clock"] } },
    { id: "stream", use: "@blokjs/sse-stream", inputs: { source: "js/ctx.state.sub" } },
  ],
});
\`\`\`

A sibling HTTP workflow publishes via \`@blokjs/sse-publish\`; both share the in-process bus. Cross-process needs a Redis pub/sub backplane.

### 2.6 WEBSOCKET — \`trigger: { websocket: {...} }\`

**Purpose:** Bidirectional WS connections; one workflow run per inbound message/lifecycle event. Mounts on the shared HTTP port via Hono \`upgradeWebSocket\`.

**USE WHEN:** two-way realtime — chat rooms, live cursors, RPC-over-WS, server-pushed updates the client also writes to. **DON'T USE FOR:** one-way push (→\`sse\` is cheaper); request/response (→\`http\`).

\`\`\`ts
trigger: { websocket: {
  path?: string,                  // URL path; supports :params (e.g. "/ws/room/:roomId")
  events?: string[],              // default ["*"]; supported: "open"|"message"|"close"|"error"
  rooms?: string[],
  maxConnections?: number,        // default 10000
  heartbeatInterval?: number,     // default 30000 ms
  messageRateLimit?: number,      // default 100 msgs/sec/client
  // also: concurrencyKey, concurrencyLimit
}}
\`\`\`

\`\`\`ts
import { workflow } from "@blokjs/helper";

export default workflow({
  name: "WS Echo", version: "1.0.0",
  trigger: { websocket: { path: "/ws/echo", events: ["message", "open", "close"] } },
  steps: [
    { id: "reply", use: "@blokjs/ws-reply",
      inputs: { message: "js/({ echo: ctx.request.body, at: Date.now() })" } },
  ],
});
\`\`\`

Helpers: \`@blokjs/ws-reply\` (this connection), \`@blokjs/ws-broadcast\` (fan-out), \`@blokjs/ws-close\`. Cross-process broadcast needs \`BLOK_WS_BACKPLANE=redis\` + \`BLOK_WS_BACKPLANE_REDIS_URL\`.

### 2.7 WEBHOOK — \`trigger: { webhook: {...} }\`

**Purpose:** Receive signed provider POSTs, verify the HMAC signature, apply replay protection, then dispatch. Mounts on the shared HTTP port.

**USE WHEN:** receiving Stripe / GitHub / Slack / Shopify / Svix callbacks, or any HMAC-signed partner webhook via custom \`signature\`. **DON'T USE FOR:** unsigned inbound requests (→\`http\`).

\`\`\`ts
trigger: { webhook: {
  provider?: "github"|"stripe"|"slack"|"shopify"|"svix",  // pick this OR signature, not both
  path?: string,                  // defaults to /webhooks/<provider>
  secretEnv?: string,             // env var name holding the shared secret (never inline the secret)
  events?: string[],              // allowlist; out-of-scope → 200 {status:"ignored"}
  tolerance?: number,             // seconds, default 300 — clock-skew window
  idempotencyKey?: string,        // e.g. "js/ctx.request.body.id" — replay protection
  namespace?: string,             // prefix for polymorphic subworkflow dispatch
  middleware?: string[],
  signature?: {                   // custom HMAC for non-built-in providers
    scheme?: "hmac-sha256"|"hmac-sha1"|"hmac-sha512",  // default sha256
    header: string, format?: string,                   // format default "{hex}"; "{hex}"/"{base64}"
    secretEnv: string, tolerance?: number, timestampHeader?: string,
  },
}}
\`\`\`

\`\`\`ts
import { workflow } from "@blokjs/helper";

export default workflow({
  name: "Stripe Webhook", version: "1.0.0",
  trigger: { webhook: {
    provider: "stripe", namespace: "stripe",
    secretEnv: "STRIPE_WEBHOOK_SECRET", idempotencyKey: "js/ctx.request.body.id",
  }},
  steps: [
    { id: "dispatch", subworkflow: "js/ctx.request.body.type",   // "invoice.paid" → "stripe.invoice.paid"
      inputs: { stripeEvent: "js/ctx.request.body" } },
  ],
});
\`\`\`

Bad signature → 401 with a structured \`reason\`; duplicate → 200 \`{status:"duplicate"}\`; a workflow throw still returns 200 (senders shouldn't retry). \`ctx.request.rawBody\` carries the bytes the HMAC was computed against.

### 2.8 MCP — \`trigger: { mcp: {...} }\`

**Purpose:** Expose a workflow as an MCP **tool** (default) or **resource** to AI/LLM clients (Cursor, Claude Code). The tool's \`inputSchema\` is auto-generated from the workflow's Zod \`input\`. Mounts on the shared HTTP port.

**USE WHEN:** giving an LLM/agent a callable tool or readable resource backed by a workflow. **DON'T USE FOR:** plain HTTP APIs for non-MCP clients (→\`http\`).

\`\`\`ts
trigger: { mcp: {
  path?: string,                  // default "/mcp"
  serverName?: string,            // default "blok-mcp"; workflows sharing path+serverName aggregate
  serverVersion?: string,         // default "1.0.0"
  transports?: ("sse"|"streamable-http")[],  // default both
  tool?: { name?: string, description?: string },
  resource?: { uri: string, name?: string, description?: string, mimeType?: string },  // expose as resource
  middleware?: string[],
}}
\`\`\`

**Requires a workflow-level \`input:\` Zod schema** — that becomes the tool's \`inputSchema\`:

\`\`\`ts
import { workflow, $ } from "@blokjs/helper";
import { z } from "zod";

export default workflow({
  name: "search_code", version: "1.0.0",
  input: z.object({ query: z.string(), limit: z.number().optional() }),  // → tool inputSchema
  trigger: { mcp: { path: "/mcp", serverName: "my-platform",
                    tool: { description: "Full-text search the indexed code" } } },
  steps: [ { id: "search", use: "@my/search", inputs: { query: $.req.body.query } } ],
});
\`\`\`

Serves over SSE (\`GET <path>/sse\` + \`POST <path>/messages\`) and/or Streamable-HTTP (\`<path>\`).

**Connecting a client** — the server mounts on the HTTP port (default 4000). Give an MCP client the URL \`http://localhost:4000/mcp\` (Streamable-HTTP, recommended) or \`http://localhost:4000/mcp/sse\` (legacy SSE):
- **Claude Code:** \`claude mcp add --transport http blok http://localhost:4000/mcp\`
- **Cursor** (\`.cursor/mcp.json\`): \`{ "mcpServers": { "blok": { "url": "http://localhost:4000/mcp" } } }\`
- **Quick test:** \`npx @modelcontextprotocol/inspector\` → connect to \`http://localhost:4000/mcp\`

\`tools/call\` arguments arrive as \`ctx.request.body\`; the final step's \`ctx.response.data\` is returned. Identity via the \`x-user-context\` header is injection-only, NOT authorization — scope access yourself.

### 2.9 GRPC — \`trigger: { grpc: {...} }\`

**Purpose:** Expose a workflow as a gRPC service method handler — typed, contract-based RPC. Dedicated process bound to a gRPC port.

**USE WHEN:** high-throughput typed RPC between services with a proto contract; cross-language internal calls. **DON'T USE FOR:** browser-facing or REST APIs (→\`http\`); async work (→\`worker\`).

> Caveat: gRPC config is **not Zod-validated** at construction. Author against the documented surface:

\`\`\`ts
trigger: { grpc: {
  service: string,        // matches \`service Foo {}\` in the proto
  method: string,         // matches \`rpc Bar(...) returns (...)\`
  proto: string,          // path to the .proto file, relative to the workflow
  port?: number,          // default 50051; all grpc workflows share one port (env GRPC_PORT)
  middleware?: string[],
}}
\`\`\`

\`\`\`ts
import { workflow } from "@blokjs/helper";

export default workflow({
  name: "GetUser", version: "1.0.0",
  trigger: { grpc: { service: "UserService", method: "GetUser", proto: "users.proto" } },
  steps: [
    { id: "lookup", use: "@blokjs/api-call",
      inputs: { url: "js/\`https://internal/users/\${ctx.request.body.userId}\`", method: "GET" } },
  ],
});
\`\`\`

The request decodes into \`ctx.request.body\`; the final step output becomes the gRPC reply. Streaming RPCs use \`@blokjs/grpc-stream\`.

> **\`trigger.queue\` is DEAD** — it has a schema but no runtime and throws at workflow construction. Use \`worker\`. **\`manual\`** has no listener (invoked programmatically only — tests / sub-workflows); not for normal authoring.

---

## 3. AUTHORING WORKFLOWS (v2 DSL)

Import from \`@blokjs/helper\`: \`{ workflow, $, branch, switchOn, forEach, loop, tryCatch }\`. The default export is \`workflow({...})\` — a single object literal, no chaining, no separate \`nodes{}\` map.

\`\`\`ts
import { workflow, $ } from "@blokjs/helper";

export default workflow({
  name: "Process Order",      // >= 3 chars
  version: "1.0.0",            // semver x.x.x (>= 5 chars)
  trigger: { http: { method: "POST", path: "/orders" } },  // path optional → derived from file path
  steps: [
    { id: "validate", use: "order-validator", inputs: { order: $.req.body } },
    { id: "save",     use: "order-store",     inputs: { data: $.state.validate } },
  ],
});
\`\`\`

A regular step is \`{ id, use, inputs }\`. \`id\` is required and unique workflow-wide. \`use\` is the node reference. \`type\` is inferred from \`use\` (in-process \`module\` by default; \`runtime.*\` must be set explicitly).

### The four context reads

| Read | Resolves to | Scope |
|---|---|---|
| \`$.state.<id>\` | A prior step's stored output | Whole workflow (cross-step) |
| \`$.prev\` | Immediately previous step's output | Adjacent only — overwritten every step |
| \`$.req\` | Request envelope (body/headers/params/query/method/url) | Whole run |
| \`$.error\` | Captured error inside a \`tryCatch.catch\` block | \`catch\` arm only — \`undefined\` elsewhere |

\`$.error\` exposes \`.message\`, \`.name\`, \`.stack\`, \`.code\` (upstream HTTP status), and \`.stepId\`. The \`$\` proxy compiles to \`"js/ctx.<path>"\` strings at definition time — in JSON workflows write those strings by hand (\`"$.state.fetch"\` or \`"js/ctx.state.fetch"\`). Legacy aliases still resolve: \`$.request\`=\`$.req\`, \`$.response\`=\`$.prev\`, \`$.vars\`=\`$.state\` — prefer the canonical four.

### Persistence knobs (per-step, declarative)

| Knob | Effect |
|---|---|
| *(none)* | Store at \`ctx.state[id]\` (the 95% case) |
| \`as: "name"\` | Store at \`ctx.state[name]\` instead of \`ctx.state[id]\` |
| \`spread: true\` | Shallow-merge \`result.data\`'s top-level keys into \`ctx.state\` (multi-output nodes). Mutually exclusive with \`as\` |
| \`ephemeral: true\` | Skip storage — only \`$.prev\` carries it to the next step (logging, audit) |

**Every step's output auto-persists to \`ctx.state[id]\` — but ONLY on success.** A step that throws writes nothing, so \`ctx.state[<id>] === undefined\` is a truthful "did this step succeed?" check inside a \`tryCatch.catch\` arm.

### Control-flow primitives

**\`branch({when, then, else})\`** — \`when\` is a JS-expression *string* (the \`$\` proxy can't intercept \`===\`):

\`\`\`ts
branch({ id: "route",
  when: '$.req.method === "POST"',
  then: [{ id: "create", use: "...", inputs: {...} }],
  else: [{ id: "read",   use: "...", inputs: {...} }] })
\`\`\`

**\`switchOn({id, on, cases, default?})\`** — N-way branch, first match wins. \`when\` may be a scalar (\`on === when\`) or an array (\`array.includes(on)\`):

\`\`\`ts
switchOn({ id: "route-by-event", on: $.req.headers["x-github-event"],
  cases: [
    { when: "push",                        do: [{ id: "h1", subworkflow: "handle-push" }] },
    { when: ["pull_request", "pr_review"], do: [{ id: "h2", subworkflow: "handle-pr" }] },
  ],
  default: [{ id: "log", use: "@blokjs/log", inputs: { message: "unknown" } }] })
\`\`\`

**\`forEach({id, in, as, do, mode?, concurrency?})\`** — iterate a collection. Each iteration sets \`ctx.state[as]\` = item and \`ctx.state[<as>Index]\` = i; the loop's own slot \`$.state[<id>]\` is the array of each iteration's last-step output. \`mode: "parallel"\` runs with bounded \`concurrency\` (default 10):

\`\`\`ts
forEach({ id: "process-items", in: $.req.body.items, as: "item",
  mode: "parallel", concurrency: 5,
  do: [{ id: "reserve", use: "inventory-reserve", inputs: { sku: $.state.item.sku } }] })
\`\`\`

**\`loop({id, while, do, maxIterations?})\`** — while-loop, hard cap default 1000.
**\`tryCatch({id, try, catch, finally?})\`** — \`catch\` sees \`$.error\`; errors in \`catch\` propagate (don't re-trigger \`catch\`); \`finally\` runs unconditionally.
**\`{ id, wait: { for: "3d" } | { until: <date> } }\`** — durable pause; cannot combine with \`idempotencyKey\` or \`retry\`.

### Caching, retry, sub-workflows (per-step)

\`\`\`ts
{ id: "fetch", use: "@blokjs/api-call", inputs: { url: "..." },
  idempotencyKey: $.req.body.requestId,   // cache by (workflow, step.id, key); default TTL 24h
  retry: { maxAttempts: 3, minTimeoutInMs: 500, maxTimeoutInMs: 10000, factor: 2 },
  maxDuration: "30s" }                     // per-attempt timeout; final-attempt timeout → run "timedOut"
\`\`\`

A cache hit replays the cached result through the same \`ephemeral\`/\`spread\`/\`as\` rules and skips the node entirely. Override TTL with \`idempotencyKeyTTL: <ms>\` (0 = disabled). Default \`maxAttempts: 1\` = no retry.

**Sub-workflow as a step:**

\`\`\`ts
{ id: "send-receipt", subworkflow: "send-receipt-email",
  inputs: { user: $.state.user },   // becomes child's ctx.request.body (read via $.req.body)
  wait: true }                       // default: parent blocks, child response lands at state[id]
\`\`\`

\`wait: false\` = fire-and-forget, returns \`{runId, workflowName, scheduledAt}\`. \`subworkflow:\` also accepts a \`$.<path>\`/\`js/...\` expression for polymorphic dispatch — pair with \`allowList: [...]\` whenever it depends on caller data. Recursion capped at 10 (\`BLOK_MAX_SUBWORKFLOW_DEPTH\`).

### JSON workflows

JSON mirrors the TS DSL one-for-one. Reference earlier outputs as \`"$.state.<id>"\` strings; use \`"ANY"\` for the wildcard method; a branch is one step with \`branch: { when, then, else }\`. JSON workflows live under \`src/workflows/json/\` (scanned recursively).

---

## 4. TRIGGER-LEVEL OPTIONS (across kinds)

These live on the **trigger config**, never on a step. They gate workflow entry.

**Per-key concurrency gating** — \`concurrencyKey\` (+ optional \`concurrencyLimit\` default 1, \`onLimit: "throw"|"queue"\`):

\`\`\`ts
trigger: { http: { method: "POST", path: "/render",
  concurrencyKey: $.req.body.tenantId, concurrencyLimit: 5, onLimit: "queue" } }
\`\`\`

\`concurrencyLimit\`/\`onLimit\`/\`concurrencyLeaseMs\` all require \`concurrencyKey\`. Denial → HTTP 429 + \`Retry-After\` (or 202 with \`onLimit: "queue"\`).

**Scheduling** — \`delay\`, \`ttl\`, \`debounce\`. Durations are a number (ms) or a unit string (\`"500ms"\`,\`"30s"\`,\`"5m"\`,\`"2h"\`,\`"1d"\`):

\`\`\`ts
trigger: { http: { method: "POST", path: "/welcome", delay: "1h", ttl: "2h" } }
trigger: { http: { method: "POST", path: "/save/:docId",
  debounce: { key: $.req.params.docId, mode: "trailing", delay: "500ms", maxDelay: "5s" } } }
\`\`\`

For HTTP, \`ttl\` requires \`delay\`. Debounce modes: \`trailing\` (default — fire after silence) / \`leading\` (fire first, suppress follow-ups).

**Middleware** — two forms:

1. *Trigger-level chain* — ordered middleware-workflow names, run before the body on the same ctx:
   \`\`\`ts
   trigger: { http: { method: "GET", middleware: ["auth-check", "request-id"] } }
   \`\`\`
2. *Defining a middleware workflow* — \`workflow({ middleware: true })\`. \`trigger\` becomes optional; it gets no public route and is referenced by \`name\`:
   \`\`\`ts
   export default workflow({ name: "auth-check", version: "1.0.0", middleware: true,
     steps: [ /* sets ctx.state.identity; may stop:true to short-circuit */ ] });
   \`\`\`

Process-global middleware: \`WorkflowRegistry.getInstance().setGlobalMiddleware([...])\` or \`BLOK_GLOBAL_MIDDLEWARE=a,b\`.

---

## 5. AUTHORING NODES

### 5.1 defineNode (TypeScript, in-process)

Always \`export default defineNode(...)\`. Never class-based \`BlokService\`. Zod input/output are mandatory.

\`\`\`ts
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "fetch-user",
  description: "Fetches a user by ID",
  input:  z.object({ userId: z.string().uuid() }),                 // validated BEFORE execute
  output: z.object({ user: z.object({ id: z.string(), name: z.string() }) }),  // validated AFTER
  async execute(ctx, input) {
    const user = await fetchUser(input.userId);                    // input is type-safe
    return { user };                                               // MUST match the output schema
  },
});
\`\`\`

- **Errors:** input failure → \`GlobalError\` code **400**; a plain \`Error\` thrown in \`execute\` → code **500**; a \`GlobalError\` you throw is preserved verbatim (custom codes like 401 survive).
- **Never write \`ctx.state\` from a node** — return your output and let the runner persist it. For a genuine side-channel value, use \`ctx.publish(name, value)\`.
- No \`any\` types — use \`z.unknown()\` and narrow.
- \`flow: true\` nodes return \`NodeBase[]\`; \`contentType: "text/html"\` sets the response Content-Type.

TypeScript nodes live in \`src/nodes/\` and are referenced by \`use: "<name>"\` (no \`type\` needed — \`module\` is the default).

### 5.2 Nodes in other runtimes (gRPC sidecars)

The 7 non-TS runtimes run as long-lived gRPC sidecar processes; the TypeScript runner is the client. A step routes to a sidecar with **\`type: "runtime.<lang>"\`** and \`use:\` = the registered node name. The step's resolved \`inputs\` arrive as the node's config / typed input (NOT \`ctx.request.body\` — that holds the original trigger payload). The node's return value lands in \`ctx.state[<step-id>]\`.

**Runtime nodes live in \`runtimes/<lang>/nodes/\`** and require that runtime to be scaffolded. Add a runtime with \`blokctl runtime add <lang>\` (or \`blokctl create <project> --runtimes go,python3,...\` at create time). Scaffold a node with \`blokctl create node <name> --runtime <lang>\`. Across all runtimes:

- The runner speaks **gRPC only** (the legacy HTTP \`/execute\` path was removed in v0.5).
- gRPC dispatch port = legacy HTTP port + 1000. **Dispatch ports:** go \`10001\`, rust \`10002\`, java \`10003\`, csharp \`10004\`, php \`10005\`, ruby \`10006\`, python3 \`10007\`. (Readiness/health HTTP ports are the legacy \`9001\`–\`9007\`; the CLI readiness check is a **TCP connect to the gRPC port**, not \`GET /health\`.)
- \`blokctl dev\` sets \`BLOK_TRANSPORT=grpc\` + \`GRPC_PORT\` for each sidecar. Most SDKs default to HTTP transport if you launch them by hand — always let \`blokctl dev\` (or the env) set gRPC, or the runner can't reach the node.
- Generated proto stubs ship with each SDK — you do **not** regenerate them to author a node.
- Each SDK has a **typed** contract (the equivalent of \`defineNode\` — validated input, typed output, reflected JSON Schema) and a lower-level untyped contract. **Prefer the typed contract.** Bad input auto-fails with \`NODE_INPUT_VALIDATION\` / HTTP 400 before your code runs.
- gRPC message cap defaults to 16 MiB (\`BLOK_GRPC_MAX_MESSAGE_BYTES\`).
- Don't edit \`.blok/runtimes/\` — those are generated copies.

The workflow step is identical regardless of runtime — only \`type\` changes:

\`\`\`ts
{ id: "sum", use: "add-numbers", type: "runtime.<lang>", inputs: { a: $.req.body.a, b: $.req.body.b } }
\`\`\`

#### Authoring a node in go

\`runtimes/go/nodes/addnumbers.go\` — typed via \`blok.DefineNode\`:

\`\`\`go
package nodes

import blok "github.com/nickincloud/blok-go"

type AddNumbersInput struct {
    A int \`json:"a"\`
    B int \`json:"b"\`
}
type AddNumbersOutput struct {
    Sum int \`json:"sum"\`
}

const AddNumbersNodeName = "add-numbers"

var AddNumbersNode = blok.DefineNode(AddNumbersNodeName, "Adds two integers",
    func(_ *blok.Context, in AddNumbersInput) (AddNumbersOutput, error) {
        return AddNumbersOutput{Sum: in.A + in.B}, nil
    })
\`\`\`

Register in \`runtimes/go/cmd/server/main.go\`:

\`\`\`go
func main() {
    registry := blok.NewNodeRegistry()
    registry.Register(nodes.AddNumbersNodeName, nodes.AddNumbersNode)
    registry.Use(blok.RecoveryMiddleware(), blok.LoggingMiddleware(blok.NewLogger(blok.LogLevelInfo)))
    if err := blok.ListenAndServe(registry); err != nil { log.Fatalf("Server error: %v", err) }
}
\`\`\`

Workflow step: \`{ id: "sum", use: "add-numbers", type: "runtime.go", inputs: { a: $.req.body.a, b: $.req.body.b } }\`. Errors: return a non-nil \`error\`, or use \`blok.NewValidationError\` / \`blok.NewError(category)...Build()\` for structured \`BlokError\`. Toolchain: Go 1.24+, \`go mod download\`, \`go run ./cmd/server\`.

#### Authoring a node in rust

\`runtimes/rust/nodes/add-numbers/src/main.rs\` — typed via the \`TypedNode\` trait:

\`\`\`rust
use async_trait::async_trait;
use blok::{BlokError, Context, NodeRegistry, TypedNode};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, JsonSchema)]
struct AddInput { a: f64, b: f64 }

#[derive(Serialize, JsonSchema)]
struct AddOutput { sum: f64 }

struct AddNumbers;

#[async_trait]
impl TypedNode for AddNumbers {
    type Input = AddInput;
    type Output = AddOutput;
    fn name(&self) -> &str { "add-numbers" }
    fn description(&self) -> &str { "Adds two numbers" }
    async fn run(&self, _ctx: &mut Context, input: AddInput) -> Result<AddOutput, BlokError> {
        Ok(AddOutput { sum: input.a + input.b })
    }
}

#[tokio::main]
async fn main() {
    let mut registry = NodeRegistry::new("1.0.0");
    registry.register_typed(AddNumbers);   // typed nodes register via register_typed
    blok::server::serve(registry, 9002).await.unwrap();
}
\`\`\`

Workflow step: \`type: "runtime.rust"\`. \`Input\`/\`Output\` must derive \`serde\` + \`schemars::JsonSchema\`. Errors: \`BlokError::validation()/.dependency()/...build()\`. Toolchain: \`cargo build --release\` / \`cargo run\`; gRPC is feature-gated — build with the \`grpc\` feature (or \`--features full\`) so the runner can dispatch.

#### Authoring a node in java

\`runtimes/java/src/main/java/com/blok/blok/nodes/AddNumbersNode.java\` — typed via \`TypedNode<I, O>\`:

\`\`\`java
package com.blok.blok.nodes;

import com.blok.blok.node.TypedNode;
import com.blok.blok.types.Context;

public final class AddNumbersNode extends TypedNode<AddNumbersNode.Input, AddNumbersNode.Output> {
    public record Input(int a, int b) {}
    public record Output(int sum) {}

    @Override public String name() { return "add-numbers"; }
    @Override public String description() { return "Adds two integers"; }
    @Override protected Class<Input> inputClass() { return Input.class; }
    @Override protected Class<?> outputClass() { return Output.class; }

    @Override protected Output run(Context ctx, Input input) {
        return new Output(input.a() + input.b());
    }
}
\`\`\`

Register in \`runtimes/java/src/main/java/com/blok/blok/Main.java\`:

\`\`\`java
NodeRegistry registry = new NodeRegistry();
registry.register("add-numbers", new com.blok.blok.nodes.AddNumbersNode());
registry.use(new RecoveryMiddleware());
registry.use(new LoggingMiddleware(logger));
\`\`\`

Workflow step: \`type: "runtime.java"\`. Errors: \`throw BlokError.validation().code(...).message(...).build();\`. Primitive record components (\`int\`, \`boolean\`) are required in the reflected schema; boxed types are optional. Toolchain: JDK 17+ and Maven, \`mvn package -q -DskipTests\`, \`java -jar target/blok-java-1.0.0.jar\`.

#### Authoring a node in csharp

\`runtimes/csharp/Nodes/AddNumbersNode.cs\` — typed via \`TypedNode<TInput, TOutput>\`:

\`\`\`csharp
using System.ComponentModel.DataAnnotations;
using Blok.Core.Node;
using Blok.Core.Types;

namespace Blok.Runtime.Nodes;

public sealed record AddNumbersInput([property: Required] double A, [property: Required] double B);
public sealed record AddNumbersOutput(double Sum);

public sealed class AddNumbersNode : TypedNode<AddNumbersInput, AddNumbersOutput>
{
    public override string Name => "add-numbers";
    public override string Description => "Adds two numbers";
    public override Task<AddNumbersOutput> RunAsync(Context ctx, AddNumbersInput input)
        => Task.FromResult(new AddNumbersOutput(input.A + input.B));
}
\`\`\`

Register in \`runtimes/csharp/Program.cs\`:

\`\`\`csharp
var config = ServerConfig.FromEnv();
var registry = new NodeRegistry(config.Version);
registry.Register("add-numbers", new AddNumbersNode());
await RuntimeServer.Run(registry, config);
\`\`\`

Workflow step: \`type: "runtime.csharp"\`. The wire is **camelCase** (\`{ "a": 2, "b": 3 }\` maps to \`A\`/\`B\`). Errors: \`throw BlokError\`. Toolchain: .NET 8.0+, \`dotnet restore\`, \`dotnet run\`.

#### Authoring a node in php

\`runtimes/php/nodes/add-numbers/src/Nodes/AddNumbersNode.php\` — typed via \`TypedNode\` (or plain \`NodeHandler\`):

\`\`\`php
<?php
declare(strict_types=1);
namespace Blok\\Nodes;

use Blok\\Blok\\Node\\TypedNode;
use Blok\\Blok\\Types\\Context;

final class AddNumbersInput
{
    public function __construct(public int $a, public int $b) {}
}

final class AddNumbersNode extends TypedNode
{
    public function name(): string         { return 'add-numbers'; }
    public function description(): string   { return 'Adds two integers'; }
    protected function inputClass(): string { return AddNumbersInput::class; }

    protected function run(Context $ctx, object $input): mixed
    {
        /** @var AddNumbersInput $input */
        return ['sum' => $input->a + $input->b];
    }
}
\`\`\`

Register in \`runtimes/php/bin/serve.php\`:

\`\`\`php
$config   = ServerConfig::fromEnv();
$registry = new NodeRegistry($config->version);
$registry->register('add-numbers', new AddNumbersNode());
// ... wire $registry into BlokNodeRuntimeService + RoadRunner GrpcServer and $server->serve();
\`\`\`

Workflow step: \`type: "runtime.php"\`. The gRPC server is RoadRunner (\`rr serve -c .rr.yaml\`), which \`blokctl dev\` runs. Imports are \`Blok\\Blok\\Node\\NodeHandler\` and \`Blok\\Blok\\Types\\Context\`. Toolchain: PHP 8.2+, Composer, RoadRunner; \`composer install\`.

#### Authoring a node in ruby

\`runtimes/ruby/nodes/add_numbers_node.rb\` — typed via \`Blok::Node::TypedNode\`:

\`\`\`ruby
# frozen_string_literal: true
require "blok"

class AddNumbersNode < Blok::Node::TypedNode
  node_name "add-numbers"
  description "Adds two numbers and returns their sum"

  input do
    field :a, :number, required: true
    field :b, :number, required: true
  end
  output { field :sum, :number }

  def run(_ctx, input)
    { "sum" => input[:a] + input[:b] }   # string-keyed Hash is idiomatic
  end
end
\`\`\`

Register in \`runtimes/ruby/bin/serve.rb\`:

\`\`\`ruby
require_relative "../nodes/add_numbers_node"

config   = Blok::Config::ServerConfig.from_env
registry = Blok::Node::NodeRegistry.new(config.version)
registry.register("add-numbers", AddNumbersNode.new)   # name MUST equal node_name
registry.use(Blok::Middleware::RecoveryMiddleware.new)
# serve.rb routes to start_grpc under BLOK_TRANSPORT=grpc
\`\`\`

Workflow step: \`type: "runtime.ruby"\`. Field types: \`:string, :integer, :number, :boolean, :array, :object\`. Errors: \`raise Blok::Errors::BlokError.validation(...)\`. Toolchain: Ruby 3.2+, Bundler; \`bundle install\`.

#### Authoring a node in python3

\`runtimes/python3/nodes/add_numbers/node.py\` — typed via the \`@node\` decorator (Pydantic):

\`\`\`python
from __future__ import annotations
from pydantic import BaseModel, Field
from blok import node, Context


class AddNumbersInput(BaseModel):
    a: float
    b: float = Field(0)


class AddNumbersOutput(BaseModel):
    sum: float


@node("add-numbers", "Adds two numbers and returns their sum")
def add_numbers(ctx: Context, input: AddNumbersInput) -> AddNumbersOutput:
    return AddNumbersOutput(sum=input.a + input.b)
\`\`\`

Registration is **manual** — importing the module runs the \`@node\` decorator; then flush with \`register_decorated\`. In \`runtimes/python3/nodes/__init__.py\`:

\`\`\`python
from blok import register_decorated
from . import add_numbers  # noqa: F401  (runs the @node decorator)

def register_project_nodes(registry):
    return register_decorated(registry)
\`\`\`

…and call \`register_project_nodes(registry)\` from the boot path (after the SDK's \`register_all(registry)\`). Workflow step: \`type: "runtime.python3"\`; \`use:\` must match the **string in \`@node("name", ...)\`**, not the function name. Errors: \`raise BlokError.validation(...)\` (or \`.dependency\`, \`.not_found\`, …). Toolchain: Python 3, \`pip3 install -r requirements.txt\`; \`@node\` requires \`pydantic\`.

> The legacy \`BlokService\` / \`async def handle()\` / \`from core.blok import BlokService\` Python shape **does not exist** in this SDK — ignore any example that uses it. Use \`@node\` (or the \`NodeHandler\` ABC).

---

## 6. RUNNING LOCALLY / INFRA

\`\`\`bash
blokctl dev          # full dev server: spawns selected runtimes + the runner
blokctl create node <name> --runtime <lang>   # scaffold a node (ts default; pass --runtime for sidecars)
blokctl runtime add <lang>                     # add a non-TS runtime to an existing project
blokctl trace        # open Blok Studio (run traces at /__blok)
\`\`\`

The \`http\`/\`sse\`/\`websocket\`/\`webhook\`/\`mcp\` triggers need no external infra — they share the HTTP server. The cross-process triggers (\`worker\`, \`pubsub\`) need a broker.

**For worker/pubsub, start the broker stack** with the dev compose (Redis + NATS + Postgres/Adminer):

\`\`\`bash
cd infra/development && docker compose up -d nats      # or: redis redis-commander
\`\`\`

The default worker adapter is \`in-memory\` (zero infra) — only start a broker when you set a real provider (\`nats\`, \`redis\`, \`bullmq\`, …). Monitoring UIs from the dev compose: Adminer \`:8080\`, Redis Commander \`:8081\`, NATS monitor \`:8222\`. The compose declares an external \`shared-network\` — if the first run fails, run \`docker network create shared-network\`.

**For Kafka / RabbitMQ / SQS / GCP-Pub/Sub emulators**, use \`infra/testing/docker-compose.yml\` instead — those brokers are wired there on non-standard ports with emulators, matching the provider env blocks the scaffold writes.

---

## 7. FOOTGUN LIST (read before authoring)

1. **Never reuse a step \`id\`** — anywhere, including across mutually-exclusive \`switch\`/\`branch\`/\`tryCatch\` arms. All ids share one flat per-workflow config map; duplicates collide (last definition wins) and the matched arm silently runs with the *other* arm's inputs. If two arms must write the same downstream key, give them distinct ids and use \`as: "shared"\`.
2. **Don't prefix \`@blokjs/expr\`'s \`expression\` input with \`js/\`** — that input is itself mapper-resolved, so \`js/...\` double-evaluates. Write plain JS: \`expression: "ctx.state.x.y"\`.
3. **\`set_var\` was removed in v0.5** — the runner throws at load time if present. Drop \`set_var: true\` (default-store handles it); replace \`set_var: false\` with \`ephemeral: true\`.
4. **Use \`"ANY"\`, not \`"*"\`, for the wildcard HTTP method** — \`"*"\` is accepted but warns and is auto-normalized.
5. **\`trigger.queue\` is rejected at construction** — it has no runtime and would silently never run. Use \`trigger.worker\` (\`{ worker: { queue: "<name>" } }\`).
6. **Workflow envelope minimums:** \`name\` >= 3 chars, \`version\` >= 5 chars (semver), \`steps\` must be non-empty, and a \`trigger\` is required unless \`middleware: true\`.
7. **Every v2 step schema is \`.strict()\`** — a misspelled or unknown field throws at load time, not silently dropped. A trigger-only field placed on a step (\`concurrencyKey\`, \`delay\`, \`ttl\`, \`debounce\`, \`concurrencyLimit\`) gets a targeted error pointing you to the trigger config.
8. **\`as\` and \`spread\` are mutually exclusive** — pick one.
9. **\`$.prev\` is volatile** (only the previous step). For any non-adjacent read use \`$.state.<id>\`. Reading \`$.state.<id>\` for a step that set \`ephemeral: true\` returns \`undefined\`.
10. **Sub-workflow \`idempotencyKey\` with \`wait: true\` caches the WHOLE child result** — a cache hit means the child (and its side effects: emails, charges) never runs. Headline pattern AND primary footgun.

Plus the cross-runtime rules: **the wrong input source** (typed sidecar nodes read their step \`inputs\`, NOT \`ctx.request.body\`), **registration is explicit** for every runtime (a file in \`runtimes/<lang>/nodes/\` does nothing until you register it by name), and **\`type: "runtime.<lang>"\` is required** on the step or it defaults to the in-process TS path and fails with \`Node type X not found\`.

**Production env knob worth naming:** \`BLOK_MAPPER_MODE=strict\` — fail-fast on \`js/...\` input resolution errors instead of silently passing the literal string through. Strongly recommended for production.

---

## 8. TESTING

Use the \`@blokjs/runner\` testing utilities with Vitest.

**Unit-test a node** with \`NodeTestHarness\`:

\`\`\`ts
import { NodeTestHarness } from "@blokjs/runner";
import myNode from "../src/nodes/my-node";

const harness = new NodeTestHarness(myNode);
const result = await harness.execute({ userId: "abc-123" });
harness.assertSuccess(result);
harness.assertOutput(result, { user: { id: "abc-123" } });
\`\`\`

**Integration-test a workflow** with \`WorkflowTestRunner\`:

\`\`\`ts
import { WorkflowTestRunner } from "@blokjs/runner";

const runner = new WorkflowTestRunner({ verbose: true, mockAllNodes: true });
runner.registerNode("validate", ValidateNode);
runner.mockNode("external-api", async (input) => ({ result: "mocked" }));
runner.loadWorkflow(myWorkflowDefinition);
const result = await runner.execute({ input: "data" });
expect(result.success).toBe(true);
\`\`\`

---

## Do / Do NOT

**Do:**
- Read \`.blok/config.json\` and existing \`src/workflows/\` to learn which triggers + runtimes this project uses; author for those.
- Start every workflow from the **trigger decision table** in §1, not from HTTP.
- Use \`workflow({ name, version, trigger, steps })\` from \`@blokjs/helper\`.
- Use the typed node contract in every runtime (\`defineNode\` / \`DefineNode\` / \`TypedNode\` / \`@node\`).
- Reference cross-step outputs with \`$.state.<id>\`; use \`as:\`/\`spread:\`/\`ephemeral:\` to shape persistence.
- Set \`type: "runtime.<lang>"\` on every sidecar step and register the node by name.

**Do NOT:**
- Default to the HTTP trigger because it's familiar — pick by intent.
- Emit \`trigger.queue\` — it throws; use \`worker\`.
- Use \`"*"\` for the wildcard method (use \`"ANY"\`), or \`set_var\` (removed in v0.5).
- Write class-based \`BlokService\` nodes, or the stale Python \`BlokService\`/\`async def handle()\` shape.
- Write to \`ctx.state\` inside a node — return your output (or \`ctx.publish(...)\` for a side-channel value).
- Reuse a step \`id\`, combine \`as\` + \`spread\`, or use \`any\` types.
- Read a typed sidecar node's data from \`ctx.request.body\` — read the step \`inputs\` / typed input.
- Edit files under \`.blok/runtimes/\` — they are generated.
`;

const claude_md = `
# Blok — Claude Code Quick Reference

This is the **terse operational quick-reference**. For full architecture, every trigger's complete config + examples, and the per-runtime node templates, **read \`AGENTS.md\`** in this project root.

## Quick Commands

\`\`\`bash
blokctl dev                              # Full dev server (spawns trigger runtimes + runner)
blokctl create workflow <name>           # Scaffold a workflow
blokctl create node <name>               # Scaffold a TS node
blokctl create node <name> --runtime go  # Scaffold a node in another runtime (go|rust|java|csharp|php|ruby|python3)
blokctl trace                            # Open Blok Studio (or visit /__blok on the running trigger)
\`\`\`

---

## 1. Pick the right trigger FIRST (do NOT default to HTTP)

Blok has **9 trigger kinds**. HTTP is **one of nine**, not the default — it is correct only for synchronous request/response. Every workflow declares exactly **one** trigger.

**Before writing any workflow:** read **\`.blok/config.json\`** to see which triggers and runtimes this project actually scaffolded, and author for those. If the project is a \`worker\`/\`cron\`/\`pubsub\` project, do not write an HTTP workflow. Match the installed triggers.

### Trigger Decision Table — choose by intent

| What you're building | Trigger |
|---|---|
| Respond to an HTTP/REST request; JSON API; HTML page; file download | **\`http\`** |
| Process a background / queued / async job; offload slow work | **\`worker\`** |
| Run on a schedule / recurring time-based job (nightly, hourly) | **\`cron\`** |
| React to messages on a cloud topic/subscription (cross-service events) | **\`pubsub\`** |
| Stream live updates one-way to a browser (tokens, progress, feed) | **\`sse\`** |
| Bidirectional realtime (chat, live cursors, client↔server messages) | **\`websocket\`** |
| Receive a signed provider webhook (Stripe / GitHub / Slack / Shopify / Svix) | **\`webhook\`** |
| Expose a workflow as a tool/resource to an AI/LLM client (Cursor, Claude) | **\`mcp\`** |
| High-throughput typed RPC between services with a \`.proto\` contract | **\`grpc\`** |

Tie-breakers: one-way stream → \`sse\`; two-way → \`websocket\`. In-process pub/sub (single Node process, HTTP+SSE) → \`sse\` bus, not \`pubsub\`. Queue consumer → **\`worker\`** (the \`queue\` kind is dead — it throws at construction; never emit \`trigger: { queue: ... }\`).

\`http\`, \`sse\`, \`websocket\`, \`webhook\`, \`mcp\` share one Hono port. \`worker\`, \`cron\`, \`pubsub\`, \`grpc\` run in their own processes. Regardless of kind, the body reads \`ctx.request.{body,headers,params,query,method}\` identically — only the \`trigger:\` block changes. See \`AGENTS.md\` for each kind's full config + a runnable example.

---

## 2. Context & State (v2)

**Every step's output auto-persists to \`ctx.state[id]\` — on success only.** A step that errors writes nothing, so \`ctx.state[<id>] === undefined\` is a truthful "did it succeed?" check inside a \`tryCatch.catch\` arm.

**The four reads** (the \`$\` proxy compiles to \`"js/ctx.<path>"\` strings; in JSON write those strings by hand):

| Read | Resolves to | Scope |
|---|---|---|
| \`$.state.<id>\` | A prior step's stored output | Whole workflow (cross-step) |
| \`$.prev\` | Immediately previous step's output | Adjacent only — overwritten every step |
| \`$.req\` | Request envelope (body/headers/params/query/method) | Whole run |
| \`$.error\` | Captured error (\`.message\`/\`.code\`/\`.stepId\`) | \`tryCatch.catch\` arm only |

**Persistence knobs (per-step):**

| Knob | Effect |
|---|---|
| *(none)* | Store at \`ctx.state[id]\` (the 95% case) |
| \`as: "name"\` | Store at \`ctx.state[name]\` instead. Mutually exclusive with \`spread\` |
| \`spread: true\` | Shallow-merge \`result.data\`'s keys into \`ctx.state\` (multi-output nodes) |
| \`ephemeral: true\` | Skip storage; only \`$.prev\` carries it to the next step (logging/audit) |

Per-step reliability lives on the step: \`idempotencyKey\` (cache by \`(workflow, step.id, key)\`, default 24h TTL), \`retry: { maxAttempts, minTimeoutInMs?, factor? }\`, \`maxDuration: "30s"\`. Cross-key gating + scheduling (\`concurrencyKey\`, \`onLimit\`, \`delay\`, \`ttl\`, \`debounce\`, \`middleware\`) go on the **trigger block**, never on a step.

---

## 3. Generating Nodes

Always \`export default defineNode(...)\` (TS) — never class-based \`BlokService\`. Zod input/output are mandatory. Never write \`ctx.state\` from a node — return your output and let the runner persist it (use \`ctx.publish(name, value)\` for a true side-channel). No \`any\` types — use \`z.unknown()\`.

\`\`\`typescript
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "fetch-user",
  description: "Fetches a user by ID",
  input:  z.object({ userId: z.string().uuid() }),                    // validated BEFORE execute → 400 on fail
  output: z.object({ user: z.object({ id: z.string(), name: z.string() }) }), // validated AFTER → 500 on fail
  async execute(ctx, input) {
    const user = await fetchUser(input.userId);  // input is type-safe
    return { user };                             // MUST match the output schema
  },
});
\`\`\`

### Nodes in other runtimes

A non-TS node runs in a per-language sidecar and is referenced from a step with \`type: "runtime.<lang>"\` + \`use: "<node name>"\`. Scaffold one with \`blokctl create node <name> --runtime <lang>\`. **Full, copy-pasteable per-runtime node templates are in \`AGENTS.md\`.** Nodes live under \`runtimes/<lang>/nodes/\`.

| Runtime | Step \`type\` | gRPC port |
|---|---|---|
| Go | \`runtime.go\` | 10001 |
| Rust | \`runtime.rust\` | 10002 |
| Java | \`runtime.java\` | 10003 |
| C# | \`runtime.csharp\` | 10004 |
| PHP | \`runtime.php\` | 10005 |
| Ruby | \`runtime.ruby\` | 10006 |
| Python3 | \`runtime.python3\` | 10007 |

**Inline cross-runtime example (Python3 — \`@node\` is the Python \`defineNode\`):**

\`\`\`python
# runtimes/python3/nodes/add_numbers/node.py
from pydantic import BaseModel, Field
from blok import node, Context

class AddNumbersInput(BaseModel):
    a: float
    b: float = Field(0)

class AddNumbersOutput(BaseModel):
    sum: float

@node("add-numbers", "Adds two numbers and returns their sum")
def add_numbers(ctx: Context, input: AddNumbersInput) -> AddNumbersOutput:
    return AddNumbersOutput(sum=input.a + input.b)
\`\`\`

Registration is **manual** in non-TS runtimes — importing the module runs the decorator; wire it into the boot path (see \`AGENTS.md\`). The \`use:\` value must match the registered node **name** string, not the function name.

---

## 4. Generating Workflows

Canonical form: \`workflow({ name, version, trigger, steps })\` from \`@blokjs/helper\` — one object literal, no chained builder, no separate \`nodes{}\` map. \`name\` ≥ 3 chars, \`version\` ≥ 5 chars (semver). Reference earlier outputs with \`$.state.<id>\` / \`$.req.body\`. Use \`branch\`, \`switchOn\`, \`forEach\`, \`loop\`, \`tryCatch\` (all from \`@blokjs/helper\`) for control flow.

\`\`\`typescript
import { workflow, $ } from "@blokjs/helper";

export default workflow({
  name: "Process Order",
  version: "1.0.0",
  trigger: { http: { method: "POST", path: "/orders" } }, // path optional → derived from file path
  steps: [
    { id: "validate", use: "order-validator", inputs: { order: $.req.body } },
    { id: "save",     use: "order-store",     inputs: { data: $.state.validate } },
  ],
});
\`\`\`

**Swap the \`trigger:\` block for any other kind** (body stays the same). Full configs + examples in \`AGENTS.md\`:

\`\`\`typescript
trigger: { worker: { queue: "background-jobs" } }                       // background jobs
trigger: { cron: { schedule: "0 2 * * *", timezone: "America/New_York" } } // recurring
trigger: { pubsub: { provider: "gcp", topic: "orders.placed", subscription: "fulfillment-svc" } }
trigger: { sse: { path: "/sse/clock", heartbeatInterval: 15000 } }      // one-way stream
trigger: { websocket: { path: "/ws/echo", events: ["message", "open", "close"] } }
trigger: { webhook: { provider: "stripe", secretEnv: "STRIPE_WEBHOOK_SECRET", idempotencyKey: "js/ctx.request.body.id" } }
trigger: { mcp: { path: "/mcp", tool: { description: "..." } } }        // needs a workflow-level input: z.object({...})
trigger: { grpc: { service: "UserService", method: "GetUser", proto: "users.proto" } }
\`\`\`

**Branch:**

\`\`\`typescript
import { workflow, branch, $ } from "@blokjs/helper";
branch({ id: "route",
  when: '$.req.method === "POST"',   // when is a JS-expression STRING ($ can't intercept ===)
  then: [{ id: "create", use: "...", inputs: {...} }],
  else: [{ id: "read",   use: "...", inputs: {...} }] })
\`\`\`

**Worker/pubsub/broker projects** need local infra. The scaffold ships an \`infra/development\` docker-compose with the broker stack — \`cd infra/development && docker compose up -d\` to start NATS/Redis (run \`docker network create shared-network\` once if prompted).

---

## 5. Common Errors

| Error | Cause | Fix |
|---|---|---|
| \`Trigger kind 'queue' has no runtime\` | Used \`trigger: { queue: ... }\` | Use \`trigger: { worker: { queue: "<name>" } }\` |
| \`Validation failed: name must be at least 3 characters\` | Workflow \`name\` < 3 chars / \`version\` < 5 chars | Lengthen name; use full semver \`x.x.x\` |
| \`Unrecognized key(s) in object: "..."\` | Misspelled / unknown field — every v2 step schema is \`.strict()\` | Fix the spelling; trigger-only fields (\`concurrencyKey\`, \`delay\`, \`ttl\`, \`debounce\`) belong on the trigger, not a step |
| \`ctx.state['X'] is undefined\` | Step X has \`ephemeral: true\`, or \`$.state.<id>\` references a typo'd id | Remove \`ephemeral\`, or fix the id reference |
| \`as and spread are mutually exclusive\` | Step set both | Pick one |
| \`branch step is missing 'when'\` | No condition string | Set \`when: "..."\` |
| \`step "..." uses set_var\` | Legacy field (removed v0.5) | Drop \`set_var: true\`; replace \`set_var: false\` with \`ephemeral: true\` |
| \`node '<name>' not found in registry\` (non-TS) | Node not imported/registered in the sidecar boot path | Import the module + register it; \`use:\` must match the registered node name |
| \`Node type X not found\` | Missing runtime resolver / wrong \`type\` | Check \`type: "runtime.<lang>"\` and that the runtime is scaffolded |
| \`[blok][mapper] Failed to resolve ...\` | A \`js/...\` input expression threw | Fix the expression; set \`BLOK_MAPPER_MODE=strict\` to fail-fast in prod |

---

## 6. Do NOT

- Do NOT default to the HTTP trigger — read \`.blok/config.json\` and pick the trigger by intent (Section 1).
- Do NOT use \`trigger: { queue: ... }\` — it has no runtime and throws. Use \`worker\`.
- Do NOT reuse a step \`id\` anywhere — including across \`switch\`/\`branch\`/\`tryCatch\` arms (all ids share one flat map; duplicates collide silently). Use \`as:\` if two arms must write the same downstream key.
- Do NOT write to \`ctx.state\` inside a node's \`execute()\` — return your output; use \`ctx.publish(name, value)\` for a side-channel.
- Do NOT assume \`$.prev\` (or \`ctx.response.data\`) survives more than one step — use \`$.state.<id>\` for cross-step reads.
- Do NOT prefix \`@blokjs/expr\`'s \`expression\` input with \`js/\` — it double-evaluates. Write plain JS: \`expression: "ctx.state.x.y"\`.
- Do NOT use \`set_var\` — removed in v0.5, throws at load.
- Do NOT use \`"*"\` for the wildcard HTTP method — use \`"ANY"\`.
- Do NOT generate class-based \`BlokService\` nodes or use \`any\` types — always \`defineNode()\` (TS) / \`@node\` (Python) with Zod/Pydantic schemas.
- Do NOT use ESLint/Prettier — this project uses Biome. Do NOT edit auto-generated files in \`.blok/runtimes/\`.
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
