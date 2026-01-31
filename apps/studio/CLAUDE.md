# Blok Studio

React 19 SPA for real-time workflow trace visualization. Built with Vite.

## Tech Stack

- React 19, TanStack Router, TanStack Query, TanStack Table
- @xyflow/react — workflow graph visualization
- Zustand — state management
- Tailwind CSS 4 — styling
- Recharts — metrics charts
- Lucide React — icons
- dagre — graph layout

## Commands

```bash
pnpm dev          # Vite dev server
pnpm build        # TypeScript check + Vite production build
pnpm test         # Vitest (Testing Library + jsdom)
pnpm test:dev     # Watch mode
```

## Data Flow

Studio connects to the runner's `/__blok/*` endpoints:

```
Runner (Express) → /__blok/runs        → useRuns() hook
                 → /__blok/runs/:id     → useRunDetail(id) hook
                 → /__blok/runs/:id/stream → useGlobalStream() (SSE)
                 → /__blok/workflows    → useWorkflows() hook
                 → /__blok/metrics      → useMetrics() hook
```

## Key Types

```typescript
RunTrace { id, workflowName, status, startTime, endTime, nodes: NodeTrace[] }
NodeTrace { id, nodeName, nodeType, runtimeKind, status, inputs, outputs, error, depth, stepIndex }
```

`depth: 0` = top-level step, `depth: 1+` = nested inside flow node (if-else, loop)

## Testing

Uses `@testing-library/react` with jsdom. Test files alongside source as `*.test.ts` or `*.test.tsx`.
