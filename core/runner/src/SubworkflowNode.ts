import type { Context, ResponseContext } from "@blokjs/shared";
import { context, propagation } from "@opentelemetry/api";
import Configuration from "./Configuration";
import RunnerNode from "./RunnerNode";
import { SubworkflowMetrics } from "./monitoring/SubworkflowMetrics";
import { RunTracker } from "./tracing/RunTracker";
import type GlobalOptions from "./types/GlobalOptions";
import { createChildContext } from "./utils/createChildContext";
import { applyStepOutput } from "./workflow/PersistenceHelper";
import { WorkflowRegistry } from "./workflow/WorkflowRegistry";

/**
 * Hard cap on `parent → child → grandchild → …` recursion. Bounds the
 * blast radius of an accidental cycle (workflow A calls B calls A) or
 * a legitimate-but-pathological deep nesting. Tunable via
 * `BLOK_MAX_SUBWORKFLOW_DEPTH` env var; falls back to 10.
 */
function getMaxDepth(): number {
	const raw = process.env.BLOK_MAX_SUBWORKFLOW_DEPTH;
	if (typeof raw === "string" && raw.length > 0) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isInteger(parsed) && parsed > 0) return parsed;
	}
	return 10;
}

/**
 * G2 — resolve the deployment's self base URL for HTTP self-call
 * dispatch. Reads `BLOK_SELF_BASE_URL` when set (recommended in
 * containerized deployments where `localhost` is just the pod);
 * otherwise defaults to `http://localhost:${PORT || 4000}` which
 * works out-of-box for the dev orchestrator. Always trims a trailing
 * slash so callers can `${base}${path}` without doubling.
 *
 * Exported for tests; production callers go through
 * `SubworkflowNode.dispatchHttpSelf`.
 */
export function getSelfBaseUrl(): string {
	const fromEnv = process.env.BLOK_SELF_BASE_URL;
	if (typeof fromEnv === "string" && fromEnv.length > 0) {
		return fromEnv.endsWith("/") ? fromEnv.slice(0, -1) : fromEnv;
	}
	const port = process.env.PORT && process.env.PORT.length > 0 ? process.env.PORT : "4000";
	return `http://localhost:${port}`;
}

/**
 * Internal ctx field that carries the current sub-workflow depth.
 * Incremented by `SubworkflowNode.run` before invoking the child;
 * read on entry to enforce the cap.
 */
const SUBWORKFLOW_DEPTH_KEY = "_subworkflowDepth";

/**
 * `SubworkflowNode` — the runner-side dispatch primitive that powers
 * the v2 `subworkflow:` step shape. Looks up the named child workflow
 * in the `WorkflowRegistry`, materializes a child `Configuration` +
 * `Runner`, runs the child to completion in its own isolated `Context`,
 * and returns the child's `ctx.response` as this step's `model.data`.
 *
 * **Composition with Tier 1**:
 * - Parent step's `idempotencyKey` is consulted by `RunnerSteps` BEFORE
 *   `SubworkflowNode.run` is even called — cache hit short-circuits the
 *   entire sub-workflow (no child invocation, no side effects fire).
 *   This is the headline pattern AND the documented footgun.
 * - Parent step's `retry` retries the whole sub-workflow on failure;
 *   each retry creates a fresh child run record under the same parent.
 * - Replay re-creates fresh sub-run lineage automatically — the new
 *   parent run invokes the sub-workflow fresh.
 *
 * **Lineage**: child's `WorkflowRun.parentRunId` and
 * `WorkflowRun.parentNodeRunId` carry the parent run + step that
 * invoked it. Studio renders a "called from #..." breadcrumb on the
 * child and a "Sub-runs" list on the parent.
 *
 * **Recursion guard**: `BLOK_MAX_SUBWORKFLOW_DEPTH` (default 10) bounds
 * cycle / deep-nesting blast radius. Throws a clear error past the cap.
 */
export class SubworkflowNode extends RunnerNode {
	/**
	 * The child workflow's `name:` field — looked up in `WorkflowRegistry`
	 * at run time. Set by `Configuration.subworkflowResolver`; this field
	 * shadows the inherited `NodeBase.subworkflow` so callers can rely on
	 * it being defined.
	 */
	public declare subworkflow: string;
	/**
	 * v0.7 — optional namespace prefix prepended to the resolved
	 * polymorphic name. Used by the Webhook trigger:
	 * `namespace: "stripe"` + `subworkflow: "js/ctx.req.body.type"`
	 * resolving to `"invoice.paid"` looks up `"stripe.invoice.paid"`.
	 * Static names are unaffected.
	 */
	public namespace?: string;
	/**
	 * G3 (v0.5) — exact-match allow-list for the workflow name dispatched
	 * by this step. When set, the **final** resolved name (after any
	 * polymorphic `js/...` evaluation AND the `namespace` prefix) must be
	 * in this array; otherwise the dispatch is rejected at run time with
	 * a structured error. Strongly recommended when `subworkflow` is an
	 * expression so a malicious or buggy ctx value can't escalate the
	 * workflow surface accessible to a request.
	 *
	 * `undefined` preserves pre-G3 behaviour (no constraint). Authors
	 * with literal `subworkflow:` strings have no reason to set this —
	 * the registry lookup already gates dispatch on the literal name.
	 */
	public allowList?: readonly string[];
	/**
	 * G2 (v0.6) — dispatch strategy.
	 *
	 * - `"in-process"` (default): the child workflow runs in the SAME
	 *   Node process — synchronous when `wait: true`, `setImmediate`-
	 *   based when `wait: false`. Cheapest, no extra hops; the historic
	 *   behaviour.
	 * - `"http-self"`: the child is dispatched as a fresh HTTP request
	 *   to the deployment's own base URL (resolved from
	 *   `BLOK_SELF_BASE_URL`, defaulting to `http://localhost:${PORT}`).
	 *   Use when each child run should land on a different process in
	 *   a horizontally-scaled deployment, or to fully isolate child
	 *   execution from the parent's call stack. The child MUST have an
	 *   HTTP trigger — a runtime error is thrown otherwise. Lineage
	 *   (parentRunId / parentNodeRunId / depth) is preserved across the
	 *   HTTP hop via `X-Blok-Parent-Run-Id` / `X-Blok-Parent-Node-Run-Id`
	 *   / `X-Blok-Subworkflow-Depth` headers that the receiving
	 *   HttpTrigger reads + threads into `tracker.startRun(...)`.
	 *
	 * Both modes integrate with `wait` and `idempotencyKey` identically
	 * (the cache lookup happens BEFORE `SubworkflowNode.run`).
	 */
	public dispatch?: "in-process" | "http-self";
	/**
	 * Wait mode for the sub-workflow dispatch:
	 *
	 * - `true` (default) — synchronous: parent step blocks on the child
	 *   and the child's `ctx.response` becomes the parent step's output.
	 * - `false` — fire-and-forget: parent step returns IMMEDIATELY with
	 *   `{runId, workflowName, scheduledAt}`. The child runs
	 *   asynchronously via `setImmediate` and shows up in Studio's
	 *   Sub-runs strip with status transitioning `running → completed |
	 *   failed` independently of the parent.
	 *
	 * Combine `wait: false` with `idempotencyKey` for at-most-once
	 * dispatch deduplication (the `runId` is cached against the key
	 * regardless of child outcome — Trigger.dev / Stripe semantics).
	 */
	public declare wait: boolean;
	/**
	 * Runner-wide options (carries the `nodes` registry that the child
	 * Configuration needs for `module` step resolution). Set by
	 * `Configuration.subworkflowResolver` before this node runs.
	 */
	public globalOptions?: GlobalOptions;

	async run(ctx: Context): Promise<ResponseContext> {
		// === 1. Recursion guard ===
		const depth = (((ctx as Record<string, unknown>)[SUBWORKFLOW_DEPTH_KEY] as number) ?? 0) + 1;
		const maxDepth = getMaxDepth();
		if (depth > maxDepth) {
			throw new Error(
				`[blok] Sub-workflow recursion limit exceeded (depth ${depth} > ${maxDepth}). Likely a cycle: workflow "${ctx.workflow_name}" called sub-workflow "${this.subworkflow}" too deep. Bump via BLOK_MAX_SUBWORKFLOW_DEPTH if intentional.`,
			);
		}

		// === 2. Resolve the child workflow name (polymorphic v0.7) ===
		// Static names ("send-receipt-email") are looked up directly.
		// Mapper-expression names ("js/ctx.req.body.type", "$.req.body.type")
		// are evaluated against the live ctx — the cleanest way to dispatch
		// many handlers from one webhook / event router workflow without a
		// big switch statement. Resolved names go through the same registry
		// lookup as static names.
		const resolvedName = await this.resolveSubworkflowName(ctx);
		const registry = WorkflowRegistry.getInstance();
		const entry = registry.get(resolvedName);
		if (!entry) {
			const known = registry.list().map((w) => w.name);
			const knownStr = known.length > 0 ? known.join(", ") : "(none registered yet)";
			throw new Error(
				`[blok] Sub-workflow "${resolvedName}" not found in WorkflowRegistry. Available: ${knownStr}. Workflows enter the registry from one of several paths: (a) JSON under \`WORKFLOWS_PATH/json/\` is auto-scanned by the HTTP trigger; (b) TypeScript workflows must be added to your \`src/Workflows.ts\` map; (c) worker/cron/grpc-only deployments register their nodeMap workflows at boot — if no HTTP trigger runs, register the child explicitly via \`WorkflowRegistry.getInstance().register({ name, source, workflow })\`. Verify the workflow's \`name\` matches "${resolvedName}" exactly.`,
			);
		}

		// === 2.5. Registry-level authorization ===
		// Default-allow when no hook is installed (preserves pre-v0.4.1
		// behavior). Operators install a hook via
		// WorkflowRegistry.getInstance().setAuthorizeFn(...) for
		// multi-tenant access control. Throws on denial; the parent
		// step's retry loop (if any) will retry — author should pin
		// `retry: undefined` on sub-workflow steps where denial is
		// permanent.
		const allowed = await registry.authorize(ctx.workflow_name ?? "<unknown>", resolvedName, ctx);
		if (!allowed) {
			throw new Error(
				`[blok] Sub-workflow access denied: workflow "${ctx.workflow_name}" is not authorized to invoke "${resolvedName}". This denial came from the registry-level authorize hook (WorkflowRegistry.setAuthorizeFn). Adjust the hook to allow this composition, or remove the gate.`,
			);
		}

		// === 2.6. G2 — HTTP self-call dispatch ===
		// When `dispatch: "http-self"`, skip the in-process Configuration
		// + Runner materialization entirely. The child workflow runs on
		// the OTHER side of an HTTP request that goes through the
		// deployment's own base URL, hitting whichever process picks it
		// up. The receiving HttpTrigger registers the child run record;
		// this side just makes the HTTP call.
		if (this.dispatch === "http-self") {
			return this.dispatchHttpSelf(ctx, entry, resolvedName, depth);
		}

		// === 3. Materialize child Configuration + Runner ===
		// `preloaded` = entry.workflow skips the disk re-read; the
		// normalizer still runs so v1→v2 conversion happens for legacy
		// child workflows.
		const childConfig = new Configuration();
		await childConfig.init(entry.name, this.globalOptions, entry.workflow);
		// Lazy import of Runner to avoid a circular dep
		// (Configuration → RunnerNode → ... — Runner has its own chain).
		const { default: Runner } = await import("./Runner");
		const childRunner = new Runner(childConfig.steps);

		// === 4. Build the child Context ===
		// Parent step's resolved inputs (from blueprint mapper) live on
		// `ctx.config[this.name].inputs` — the blueprint mapper has
		// mutated the wrapper in place, so `js/...` and `$.<path>`
		// expressions are now concrete values. These become the child's
		// `request.body` so the child reads them via `$.req.body.<key>`
		// exactly as if HTTP-triggered (function-call semantics).
		const parentNodeConfig = (ctx.config as Record<string, { inputs?: unknown }> | undefined)?.[this.name];
		const parentInputs = parentNodeConfig?.inputs ?? {};
		const childCtx = createChildContext(ctx, {
			workflowName: entry.name,
			workflowPath: entry.source,
			body: parentInputs,
			config: childConfig.nodes,
		});
		// Carry the depth counter forward so nested sub-workflows hit the cap.
		(childCtx as Record<string, unknown>)[SUBWORKFLOW_DEPTH_KEY] = depth;

		// === 5. Tracing — child gets its own run record + lineage ===
		const tracker = RunTracker.getInstance();
		const parentRunId = (ctx as Record<string, unknown>)._traceRunId as string | undefined;
		const parentNodeRunId = (ctx as Record<string, unknown>)._traceNodeId as string | undefined;
		const childTriggerSummary = `${ctx.workflow_name ?? "?"} → ${entry.name}`;

		let childRunId: string | undefined;
		if (tracker.active) {
			const childRun = tracker.startRun({
				workflowName: entry.name,
				workflowPath: entry.source,
				triggerType: "subworkflow",
				triggerSummary: childTriggerSummary,
				nodeCount: childConfig.steps.length,
				parentRunId,
				parentNodeRunId,
			});
			childRunId = childRun.id;
			(childCtx as Record<string, unknown>)._traceRunId = childRun.id;
		}

		// === 6. Dispatch — sync or fire-and-forget based on `this.wait` ===
		if (this.wait === false) {
			return this.dispatchAsync(ctx, childRunner, childCtx, childRunId, entry.name);
		}

		// === 6a. Synchronous dispatch (wait: true / default) ===
		try {
			await childRunner.run(childCtx);
			if (childRunId) tracker.completeRun(childRunId, childCtx.response);
		} catch (err) {
			if (childRunId) tracker.failRun(childRunId, err);
			throw err;
		} finally {
			// PR 1 follow-up · A3 fix. Abort the listener-cleanup signal so
			// the parent.signal listener (registered in createChildContext)
			// auto-removes. Without this, listeners accumulate on long-lived
			// parents that fire many sub-workflows.
			const childPrivate = childCtx._PRIVATE_ as { listenerCleanup?: AbortController } | null;
			if (childPrivate?.listenerCleanup && !childPrivate.listenerCleanup.signal.aborted) {
				childPrivate.listenerCleanup.abort();
			}
		}

		// === 7. Apply parent persistence + return child's response ===
		// Mirrors HTTP function-call semantics: parent reads child output
		// at `$.state[<this.name>]`. Child author controls the shape via
		// `@blokjs/respond` (or the last step's natural output).
		//
		// Persistence-helper call mirrors the RuntimeAdapterNode pattern
		// (RuntimeAdapterNode.ts:100). The parent step's `as` / `spread`
		// / `ephemeral` knobs apply identically here — sub-workflow
		// output is just data, persistence rules are uniform.
		const result = { success: !childCtx.response?.error, data: childCtx.response };
		applyStepOutput(ctx, this, result);
		return {
			success: result.success,
			data: childCtx.response,
			error: childCtx.response?.error ?? null,
		};
	}

	/**
	 * Fire-and-forget dispatch (Tier 2 #4 follow-up — `wait: false`).
	 *
	 * Schedules the child runner via `setImmediate` so the parent step
	 * can return immediately. Child errors are caught and routed to
	 * `tracker.failRun(childRunId, err)` — visible in Studio, NOT
	 * propagated to the parent step (which has already returned). Also
	 * logged via `console.error` for ops visibility.
	 *
	 * Parent step's output is the dispatch metadata `{runId,
	 * workflowName, scheduledAt}` — NOT the child's response (which
	 * doesn't exist yet). Caller polls `GET /__blok/runs/<runId>` for
	 * the actual outcome.
	 */
	/**
	 * v0.7 PR 4 — resolve a (possibly polymorphic) sub-workflow name to
	 * the actual workflow name in the registry.
	 *
	 *   - Static names ("send-receipt-email") pass through unchanged.
	 *   - `js/...` expressions are evaluated against the live ctx —
	 *     `subworkflow: "js/ctx.req.body.type"` becomes `"invoice.paid"`
	 *     on a request with that body.
	 *   - `$.<path>` / `${...}` strings go through the same Mapper code
	 *     path as step inputs (the TS DSL compiles `$` to `"js/ctx..."`
	 *     by the time the workflow hits Configuration; this branch
	 *     handles authors who hand-wrote `$` in JSON).
	 *   - When `this.namespace` is set (from the parent workflow's
	 *     `trigger.webhook.namespace`), the resolved name is prefixed
	 *     as `"<namespace>.<resolvedName>"` — only when polymorphic
	 *     resolution fired AND the resolved name isn't already prefixed.
	 *
	 * Throws if the expression evaluates to anything other than a
	 * non-empty string — operators should see a clear "polymorphic
	 * subworkflow name resolved to <T>" error rather than a confusing
	 * "workflow not found" downstream.
	 */
	private async resolveSubworkflowName(ctx: Context): Promise<string> {
		const raw = this.subworkflow;
		const isExpression =
			typeof raw === "string" && (raw.startsWith("js/") || raw.startsWith("$.") || raw.startsWith("${"));

		let resolvedName: string;
		if (!isExpression) {
			resolvedName = raw;
		} else {
			// Lazy import keeps the static dep graph between runner and
			// shared minimal — most steps don't dispatch sub-workflows.
			const { mapper } = await import("@blokjs/shared");
			// Normalise `$.<path>` → `js/ctx.<path>` so Mapper.replaceString
			// evaluates it. Authors who wrote `js/...` go straight through.
			let expr = raw;
			if (expr.startsWith("$.")) {
				expr = `js/ctx.${expr.slice(2)}`;
			} else if (expr.startsWith("$")) {
				expr = `js/${expr.slice(1)}`;
			}
			const resolved = mapper.replaceString(expr, ctx, {});
			if (typeof resolved !== "string" || resolved.length === 0) {
				throw new Error(
					`[blok] Polymorphic sub-workflow name "${raw}" resolved to ${JSON.stringify(resolved)} (expected a non-empty string). Check the expression and the runtime value of ctx.`,
				);
			}
			resolvedName = resolved;
		}

		// Namespace prefix — applies to polymorphic resolutions when set on
		// the parent workflow's trigger (today: webhook namespace). Static
		// names skip prefixing so they stay routable by their literal name.
		if (isExpression && this.namespace && this.namespace.length > 0 && !resolvedName.startsWith(`${this.namespace}.`)) {
			resolvedName = `${this.namespace}.${resolvedName}`;
		}

		// G3 allow-list enforcement. Checked after namespace prefixing so
		// the value an author writes in the list matches the registry name
		// they intend to permit. Polymorphic dispatch without an allow-list
		// is still allowed (matches pre-G3 behaviour); the schema's
		// describe() recommends pairing them in production.
		if (this.allowList && this.allowList.length > 0 && !this.allowList.includes(resolvedName)) {
			throw new Error(
				`[blok] Sub-workflow dispatch blocked: resolved name "${resolvedName}" is not in the step's \`allowList\` [${this.allowList.map((n) => `"${n}"`).join(", ")}]. Add it to the list if the dispatch is intended, or audit the workflow whose ctx produced this name.`,
			);
		}

		return resolvedName;
	}

	/**
	 * G2 (v0.6) — HTTP self-call dispatch.
	 *
	 * Replaces the in-process child Configuration / Runner / Context
	 * with an HTTP request to the deployment's own base URL. The
	 * receiving HttpTrigger materializes the child as if it were a
	 * fresh request — registers its own run record, runs the workflow,
	 * returns the response.
	 *
	 * - `wait: true` (default) — `fetch` is awaited. The HTTP response
	 *   body becomes this step's `model.data`. A non-2xx response is
	 *   treated as failure (mirrors the in-process error propagation).
	 * - `wait: false` — `fetch` is fired-and-forgotten. The promise's
	 *   rejection is caught + logged. Parent step's output is
	 *   `{runId: null, workflowName, scheduledAt}` — the child's runId
	 *   isn't known on this side until the receiver actually creates
	 *   the run record. Studio's Sub-runs strip surfaces the child
	 *   once it lands.
	 *
	 * Lineage (parentRunId / parentNodeRunId / depth) crosses the HTTP
	 * boundary via headers that the receiving HttpTrigger reads + threads
	 * into `tracker.startRun(...)`. Same end-result as the in-process
	 * path: child's `WorkflowRun` carries the parent ids so Studio renders
	 * the breadcrumbs.
	 */
	private async dispatchHttpSelf(
		parentCtx: Context,
		entry: { name: string; source: string; workflow: unknown },
		resolvedName: string,
		depth: number,
	): Promise<ResponseContext> {
		// === 1. Validate the child has an HTTP trigger ===
		const childWorkflow = entry.workflow as { trigger?: { http?: { method?: string; path?: string } } } | undefined;
		const httpTrigger = childWorkflow?.trigger?.http;
		if (!httpTrigger || typeof httpTrigger.path !== "string" || httpTrigger.path.length === 0) {
			throw new Error(
				`[blok] Sub-workflow dispatch failed: \`dispatch: "http-self"\` requires the child workflow "${resolvedName}" to have an HTTP trigger with an explicit \`trigger.http.path\`. Switch the step to \`dispatch: "in-process"\` (or omit the field) for non-HTTP children, or add an HTTP trigger to the child.`,
			);
		}
		const method = (httpTrigger.method ?? "POST").toUpperCase();
		const path = httpTrigger.path.startsWith("/") ? httpTrigger.path : `/${httpTrigger.path}`;

		// === 2. Resolve the deployment's self base URL ===
		const baseUrl = getSelfBaseUrl();
		const url = `${baseUrl}${path}`;

		// === 3. Build lineage headers ===
		const parentRunId = (parentCtx as Record<string, unknown>)._traceRunId as string | undefined;
		const parentNodeRunId = (parentCtx as Record<string, unknown>)._traceNodeId as string | undefined;
		const headers: Record<string, string> = {
			"content-type": "application/json",
			// Receiving HttpTrigger reads these in `runWorkflowExecution`
			// and threads them into `tracker.startRun({parentRunId, ...})`.
			// Same shape as the existing `X-Blok-Replay-Of` plumbing.
			"X-Blok-Subworkflow-Depth": String(depth),
		};
		if (parentRunId) headers["X-Blok-Parent-Run-Id"] = parentRunId;
		if (parentNodeRunId) headers["X-Blok-Parent-Node-Run-Id"] = parentNodeRunId;

		// OBS-02 B2.3 — inject W3C trace context so a child workflow running in
		// another process joins this trace instead of starting a fresh root.
		// No-op (headers unchanged) when no tracer provider is registered.
		propagation.inject(context.active(), headers);

		// === 4. Parent step's resolved inputs become the request body ===
		const parentNodeConfig = (parentCtx.config as Record<string, { inputs?: unknown }> | undefined)?.[this.name];
		const parentInputs = parentNodeConfig?.inputs ?? {};
		const body = JSON.stringify(parentInputs);

		// === 5. Fire-and-forget (wait: false) ===
		if (this.wait === false) {
			const scheduledAt = Date.now();
			fetch(url, { method, headers, body }).catch((err: unknown) => {
				// OBS-05 T5 — surface the silent fire-and-forget failure as a
				// metric (alongside the existing console.error). Additive.
				SubworkflowMetrics.getInstance().recordAsyncFailure({
					workflow_name: parentCtx.workflow_name ?? "<unknown>",
					dispatch: "http-self",
				});
				console.error(
					`[blok][subworkflow] http-self dispatch to ${url} failed (wait:false):`,
					err instanceof Error ? err.stack || err.message : err,
				);
			});
			const dispatchData: Record<string, unknown> = {
				runId: null, // unknown on this side — receiving trigger creates the record
				workflowName: entry.name,
				scheduledAt,
				dispatch: "http-self",
				url,
			};
			const result = { success: true, data: dispatchData };
			applyStepOutput(parentCtx, this, result);
			return {
				success: true,
				data: dispatchData,
				error: null,
			};
		}

		// === 6. Synchronous (wait: true) ===
		let response: Response;
		try {
			response = await fetch(url, { method, headers, body });
		} catch (err) {
			// Network-level failure: connection refused, DNS, etc.
			throw new Error(
				`[blok] Sub-workflow http-self dispatch to ${url} failed: ${err instanceof Error ? err.message : String(err)}. The deployment's self base URL is "${baseUrl}" (set via BLOK_SELF_BASE_URL or defaulted from PORT). Make sure the trigger is listening + the URL is reachable from THIS process.`,
			);
		}
		const responseText = await response.text();
		let responseBody: unknown;
		try {
			responseBody = responseText.length > 0 ? JSON.parse(responseText) : undefined;
		} catch {
			responseBody = responseText;
		}

		if (!response.ok) {
			throw new Error(
				`[blok] Sub-workflow http-self dispatch returned ${response.status} ${response.statusText} from ${url}. Body: ${typeof responseBody === "string" ? responseBody.slice(0, 500) : JSON.stringify(responseBody).slice(0, 500)}`,
			);
		}

		const resp: ResponseContext = { success: true, data: responseBody, error: null };
		const result = { success: true, data: responseBody };
		applyStepOutput(parentCtx, this, result);
		return resp;
	}

	private dispatchAsync(
		parentCtx: Context,
		childRunner: { run: (ctx: Context) => Promise<unknown> },
		childCtx: Context,
		childRunId: string | undefined,
		childWorkflowName: string,
	): ResponseContext {
		const scheduledAt = Date.now();
		const tracker = RunTracker.getInstance();

		setImmediate(() => {
			void (async () => {
				try {
					await childRunner.run(childCtx);
					if (childRunId) tracker.completeRun(childRunId, childCtx.response);
				} catch (err) {
					if (childRunId) {
						tracker.failRun(childRunId, err instanceof Error ? err : new Error(String(err)));
					}
					// OBS-05 T5 — surface the silent fire-and-forget failure as a
					// metric (alongside the existing failRun + console.error).
					// Additive.
					SubworkflowMetrics.getInstance().recordAsyncFailure({
						workflow_name: parentCtx.workflow_name ?? "<unknown>",
						dispatch: "in-process",
					});
					console.error(
						`[blok][subworkflow] async child '${childWorkflowName}' (run ${childRunId ?? "?"}) failed:`,
						err instanceof Error ? err.stack || err.message : err,
					);
				} finally {
					// PR 1 follow-up · A3 fix. Same listener-cleanup hook as the
					// sync path so async sub-workflows also auto-remove the
					// parent.signal listener on completion.
					const childPrivate = childCtx._PRIVATE_ as { listenerCleanup?: AbortController } | null;
					if (childPrivate?.listenerCleanup && !childPrivate.listenerCleanup.signal.aborted) {
						childPrivate.listenerCleanup.abort();
					}
				}
			})();
		});

		// Parent step's output: dispatch metadata (the runId is the
		// canonical handle for at-most-once dispatch deduplication when
		// combined with `idempotencyKey`).
		const dispatchData: Record<string, unknown> = {
			runId: childRunId ?? null,
			workflowName: childWorkflowName,
			scheduledAt,
		};
		const result = { success: true, data: dispatchData };
		applyStepOutput(parentCtx, this, result);
		return {
			success: true,
			data: dispatchData,
			error: null,
		};
	}
}
