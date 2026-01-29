# Module Reference: Built-in Nodes

> **Path:** `nodes/`
> **Purpose:** Pre-built node implementations that ship with Blok

## What It Does

Nodes are the building blocks of Blok workflows. Each node performs a single task (API call, conditional logic, rendering, etc.). The `nodes/` directory contains the built-in nodes that ship with the framework.

## Built-in Nodes

### 1. if-else@1.0.0 (Conditional Logic)
- **Path:** `nodes/control-flow/if-else@1.0.0/`
- **Package:** `@nanoservice-ts/if-else`
- **Purpose:** Evaluates conditions and routes workflow execution
- **Files:**
  - `index.ts` — Main implementation (function-first via defineNode)
  - `inputSchema.ts` — Input schema definition
  - `config.json` — Node metadata (name, version, description)
  - `test/index.test.ts` — Unit tests
- **Usage in workflows:**
  ```json
  {
    "node": "if-else",
    "inputs": {
      "conditions": [
        { "field": "ctx.request.body.age", "operator": ">=", "value": 18 }
      ]
    }
  }
  ```

### 2. api-call@1.0.0 (HTTP API Client)
- **Path:** `nodes/web/api-call@1.0.0/`
- **Package:** `@nanoservice-ts/api-call`
- **Purpose:** Makes HTTP requests to external APIs
- **Files:**
  - `index.ts` — Main implementation (function-first)
  - `inputSchema.ts` — Input schema (url, method, headers, body, etc.)
  - `util.ts` — HTTP utility functions
  - `config.json` — Node metadata
  - `test/index.test.ts` — Unit tests
- **Usage in workflows:**
  ```json
  {
    "node": "api-call",
    "inputs": {
      "url": "https://api.example.com/users",
      "method": "GET",
      "headers": { "Authorization": "Bearer {{ctx.vars.token}}" }
    }
  }
  ```

### 3. react@1.0.0 (React SSR)
- **Path:** `nodes/web/react@1.0.0/`
- **Package:** `@nanoservice-ts/react`
- **Purpose:** Server-side renders React components
- **Files:**
  - `index.ts` — Main implementation (function-first)
  - `inputSchema.ts` — Input schema
  - `app/index.jsx` — React component entry
  - `config.json` — Node metadata
  - `test/` — Tests with HTML mockup

## Node Structure Convention

Every node follows this structure:

```
nodes/{category}/{name}@{version}/
├── index.ts          # Main implementation (export default)
├── inputSchema.ts    # Input validation schema
├── config.json       # Metadata: { name, version, description, inputs, outputs }
├── package.json      # Dependencies and scripts
├── tsconfig.json     # TypeScript config
└── test/
    └── index.test.ts # Unit tests
```

## Node Versioning

Nodes use semantic versioning in their directory name (`name@version`). This allows multiple versions of the same node to coexist, enabling safe upgrades.

## config.json Format

```json
{
  "name": "api-call",
  "version": "1.0.0",
  "description": "Makes HTTP requests to external APIs",
  "group": "web",
  "inputs": {
    "type": "object",
    "properties": {
      "url": { "type": "string", "description": "Target URL" },
      "method": { "type": "string", "enum": ["GET", "POST", "PUT", "DELETE"] }
    },
    "required": ["url", "method"]
  },
  "outputs": {
    "type": "object",
    "properties": {
      "status": { "type": "number" },
      "body": { "type": "object" }
    }
  }
}
```

## Python Nodes (runtimes/python3/)

Python nodes live in `runtimes/python3/nodes/` and include:
- `api_call/` — Python HTTP API client
- `embed/` — Text embedding generation
- `generate_pdf/` — PDF generation
- `image_description/` — Image analysis
- `milvus/insert/` — Milvus vector DB insert
- `milvus/query/` — Milvus vector DB query
- `sentiment/` — Sentiment analysis
- `test_simple/`, `test_context/`, `test_error/` — Test nodes

## What to Document

1. **Creating nodes** — Step-by-step guide using defineNode
2. **Node structure** — config.json, input/output schemas
3. **Built-in nodes** — Reference for each node (if-else, api-call, react)
4. **Testing nodes** — How to write unit tests
5. **Publishing nodes** — How to share nodes via the registry
6. **Python nodes** — How to create Python-based nodes
