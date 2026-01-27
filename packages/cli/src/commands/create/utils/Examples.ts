const node_file = `
import ApiCall from "@nanoservice-ts/api-call";
import IfElse from "@nanoservice-ts/if-else";
import type { NodeBase } from "@nanoservice-ts/shared";
import ExampleNodes from "./nodes/examples";

const nodes: {
	[key: string]: NodeBase;
} = {
	"@nanoservice-ts/api-call": new ApiCall(),
	"@nanoservice-ts/if-else": new IfElse(),
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
};

const package_dev_dependencies = {
	"@types/ejs": "^3.1.5",
	"@types/pg": "^8.11.11",
};

const python3_file = `
from core.nanoservice import NanoService
from core.types.context import Context
from core.types.nanoservice_response import NanoServiceResponse
from core.types.global_error import GlobalError
from typing import Any, Dict
import traceback

class Node(NanoService):
    def __init__(self):
        NanoService.__init__(self)
        self.input_schema = {}
        self.output_schema = {}

    async def handle(self, ctx: Context, inputs: Dict[str, Any]) -> NanoServiceResponse:
        response = NanoServiceResponse()

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

For more documentation, visit src/nodes/examples/README.md. The first three examples require a PostgreSQL database to function.
`;

const workflow_template = `
{
	"name": "",
	"description": "",
	"version": "1.0.0",
	"trigger": {
		"http": {
			"method": "GET",
			"path": "/",
			"accept": "application/json"
		}
	},
	"steps": [
		{
			"name": "node-name",
			"node": "node-module-name",
			"type": "module"
		}
	],
	"nodes": {
		"name": {
			"inputs": {

			}
		}
	}
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
command=python3 /app/.nanoctl/runtimes/python3/server.py
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
};
