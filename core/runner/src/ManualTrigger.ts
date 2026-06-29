import type { Context, RequestContext } from "@blokjs/shared";
import { v4 as uuid } from "uuid";
import Configuration from "./Configuration";
import TriggerBase from "./TriggerBase";
import type GlobalOptions from "./types/GlobalOptions";
import { WorkflowRegistry } from "./workflow/WorkflowRegistry";

/**
 * ManualTrigger — the programmatic dispatch entrypoint for the `manual` trigger
 * kind (#434). Unlike every other trigger, it does NOT listen on a socket or a
 * broker: the application code PUSHES a workflow in by calling {@link dispatch}.
 * This is the typed function-call surface for invoking a Blok workflow from
 * arbitrary host code (a script, a custom queue consumer, a cron in the host
 * app) — distinct from sub-workflows (workflow → workflow) and the test runner
 * (tests only).
 *
 * The dispatch args land at `ctx.request.body`, which the workflow's callback
 * receives as the typed `args` entry handle (`ManualEntry`; typed from the
 * workflow's declared `input` Zod when present). Each dispatch runs through the
 * full runner — tracing, persistence, retries, idempotency, concurrency — so a
 * manually-dispatched run is a first-class Blok Studio run like any other.
 *
 * Lifecycle mirrors the other triggers: construct → {@link setNodeMap} →
 * {@link listen} (registers this trigger's workflows so they can be resolved by
 * name) → {@link dispatch}. When another trigger (e.g. HTTP) has already
 * populated the `WorkflowRegistry`, `dispatch` resolves against it directly.
 *
 * ```ts
 * const manual = new ManualTrigger();
 * manual.setNodeMap(nodeMap);
 * await manual.listen();
 * const result = await manual.dispatch("reindex-tenant", { tenantId: "t_123" });
 * ```
 */
export default class ManualTrigger extends TriggerBase {
	protected nodeMap: GlobalOptions = {} as GlobalOptions;

	/** Inject the runner-wide options (the `nodes` + `workflows` registry). */
	setNodeMap(nodeMap: GlobalOptions): void {
		this.nodeMap = nodeMap;
	}

	/**
	 * No socket to bind — register this trigger's workflows into the
	 * `WorkflowRegistry` so {@link dispatch} can resolve them by name, then
	 * return. The numeric return is a no-op (0) kept only to satisfy the
	 * `TriggerBase.listen()` contract (other triggers return their bound port).
	 */
	async listen(): Promise<number> {
		this.registerWorkflowsFromNodeMap();
		return 0;
	}

	/**
	 * Invoke a registered workflow by name with `args`. Returns the workflow's
	 * response data (`ctx.response.data`). Each call uses a FRESH `Configuration`
	 * so overlapping dispatches from the host app are isolated (no shared-config
	 * race).
	 *
	 * No-listener guarantee: dispatching a name that no registered workflow
	 * claims throws a clear error rather than silently dropping the call — the
	 * push-model analogue of "an event with no listener".
	 */
	async dispatch<T = unknown>(workflowName: string, args: Record<string, unknown> = {}): Promise<T> {
		if (!workflowName || typeof workflowName !== "string") {
			throw new Error("[blok][manual] dispatch() requires a non-empty workflow name.");
		}
		const registry = WorkflowRegistry.getInstance();
		const entry = registry.get(workflowName);
		if (!entry) {
			const known = registry
				.list()
				.map((w) => w.name)
				.join(", ");
			throw new Error(
				`[blok][manual] no workflow named "${workflowName}" is registered — nothing to dispatch (no-listener guarantee). ` +
					`Registered: ${known || "none"}. Register the workflow (ManualTrigger.listen() or another trigger) before dispatching.`,
			);
		}

		// Fresh Configuration per dispatch → isolated + concurrent-safe. Mirrors
		// SubworkflowNode's child dispatch; `entry.workflow` is the preloaded
		// definition so init skips the disk re-read.
		const config = new Configuration();
		await config.init(workflowName, this.nodeMap, entry.workflow);

		const requestId = uuid();
		const ctx: Context = this.createContext(undefined, workflowName, requestId, config);
		ctx.request = { body: args, headers: {}, params: {}, query: {} } as unknown as RequestContext;

		await this.applyMiddlewareChain(ctx, this.nodeMap);
		await this.run(ctx, config);
		return ctx.response?.data as T;
	}
}
