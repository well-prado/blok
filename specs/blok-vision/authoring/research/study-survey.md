I have enough verified material. I'll write the brief from confirmed syntaxes (Temporal/Dagster are well-established code-first patterns I can state precisely).

---

# Workflow Authoring Patterns — Survey for Blok Next-Gen

The founder's two pain points map to two well-studied axes: **(A) how a step names a prior step's output** and **(B) where canvas/layout lives**. Here's how seven systems handle each, with real snippets.

## What they do

### 1. Airflow TaskFlow API — *plain Python return values* (cleanest data-flow)
Tasks are functions. Wiring = calling a function with another's return value. XCom is invisible.
```python
@task
def extract(): return {"order_1": 100, "order_2": 200}

@task
def transform(orders: dict): return sum(orders.values())

@dag(schedule=None, start_date=...)
def pipeline():
    data  = extract()
    total = transform(data)   # dependency inferred from the variable
```
No string paths. No `$`. The variable name *is* the reference. Layout is fully derived by the scheduler (DAG topology) — there is no canvas in the source at all.

### 2. GitHub Actions — `${{ steps.<id>.outputs.<name> }}` + `needs:` (most-readable string syntax)
```yaml
jobs:
  build:
    outputs:
      sha: ${{ steps.compile.outputs.sha }}
    steps:
      - id: compile
        run: echo "sha=abc123" >> $GITHUB_OUTPUT
  deploy:
    needs: build                                  # explicit dependency edge
    steps:
      - run: echo "Deploying ${{ needs.build.outputs.sha }}"
```
`steps.<id>.outputs.<name>` reads in English: *step → its outputs → this one*. `needs:` makes cross-job edges explicit and self-documenting. No layout — execution order comes from `needs:`.

### 3. Pipedream — `steps.<name>.$return_value` / `$.export("name", val)`
```js
export default defineComponent({
  async run({ steps, $ }) {
    const user = steps.fetch_user.$return_value;   // auto return value
    $.export("email", user.email);                 // or name it explicitly
  },
});
```
`steps.fetch_user.email` reads cleanly; `$return_value` is the one ugly token. Layout is editor-managed, not in the step code.

### 4. Windmill OpenFlow — `results.<step_id>` inside `input_transforms` (JSON, separate UI)
```jsonc
{ "input_transforms": {
    "name": { "type": "javascript", "expr": "results.a.username" },
    "max":  { "type": "static", "value": 100 } } }
```
Context vars: `flow_input`, `results`, `previous_result`, `step`. Inputs are *typed* — `static` vs `javascript` is declared, so a literal can never be mistaken for an expression. **Canvas position is NOT in the OpenFlow spec** — it's a pure logic DAG; the visual editor stores positions separately. This is the strongest "separate layout" precedent in the set.

### 5. Dagster — typed function params (`@asset`/`@op`)
```python
@asset
def raw_users(): ...
@asset
def clean_users(raw_users):        # param name == upstream asset name == the edge
    return dedupe(raw_users)
```
Dependency = the parameter name. Strongly typed, no strings, no layout in code (graph is rendered from deps).

### 6. Temporal — it's just code; "output reference" is a local variable
```ts
const order   = await activities.createOrder(req);
const charged = await activities.charge(order.id);   // ordinary await + variable
```
No DSL, no expression language, no layout — the call graph *is* the workflow. Maximum readability for engineers, zero visual model.

### 7. n8n / Make / Zapier — visual-first, expressions are the weak point
n8n stores everything in one JSON: `nodes[]` carry `"position": [x, y]`, a separate `connections{}` object holds edges, and data is read via `{{ $json.name }}` or `$node["Fetch"].json`. **Layout (`position`) lives inline next to logic** — exactly the anti-pattern the founder dislikes — and `$json`/`$node[...]` strings are the n8n equivalent of Blok's `$.state` complaint. Make/Zapier are pure GUI (no readable source artifact at all).

## Readability verdict

**Reference-syntax, ranked (most → least readable):**
1. **Airflow / Dagster / Temporal — variable/param name as the edge.** Zero ceremony; the language's own scoping is the reference. Only works in code-first authoring.
2. **GitHub Actions `steps.<id>.outputs.<name>` + `needs:`.** Best *string* syntax: noun-path that reads as English, explicit edges. Wins for declarative/JSON-or-YAML authoring.
3. **Pipedream `steps.<name>.<export>`.** Clean when you name exports; `$return_value` is the blemish.
4. **Windmill `results.<id>`** + typed `static`/`javascript` transforms — verbose but unambiguous and machine-friendly.
5. **n8n `$json` / `$node["X"].json`** — terminal-y, opaque, the thing to avoid (this is Blok's `$.state`/`js/ctx` smell).

**Separate-layout, ranked precedent:**
1. **Windmill OpenFlow** — explicit: logic spec has *no* coordinates; UI owns position. Direct model for Blok.
2. **Airflow / Dagster / Temporal** — layout doesn't exist in source; it's *derived* from the dependency graph at render time (even cleaner — no second file needed unless a human pins positions).
3. **n8n** — counter-example: `position` baked into the logic JSON. Don't do this.

## Lessons for Blok authoring

- **Kill `$.state.x` and `js/ctx...` as the default.** The two clean exits both exist already in your codebase's mental model:
  - **Code-first (Airflow/Temporal model):** make a step's output a typed handle the next step *references by name*, not by string path. Authors write `transform(fetchUser)` / `inputs: { user: fetchUser.output }`, not `"$.state.fetch"`. The TS DSL can return a typed step ref so the variable name carries the data — no proxy, no string.
  - **Declarative (GitHub Actions model):** if a string syntax must remain for JSON, adopt `steps.<id>.outputs.<field>` (or just `outputs.fetch.user`) over `$.state.fetch`. It reads as English and survives copy-paste. Reserve a *separate* typed field for literal-vs-expression (Windmill's `static`/`javascript` split) so a literal `"$.foo"` can never be misread.
- **Make dependencies explicit, like `needs:`.** A top-of-step `after:`/`uses:` edge list makes the flow legible at a glance and lets the renderer derive the canvas — no hand-placed coordinates.
- **Move layout to a sibling file (`workflow.layout.json`) — Windmill precedent.** The `.blok` workflow file should contain *only* steps, triggers, data flow. Canvas x/y/zoom/notes live in a separate file the Studio owns and round-trips. If a step has no pinned position, auto-layout from the dependency DAG (Airflow/Dagster model) so the layout file is optional, not mandatory.
- **Triggers stay declarative and top-of-file** (you already do this well) — GitHub's `on:` block is the gold standard: one readable block, no logic mixed in.
- **Best synthesis for Blok:** code-first TS where steps return typed refs (Temporal-clean data flow) + a `needs:`-style edge surface for legibility + Windmill-style separate layout file + GitHub-style trigger block. That removes both `$` proxies and inline canvas in one move.

## Sources
- [GitHub Actions contexts (`steps.*.outputs`, `needs.*`)](https://docs.github.com/en/actions/learn-github-actions/contexts)
- [Airflow TaskFlow API tutorial (return-value chaining, implicit XCom)](https://airflow.apache.org/docs/apache-airflow/stable/tutorial/taskflow.html)
- [Windmill OpenFlow spec](https://www.windmill.dev/docs/openflow) · [Windmill flow architecture (`results.<id>`, `input_transforms`)](https://www.windmill.dev/docs/flows/architecture) · [OpenFlow OpenAPI yaml](https://github.com/windmill-labs/windmill/blob/main/openflow.openapi.yaml)
- [Pipedream — referencing data from other steps (`steps.x.$return_value`, `$.export`)](https://pipedream.com/docs/workflows/building-workflows/code/nodejs/)
- [n8n data structure & JSON (`position`, `connections`, `$json`/`$node`)](https://docs.n8n.io/data/data-structure/) · [n8n workflow JSON format guide](https://latenode.com/blog/low-code-no-code-platforms/n8n-setup-workflows-self-hosting-templates/n8n-import-workflow-json-complete-guide-file-format-examples-2025)

*Dagster (`@asset`/`@op` param-name deps) and Temporal (plain `await` + local vars) snippets are from their standard programming models — well-established public patterns, not fetched for this brief.*