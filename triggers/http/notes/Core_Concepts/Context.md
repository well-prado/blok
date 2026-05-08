# Understanding Context (`ctx`)

In `Blok`, **Context (`ctx`)** is the primary data structure that flows between nodes in a workflow. It enables nodes to **exchange data** and maintain state throughout execution.

---

## 📌 Context Structure

Each node in a workflow receives `ctx` as an input, which contains the following structure:

```typescript
const ctx: Context = {
    vars: {}, // Stores dynamically generated variables
    request: { body: {}, method: "GET", headers: {}, query: {}, params: {} }, // Incoming request details
    response: { data: {} } // Stores processed results
};
```

### 🔹 Breakdown of `ctx`

- **`ctx.request`**: Contains all HTTP request details:
  - `body`: The request payload (e.g., for POST, PUT requests)
  - `method`: HTTP method (e.g., GET, POST, etc.)
  - `headers`: Request headers
  - `query`: Query parameters (e.g., `?key=value`)
  - `params`: Path parameters (e.g., `/:id`)

- **`ctx.response`**: Holds workflow outputs:
  - `data`: The latest processed data from nodes

- **`ctx.vars`**: Temporary workflow variables:
  - These are **not persisted** across requests.
  - Nodes can store variables dynamically for later use.

---

## 📖 Context in Workflows

Context is essential for **passing data between nodes** and making dynamic decisions.

### 🛠 Example: Using `ctx.request.params`

In this workflow, we extract `id` from the request URL and fetch details from MongoDB:

```json
{
    "name": "Get Movie Details",
    "description": "Fetches a movie by ID",
    "version": "1.0.0",
    "trigger": {
        "http": {
            "method": "GET",
            "path": "/movies/:id",
            "accept": "application/json"
        }
    },
    "steps": [
        {
            "name": "get-movie",
            "node": "mongo-query",
            "type": "local"
        }
    ],
    "nodes": {
        "get-movie": {
            "inputs": {
                "collection": "movies",
                "id": "${ctx.request.params.id}"
            }
        }
    }
}
```

#### 🔹 How it Works:
- `path: "/movies/:id"` defines a **dynamic route**.
- The MongoDB node retrieves the movie using:
  ```json
  "id": "${ctx.request.params.id}"
  ```
  This extracts `id` from the URL (e.g., `/movies/123` → `ctx.request.params.id = 123`).

---

### 🛠 Example: Using `ctx.vars`

This workflow **stores an API response in a variable** and **uses it in a later step**:

```json
{
    "name": "Fetch and Process Data",
    "description": "Stores fetched data and processes it",
    "version": "1.0.0",
    "trigger": {
        "http": {
            "method": "GET",
            "path": "/fetch-data",
            "accept": "application/json"
        }
    },
    "steps": [
        {
            "name": "fetch-data",
            "node": "@blokjs/api-call",
            "type": "module",
            "set_var": true
        },
        {
            "name": "process-data",
            "node": "@blokjs/mapper",
            "type": "module"
        }
    ],
    "nodes": {
        "fetch-data": {
            "inputs": {
                "url": "https://api.publicapis.org/entries",
                "method": "GET",
                "headers": {},
                "var": "apiResponse"
            }
        },
        "process-data": {
            "inputs": {
                "mapper": {
                    "totalApis": "js/ctx.vars['fetch-data'].count",
                    "categories": "js/ctx.vars['fetch-data'].categories"
                }
            }
        }
    }
}
```

#### 🔹 How it Works:
- The **API call node (`fetch-data`)** fetches API data and stores it in `ctx.vars['fetch-data']`.
- The **mapper node (`process-data`)** extracts and processes values from `ctx.vars['fetch-data']`.

---

## 🎯 Key Takeaways

- ✅ **`ctx` allows passing request data to nodes.**  
- ✅ **Nodes modify and store values in `ctx.vars`.**  
- ✅ **Nodes can dynamically read/write to `ctx.response.data`.**  
- ✅ **`ctx.request.params`, `ctx.request.body`, and `ctx.response` drive workflow execution.**

---

## 🔍 Next Steps

Now that you understand `ctx`, explore:
- [Creating Custom Nodes](../CLI_Commands/Create_Node.md)
- [Creating Workflows](../CLI_Commands/Create_Workflow.md)
- [Examples](../examples.md)
- [Index](../index.md)