I have everything. Writing the brief.

---

## What they do (with real code)

n8n stores every parameter as a plain value **unless the string starts with `=`** — that single byte is the entire "this is an expression" signal:

```ts
// expressions/expression-helpers.ts
export const isExpression = (expr: unknown): expr is string =>
  typeof expr === 'string' && expr.charAt(0) === '=';
```

Resolution strips the `=` and hands the rest to **Tournament** (n8n's riot.js-style template compiler), which interpolates every `{{ … }}` block and runs arbitrary JS inside the braces:

```ts
// expression.ts resolveSimpleParameterValue()
parameterValue = parameterValue.substr(1);        // drop the '='
const extendedExpression = extendSyntax(parameterValue);
const returnValue = this.renderExpression(extendedExpression, data);  // Tournament or VM
```

```ts
// expression-evaluator-proxy.ts
import { Tournament } from '@n8n/tournament';
const tournamentEvaluator = new Tournament(errorHandler, undefined, undefined, {
  before: [ThisSanitizer], after: [PrototypeSanitizer, DollarSignValidator],
});
```

So a real parameter value looks like a string literal in JSON but is template-aware:

```
"url":  "=https://api.example.com/users/{{ $json.userId }}"
"text": "=Hello {{ $('Fetch User').item.json.name }}, you have {{ $json.orders.length }} orders"
```

**The runtime context is one giant Proxy `base` object** assembled in `WorkflowDataProxy.getDataProxy()`. The full built-in surface (workflow-data-proxy.ts:1172-1647):

| Variable | Meaning |
|---|---|
| `$json` | the current item's JSON (`= $data` alias) — most-used var |
| `$binary` | current item's binary attachments |
| `$('Node Name')` | **the prior-step accessor** — a Proxy keyed by node **display name**; exposes `.item`, `.first()`, `.last()`, `.all()`, `.itemMatching(i)`, `.pairedItem()`, `.isExecuted`, `.params`, `.context` |
| `$node['Node Name'].json` | legacy name-keyed accessor (same data, older syntax) |
| `$input` | current node's input: `.item`, `.first()`, `.last()`, `.all()`, `.params`, `.context` |
| `$items(name?, out?, run?)` | legacy array accessor (undocumented) |
| `$prevNode` | `{ name, outputIndex, runIndex }` of the immediately-upstream node |
| `$parameter` / `$rawParameter` | this node's own (resolved/raw) parameters |
| `$self`, `$nodeId`, `$nodeVersion`, `$webhookId` | current node metadata |
| `$workflow` | `{ id, name, active }` |
| `$runIndex`, `$itemIndex`, `$mode`, `$position` | execution coordinates |
| `$now`, `$today` | Luxon `DateTime` (timezone from workflow settings) |
| `$env` | env vars (gated by `N8N_BLOCK_ENV_ACCESS_IN_NODE`) |
| `$jmesPath(obj, query)` | JMESPath query helper |
| `$evaluateExpression(str, i?)` | eval an expression string at runtime |
| `$fromAI(...)` | AI-tool parameter binding (for the agent node) |
| `$getPairedItem`, `$item(i)` | paired-item lineage helpers |
| `DateTime`, `Interval`, `Duration` | raw Luxon classes |

**Prior-step reference is by node display name, resolved through a Proxy `get` trap** (workflow-data-proxy.ts:775-799, 1181-1189):

```ts
get(_, name) {
  const nodeName = name.toString();
  if (that.workflow.getNode(nodeName) === null)
    throw new ExpressionError("Referenced node doesn't exist", { nodeCause: nodeName });
  return that.nodeDataGetter(nodeName);
}
```

`$('Fetch User')` additionally enforces graph connectivity and execution at resolve time — if the referenced node hasn't run, it throws with a guidance template (line 1196-1208):

```
"Node 'Fetch User' hasn't been executed"
→ "Consider re-wiring your nodes or checking for execution first,
   i.e. {{ $if( $('Fetch User').isExecuted, <action>, '') }}"
```

On top of the variables, **expression extensions** (extensions/expression-extension.ts) AST-rewrite the source to add fluent methods on primitives — `"hello".toTitleCase()`, `arr.first()`, `$now.toDateTime()`, `{...}.removeKeys()` — across string/number/date/array/object/boolean. These are *not* native JS; `extendTransform()` rewrites the parse tree before evaluation.

## Readability verdict

**Better than Blok's `$.state.x` / `js/ctx...` on three axes:**

1. **One mental model, not two.** n8n has exactly one signal (`=`) and one bracket (`{{ }}`). Inside the braces it is *just JavaScript* against named variables — no second `js/` escape hatch, no `$.` proxy that compiles to a different `js/ctx.` string. Blok's split (`$.state.x` *and* `"js/ctx.state.x"` *and* raw-`ctx` in `branch.when`) is three dialects for one job; n8n is one.
2. **Refs read like prose.** `$('Fetch User').item.json.email` says what it does. `$.state.fetch.data.email` requires you to know `fetch` is a step id and that outputs nest under `.data`.
3. **Rich, discoverable surface.** `$now`, `$json`, `$input.first()`, `.toDateTime()` are autocompletable and self-documenting. Luxon-as-default kills the date footgun.

**Worse — the footguns the founder is right to fear, in sharper form than Blok's:**

1. **Name-keyed refs are the cardinal sin.** `$('Fetch User')` is a *string lookup by display name*. Rename the node in the canvas and every expression silently breaks at runtime (the Proxy throws `"Referenced node doesn't exist"` — but only when that branch executes, never at author/compile time). Blok's `$.state.fetch` keys off the **step `id`**, which is structural and at least typed in TS. n8n traded compile-time safety for prose-readability and lost.
2. **Stringly-typed everything.** The whole expression is a string literal starting with `=`. No type checking, no go-to-definition, no rename-refactor. A typo (`$jon` for `$json`) is a runtime `undefined`, not a build error. Blok's TS `$` proxy is at least caught by `tsc`.
3. **`{{ }}` is a full JS sandbox.** Tournament evaluates arbitrary JS, so n8n needs `ThisSanitizer`, `PrototypeSanitizer`, `DollarSignValidator`, a `.constructor` regex block, and an optional VM isolate. Power = attack surface = the opposite of "anyone can read it."
4. **Resolve-time graph coupling.** `$('X')` re-checks connectivity + execution at eval time and throws if upstream didn't run. Readable when it works; a class of confusing late failures when it doesn't.
5. **Legacy sprawl.** `$node` vs `$()`, `$items` vs `$input.all()`, `$json` vs `$data` — multiple undocumented aliases for the same thing. The thing the founder wants to avoid (one obvious way) is already lost here.

Net: n8n is **more readable at the cell level** (a single expression reads beautifully) but **less safe and less refactorable at the workflow level** (name-keyed, stringly, untyped). It optimizes for the visual editor where you click a node to insert the ref; it degrades badly when read/edited as text — which is exactly Blok's authoring surface.

## Lessons for Blok authoring

- **Keep step-`id` refs, drop the dual dialect.** n8n proves the *readability* win comes from named, dotted access (`$('Fetch User').item.json`), not from a proxy-vs-string split. Pick ONE form. Blok should resolve `state.fetch.data` (or a typed equivalent) and delete the `"js/ctx..."` string form *and* the `$.`-compiles-to-`js/` indirection — that two-dialect seam is Blok's worst readability tax and n8n has no equivalent.
- **Reference by structural id, never by display name.** This is n8n's biggest mistake; do not copy it. Keep keying off step `id`. If you want prose-readable refs, alias the id to a human label in metadata, but resolve against the id so rename never breaks data flow.
- **Make refs typed.** n8n's name-keyed strings can't be checked; Blok's TS `$` can. Lean into that — a ref that fails `tsc` is worth more than one that reads slightly nicer. The founder's "anyone can read it" goal is better served by *autocomplete + rename-safety* than by template prose.
- **A single delimiter, only where interpolation is needed.** n8n's `=…{{ }}` is elegant *because* a bare value is never an expression. Blok could adopt one unambiguous marker for "this field is computed" and otherwise take literals — no `js/` smell anywhere.
- **Steal the helper surface, not the eval model.** Luxon-by-default (`$now`), `.first()/.last()/.all()` on collections, and JMESPath are genuine ergonomics wins with no name-keying downside. Bundle equivalents.
- **Don't ship a JS sandbox per field.** n8n's `{{ full JS }}` forces 4 sanitizers + a VM. Keep Blok's expressions to *path access + a vetted helper set*; that alone covers ~95% of n8n usage and keeps workflows readable and safe.
- **Layout already belongs out-of-band — n8n inlines `position` per node, which is the very coupling the founder wants gone.** n8n is a *cautionary* example here: keep canvas/layout in a separate file as planned.

## Sources

Local source only (no web). Key files under `…/research-repos/n8n/packages/workflow/src/`:
- `expressions/expression-helpers.ts` — `isExpression` (`=` prefix, line 5-9)
- `expression.ts` — `resolveSimpleParameterValue` (529-624), `renderExpression` (626+)
- `expression-evaluator-proxy.ts` — Tournament wiring + sanitizers (1-13)
- `workflow-data-proxy.ts` — the `base` built-ins object (1172-1647), `$()` node accessor (1173-1440), `$input` (1442-1535), `nodeGetter`/name-keyed Proxy (775-799), unexecuted-node error template (1196-1208)
- `extensions/expression-extension.ts` — AST-rewrite fluent extensions (`extendTransform`, 124+)