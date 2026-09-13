# @blokjs/code-mode

## 2.2.1

### Patch Changes

- Fix the workspace filesystem watcher on macOS: kqueue's directory self-event was turned into a bogus path and consumed the bounded watch budget before the real per-file event (#991). Lockstep 2.2.1 for every package.
- Updated dependencies
  - @blokjs/shared@2.2.1

## 2.2.0

### Minor Changes

- 1beaa83: Add the constrained, policy-gated TypeScript Code Mode runtime with AST
  validation, isolated worker execution, deterministic bindings, cancellation,
  resource budgets, and conformance coverage.

### Patch Changes

- Updated dependencies [8608279]
- Updated dependencies [3d6ab7b]
- Updated dependencies [a3cf6e5]
- Updated dependencies [f38e2b0]
- Updated dependencies
- Updated dependencies [84fabc0]
  - @blokjs/shared@2.2.0
