# Blok Core Redesign — Validation Report

Adversarial validation of the proposed core-authoring redesign (typed `step()` handles, `$ref`, `@blokjs/core`, killed `Nodes.ts`, cross-runtime stubs, all 10 triggers). 12 areas attacked; every hole became a task. Tracked in **GitHub Project #5 — Blok Core Redesign** (12 epics, 133 tasks: 24 spikes / 53 impl / 50 test / 6 docs).

## The decision that gates everything

**The `{$ref}` contract is not frozen, and the "byte-identical engine" claim is false.** The real Mapper (`core/shared/src/utils/Mapper.ts:269-288`) only resolves string values and recurses *into* plain objects — a structural `{ $ref: { step, path } }` is never dereferenced. Worse, a handle compiles to **three different wire forms** by position: a `{$ref}`/`js/` string in inputs, a structured segment inside `tpl`, and a **bare `ctx.state...` raw string** in `branch.when` (the if-else node raw-`eval`s a string). So either the DSL lowers handles to `js/` strings (reuse the engine; `{$ref}` is a fiction) **or** the mapper gains a real `$ref` branch (an engine change). Pick one before any code. This is the first spike in M1.

## Verdicts

| Epic | Verdict | Tasks |
|---|---|---|
| ir | `sound-with-risks` | 12 |
| handles | `sound-with-risks` | 14 |
| controlflow | `sound-with-risks` | 11 |
| context | `sound-with-risks` | 12 |
| persistence | `sound-with-risks` | 9 |
| nodes | `needs-rework` | 12 |
| crossruntime | `sound-with-risks` | 9 |
| corepkg | `sound-with-risks` | 10 |
| triggers | `sound-with-risks` | 11 |
| migration | `sound-with-risks` | 12 |
| studio | `needs-rework` | 11 |
| e2e | `sound-with-risks` | 1 |

## ir — Adversarial validation
**Verdict:** `sound-with-risks`  
The IR-as-formalized-v2-Zod approach is sound and high-leverage (mostly deletion of 2 stale hand-written schemas + 1 generated artifact). But I broke three load-bearing claims. (1) BYTE-IDENTICAL ENGINE IS FALSE for the redesign's `{ $ref: { step, path } }` input value: the real mapper (core/shared/src/utils/Mapper.ts:269-288) only resolves STRING values and recurses INTO plain object containers — it would walk into `{ $ref }` and try to string-resolve `step`/`path`, never resolving it as a reference. Either the DSL must compile `{ $ref }` back to a `js/ctx.state...` STRING before the mapper s

**Top risks found:**
- BYTE-IDENTICAL ENGINE CLAIM IS FALSE for structured `{ $ref }` input values. core/shared/src/utils/Mapper.ts:269-288 (replaceObjectStrings) only resolves `typeof value === 'string'` and recurses into plain containers (isPlainContainer, :235). A `{ $ref: { step, path } }` object is a plain container → mapper recurses INTO it, tries to string-resolve `step` and `path`, and NEVER resolves the ref. Re
- JSON workflows are NEVER Zod-validated today: scanWorkflows.ts does JSON.parse → normalizeWorkflow (tolerant structural reads, WorkflowNormalizer.ts:162). The 18 `.strict()` step schemas are STRICTER than the normalizer. Wiring validateWorkflow() as a mandatory JSON admission gate WILL reject some workflows that currently load and run — any JSON file carrying an extra field the normalizer ignores 
- 18 `.strict()` calls in StepOpts.ts across 8 step kinds + nested arms (branch then/else :373/:380, forEach body :709/:715, switch cases :811/:817, tryCatch :884/:890). `ui` must be added to ALL of them or it throws in the TS factory (workflowV2.ts:229 runs V2StepSchema.safeParse per step). Miss a nested-arm schema and `ui` on a step inside a branch/forEach throws while `ui` on a top-level step wor
- InternalStep constructors copy ENUMERATED fields only (8 constructors: regular :382, branch :516, subworkflow :572, wait :697, forEach :760, loop :827, switch ~860, tryCatch :953). The `[key:string]: unknown` index signature (WorkflowNormalizer.ts:98) is a TYPE affordance, not a runtime copy — verified normalizeRegularStep hand-lists every field. `ui` is dropped on the floor unless added to all 8 
- The TS author surface (WorkflowOpts interface, WorkflowOpts.ts:39-98 and the V2Step type) has no `schemaVersion`/`ui` fields. Adding them to the Zod schema alone is insufficient — the hand-written TS interfaces that authors program against need the fields too, or TS authors can't set them with type safety (only the Zod runtime accepts them).

**Open questions:**
- Does the runtime IR carry `{ $ref: { step, path } }` as a structured object, or does the DSL lower it to a `js/ctx.state...` string before serialization? This is THE contract decision and it determines whether the mapper needs changing. The deck says both things in different places. Resolve before f
- Is validateWorkflow() advisory (warn, Studio rendering hint, registry gate) or an enforced admission gate on load? If enforced on the JSON load path it's a breaking change. Recommend: advisory + registry-publish-only enforcement; never block scanWorkflows load in v2.
- Does the published schema describe ONLY v2, treating v1 as legacy/normalizer-only (spec recommends this)? If so, validateWorkflow() must structurally detect v1 and skip/route it, not strict-reject it — otherwise every v1 file fails validation with strict-mode noise.
- Should WorkflowV2Schema itself become `.strict()` for parity with steps, or stay open so input/output/events/middleware/schemaVersion/ui all pass? Currently open. If it stays open, `schemaVersion` typos (`schemaVesion`) pass silently. If it goes strict, it must enumerate every metadata field.
- Can the Studio bundle absorb Zod + the full StepOpts schema graph, or is the server-side validate endpoint (§7.5b) actually required for M5? Needs a measured bundle-size delta, not a recommendation.

## handles — Typed step() handles + $ref engine
**Verdict:** `sound-with-risks`  
Verdict: SOUND-WITH-RISKS. The surface (typed step() handles, tpl, branch-on-handle) is achievable in TS and is a real ergonomic win, but the headline "same {$ref} engine, byte-identical runtime" claim is FALSE as written and is the load-bearing risk the founder must not ship on faith.

GROUNDED FINDINGS (verified against real code):

1. {$ref} IS NOT RESOLVED BY TODAY'S MAPPER — CONFIRMED. core/shared/src/utils/Mapper.ts:269-288 `replaceObjectStrings` only transforms values where `typeof value === "string"` (via replaceString→jsMapper, which itself no-ops unless the string starts with "js/", 

**Top risks found:**
- {$ref} is NOT resolved by today's Mapper (verified Mapper.ts:269-288 + 361) — the 'byte-identical engine' claim is false; the design must EXPLICITLY choose js/-string lowering (engine reused, {$ref}-in-IR is fiction) OR a new mapper {$ref} branch (engine changes). The deck asserts both, which is contradictory.
- branch-on-handle needs a THIRD lowering: the if-else node evals when as a raw Function(ctx) string (if-else index.ts:73-74), never via the mapper — so a boolean handle must become a bare `ctx.state.<step>.<path>` string, distinct from the input lowering AND from tpl. 'One surface' compiles to three wire forms.
- defineNode's output type is currently ERASED to BlokService<unknown> (deck section 2 confirms). step() inferring the node's Zod OUTPUT into the handle requires defineNode to carry a phantom output type param — that is NEW work, not the 'untouched defineNode' the deck claims.
- step() has a registration side-effect that must target the CURRENT branch arm; the callback-style factory needs an ambient builder stack (push/pop per arm). The deck never shows this. Misuse (step() outside a workflow callback, or a deferred thunk) registers to the wrong arm or throws — highest implementation risk.
- Cross-arm handle reads type as present but resolve to state[step]===undefined when the producing step was in an untaken arm — the type system LIES where the string form at least signaled late-binding. Honesty regression unless cross-arm handles are typed optional or made compile errors.

**Open questions:**
- Q1 (BLOCKING): Lower handle reads to `js/ctx.state.<step>.<path>` STRINGS (reuse Mapper byte-for-byte, but {$ref}-in-the-IR is a fiction and the canvas/JSON-twin must read js/ strings) OR add a real `{$ref}` resolution branch to the Mapper (genuine engine change, needs error-context + idempotency-ke
- Q2: How does step() register into the CURRENT branch/forEach arm? Ambient module-level builder stack (push/pop per arm callback) or an explicit builder passed into each callback? What happens if step() is called outside any workflow() callback?
- Q3: Is reading a handle declared in one branch arm from outside that arm a COMPILE error, a runtime-undefined (current string-form behavior), or typed-optional? The type currently lies (non-optional field, undefined at runtime).
- Q4: In the recorded ref, how is a whole-output reference (`stock`) distinguished from a field reference (`stock.field`) — path:[] vs path:[...]? And how does the Proxy know a property read is TERMINAL (a leaf value the node wants) vs a traversal step? Optional/array/union fields make this non-obviou
- Q5: How does step('id', node, inputs) infer the node's OUTPUT type into the handle, given defineNode currently erases to BlokService<unknown>? Does defineNode need to carry z.infer<output> as a phantom type param (new work), and does that break the existing Nodes.ts Record typing during the migratio

## controlflow — Control-flow over handles
**Verdict:** `sound-with-risks`  
The proposed handle-based control-flow surface is sound in DIRECTION but rests on three engine-level holes that the new authoring sugar does not close and in two cases makes WORSE by hiding ids. (1) Duplicate step-ids across branch/switch/tryCatch/forEach arms silently collide in the flat per-workflow config map (`innerNodes[regularStep.name] = nodeConfig` in WorkflowNormalizer; the matched arm runs the OTHER arm's inputs) — there is a test literally titled "Bug 3 — real cause is duplicate inner ids", so this is known and unfixed. Handles make ids feel auto-generated, which will MASS-produce c

**Top risks found:**
- DUPLICATE-ID COLLISION (critical, known-unfixed): WorkflowNormalizer.normalizeBranchStep builds `innerNodes` as a flat Record keyed by step name; duplicate ids across then/else arms (and switch cases, tryCatch try/catch, forEach bodies) overwrite silently — last write wins. The matched arm executes with the OTHER arm's inputs. Existing test foreach-switch-state.test.ts:100 is titled 'Bug 3 — real 
- BRANCH RAW-EVAL FOOTGUN STILL LIVE (critical): the if-else node (nodes/control-flow/if-else@1.0.0/index.ts:17-25,74) compiles `condition.condition` via `Function('ctx',...)` with NO js/ strip. A boolean handle `branch(x.field)` MUST emit a bare-ctx string (e.g. `ctx.state.x.field`), NOT a `js/ctx...` string — otherwise it throws `ReferenceError: js is not defined` inside the node (the exact docume
- FOREACH ITEM-HANDLE NAMESPACE COLLISION: cloneCtxForIteration sets `state[as] = item` and `state[as+'Index'] = i` into the SAME flat state object shared with all step ids. A per-item handle scoped as `item` collides with any sibling/outer step `id: 'item'` (and `itemIndex` collides with a step `id: 'itemIndex'`). The forEach() factory validates `as` is a JS identifier but does NOT check it against
- HANDLE ESCAPING ITS BRANCH ARM (soundness, type-vs-runtime divergence): a handle produced by a step inside `then` is type-visible to code in `else` or after the branch, but at RUNTIME that step never ran, so `state[id]` is undefined. Same for switch cases and tryCatch try-arm handles read after the block. The structural `{$ref}` records the path unconditionally; nothing proves the referenced step 
- TRYCATCH ERROR-ENVELOPE OPTIONALITY: toErrorEnvelope (TryCatchNode.ts:67-133) types message/name as always-present but code/stepId as conditional (`...meta` only spreads when defined). A non-GlobalError throw yields code:undefined; a pre-wrap throw yields stepId:undefined. The proposed typed `$.error` handle must model code?/stepId? as OPTIONAL or authors reading `error.code` get a non-optional ty

**Open questions:**
- Duplicate-id policy: hard-THROW at load time on any duplicate id within a workflow (including across arms), or auto-uniquify by suffixing arm path (e.g. `route.then.create`)? Throw is safer + matches the standing 'framework bug → fail loud' rule; auto-uniquify is friendlier to handle-based authoring
- Boolean-handle compilation target: should a bare boolean handle `branch(x.field)` compile to `ctx.state.x.field` (raw, evals truthy) AND emit the S3 build-time warn-nudge that it's a truthiness check, or REQUIRE a gt/eq/lt op for non-boolean-typed handles? The type system CAN distinguish a `z.boolea
- Does the new layer ship ON TOP of the unshipped S3 Mapper-routing fix, or independently? If branch/loop conditions still hit the raw if-else/LoopNode eval, the handle layer must emit raw-ctx strings AND the S3 fix is a hard prerequisite for any handle that isn't a literal comparison. Sequencing matt
- forEach item-handle scope: enforce that `as` cannot equal any surrounding step id (load-time throw), or make item-handles a genuinely separate namespace (e.g. `ctx.loop[as]` instead of `ctx.state[as]`) so they CAN'T collide? The latter is an engine change (breaks the byte-identical claim) but is the
- Handle-escapes-arm: should reading a handle outside its proving branch arm be a TYPE error (track arm-scope in the handle type), or remain a runtime-undefined the author must guard? Type-level arm scoping is a large TS undertaking; the lazy answer is runtime-undefined + a documented `state[id] === u

## context — Adversarial validation: Remove the ctx authoring surface
**Verdict:** `sound-with-risks`  
The handle model is sound for the COMMON case (field reads chained between steps). Every primary workflow-authoring `ctx.*` form has a structural replacement: `ctx.state[id]` -> step handle; `ctx.prev` -> immediately-prior handle; `ctx.req`/event/job -> typed entry handle; `$.error` -> per-`tryCatch.catch` error handle; forEach item -> per-item handle. But the precise boundary is **non-author-facing, not removed**: `defineNode.execute(ctx, input)` at `core/runner/src/defineNode.ts:76` is the node ABI and stays unchanged. Nodes still receive the full `Context`.

**ctx boundary table (new handle-style workflow files):**

| ctx member | Author replacement handle | Retained node-side? | Internal-only? |
|---|---|---:|---:|
| `ctx.request` / `ctx.req` | trigger entry handle (`req`, `event`, `job`, `msg`, `tick`, `rpc`, etc.) | yes | no |
| `ctx.response` / `ctx.prev` | the step handle already bound in local TS; adjacent output is just the previous const | yes | no |
| `ctx.state` | named step handles; for rare dynamic keys use the explicit escape hatch decided by the persistence/vars tasks | yes, rare reads allowed; never write directly | no |
| `ctx.vars` | no new author surface; legacy alias of `ctx.state` and dynamic side-channel escape | yes, for back-compat / cross-runtime `vars_delta` | no |
| `ctx.error` | `catch: (err) => ...` typed error handle | yes inside try/catch implementation and helper nodes | no |
| `ctx.logger` | no author handle; logging is a node concern | yes | no |
| `ctx.config` | validated `input` argument to `execute(ctx, input)` | yes for legacy/custom nodes | no |
| `ctx.func` | no author handle | yes for function/runtime internals | no |
| `ctx.env` | no workflow handle; future managed connections use `ctx.auth`, not author expressions | yes | no |
| `ctx.publish(name, value)` | none; side-channel publication is node-only | yes | no |
| `ctx.signal` | none; cooperative cancellation is node-only | yes | no |
| `ctx.connection` | none in ordinary workflow authoring; WS helper nodes may use it | yes (`ConnectionContext`) | no |
| `ctx.stream` | none in ordinary workflow authoring; SSE helper nodes may use it | yes (`StreamContext`) | no |
| `ctx.id`, `ctx.workflow_name`, `ctx.workflow_path` | no author handle | read-only diagnostics if a node needs them | mostly |
| `ctx.eventLogger` | no author handle | avoid in ordinary nodes; tracing plumbing owns it | yes |
| `ctx._PRIVATE_` | none | no | yes |

**Migration lint:** new handle-style workflow files may not name `ctx`. Node files may: `defineNode({ async execute(ctx, input) { ... } })` is unchanged. A node that legitimately needs a cross-step read inside `execute` may still read `ctx.state`, but should prefer its validated `input` when possible and must not write `ctx.state` directly. Helper nodes such as `@blokjs/ws-reply`, `@blokjs/ws-broadcast`, `@blokjs/sse-subscribe`, and `@blokjs/sse-stream` remain valid node-side users of `ctx.connection`/`ctx.stream`.

**Top risks found:**
- EXPRESSIVENESS LOSS (highest): triggers/http/src/workflows/examples/*.ts use arbitrary exprs the structural {$ref} cannot encode -- 'js/ctx.request.body.tenantId || 1default1', 'body.action || null', 'body.commits || []' (coalescing/defaulting), plus implied arithmetic/.filter/.map/concat. A handle that only records {$ref:{step,path}} loses these. tpl covers string interpolation only. Without a de
- CTX IS THE NODE ABI, NOT REMOVABLE: defineNode.execute(ctx, input) (core/runner/src/defineNode.ts:76) passes full Context to every node. ctx.publish (TriggerBase.ts:1767, createChildContext.ts:128), ctx.signal (Context.ts:126), ctx.connection (ConnectionContext, WebSocket), ctx.stream (StreamContext, SSE) are node-side APIs with NO handle equivalent and no business being one. The epic says ctx 'be
- BRANCH WHEN BYPASSES THE MAPPER/HANDLE PATH: branch when is a raw Function(ctx) eval, NOT mapper-resolved (understand-mapper.md invariant #7; eq.ts header comment). gt/eq/ne/lt emit raw 'ctx.* op literal' strings (eq.ts). So a 'boolean handle' for branch must compile to that raw-ctx form, not a {$ref}. If the new branch(handle) naively emits {$ref} it will 500 at runtime exactly like the documente
- CROSS-RUNTIME vars_delta HAS NO HANDLE: cross-runtime nodes publish extra state via the proto vars_delta field, merged in RuntimeAdapterNode.ts:111-115 (Object.assign(state, result.vars)). Those keys are dynamic, decided at runtime by the sidecar, unknown to the TS type system. A typed handle shaped from the node Zod OUTPUT cannot reference them (they are not in output). Either vars_delta keys mus
- SPREAD AND AS BREAK HANDLE IDENTITY: with spread:true the result.data keys merge into state at top level (state.user not state.<id>.user); with as:'name' the result lands at state[name]. The handle returned by step() is shaped from the node output and keyed by id -- but the actual state key changes. forEach 'as' similarly writes state[as] and state[as+'Index'] (forEach.ts). If step() returns one h

**Open questions / resolved boundaries:**
- What is the sanctioned escape hatch for non-structural expressions (|| default, arithmetic, .filter/.map, concat beyond tpl)? Options: a js`...` tagged-template handle that emits a raw js/ literal (lowest effort, reuses existing mapper), an expr(fn) helper, or forcing a @blokjs/expr compute node. Th
- **Resolved boundary:** `ctx` is out of scope only for new handle-style workflow authoring. It remains the unchanged `defineNode` ABI (`execute(ctx, input)`), so node files keep `ctx.publish`, `ctx.signal`, `ctx.connection`, `ctx.stream`, `ctx.logger`, `ctx.func`, and rare `ctx.state` reads.
- Does branch unify onto the mapper path, or does the boolean handle keep compiling to the raw-ctx Function form? Unifying is cleaner but is an engine change that contradicts the 'engine byte-identical' claim. Keeping raw-ctx means the handle compiler needs a second emit mode.
- How do authors reference cross-runtime vars_delta keys and ctx.publish names that are not in the node Zod output? Declare them in the manifest, or provide an untyped state('name') accessor?
- Is ctx.prev adjacency dropped entirely in the new DSL (handles only), and if so, what replaces the genuinely-ergonomic 'use the last step's output' pattern inside a single linear pipeline?

## persistence — Adversarial validation: Auto-persist-all + handle resolution
**Verdict:** `sound-with-risks`  
The engine claim holds. PersistenceHelper.applyStepOutput (Rules 0/1/2/3) and Mapper.jsMapper can stay byte-identical. A step() handle that records {$ref:{step,path}} and unwraps to "js/ctx.state.<step>.<path>" is exactly the wire-shape the existing $-proxy already produces (core/workflow-helper/src/proxy/$.ts unwraps "$.state.fetch" to "js/ctx.state.fetch"). So "only the authoring surface changes" is TRUE for the happy path: a handle is a typed $-proxy rooted at a known step id, and the runner needs zero engine changes to resolve it. The adversarial pass found real soundness gaps where the au

**Top risks found:**
- R1 (GATING) Ephemeral handle read is silent, not loud. step("log", node, {ephemeral:true}) returns a handle; reading x.field unwraps to js/ctx.state.log.field. Rule 1 in PersistenceHelper.ts:64 never wrote state.log, so at runtime it is an undefined access. With the default BLOK_MAPPER_MODE=strict it throws MapperResolutionError at the CONSUMING step (wrong blame target, message mentions the consu
- R2 as/spread relocate the output away from state[id], breaking the handle's path root. as:"foo" -> applyStepOutput Rule 3 writes state.foo not state.<id>; spread:true -> Rule 2 scatters result.data.{k} into state.{k}. A handle minted from the step id (and unwrapping to js/ctx.state.<id>...) resolves to undefined under either knob. The handle's compiled root MUST be derived from the persistence dec
- R3 forEach per-item handle is closure-scoped and mutation-based. ForEachNode.ts:586-587 does state[as]=item / state[as+'Index']=i, overwriting every iteration. A typed per-item handle compiles to js/ctx.state.<as>. It is ONLY valid inside the do[] body of that iteration. If an author captures the per-item handle and references it from a step AFTER the forEach, it resolves to the LAST item (sequent
- R4 Truthful-undefined contract is preserved BUT now ambiguous between two causes. Rule 0 (errored result) and Rule 1 (ephemeral) BOTH leave state[id]===undefined. Under handles, state[id]===undefined inside a tryCatch.catch arm can mean either 'step threw' or 'step was ephemeral' - the author's did-this-succeed check silently lies for ephemeral steps. The handle layer must forbid the existence-che
- R5 Persist-all memory growth has no measured ceiling. Every successful step writes state[id]; forEach over N items mutates state[as] N times (bounded, good) but a workflow with thousands of sequential persisted steps, or spread steps fanning many keys, grows ctx.state monotonically for the whole run. Long-lived runs (wait/defer/re-entry) keep the whole state object resident and re-serialize it int

**Open questions:**
- Should an ephemeral step be allowed to return a handle at all, or should step(id, node, {ephemeral:true}) return void (TS error on any read)? Returning a branded EphemeralHandle gives a better error message than void but costs a type.
- For spread:true, do we require the node's Zod output to be a statically-known object so each key becomes a typed sub-handle, and hard-error at authoring if output is z.unknown()/z.record()? Without that, spread handles cannot be sound.
- Do we add a thin runtime guard in the Mapper (or a pre-flight) that, when a js/ctx.state.<id> ref resolves to undefined, throws a NamedMissingStateError carrying the step id and the referencing step - turning R1/R2/R3 runtime failures from generic undefined-access into blameable errors? This is a sm
- Should the IR carry the {$ref:{step,path}} structurally (not pre-compiled to js/ strings) so the canvas and AI can validate dangling refs statically, with the js/ compilation happening only at the runner boundary? The mandate says the DSL compiles to js/-shaped inputs today via unwrapProxies; keepin
- What is the acceptable upper bound on ctx.state size for a single run, and do we want an opt-in state-slot GC (drop slots no downstream step references, computable from the handle graph at compile time) before this ships at scale?

## nodes — EPIC: defineNode unchanged + import-registration (kill Nodes.ts)
**Verdict:** `needs-rework`  
The "defineNode() unchanged" half is true and safe: FunctionNode (core/runner/src/defineNode.ts) sets this.name = definition.name and is wired into the registry purely by the OUTSIDE — nothing in defineNode reads or derives a use-string, so it can stay byte-identical. The dangerous half is "use derived from node.name." It is FALSE against the live corpus. Today the registry key (what `use:` references and what moduleResolver looks up via opts.nodes.getNode(node.node)) is set by the HAND FILE triggers/http/src/Nodes.ts / HELPER_NODES / ExampleNodes maps — and that key diverges from node.name in

**Top risks found:**
- FALSE INVARIANT (highest): 'use derived from node.name' does not hold today. node.name != registry key for api-call (name 'api-call' / key '@blokjs/api-call'), if-else, and most example nodes (base64-pdf, save-image, dashboard-ui). Deriving use from name silently re-keys the whole library; every existing workflow referencing '@blokjs/api-call' gets 'Node ... not found'. Proven by reading nodes/web
- THREE competing keying schemes today: (a) registry key from the hand maps in triggers/http/src/Nodes.ts + HELPER_NODES + ExampleNodes; (b) node.name in defineNode; (c) HMR keys by FILE PATH (core/runner/src/hmr/index.ts: nodeMap.addNode(event.relativePath, mod.default)). 'import = registration' must reconcile all three or HMR re-registration will key a node differently from its boot-time key, so a
- Collisions are SILENT today: Nodes.ts builds the map via object spread (...HELPER_NODES, ...EvalNodes, ...ExampleNodes). A user node whose name collides with a built-in (e.g. a user 'respond' or '@blokjs/log') overwrites the built-in last-wins with no warning. Killing the hand-file and auto-importing makes collisions MORE likely (no curated single map) while keeping them silent. There is no duplic
- The JSON/palette path is already lossy: triggers/http/src/runner/nodeCatalog.ts:88 emits `name: r.name ?? key` and discards `key`. The Studio palette / JSON authoring therefore cannot surface the actual `use` string for any node where name != key. 'Auto-discovery for JSON workflows + palette' will reproduce the SAME hand-file by another name unless the canonical-key rule is enforced AND the catalo
- Cross-runtime stub generation rests on schemas that are mostly NULL today: GrpcRuntimeAdapter.listNodes (core/runner/src/adapters/grpc/GrpcRuntimeAdapter.ts:474) returns inputSchema/outputSchema from parseSchemaBytes, and the code comment + parseSchemaBytes both confirm the SDKs largely don't emit schema bytes yet ('until then they're empty -> null'). A generated typed runtimeNode stub would have 

**Open questions:**
- What is the ONE canonical key rule? Options: (a) `name` must equal the fully-qualified ref and we migrate api-call/if-else/examples to `name: '@blokjs/api-call'` etc.; (b) keep `node.name` short and derive `use` from the package name + name; (c) keep an explicit, generated (not hand-written) manifes
- On a name/use collision (user node shadows a built-in), is the desired behavior throw-at-startup, warn-and-last-wins (current implicit), or namespaced-coexist? This is a product decision with security implications (a user node shadowing '@blokjs/jwt-verify' is an auth bypass).
- Does 'import = registration' run at module-eval time (side-effectful import) or via an explicit barrel/glob the build generates? A glob-generated barrel IS a hand-file the build owns — acceptable, but it must be named as such so it isn't sold as 'no file'.
- For runtime nodes whose ListNodes returns null schemas, does `blokctl nodes sync` (a) generate an `unknown`-typed stub, (b) refuse to generate and require the SDK to emit schema, or (c) let the author hand-annotate? This gates whether cross-runtime typed handles are real or aspirational.
- How does HMR re-key on edit so the edited node replaces the SAME registry entry it had at boot? Today it keys by relativePath; the canonical rule must be applied identically in hmr/index.ts and at boot, or edits silently fork the registry.

## crossruntime — Typed runtimeNode stubs + ListNodes manifest codegen
**Verdict:** `sound-with-risks`  
The plumbing this epic depends on is ALREADY BUILT and verified in all 7 SDKs: every SDK implements gRPC ListNodes returning NodeDescriptor{input_schema_json, output_schema_json} (Go sdks/go/grpc_server.go:207, Python sdks/python3/blok/server/grpc_server.py:275, Ruby grpc_server.rb:80, PHP BlokNodeRuntimeService.php:87, plus Rust/Java/C#). The runner already aggregates them: core/runner GrpcRuntimeAdapter.listNodes() parses the schema bytes (line 474), triggers/http/src/runner/nodeCatalog.ts:buildNodeCatalog() flattens module + all runtime nodes into GET /__blok/nodes, and blokctl nodes list (

**Top risks found:**
- NO-SCHEMA NODES ARE THE COMMON CASE, NOT THE EDGE. Every SDK returns nil/None when a node lacks a typed model (Go define_node.go:79, Python define_node.py:124 returns None, Ruby typed_node.rb:132 nil out-schema, PHP NodeReflector ?array). Dynamic langs (Python/Ruby/PHP) reflect from a DECLARED Pydantic model / field-DSL / array — NOT an fs-scan of arbitrary code as the research brief's 'fs-scan' f
- CHICKEN-AND-EGG: listNodes() is a LIVE gRPC call (GrpcRuntimeAdapter.ts:474) — it requires the sidecar process running. So `nodes sync` cannot generate stubs for a runtime that won't boot. On a clean checkout / CI / fresh clone with no runtimes started, sync produces nothing. 'Codegen on blokctl dev' has a race: dev spawns the sidecars AND the runner; stubs must be generated AFTER each sidecar's H
- STALE STUBS vs PROTO/SCHEMA DRIFT: stubs are generated artifacts checked in (like gen app-types' blok-app.d.ts). If an author edits a Go node's struct and forgets `nodes sync`, the .ts stub's type lies — typecheck passes against the OLD shape, runtime fails when the mapper resolves a $ref to a field the new node never returns. Nothing detects this unless sync runs in CI with a git-dirty check. Pro
- SAME NODE NAME ACROSS RUNTIMES is explicitly allowed (understand-runtimes.md invariant #3: name unique PER runtime, not globally). buildNodeCatalog flattens `validate-card`@runtime.go AND `validate-card`@runtime.python3 into one list differentiated only by `runtime` field. The vision says `use` is DERIVED FROM node.name — but two runtimes both expose `validate-card`, so the derived `use:'validate-
- JSON-SCHEMA → TS TYPE FIDELITY: no json-schema-to-typescript dep exists in the repo (checked package.json / cli / runner). Pydantic, go-jsonschema (Reflector{DoNotReference,ExpandedStruct}), Ruby's hand-rolled {type:object,properties}, and PHP arrays emit DIFFERENT JSON-Schema dialects (draft versions, $ref expansion, format keywords, nullable vs anyOf[null], additionalProperties defaults, enum/on

**Open questions:**
- When a node reports no schema, does the stub emit (a) an untyped handle Record<string,unknown>→unknown, (b) skip the node entirely and warn (like gen app-types skips JSON workflows), or (c) fail sync? Recommend (a) so the node is still callable, with a // no-schema comment + a warning listing untype
- Where do stubs live and are they git-checked-in (like blok-app.d.ts) or gitignored generated artifacts? Checked-in enables CI drift detection; gitignored avoids merge noise but needs a build-step guarantee.
- Should `nodes sync` read the live GET /__blok/nodes (reuse buildNodeCatalog, needs server up) or call each adapter.listNodes() directly (needs sidecars up but not the full trigger)? Reusing the HTTP endpoint is the laziest correct path and already battle-tested.
- How is same-name-across-runtimes disambiguated in the authoring DSL — per-runtime module namespacing (import {validateCard} from './nodes/go') or a qualified use string? This blocks the codegen output shape.
- Does the dev-loop regen on sidecar Health=SERVING (event-driven) or poll? And does a sidecar that never boots block dev startup or just warn + skip its stubs?

## corepkg — @blokjs/core consolidation + packaging
**Verdict:** `sound-with-risks`  
The merge of runner+shared+helper into one @blokjs/core is structurally SOUND on the dependency graph: shared has no internal deps, helper depends only on zod (NOT shared — confirmed, no grep hit), and runner depends on both helper and shared. That is a clean DAG, so there is no circular-dependency risk between the three merged units, and lockstep release (release.ts PUBLISHABLE list + checkLockstepVersion + checkCrossDepRanges + checkCliConstants) can be retired for these three.

BUT the tree-shaking and back-compat claims do NOT survive scrutiny as written:

1. NO package in the repo declare

**Top risks found:**
- TREE-SHAKING UNVERIFIED: no `sideEffects:false` exists anywhere. Merging the runner barrel (re-exports grpc/otel/sqlite as VALUE exports) with the DSL into one entry means `import {workflow}` pulls the runtime's heavy transitive graph. Needs an exports-map subpath split (@blokjs/core/dsl vs runtime) + sideEffects:false + a bundle-size assertion, or the 'unused drops' claim is false.
- $ref IS NEW CODE, NOT THE EXISTING ENGINE: today `$` lowers to `js/ctx....` strings (unwrapProxies + JS_EXPR_TAG) and Mapper resolves via slice(3) eval. `{$ref:{step,path}}` appears nowhere in core/. The 'mapper is byte-identical' claim is FALSE unless handles lower to js/ strings at definition time. Decide: new mapper $ref branch vs lower-to-js/. Each has different soundness/perf.
- SHIM SURFACE IS HUGE + MIXED: 144/137/99 files import runner/shared/helper. Shims must re-export value AND type exports verbatim. `export *` risks dual-name (type+value same identifier like FunctionNode/FnNodeDefinition) collisions and breaks `import type` elision. A deprecation console.warn at import time would fire on EVERY boot for unmigrated users — annoying and un-silenceable without an env f
- AUTO-DISCOVERY AMBIGUITY: Nodes.ts mixes package-named nodes (`@blokjs/api-call` where package name == node name) with local nodes (`chain-init`, name-derived) and a SPREAD map (`...HELPER_NODES` = 20+ nodes from ONE package). 'import = registration, use derived from node.name' breaks for the helpers package: one import yields many node.names. Auto-discovery must handle 1-package-N-nodes and name 
- RELEASE.TS PARTIAL TEARDOWN: checkCrossDepRanges/checkLockstepVersion span ALL 16 packages, not just the 3 merging. Removing lockstep for core while triggers+nodes+cli STILL lockstep (scaffold needs them co-versioned, see the v0.6 comment block) means release.ts becomes a HYBRID: independent @blokjs/core + still-lockstepped rest. checkCliConstants (GITHUB_REPO_RELEASE_TAG/BLOKJS_DEP_RANGE pin) ass

**Open questions:**
- $ref lowering: does the DSL emit structural `{$ref}` (new mapper branch) or lower to `js/ctx.state.<step>.<path>` strings at definition time (engine unchanged)? This is the single highest-leverage decision and gates whether 'byte-identical engine' is true.
- Exports-map shape for @blokjs/core: one entry (`.`) or split subpaths (`./dsl`, `./runtime`, `./testing`)? The DSL-in-author-bundle weight depends entirely on this.
- Lockstep: does ending lockstep apply ONLY to @blokjs/core, or also to triggers and nodes? release.ts's scaffold-pin logic (trigger-http imports 4 sibling packages by ^version) assumes co-versioning — partial decoupling needs a documented version-compat matrix.
- Deprecation shim: console.warn on import (noisy, every boot) vs JSDoc @deprecated only (silent, IDE-only) vs a one-time process-level warn? And for how many minor versions do shims live before removal?
- Node-name collision policy when two independently-published packages both export a node whose `node.name` is the same string — last-import-wins (current Map behavior) or hard error at discovery?

## triggers — Adversarial validation: all 10 triggers as typed entry handles in the new Blok DSL
**Verdict:** `sound-with-risks`  
The 10-trigger typed-entry-handle plan is SOUND for the 6 unary/request-shaped triggers (http/webhook/cron/worker/pubsub/grpc) because they all already funnel their payload into the SAME shape — `ctx.request.{body,headers,query,params}` plus a per-trigger side-channel in `ctx.vars` (`_cron_context`, `_worker_job`, `_pubsub_message`). So a typed entry handle (req/event/job/msg/tick/rpc) is a THIN typed projection over `ctx.request.body` + the trigger's side-channel — no runner change needed, just a per-trigger TS type and a handle factory. Grounding: triggers/cron/src/CronTrigger.ts:432, trigge

**Top risks found:**
- SSE/WebSocket break the declarative purity: the shipped emit model (ctx.stream.writeSSE / ctx.connection.send in StreamContext.ts/ConnectionContext.ts) is imperative and long-lived. The new DSL has no expression for 'hold the connection and emit in a loop'. conn/stream handles must expose imperative methods, contradicting 'NO ctx, no side effects in authoring'. Untouched, authors fall back to raw 
- manual trigger has NO runtime whatsoever — only an enum entry + null schema + visualizer label. There is no dispatcher, no ctx builder, no source for the `args` handle. The plan lists it as one of 10 'helpers' as if it exists; it must be built from zero, and its dispatch surface (programmatic .run(args)? blokctl invoke? test harness only?) is undefined.
- grpc and manual have null config schemas (TRIGGER_SCHEMAS.grpc/manual = null) → zero validation. grpc's payload is whatever the runtime adapter writes to messageContext.request (GRpcTrigger.ts:151), with no framework-level type. The rpc entry handle has no typed source; deriving req/resp typing requires a proto-or-Zod schema story that doesn't exist yet.
- Mapper {$ref} gap extends to entry handles: side-channels are plain objects in ctx.vars (_cron_context, _worker_job, _pubsub_message). If entry handles are structural proxies, Mapper.ts (string-only resolution) won't resolve them — same root issue as step() handles. Two resolution paths can silently diverge.
- Side-channel data is DUPLICATED and INCONSISTENT: cron puts the job in BOTH ctx.request.body AND ctx.vars._cron_context (with different value types — Date vs ISO string, see CronTrigger.ts:432 vs :449). worker/pubsub do the same. A typed handle must pick ONE source of truth; picking ctx.request.body loses the typed metadata, picking ctx.vars loses the body, and the two disagree on types (Date obje

**Open questions:**
- What dispatches a `manual` trigger and what is the shape of its `args` handle? Programmatic workflow.run(args), a blokctl invoke command, test-harness-only, or all three? This decides whether manual needs a real listen()/runtime or is purely a typed in-process entry.
- For SSE/WebSocket, does the new DSL accept an explicit escape hatch (a `stream`/`conn` handle with imperative emit methods that IS allowed to be impure), or does it model streaming as a terminal step that consumes an async-iterator handle (declarative)? The shipped helper-node model (@blokjs/sse-str
- Should the entry handle read from ctx.request.body (the canonical body) or the trigger's typed side-channel (ctx.vars._cron_context etc.)? They carry different types for the same field (Date vs ISO string). Pick one as the typed source and document the other as legacy.
- Does the entry handle lower to a `js/ctx...` string at compile time (mapper resolves it as today) or stay a structural {$ref} the mapper must learn to resolve? Must match whatever step()-handle resolution decides — confirm a single shared lowering.
- For webhook/grpc/mcp typed payloads: is per-trigger payload typing author-supplied (a Zod schema on the trigger config or workflow.input) or framework-provided? grpc/webhook configs currently have no input-schema field; adding one is the only way `event`/`rpc` are typed rather than `unknown`.

## migration — Codemods + back-compat + hybrid coexistence
**Verdict:** `sound-with-risks`  
Validated the codemod/back-compat/hybrid story against the real tree (1611 TS + 545 JSON workflows; the real $ proxy compiler at core/workflow-helper/src/proxy/$.ts; eq.ts comparators; triggers/http/src/Nodes.ts; WorkflowNormalizer). Five load-bearing holes the deck glosses over. (1) Un-migratable expressions are the COMMON case: 58 of 338 js/ expressions in shipped JSON contain real logic (|| defaults, ?? , ternaries, [...spread,{...}], process.env, Date.now(), Array.isArray(x)?x:[], (x||'').toLowerCase()) — none map to a handle or tpl. On the most-copied workflows (agent, chat, webhook-githu

**Top risks found:**
- UN-MIGRATABLE IS THE MAJORITY ON HOT WORKFLOWS: 58/338 js/ expressions carry logic; tpl only covers pure paths; the codemod must emit markers for them and report coverage honestly or the migration looks broken.
- js/ IS OVERLOADED ACROSS 4+ RESOLVERS: step inputs (handle-eligible) vs @blokjs/expr expression (raw IIFE, must not touch) vs idempotency/concurrency/debounce key (fail-open custom eval, no handle form) vs forEach.in/switch.on vs polymorphic subworkflow. A blanket rewrite corrupts the last four; codemod must be field-aware.
- use: IS NOT UNIQUE: cross-runtime-chain.json reuses use:chain-test across 5 runtime kinds; stub/import resolution must key on the (use,type) pair, and runtime.* nodes are not even in Nodes.ts.
- BRANCH/forEach IR-PRODUCTION IS NEW: closure form collects steps by side-effect, structurally unlike today's unwrapProxies(array); the byte-identical claim holds only for the Mapper/PersistenceHelper on the resolved IR, not the IR-building path.
- COMPOUND branch.when HAS NO TYPED-OP TARGET (&&, .toLowerCase(), typeof, !=null) and the new branch(boolean-handle) can't express them, so hybrid coexistence is permanent, not transitional.

**Open questions:**
- Is there an explicit schemaVersion/dsl marker on the envelope, or must the hybrid runner keep inferring from structure? An explicit gate is near-mandatory for mixed-mode detection.
- For fail-open keys (idempotency/concurrency/debounce), does the new model keep raw expression strings (no handle)? If so, 'no js/ anywhere in authoring' is false and must be qualified.
- Does step() register via ambient builder side-effect or closure return? Determines testability and whether conditional step() corrupts the IR (see SPIKE-CLOSURE-IR).
- When a node name exists in multiple runtimes, what is the stub filename/import-identity convention, and does step() carry the runtime kind so (use,type) survives into the IR?
- Must the two codemods be idempotent and order-independent (refs-first vs Nodes-first)? Golden files must pin this.

## studio — IR to canvas round-trip + separate layout.json - adversarial validation
**Verdict:** `needs-rework`  
Lossless round-trip is sound only under S4 Option A (JSON IR is the single source of truth; canvas re-derives the DAG every edit). The engine claim (PersistenceHelper/Mapper byte-identical) is untouched - round-trip is structural, not runtime. Three soundness gaps break against real code and the existing specs. (1) buildWorkflowDag does NOT key nodes by step id - it mints synthetic, build-order-dependent ids (step-1, branch-2, merge-3) via a monotonic idCounter and stashes the real id only in meta.stepId; synthetic nodes (merge/trigger/end/catchEnter/finallyEnter) have NO step id. A layout.jso

**Top risks found:**
- SYNTHETIC, BUILD-ORDER-DEPENDENT NODE IDS. buildWorkflowDag (apps/studio/src/lib/workflowDag.ts:165-167) generates node ids from a monotonic idCounter (step-N, branch-N, merge-N), NOT from step.id. Inserting or deleting any step renumbers every downstream synthetic id, so a layout.json keyed by these ids corrupts on every structural edit. The epic correctly wants to key by step id - but the render
- SYNTHETIC NODES HAVE NO STEP ID, so a step-id-keyed layout.json structurally cannot position them. merge, trigger, end, catchEnter, finallyEnter are created with no meta.stepId (workflowDag.ts:312,344,432-438,453-454,546,556). tryCatch's try lane reuses the parent step id on tryEnter only; catch/finally enters are anonymous. If a user drags a merge diamond or the End pill, there is nowhere to stor
- THE $ref IR DOES NOT EXIST AND CONTRADICTS S1/S4/S5. The shipped and spec'd reference encoding is the string js/ctx.state.id (or $.state.id in JSON), produced by unwrapProxies at definition time (core/workflow-helper/src/proxy/$.ts:143-177) and resolved by the runtime Mapper. S1 never introduces a structural $ref node; S4/S5 treat references as opaque strings Studio must not parse. The epic's conn
- LAYOUT STORAGE CONFLICT: separate layout.json vs inline ui:{x,y}. S4 section 7.8 recommends positions as an optional pass-through ui:{x,y} on the step (runner-ignored, no format break). The epic mandates a separate layout.json keyed by step id. Both are defensible but mutually exclusive and imply different write paths, staleness semantics, and synthetic-node handling. Shipping one while a spec rec
- LAYOUT STALENESS / ORPHANING ON STRUCTURAL EDITS. A layout.json keyed by step id goes stale the instant a step is renamed (key no longer matches), deleted (orphan entry), or duplicated. renameStep must rewrite the layout key, deleteStep must purge it, and the loader must tolerate orphan/missing keys (fall back to dagre). None of this is in the epic. A missing key must NOT crash the canvas.

**Open questions:**
- Does the proposed-core actually replace js/ctx.state.id strings with structural $ref:{step,path} in the persisted IR, or is $ref only an in-memory authoring/handle representation that COMPILES DOWN to the existing string form (as the $ proxy does today)? This determines whether the canvas round-trip
- Separate layout.json or inline ui:{x,y}? If separate: where does it live (next to the workflow file? one studio-layouts.json? localStorage like S5 pin-data?), and is it committed or gitignored? Co-location and VCS semantics differ sharply.
- How are positions stored for synthetic nodes (merge, end, trigger, catchEnter, finallyEnter) with no step id? Options: (a) make them non-draggable/dagre-only; (b) composite key (ownerStepId + arm-role); (c) give every emitted node a stable derived id. Pick one before building the write path.
- Is connect-picker emit in scope for THIS epic or owned by S5? S5 section 7.4 owns the picker and the upstream-only port model. The epic lists picker emit as an attack surface but the logic lives in S5. Clarify the boundary so the picker test lands in the right epic.
- Should layoutDag pin keyed (manually-dragged) nodes after dagre runs, or seed-and-let-dagre-move them? Pinning is required for manual layout to survive structural edits; confirm that is the intended behavior (more work than the S4 seed-and-honor wording implies).

## e2e — Adversarial validation: bulletproofing the new Blok core
**Verdict:** `sound-with-risks`  
test

## Milestones
- **M1 — Foundation — freeze the contracts before any code**: Resolve the three contract-level forks that every later epic inherits, and prove the engine is genuinely byte-identical against the real corpus. Nothing downstream is safe until these are decided: (1)
- **M2 — Build the authoring surface, packaging, and migration on the frozen contracts**: With the wire format, key rule, and handle soundness fixed, build the deliverables that consume them: the @blokjs/core package (exports-map subpath split + sideEffects:false so DSL-only import does no
- **M3 — Canvas round-trip + JSON twin on the frozen IR**: Make the IR editable and round-trippable in Studio: stable step-id-derived node ids (replace the build-order idCounter that renumbers synthetic nodes on every structural edit), a layout decision (sepa
- **M4 — Bulletproof — marketplace seam, docs, and the standing guarantees**: Close the platform-level seams and make the guarantees standing rather than one-shot: validate the IR as the registry/marketplace publish+install unit (validateWorkflow as a real admission gate, insta

## Completeness gaps the critic added
- MANUAL TRIGGER IS GREENFIELD, UNOWNED. The design names 10 triggers (http, webhook, cron, worker, pubsub, sse, websocket, mcp, grpc, manual) each yielding a distinct typed entry handle. Only 9 trigger dirs exist (triggers/{http,webhook,cron,worker,pubsub,sse,websocket,mcp,grpc}); there is NO manual 
- TYPED ENTRY HANDLE PER TRIGGER IS UNDER-SPECIFIED AND UNTESTED. The context epic replaces ctx.req/event/job with 'a typed entry handle' but no epic systematically defines + tests the SHAPE of each of the 10 entry handles (req for http, event for webhook, tick for cron, job for worker, msg for pubsub
- tpl TEMPLATE-LITERAL IS REFERENCED EVERYWHERE BUT BUILT NOWHERE. The DSL spec relies on `tpl`backtick`` to keep {$ref} structural inside interpolated strings (replacing string-building js/ exprs). No epic implements or tests tpl: ref-preservation across `${handle.field}` interpolation, nested field 
- forEach INPUT-ITERABLE-AS-HANDLE + switch.on/loop.while HANDLE ACCEPTANCE UNTESTED. The controlflow epic validates the per-ITEM handle and branch boolean handles, but not: (a) forEach(handle, ...) where the iterable itself is a handle (forEach.in resolves via mapper today — handle-eligible); (b) swi
- docs/d/fundamentals/context-and-state.mdx (the CANONICAL user-facing context guide CLAUDE.md mandates kept in sync), AGENTS.md, and CLAUDE.md itself ALL describe the ctx.state/$/js/ authoring model that this redesign removes. No epic rewrites them. Shipping the new DSL while the canonical docs teach
- MARKETPLACE / REGISTRY SEAM IS UNVALIDATED END-TO-END. The IR is positioned as the language-neutral publishable artifact consumed by canvas, JSON twin, AND the npm-like registry/marketplace (per the platform vision). No epic proves the IR is the publish/install unit: that validateWorkflow() is the r
- @blokjs/expr MUST-NOT-TOUCH HAS NO POSITIVE TEST. The migration epic flags that expr's `expression` input is raw IIFE JS and must NOT be rewritten by the js/-codemod (double-eval hazard), and CLAUDE.md warns never to prefix expr with js/. But no epic has a TEST asserting expr nodes survive UNCHANGED
- WORKER / PUBSUB / WEBHOOK WORKFLOW MIGRATION IS HTTP-CENTRIC. The migration corpus and codemod golden-files focus on HTTP workflows (req.body). Worker workflows map ctx.request.body to a JOB payload and use ctx.vars._worker_job / params.{queue,jobId,attempt}; pubsub uses msg; webhook uses event. No 
- THE 'NOTHING LOST' GUARANTEE HAS NO SINGLE CORPUS-WIDE EQUIVALENCE GATE. Individual epics test their own round-trips, but no epic owns one harness that runs the FULL existing corpus (1611 TS + 545 JSON workflows) before and after the redesign and asserts identical resolved-IR + run-trace (the true '
- RUNTIME SDK PROTO-DRIFT VS GENERATED STUBS HAS NO CI GATE ACROSS ALL 7 SDKS. The crossruntime epic adds `nodes sync --check` for stub staleness, but proto drift between the 7 vendored SDK protos and the canonical runtime.proto (a documented risk) means input_schema_json can decode empty/wrong BEFORE

## Cross-cutting risk register
- CONTRACT FORK NOT FROZEN BEFORE BUILD (highest, cross-cutting ir/persistence/corepkg/studio/migration). The IR input-value representation — structural {$ref} object vs lowered js/ctx.state string — is asserted four different ways across the epics and is currently CONTRADICTORY. Verified against core
- FALSE NODE-KEY INVARIANT (high, nodes/corepkg/crossruntime/migration). 'use derived from node.name' does not hold: verified nodes/web/api-call@1.0.0/index.ts:38 has name:'api-call' while triggers/http/src/Nodes.ts:12 keys it '@blokjs/api-call'. Deriving use from name re-keys the whole library and 40
- HANDLE TYPE-SYSTEM PROMISES THE ENGINE CANNOT KEEP (high, persistence/context/controlflow). The engine resolves $ref against runtime ctx.state with zero knowledge of the handle graph. Ephemeral-step handles read as undefined (Rule 1 no-ops the write) — silent under warn/silent mapper mode, confusing
- BRANCH/LOOP RAW-EVAL FOOTGUN UNSHIPPED (high, controlflow/context). Verified nodes/control-flow/if-else@1.0.0/index.ts runJs uses Function('ctx','data','func','vars', ...) with NO js/ strip. A boolean/op handle for branch MUST emit bare-ctx (ctx.state.x.field), NOT js/ctx... or {$ref}, or it 500s ex
- EXPRESSIVENESS REGRESSION (high, context/migration). 65 of 393 js/ expressions in shipped JSON workflows carry logic (||default, ??, ternary, process.env, Date.now, Array.isArray, .filter/.map) that a structural {$ref} cannot encode and tpl (string-only) does not cover. Without a defined escape hatc
- BACK-COMPAT BLAST RADIUS + BUNDLE BLOAT (medium-high, corepkg). 168 files import @blokjs/runner, 145 @blokjs/shared, 114 @blokjs/helper (verified). Deprecated shims must re-export the FULL value+type surface; export * risks dual type/value name collisions and breaks import type elision. No package d
- NO-SCHEMA RUNTIME NODES ARE THE COMMON CASE (medium-high, crossruntime). Schema is OPTIONAL in all 7 SDKs (Go reflectSchemaJSON returns nil on error; Python returns None with no Pydantic model; Ruby/PHP nil/?array). A stub for a no-schema node must degrade to unknown, not silently emit any-as-typed.
- STUDIO WRITE-PATH INSTABILITY (medium, studio). buildWorkflowDag mints synthetic build-order ids (step-N/branch-N/merge-N) and stores the real id only in meta.stepId; synthetic nodes (merge/trigger/end/catchEnter/finallyEnter) have NO step id, so a step-id-keyed layout.json structurally cannot posit
- SILENT JSON VALIDATION BEHAVIOR CHANGE (medium, ir). JSON workflows are NEVER Zod-validated today (scanWorkflows: JSON.parse -> normalizeWorkflow, tolerant structural reads). The 18 .strict() step schemas (verified count in StepOpts.ts) are stricter than the normalizer, so wiring validateWorkflow as
- UI/schemaVersion PASS-THROUGH DROPS SILENTLY (medium, ir). InternalStep constructors copy ENUMERATED fields only (8 constructors); the [key:string] index signature is a type affordance, not a runtime copy. Adding ui/schemaVersion to the zod schema alone makes it survive the TS factory but vanish at 
- UNOWNED SEAMS (medium, completeness). manual trigger is greenfield (only 9 trigger dirs exist); tpl is referenced everywhere but built nowhere; the marketplace/registry IS the IR's reason to exist but no epic validates publish/install round-trip; the canonical authoring docs (context-and-state.mdx +
