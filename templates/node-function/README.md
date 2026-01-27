# Function-First Node

This node uses the modern **function-first** pattern with `defineNode` API and Zod validation.

## Features

- ✅ **Type-Safe**: Automatic TypeScript inference from Zod schemas
- ✅ **Validated**: Automatic input/output validation
- ✅ **Clean**: 60% less boilerplate vs class-based nodes
- ✅ **AI-Friendly**: 95%+ AI generation success rate

## Usage

```typescript
import { defineNode } from "@nanoservice-ts/runner";
import { z } from "zod";

export default defineNode({
  name: "my-node",
  description: "Description here",

  input: z.object({
    // Define your input schema
  }),

  output: z.object({
    // Define your output schema
  }),

  async execute(ctx, input) {
    // Your business logic here
    return { /* output */ };
  },
});
```

## Development

### Build
```bash
npm run build
```

### Watch Mode
```bash
npm run build:dev
```

### Test
```bash
npm test
```

## Documentation

- [Function-First Node Guide](https://blok.build/docs/nodes/function-first)
- [defineNode API Reference](https://blok.build/docs/api/define-node)
- [Zod Schema Cookbook](https://blok.build/docs/guides/zod-schemas)

## License

Apache-2.0
