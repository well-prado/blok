import _ from "lodash";
import GlobalError from "./GlobalError";
import type Context from "./types/Context";
import type ErrorContext from "./types/ErrorContext";
import type FunctionContext from "./types/FunctionContext";
import type NodeConfigContext from "./types/NodeConfigContext";
import type ParamsDictionary from "./types/ParamsDictionary";
import type ResponseContext from "./types/ResponseContext";
import type Step from "./types/Step";
import type VarsContext from "./types/VarsContext";
import mapper from "./utils/Mapper";
import { MapperResolutionError } from "./utils/MapperResolutionError";

export default abstract class NodeBase {
	public flow = false;
	public name = "";
	public contentType = "";
	public active = true;
	public stop = false;
	public originalConfig: ParamsDictionary = {};

	// =========================================================================
	// V2 persistence knobs — populated by Configuration.getSteps from the
	// step definition. Read by PersistenceHelper.applyStepOutput.
	// =========================================================================

	/**
	 * Alternative state key for this step's output. When set, the runner
	 * stores result.data at `ctx.state[as]` instead of `ctx.state[name]`.
	 */
	public as?: string;

	/**
	 * When true, the runner shallow-merges the keys of result.data into
	 * `ctx.state` instead of nesting under the step name. Mutually exclusive
	 * with `as`.
	 */
	public spread = false;

	/**
	 * When true, the runner skips persisting this step's output to state.
	 * Only `ctx.prev` carries the result to the immediately next step.
	 */
	public ephemeral = false;

	// =========================================================================
	// V2 idempotency cache + retry knobs — populated by Configuration.getSteps
	// from the step definition. Read by RunnerSteps before delegating to
	// `step.process()`. Caching layers ABOVE PersistenceHelper.applyStepOutput;
	// retry wraps the same call site.
	//
	// Mirrors the Zod schema in `@blokjs/helper/src/types/StepOpts.ts`. Kept
	// as a structural interface here to avoid a runtime dep from shared on
	// helper.
	// =========================================================================

	/**
	 * Optional cache key for this step's result. When set, the runner consults
	 * the idempotency cache before executing — a hit returns the cached result
	 * (and emits a NODE_CACHED event); a miss runs the step and caches its
	 * result on success. Cache namespace is (workflowName, name, idempotencyKey).
	 *
	 * Author-facing values may be a literal string ("user-123") or a $ proxy
	 * expression compiled to `js/ctx....`. The runner resolves the expression
	 * against the live ctx at run time before consulting the cache.
	 */
	public idempotencyKey?: string;

	/**
	 * Optional cache lifetime in milliseconds. Defaults to 24 hours
	 * (86_400_000) when undefined. Pass 0 to mark a stored result as
	 * immediately expired (effectively disables caching for this step).
	 */
	public idempotencyKeyTTL?: number;

	/**
	 * Optional retry configuration with capped exponential backoff. When
	 * undefined, the step runs at most once (matches pre-v0.3.x behaviour).
	 * Per-attempt failures emit `NODE_ATTEMPT_FAILED` trace events.
	 */
	public retry?: {
		maxAttempts: number;
		minTimeoutInMs?: number;
		maxTimeoutInMs?: number;
		factor?: number;
		/**
		 * Error names that never retry. When a thrown or soft error (or any
		 * wrapped `cause`) carries one of these names — `Error.name` or
		 * `GlobalError.context.name` — the step fails on the current attempt
		 * without further retries or backoff.
		 */
		nonRetryableErrorNames?: string[];
	};

	/**
	 * Tier 2 quick-wins — per-attempt execution timeout in milliseconds.
	 * When set, `RunnerSteps` wraps each `step.process()` in a setTimeout-
	 * based Promise.race. On timeout, throws `StepTimeoutError` (which the
	 * retry loop treats as any other error). On final-attempt timeout,
	 * the run auto-flips to `"timedOut"` status. When undefined, the
	 * step runs without a per-attempt cap (matches pre-quick-wins
	 * behaviour).
	 *
	 * Originally set as a duration string or number on the step schema;
	 * `Configuration.getSteps` converts to milliseconds via
	 * `parseDuration` before assigning here.
	 */
	public maxDurationMs?: number;

	// =========================================================================
	// V2 sub-workflow knobs — populated by Configuration.getSteps for steps
	// that invoke another workflow (`subworkflow: "<name>"` shape). Read by
	// `SubworkflowNode.run()` to look up the child workflow in the
	// WorkflowRegistry. Mirrors the Zod schema in `@blokjs/helper`.
	// =========================================================================

	/**
	 * Name of the workflow to invoke when this step runs. When set, the
	 * step's `node` ref is `"@blokjs/subworkflow"` (a sentinel) and the
	 * runner resolves it to a `SubworkflowNode` that looks up the child
	 * by this name in the `WorkflowRegistry` singleton.
	 */
	public subworkflow?: string;

	/**
	 * If true (default), the parent step blocks until the child workflow
	 * completes. The child's `ctx.response` becomes the parent step's
	 * output (lands on `state[<id>]` like any other step).
	 *
	 * `wait: false` (fire-and-forget) is rejected at workflow load time
	 * in v0.3.x — the schema includes a deferred-feature error message.
	 */
	public wait?: boolean;

	public async process(ctx: Context, step?: Step): Promise<ResponseContext> {
		let response: ResponseContext = {
			success: true,
			data: null,
			error: null,
		};

		const config: NodeConfigContext = ctx.config as unknown as NodeConfigContext;
		this.originalConfig = _.cloneDeep(config[this.name]);
		this.blueprintMapper(config[this.name], ctx);

		response = await this.run(ctx);

		if (response.error) throw response.error;
		ctx.response = response;

		return response;
	}

	public async processFlow(ctx: Context): Promise<ResponseContext> {
		let response: ResponseContext = {
			success: true,
			data: null,
			error: null,
		};

		try {
			const config: NodeConfigContext = ctx.config as unknown as NodeConfigContext;
			this.blueprintMapper(config[this.name], ctx);

			response = await this.run(ctx);
		} catch (error: unknown) {
			response.error = this.setError(error as ErrorContext);
			response.success = false;
			ctx.response = response;
		}

		return response;
	}

	abstract run(ctx: Context): Promise<ResponseContext>;

	public runSteps(step: Step | Step[], ctx: Context): Promise<Context> {
		console.error("[Error] runSteps method is not implemented.");
		throw new Error("runSteps method is not implemented.");
	}

	public runJs(
		str: string,
		ctx: Context,
		data: ParamsDictionary = {},
		func: FunctionContext = {},
		vars: VarsContext = {},
	): ParamsDictionary {
		return Function("ctx", "data", "func", "vars", `"use strict";return (${str});`)(ctx, data, func, vars);
	}

	/**
	 * @deprecated In v2, return your output and let the runner persist it
	 * to `ctx.state[id]` automatically. Use `ctx.publish(name, value)` for
	 * explicit side-channel publication when you really need it. This
	 * method continues to work for legacy code.
	 */
	public setVar(ctx: Context, vars: VarsContext) {
		if (ctx.vars === undefined) ctx.vars = {};
		ctx.vars = { ...ctx.vars, ...vars };
	}

	/**
	 * @deprecated Read from `ctx.state[name]` directly, or reference it from
	 * a workflow step's `inputs` as `$.state[name]` / `js/ctx.state.name`.
	 */
	public getVar(ctx: Context, name: string) {
		return ctx.vars?.[name];
	}

	public blueprintMapper = (obj: ParamsDictionary, ctx: Context, data?: ParamsDictionary) => {
		let newObj: ParamsDictionary | string = obj;

		try {
			if (typeof obj === "string")
				newObj = mapper.replaceString(obj, ctx, data as ParamsDictionary) as unknown as string;
			else mapper.replaceObjectStrings(newObj, ctx, data as ParamsDictionary);
		} catch (e) {
			// `MapperResolutionError` (strict mode) carries full diagnostic
			// context — let it escape so the step's error envelope surfaces
			// the workflow / step / expression that failed.
			if (e instanceof MapperResolutionError) throw e;
			// Anything else here is an UNEXPECTED bug in the mapper itself
			// (recursion fault, OOM, logger crash). Surface loudly via
			// stderr WITH the stack trace — never silently swallow.
			console.error("[blok][mapper] unexpected error during input resolution:", e);
		}

		return newObj;
	};

	public setError(config: ErrorContext): GlobalError {
		let errorHandler: GlobalError;

		if (typeof config === "string") {
			errorHandler = new GlobalError(config);
		} else if (config.message && Object.keys(config).length === 1) {
			errorHandler = new GlobalError(config.message as string);
		} else {
			const err = typeof config === "object" ? JSON.stringify(config) : "Unkwon Error";
			errorHandler = new GlobalError(err);
			if (typeof config === "object") {
				errorHandler.setJson(config);
			}
		}

		if (config.json) errorHandler.setJson(config);
		if (config.stack) errorHandler.setStack(config.stack);
		if (config.code) errorHandler.setCode(typeof config.code === "number" ? config.code : 500);

		errorHandler.setName(this.name);

		return errorHandler;
	}
}
