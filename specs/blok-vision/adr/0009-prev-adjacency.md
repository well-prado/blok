# ADR 0009: No `prev()` Handle in the Redesign Authoring Surface

## Status

Accepted for M1 planning.

## Context

The current runner keeps adjacent-step output in `ctx.response` with `ctx.prev`
as an authoring alias. That value is overwritten after every step. It is useful
for tiny linear workflows, but it is positional state: the meaning changes when
steps move, when a flow-control arm starts, or when a loop executes multiple
times.

The redesign handle model makes data dependencies explicit and stable. A handle
points to a declared step, branch arm, loop item, workflow input, or error slot.
A positional `prev()` handle would reintroduce the old ambiguity at the exact
places handles are meant to make safe.

## Decision

Do not add `prev()` to the new handle DSL.

New redesign authoring must read prior data through explicit handles:

```ts
const user = step("load-user", ...);
const normalized = step("normalize", {
  input: user.output,
});
```

The runner can continue overwriting `ctx.response` / `ctx.prev` internally for
v1, v2, JSON, raw mapper expressions, and runtime compatibility. This decision
changes only the new authoring surface and migration rules.

## Rationale

- Explicit handles survive insertion, deletion, reordering, extraction, and
  branch refactors.
- `prev()` has no single obvious meaning at control-flow boundaries.
- A typed `prev()` would still need special cases for every primitive and would
  teach authors to rely on adjacency again.
- Dropping `prev()` costs one named handle in simple workflows and avoids a long
  tail of unsound migrations.

## Boundary Rules

Since the redesign DSL has no `prev()` handle, these boundary cases are rejected
or require explicit handles:

| Shape | Redesign rule |
| --- | --- |
| First step in an `else` arm | No previous handle. Read workflow input, an outer step handle, or a branch-scoped input explicitly. |
| First step in a `forEach` body | No previous handle. Read the item handle and any explicit outer handles. |
| Step immediately after `forEach` | Read the loop step handle, whose value is the array of iteration results. |
| First step in `try` | No previous handle. Read explicit outer handles. |
| First step in `catch` | Read the catch error handle plus explicit outer handles. |
| First step in `finally` | Read explicit try/catch outputs if the primitive exposes them; otherwise read explicit outer handles. |
| Step after `tryCatch` | Read the tryCatch step handle, not a positional previous output. |
| Prior step is `ephemeral: true` | No handle exists. Remove `ephemeral`, consume the value in the adjacent legacy expression surface, or split the side effect from the data output. |

These rules intentionally do not define what runtime `ctx.response` happens to
contain at those boundaries. That value remains an implementation detail for the
legacy mapper surface.

## Migration Rule

The codemod may rewrite `ctx.prev`, `ctx.response`, `$.prev`, and
`ctx.response.data` only when all of these are true:

1. The read is inside a regular step's inputs or expression.
2. The immediately preceding step is statically visible in the same step array.
3. That predecessor is not `ephemeral: true`.
4. The predecessor is not inside a different branch, loop iteration, try/catch
   arm, or sub-workflow boundary.

In that narrow case, rewrite the read to the predecessor's explicit handle. In
all other cases, emit a hand-migration marker with the local reason, for example
`prev crosses forEach boundary` or `prev reads ephemeral output`.

## Engine Impact

No runner change is required for this decision.

The existing overwrite behavior stays in place:

- each completed step still updates `ctx.response`;
- `ctx.prev` remains the legacy alias for the immediately previous response;
- `ephemeral: true` still skips state persistence while leaving the adjacent
  response visible to legacy expressions.

The redesign compiler simply does not generate or type-check a `prev()` handle.

## Consequences

- New workflows become more verbose by one binding in some linear cases.
- Branch, loop, and error-path data flow becomes refactor-safe.
- The codemod is conservative: it can auto-fix obvious adjacent reads and marks
  the risky ones instead of guessing.
- No SDK or runtime contract changes are needed.
