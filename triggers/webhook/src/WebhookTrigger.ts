/**
 * WebhookTrigger — v0.7 PR 4 — Inbound webhook trigger that mounts
 * verified POST routes on the shared Hono app. One route per workflow
 * whose `trigger.webhook` config is registered.
 *
 * **Authoring surface (built-in provider):**
 *
 * ```json
 * {
 *   "name": "stripe-events",
 *   "trigger": {
 *     "webhook": {
 *       "provider": "stripe",
 *       "path": "/webhooks/stripe",
 *       "secretEnv": "STRIPE_WEBHOOK_SECRET",
 *       "namespace": "stripe",
 *       "idempotencyKey": "js/ctx.request.body.id"
 *     }
 *   },
 *   "steps": [
 *     { "id": "dispatch", "subworkflow": "js/ctx.request.body.type", "inputs": { "stripeEvent": "js/ctx.request.body" } }
 *   ]
 * }
 * ```
 *
 * **Pipeline (per inbound request):**
 *
 *   1. Read raw body — verifiers MUST sign the bytes that crossed
 *      the wire, not the JSON-re-stringified body (Stripe / GitHub /
 *      Slack all sign raw bytes).
 *   2. Verify the signature via the per-provider strategy
 *      (`verifiers.ts`). On failure, return 401 with structured
 *      `{ error, reason, message }`.
 *   3. Replay check: if `idempotencyKey` is configured, look up
 *      `(workflowName, eventId)` in the idempotency cache (same store
 *      as Tier 1 step caching). On hit, return 200 with
 *      `{ status: "duplicate", eventId }` and DON'T run the workflow.
 *   4. Events allowlist: if `events: [...]` is configured, skip
 *      workflow runs whose event type isn't in the list — return
 *      200 with `{ status: "ignored", eventType }` so the sender
 *      doesn't retry.
 *   5. Run the workflow through `TriggerBase.run` so middleware,
 *      tracing, retries, concurrency, etc. apply uniformly.
 *   6. Cache the eventId so a retry within the TTL window returns
 *      the duplicate response.
 *
 * **Hono integration:** identical to WebSocket and SSE — accepts the
 * shared `Hono<any, any, any>` app and an optional `HttpTriggerLike`
 * exposing `addPreCatchAllHook` so webhook routes mount BEFORE the
 * legacy `/:workflow{.+}` catch-all and win Hono's first-match
 * dispatch.
 *
 * See [additional-triggers-plan.mdx](../../../docs/c/devtools/additional-triggers-plan.mdx#webhook-trigger)
 * for the full v0.7 design.
 */

import {
	DefaultLogger,
	RunTracker,
	type GlobalOptions as RunnerGlobalOptions,
	TriggerBase,
	WorkflowRegistry,
} from "@blokjs/runner";
import { type Context, type GlobalError, type RequestContext, isNonRetryableValidationError } from "@blokjs/shared";
import { type Span, SpanStatusCode, metrics, trace } from "@opentelemetry/api";
import type { Hono, Context as HonoContext } from "hono";
import { v4 as uuid } from "uuid";

import { BUILTIN_VERIFIERS, type Verifier, type VerifyResult, buildCustomVerifier } from "./verifiers";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface WebhookTriggerConfig {
	provider?: "github" | "stripe" | "slack" | "shopify" | "svix";
	path?: string;
	events?: string[];
	secretEnv?: string;
	signature?: {
		scheme?: "hmac-sha256" | "hmac-sha1" | "hmac-sha512";
		header: string;
		format?: string;
		secretEnv: string;
		tolerance?: number;
		timestampHeader?: string;
		/** Event-id source for replay dedup — header name (wins) … */
		eventIdHeader?: string;
		/** … or a dot-path into the parsed body (e.g. "id", "data.id"). */
		eventIdPath?: string;
	};
	tolerance?: number;
	idempotencyKey?: string;
	namespace?: string;
	middleware?: string[];
}

interface HttpTriggerLike {
	addPreCatchAllHook(cb: () => void | Promise<void>): void;
}

const DEFAULT_TOLERANCE_SEC = 300;
const DEFAULT_REPLAY_TTL_MS = 5 * 60 * 1000; // 5 min — match Stripe / Svix default.
const REPLAY_NAMESPACE = "__webhook__";

// -----------------------------------------------------------------------------
// Trigger class
// -----------------------------------------------------------------------------

export default class WebhookTrigger extends TriggerBase {
	/**
	 * ADR 0015 — a webhook POST body IS caller-supplied input the workflow's
	 * `input` schema describes, so it is validated (after signature verification).
	 * A malformed payload returns a real 4xx with `validation_errors` and is NOT
	 * cached as processed, so the sender can retry after correcting it. Use
	 * `.passthrough()` to keep body fields outside the schema.
	 */
	protected validatesDeclaredInput(): boolean {
		return true;
	}

	protected nodeMap: RunnerGlobalOptions = {} as RunnerGlobalOptions;
	protected readonly logger = new DefaultLogger();
	protected readonly tracer = trace.getTracer(
		process.env.PROJECT_NAME || "trigger-webhook-workflow",
		process.env.PROJECT_VERSION || "0.0.1",
	);

	private readonly meter = metrics.getMeter("blok");
	private readonly counterReceived = this.meter.createCounter("blok_webhook_received_total", {
		description: "Webhook deliveries received (cumulative).",
		unit: "1",
	});
	private readonly counterRejected = this.meter.createCounter("blok_webhook_rejected_total", {
		description: "Webhook deliveries rejected (signature failure, allowlist miss, replay).",
		unit: "1",
	});
	private readonly counterAccepted = this.meter.createCounter("blok_webhook_accepted_total", {
		description: "Webhook deliveries that triggered a workflow run.",
		unit: "1",
	});

	// biome-ignore lint/suspicious/noExplicitAny: Hono's generic propagation
	private readonly app: Hono<any, any, any>;
	private readonly httpTrigger: HttpTriggerLike | null;

	private wired = false;

	// biome-ignore lint/suspicious/noExplicitAny: matches `app` field's any generic
	constructor(app: Hono<any, any, any>, httpTrigger?: HttpTriggerLike) {
		super();
		this.app = app;
		this.httpTrigger = httpTrigger ?? null;
		_setActiveWebhookTrigger(this);
	}

	/**
	 * Inject the runner's GlobalOptions (nodes + workflows). Called by
	 * the orchestrator AFTER constructing the trigger but BEFORE
	 * `listen()`. Shares HttpTrigger's nodeMap so per-request workflow
	 * runs resolve helpers + sub-workflows through the same registry.
	 */
	setNodeMap(nodeMap: RunnerGlobalOptions): void {
		this.nodeMap = nodeMap;
	}

	async listen(): Promise<number> {
		const startTime = this.startCounter();
		if (this.wired) {
			this.logger.log("[blok][webhook] listen() called twice; ignoring");
			return this.endCounter(startTime);
		}
		this.wired = true;

		if (this.httpTrigger) {
			this.httpTrigger.addPreCatchAllHook(() => {
				this.registerRoutesFromRegistry();
			});
		} else {
			this.registerRoutesFromRegistry();
		}

		return this.endCounter(startTime);
	}

	async stop(): Promise<void> {
		this.wired = false;
		if (_getActiveWebhookTrigger() === this) _setActiveWebhookTrigger(null);
		this.destroyMonitoring();
		this.logger.log("[blok][webhook] stopped");
	}

	// ---------------------------------------------------------------------------
	// Route registration
	// ---------------------------------------------------------------------------

	private registerRoutesFromRegistry(): void {
		const workflows = this.getWebhookWorkflows();
		if (workflows.length === 0) {
			this.logger.log("[blok][webhook] no workflows with trigger.webhook found");
			return;
		}
		this.logger.log(`[blok][webhook] registering ${workflows.length} webhook route(s):`);
		for (const entry of workflows) {
			this.registerWebhookRoute(entry);
		}
	}

	private registerWebhookRoute(entry: { workflowName: string; config: WebhookTriggerConfig }): void {
		const { workflowName, config } = entry;
		const path = config.path ?? (config.provider ? `/webhooks/${config.provider}` : `/webhooks/${workflowName}`);
		const label = config.provider ?? "custom";
		this.logger.log(`[blok][webhook]   POST    ${path}  ←  ${workflowName}  (${label})`);

		this.app.post(path, (c: HonoContext) => this.handleRequest(c, workflowName, path, config));
	}

	private async handleRequest(
		c: HonoContext,
		workflowName: string,
		path: string,
		config: WebhookTriggerConfig,
	): Promise<Response> {
		this.counterReceived.add(1, { workflow_name: workflowName });

		// 1. Capture raw body BEFORE parsing — verifiers sign the wire bytes.
		const rawBody = await c.req.text();
		let parsedBody: unknown = {};
		if (rawBody.length > 0) {
			try {
				parsedBody = JSON.parse(rawBody) as unknown;
			} catch {
				// Non-JSON body — leave parsed as the raw text. Slack
				// challenges & Shopify can post non-JSON occasionally.
				parsedBody = rawBody;
			}
		}

		const headers = Object.fromEntries(c.req.raw.headers);
		const pathParams = c.req.param() as Record<string, string>;
		const queryParams = Object.fromEntries(new URL(c.req.url).searchParams);

		// 2. Pick the verifier.
		const verifier = this.resolveVerifier(workflowName, config);
		if (!verifier) {
			this.counterRejected.add(1, { workflow_name: workflowName, reason: "no_verifier" });
			return c.json({ error: "Configuration", reason: "no_verifier", message: "No verifier configured" }, 500);
		}

		// 3. Resolve the secret from the env var.
		const secretEnv = config.secretEnv ?? config.signature?.secretEnv;
		const secret = secretEnv ? (process.env[secretEnv] ?? "") : "";

		// 4. Verify.
		const toleranceSec = config.tolerance ?? config.signature?.tolerance ?? DEFAULT_TOLERANCE_SEC;
		const result: VerifyResult = verifier.verify({
			headers,
			rawBody,
			parsedBody,
			secret,
			toleranceSec,
		});

		if (!result.ok) {
			this.counterRejected.add(1, { workflow_name: workflowName, reason: result.reason });
			this.logger.error(
				`[blok][webhook] ${workflowName}: verify failed reason=${result.reason} message="${result.message}"`,
			);
			return c.json({ error: "Unauthorized", reason: result.reason, message: result.message }, 401);
		}

		// 5. Events allowlist — verified-but-out-of-scope returns 200 (no retry).
		if (Array.isArray(config.events) && config.events.length > 0 && !config.events.includes(result.eventType)) {
			this.counterRejected.add(1, { workflow_name: workflowName, reason: "event_not_allowed" });
			return c.json({ status: "ignored", reason: "event_not_allowed", eventType: result.eventType }, 200);
		}

		// 6. Replay protection via the idempotency cache.
		if (config.idempotencyKey && result.eventId) {
			const tracker = RunTracker.getInstance();
			const store = tracker.getStore();
			const cached = store.getIdempotencyCache(REPLAY_NAMESPACE, workflowName, result.eventId);
			if (cached) {
				this.counterRejected.add(1, { workflow_name: workflowName, reason: "replay" });
				return c.json(
					{
						status: "duplicate",
						eventId: result.eventId,
						eventType: result.eventType,
						firstSeenRunId: cached.sourceRunId,
					},
					200,
				);
			}
		}

		// 7. Verified + new event — dispatch the workflow.
		this.counterAccepted.add(1, { workflow_name: workflowName });
		const requestId = uuid();
		let dispatchOutcome: unknown;
		try {
			dispatchOutcome = await this.dispatchWorkflow({
				workflowName,
				path,
				config,
				requestId,
				headers,
				body: parsedBody,
				rawBody,
				pathParams,
				queryParams,
				eventId: result.eventId,
				eventType: result.eventType,
			});
		} catch (err) {
			// ADR 0015 — a deterministic input-validation failure. Reached only
			// AFTER signature verification, so no unauthenticated exposure. Return a
			// real 4xx with the structured `validation_errors` body, and DO NOT fall
			// through to the dedup-cache write below — so the sender may retry the
			// same delivery after correcting the payload.
			const ge = err as GlobalError;
			const code = (ge.context?.code as number | undefined) ?? 400;
			this.counterRejected.add(1, { workflow_name: workflowName, reason: "validation" });
			return c.json(ge.hasJson?.() ? (ge.context.json as object) : { error: ge.message }, code as 400);
		}

		// 8. Cache event id AFTER successful dispatch so retries on the
		//    same delivery are deduped. We cache even on workflow failure
		//    — webhook senders should not retry deliveries they've
		//    already delivered (the workflow's own retry / DLQ owns that).
		if (config.idempotencyKey && result.eventId) {
			const tracker = RunTracker.getInstance();
			const store = tracker.getStore();
			store.setIdempotencyCache(REPLAY_NAMESPACE, workflowName, result.eventId, {
				data: { eventId: result.eventId, eventType: result.eventType },
				cachedAt: Date.now(),
				expiresAt: Date.now() + DEFAULT_REPLAY_TTL_MS,
				sourceRunId: requestId,
				sourceNodeRunId: requestId,
			});
		}

		// 9. Shape the response. Workflow's `ctx.response` lands in the
		//    body for parity with HTTP triggers.
		return c.json(
			{
				status: "ok",
				eventId: result.eventId,
				eventType: result.eventType,
				runId: requestId,
				response: dispatchOutcome,
			},
			200,
		);
	}

	private resolveVerifier(workflowName: string, config: WebhookTriggerConfig): Verifier | null {
		if (config.provider) {
			const v = BUILTIN_VERIFIERS[config.provider];
			if (!v) {
				this.logger.error(`[blok][webhook] ${workflowName}: unknown provider "${config.provider}"`);
				return null;
			}
			return v;
		}
		if (config.signature) {
			return buildCustomVerifier({
				scheme: config.signature.scheme ?? "hmac-sha256",
				header: config.signature.header,
				format: config.signature.format ?? "{hex}",
				secretEnv: config.signature.secretEnv,
				tolerance: config.signature.tolerance ?? DEFAULT_TOLERANCE_SEC,
				timestampHeader: config.signature.timestampHeader,
				eventIdHeader: config.signature.eventIdHeader,
				eventIdPath: config.signature.eventIdPath,
			});
		}
		return null;
	}

	// ---------------------------------------------------------------------------
	// Workflow dispatch
	// ---------------------------------------------------------------------------

	private async dispatchWorkflow(opts: {
		workflowName: string;
		path: string;
		config: WebhookTriggerConfig;
		requestId: string;
		headers: Record<string, string>;
		body: unknown;
		rawBody: string;
		pathParams: Record<string, string>;
		queryParams: Record<string, string>;
		eventId: string;
		eventType: string;
	}): Promise<unknown> {
		const { workflowName, requestId, headers, body, rawBody, pathParams, queryParams, eventId, eventType } = opts;

		return this.tracer.startActiveSpan(`webhook:${workflowName}`, async (span: Span) => {
			try {
				const registry = WorkflowRegistry.getInstance();
				const entry = registry.get(workflowName);
				if (!entry) {
					throw new Error(`[blok][webhook] workflow "${workflowName}" not found in registry`);
				}
				await this.configuration.init(workflowName, this.nodeMap, entry.workflow);

				const ctx: Context = this.createContext(undefined, workflowName, requestId);
				ctx.request = {
					body,
					rawBody,
					headers,
					params: pathParams,
					query: queryParams,
				} as unknown as RequestContext;

				// Stamp webhook metadata onto ctx so polymorphic dispatch
				// can read namespace + event metadata uniformly.
				(ctx as Record<string, unknown>)._webhook = {
					eventId,
					eventType,
					namespace: opts.config.namespace,
				};

				await this.applyMiddlewareChain(ctx, this.nodeMap);
				await this.run(ctx);

				span.setAttribute("workflow_name", workflowName);
				span.setAttribute("event_id", eventId);
				span.setAttribute("event_type", eventType);
				span.setStatus({ code: SpanStatusCode.OK });
				return ctx.response;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				span.recordException(err as Error);
				span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
				this.logger.error(`[blok][webhook] workflow ${workflowName} failed: ${msg}`);
				// ADR 0015 — surface a deterministic input-validation failure to the
				// caller as a real 4xx (handled in `handleRequest`) instead of
				// swallowing it into a 200 body and caching the delivery as processed.
				// Runtime/other failures keep the "delivery received, the workflow owns
				// its own retry/DLQ" contract → 200.
				if (isNonRetryableValidationError(err)) throw err;
				return { error: msg };
			} finally {
				span.end();
			}
		});
	}

	// ---------------------------------------------------------------------------
	// Introspection
	// ---------------------------------------------------------------------------

	getStats(): { workflowsRegistered: number } {
		return { workflowsRegistered: this.getWebhookWorkflows().length };
	}

	private getWebhookWorkflows(): Array<{ workflowName: string; config: WebhookTriggerConfig }> {
		const registry = WorkflowRegistry.getInstance();
		const out: Array<{ workflowName: string; config: WebhookTriggerConfig }> = [];
		for (const entry of registry.list()) {
			const wf = entry.workflow as { trigger?: { webhook?: WebhookTriggerConfig } } | undefined;
			const cfg = wf?.trigger?.webhook;
			if (!cfg) continue;
			// Skip configs missing both provider AND signature — they can't
			// verify anything. Authors get a structured error at boot.
			if (!cfg.provider && !cfg.signature) {
				this.logger.error(
					`[blok][webhook] workflow "${entry.name}" has trigger.webhook with neither \`provider\` nor \`signature\` — skipping. Add one to enable signature verification.`,
				);
				continue;
			}
			out.push({ workflowName: entry.name, config: cfg });
		}
		return out;
	}
}

// -----------------------------------------------------------------------------
// Singleton accessor (mirrors WS / SSE)
// -----------------------------------------------------------------------------

let activeTrigger: WebhookTrigger | null = null;

export function _setActiveWebhookTrigger(trigger: WebhookTrigger | null): void {
	activeTrigger = trigger;
}

export function _getActiveWebhookTrigger(): WebhookTrigger | null {
	return activeTrigger;
}

export type { WebhookTriggerConfig };
