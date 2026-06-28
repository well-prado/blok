# ADR 0008 - Escape hatch for non-structural expressions

- **Status:** Accepted (spike resolution - unblocks implementation)
- **Date:** 2026-06-28
- **Resolves:** [#324](https://github.com/well-prado/blok/issues/324)
- **Epic:** [#323](https://github.com/well-prado/blok/issues/323)
- **Prototype:** `specs/blok-vision/adr/0008-non-structural-expression-escape-probe.ts`

## Decision

Keep a first-class `js` tagged-template escape hatch for expressions that are not structural refs:

```ts
js`${req.body.tenantId} || 'default'`
js`Array.isArray(${req.body.items}) ? ${req.body.items} : []`
js`[...(${history.value} || []), { role: 'user', content: ${req.body.message} }]`
```

It lowers to a plain `js/...` string before the runner sees it, preserving today's `Mapper.jsMapper` behavior exactly. Handles interpolated into the tag lower to raw `ctx.state...` / `ctx.request...` fragments inside the JavaScript expression. No new node and no Mapper change.

This is explicit escape-hatch syntax, not the default authoring surface. Plain field reads still use handles and structural `{$ref}`; string interpolation still uses `tpl`.

## Why `js` tag over `expr()` or compute nodes

- `js` tag reuses the existing Mapper and keeps parity with today's workflows.
- `expr()` would be confusing because `@blokjs/expr`'s `expression` input must not be prefixed with `js/`; it is already mapper-resolved and would double-evaluate.
- A compute node is too heavy for defaults, ternaries, env reads, and small array/object expressions. Authors can still choose a node when logic grows.

## Inventory

Scripted scan of `triggers/http/workflows/json`, `workflows/json`, and `triggers/http/src/workflows/examples` found 348 `js/` values across 132 files. 171 were non-simple field reads.

| Shape | Examples found | New form |
|---|---|---|
| default/fallback | `ctx.request.body.tenantId || 'default'`, `process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini'` | `js`${req.body.tenantId} || 'default'`` |
| optional/coalesce | `ctx.state['load-history']?.value || []`, `(ctx.state.attempt ?? 0) + 1` | `js`${history.value} || []`` / `js`(${attempt} ?? 0) + 1`` |
| collection/array | `Array.isArray(ctx.request.body.items) ? ctx.request.body.items : []`, `split(',').map(...).filter(Boolean)` | `js`Array.isArray(${req.body.items}) ? ${req.body.items} : []`` |
| string templates | `` `chat:${ctx.request.params.sessionId}` `` | prefer `tpl` for pure string refs; use `js` with concatenation only when logic is embedded |
| ternary | `ctx.state.rollback ? 'failed' : 'success'` | `js`${rollback} ? 'failed' : 'success'`` |
| env/time | `process.env.OPENROUTER_API_KEY`, `Date.now()` | `js`process.env.OPENROUTER_API_KEY`` / `js`Date.now()`` |
| object/array construction | message arrays, `{ echo: ctx.request.body, at: Date.now() }` | `js`[{ ... }, ...(${history.value} || [])]`` |
| existence checks | `ctx.state['cancel-flight'] !== undefined` | `js`${cancelFlight} !== undefined`` |

## Rules

- `js` tag output is a `js/...` string. It is not structural IR.
- It may interpolate handles and literals.
- Inside `js`, handles interpolate as JavaScript expressions. For pure string building use `tpl`; for mixed logic use normal JS concatenation (`js`'agent:' + ${sessionId}``), not nested template literals.
- It must not be used inside `@blokjs/expr`'s `expression` input; there, write plain JavaScript.
- Codemods should migrate simple field reads to handles, pure string interpolation to `tpl`, and leave logic expressions as `js` tags.
- If an expression grows beyond one line or mutates data, move it into a node.

## Prototype

Run:

```bash
bun specs/blok-vision/adr/0008-non-structural-expression-escape-probe.ts
```

The probe proves `js` tag output survives `unwrapProxies`, then resolves through the real Mapper to the same values as existing `js/` strings for defaulting, arrays, optional chaining, string concatenation, object construction, and expressions referencing two step handles.
