I have everything. The n8n expression syntax `={{ $('Webhook').item.json.headers[...] }}` is a perfect contrast point — it's node-NAME-keyed too, mirroring Blok's `$` complaint. Here's the brief.

---

## What they do (with real code)

n8n stores a workflow as **one flat JSON document** with four sibling top-level keys: `nodes[]`, `connections{}`, `pinData{}`, `settings{}` (plus `name`, `active`, `meta`, `versionId`, `tags`). Layout, wiring, parameters, and credentials are all interleaved in the same file.

**A node** (`INode`, `interfaces.ts:1431`) is a flat object — `parameters`, identity, AND canvas position all inline:

```json
{
  "parameters": { "amount": 2, "unit": "seconds" },
  "id": "7f15f650-99bc-400b-8db8-67be53003fa3",
  "name": "Wait",
  "type": "n8n-nodes-base.wait",
  "typeVersion": 1,
  "position": [720, 580],          // <- canvas x/y lives IN the workflow
  "webhookId": "18a12605-..."
}
```

`position: [number, number]` is a required field on every node (`INode.position: [number, number]`). There is no separate layout file — pixel coordinates are first-class workflow data.

**Connections** (`IConnections`, `interfaces.ts:453`) are a nested map keyed by the **source node's display `name`** → output port → array of fan-out targets, each target also referencing the **destination by `name`**:

```json
"connections": {
  "Webhook": {                         // source node NAME (not id)
    "main": [                          // output port type
      [                                // output index 0
        { "node": "Wait", "type": "main", "index": 0 }   // target by NAME
      ]
    ]
  },
  "Wait": { "main": [[ { "node": "Set", "type": "main", "index": 0 } ]] }
}
```

The type chain is `IConnections[nodeName] → INodeConnections[portType] → IConnection[][]`, and `IConnection.node` is a `string` name (`interfaces.ts:95`).

**`pinData`** is also name-keyed (`IPinData { [nodeName: string]: ... }`, `interfaces.ts:1465`) — frozen sample data per node for testing.

**`settings`** (`IWorkflowSettings`, `interfaces.ts:3485`) is execution policy: `timezone`, `errorWorkflow`, `executionOrder`, `executionTimeout`, save policies. References other workflows by id-string.

**Data flow inside parameters** is the stringly-typed expression language — note it is *also* node-name-keyed and string-embedded, the exact pain the founder dislikes about Blok's `$`:

```json
"value": "={{ $('Webhook').item.json.headers['accept-encoding'] }}"
"leftValue": "={{ $json.v }}"
```

The leading `=` flags "this string is an expression"; `{{ }}` brackets the JS; `$json` / `$('NodeName')` reach into upstream outputs by name.

## Readability verdict

**Poor for human authoring; fine for a visual editor that owns the file.** Concrete failures against "clean, separate-layout, readable":

- **You cannot read the flow top-to-bottom.** Order of execution lives in `connections{}`, not in `nodes[]` order. To trace "what runs after Webhook" you cross-reference a node array against a separate nested map. There is no linear step list.
- **Name-keyed connections are fragile.** `connections`, `pinData`, and every `$('Name')` expression key on the node's mutable display `name` — yet nodes also carry a stable `id` (UUID) that the wiring ignores. Rename a node and you must rewrite three places (connections both as source-key and target-`node`, pinData, every expression that says `$('OldName')`). The schema makes the rename-safe field (`id`) the one *not* used for wiring.
- **Position pollutes the source.** `position: [720, 580]` sits on every node. Every drag in the UI mutates the workflow file → noisy diffs, merge conflicts on pure-layout changes, and pixel coordinates reviewers must mentally skip. Layout and logic share one blast radius.
- **Expressions are opaque strings.** `"={{ $('Webhook').item.json.headers['accept-encoding'] }}"` is unparseable by eye, untyped, and — like Blok's `$.state.x` / `js/ctx...` — couples the reference to a node name buried in a string. Same class of footgun the founder is trying to escape.
- **Verbosity for trivial wiring.** A simple A→B→C linear chain costs the deeply-nested `main: [[ {node,type,index} ]]` structure three times.

## Lessons for Blok authoring

1. **Keep the linear-step model — it's Blok's advantage.** Blok's `steps[]` array IS the execution order; n8n has to reconstruct order from a connection graph. Do not adopt n8n's name-keyed `connections{}` map. An ordered list reads top-to-bottom; a graph map does not.
2. **Split layout into a sibling file — validated by n8n's pain.** n8n's inline `position` is exactly the founder's complaint. Move canvas data to e.g. `workflow.layout.json` keyed by **stable step `id`**, never persisted in the authored workflow. The runner ignores it; the editor owns it; diffs stay clean.
3. **Reference by stable id, never by mutable display name.** n8n's worst fragility is wiring on `name` while a stable `id` exists unused. Blok already references via step `id` (`$.state.<id>`) — keep that, and make rename a no-op (only a `label`/`description` changes, never the reference key).
4. **Replace stringly-typed expressions with a typed, named-output reference.** Both n8n's `={{ $('Node').json.x }}` and Blok's `$.state.fetch` / `"js/ctx.state.x"` are the readability problem. A clean model exposes prior outputs as a typed handle (e.g. `inputs: { url: steps.fetch.output.url }` in TS, or a structured `{ from: "fetch", path: "url" }` in JSON) so the data flow is parseable, autocompletes, and survives renames — instead of a magic-prefixed string the reader must mentally evaluate.
5. **Three-way name coupling is the anti-pattern to avoid.** n8n forces a rename to touch connections + pinData + expressions. Single source of truth for step identity (the `id`) means a rename touches nothing structural.

## Sources

- `packages/workflow/src/interfaces.ts` — `INode` (1431, incl. `position: [number,number]`), `IConnections`/`INodeConnections`/`IConnection` (453/448/93, name-keyed wiring), `IPinData` (1465, name-keyed), `IWorkflowSettings` (3485).
- `packages/testing/playwright/workflows/Webhook_wait_set.json` — full real workflow (nodes+connections+pinData+settings shown above).
- `packages/testing/playwright/workflows/Check_manual_node_run_for_pinned_and_rundata.json:61` — real expression `"={{ $('Webhook').item.json.headers['accept-encoding'] }}"` (name-keyed, stringly-typed).

(Local repo at `…/scratchpad/research-repos/n8n`; no web sources used.)