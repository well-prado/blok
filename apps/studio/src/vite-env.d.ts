/// <reference types="vite/client" />

// Nothing else in Studio uses `import.meta.glob`, so without this reference
// `tsc -b` (which `bun run build` runs first) fails on `src/lib/catalogPages.ts`.
// Kept as a file rather than a `"types"` entry in tsconfig.json, because adding
// `"types"` narrows the global type set and knocks out vitest's `globals: true`.
