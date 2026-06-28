I have everything. Here's the brief.

---

## What they do (with real code)

n8n nodes are a **single `INodeType` class** with one big `description` object (UI schema + metadata) plus *optional* execution hooks. The interface forces the shape:

```ts
export interface INodeType {
  description: INodeTypeDescription;          // UI schema + metadata (REQUIRED)
  execute?(this: IExecuteFunctions): Promise<NodeOutput>;     // programmatic
  trigger?(this: ITriggerFunctions): Promise<ITriggerResponse | undefined>;
  poll?(this: IPollFunctions): Promise<INodeExecutionData[][] | null>;
  webhook?(this: IWebhookFunctions): Promise<IWebhookResponseData>;
  methods?: { loadOptions?, listSearch?, credentialTest?, resourceMapping? };
}
```
*(`interfaces.ts:2159`)* — which hook you implement = what kind of node it is. No hook at all = pure declarative.

**Declarative / routing node** (`JinaAI/JinaAi.node.ts`) — no `execute()`. The HTTP call is data nested *inside* the operation option, under `routing`:

```ts
description: INodeTypeDescription = {
  displayName: 'Jina AI', name: 'jinaAi', group: ['transform'], version: 1,
  inputs: [NodeConnectionTypes.Main], outputs: [NodeConnectionTypes.Main],
  credentials: [{ name: 'jinaAiApi', required: true }],
  requestDefaults: { headers: { Accept: 'application/json' } },
  properties: [
    { displayName: 'Operation', name: 'operation', type: 'options',
      options: [{
        name: 'Read', value: 'read', action: 'Read URL content',
        routing: {
          request: { method: 'GET', url: '=https://r.jina.ai/{{ $parameter["url"] }}',
            headers: { 'X-Return-Format': '={{ $parameter["options"]["outputFormat"] }}' } },
          output: { postReceive: [{ type: 'rootProperty', properties: { property: 'data' } }] },
        },
      }] },
  ],
};
```
The whole node is a config tree — no imperative code. But note the **`={{ $parameter[...] }}` expression strings** baked into the data (n8n's exact equivalent of Blok's `$`/`js/ctx` strings the founder hates).

**Programmatic node** (`Code/Code.node.ts`) — same `description`, but adds `execute()`:

```ts
async execute(this: IExecuteFunctions) {
  const language = this.getNodeParameter('language', 0) as CodeNodeLanguageOption;
  const nodeMode = this.getNodeParameter('mode', 0) as CodeExecutionMode;
  const code = this.getNodeParameter('jsCode', 0) as string;
  const sandbox = new JsTaskRunnerSandbox(this.getMode(), this);
  return nodeMode === 'runOnceForAllItems'
    ? [await sandbox.runCodeAllItems(code)]
    : [await sandbox.runCodeForEachItem(code, this.getInputData().length)];
}
```
Inputs are pulled **imperatively** via `this.getNodeParameter(name, itemIndex)` — verbose, untyped (manual `as` casts), index-threaded.

**Trigger node** (`SseTrigger/SseTrigger.node.ts`) — differs in three ways: `group: ['trigger']`, **`inputs: []`** (no main input — it's a source), and it implements **`trigger()`** instead of `execute()`, returning a `closeFunction` for teardown:

```ts
description = { group: ['trigger'], inputs: [], outputs: [NodeConnectionTypes.Main],
  properties: [{ displayName: 'URL', name: 'url', type: 'string', required: true }] };

async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
  const eventSource = new EventSource(this.getNodeParameter('url') as string);
  eventSource.onmessage = (event) =>
    this.emit([this.helpers.returnJsonArray([jsonParse(event.data)])]);
  return { closeFunction: async () => eventSource.close() };
}
```
Long-poll sources use `poll()`, webhook sources use `webhook()` + a `webhooks` description block. The *shape* (description + one hook) never changes.

## Readability verdict

- **Good:** the `properties[]` UI schema is genuinely excellent for *reading data flow at a glance* — every input has a `displayName`, `type`, `default`, `description`, and `displayOptions.show` (conditional visibility). You can see the entire surface of a node without running it, and it auto-renders the form. `usableAsTool: true` flips a node into an AI tool for free.
- **Good:** the hook-presence convention is clean — `trigger`/`poll`/`webhook`/`execute`/none tells you the node's nature immediately.
- **Bad — verbosity:** declarative `routing` and `properties` are *deeply* nested, 5–6 levels of object literals; JinaAI is 465 lines for two operations. A property is ~8 lines of boilerplate (`displayName`/`name`/`type`/`default`/`displayOptions`...) before any real content.
- **Bad — the exact thing the founder dislikes:** n8n smuggles logic into strings — `'={{ $parameter["url"] }}'`, `subtitle: '={{ $parameter["operation"] + ": " + ... }}'`. Same stringly-typed-expression problem as Blok's `$.state.x` / `js/ctx...`. No type safety, no IDE help, fails at runtime.
- **Bad — programmatic ergonomics:** `getNodeParameter('x', itemIndex) as T` everywhere — no typed input object, manual casts, the item-index has to be threaded by hand.

## Lessons for Blok authoring

1. **Adopt the declarative `properties[]` UI schema, drop the stringly-typed expressions.** n8n proves a node's input surface should be *declared data* (name/type/default/description/conditional-show) — this is what makes a node instantly readable and auto-renders an editor form. Blok already has this via Zod (`input: z.object(...)`); lean into it as the canonical "what does this node take" contract. But **do NOT copy `={{ $parameter[...] }}`** — that's n8n's version of the founder's complaint.
2. **Replace `$.state.x` strings with a typed binding object, not an expression DSL.** n8n's pain is that data flow lives inside template strings. Cleaner: a step declares `inputs` as references resolved by name/type, e.g. `inputs: { url: from("fetch").url }` where `from()` returns a typed proxy that compiles to a binding — readable, autocompletes, fails at *author* time, no `js/` prefix. (Blok's `$` proxy is already close; the fix is making it read like a reference, not an expression — and never letting hand-written `js/ctx...` strings be the documented path.)
3. **Keep the "one shape, optional hooks" convention** — Blok's `defineNode()` with `execute()` is already this. Mirror n8n's trigger distinction explicitly: a trigger declares no input + a lifecycle hook with teardown. Blok's worker/HTTP triggers already separate this; make the *node file* visibly say "I am a source" the way `group: ['trigger'] + inputs: []` does.
4. **Don't nest routing config inside option arrays.** n8n's 465-line files come from burying HTTP requests 5 levels deep inside `properties[].options[].routing.request`. Keep Blok's flat `steps[]` with one step = one node ref + flat `inputs`. This is already Blok's advantage — protect it.
5. **The separate-canvas-file instinct is correct and n8n validates it negatively:** n8n bolts UI hints (`subtitle`, `triggerPanel`, `builderHint`, `iconColor`, huge HTML help strings) *into the node description*, bloating the logic file. Keeping layout/canvas in a sibling file is the cleaner split n8n never made.

## Sources

Local n8n repo (no web):
- `packages/nodes-base/nodes/JinaAI/JinaAi.node.ts` (declarative routing)
- `packages/nodes-base/nodes/Code/Code.node.ts` (programmatic `execute`)
- `packages/nodes-base/nodes/SseTrigger/SseTrigger.node.ts` (trigger)
- `packages/workflow/src/interfaces.ts:2159` (`INodeType`)