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

export default abstract class NodeBase {
	public flow = false;
	public name = "";
	public contentType = "";
	public active = true;
	public stop = false;
	public originalConfig: ParamsDictionary = {};

	/**
	 * @deprecated v2 default-stores every step's output. `set_var: true` is
	 * a no-op (default behaviour); `set_var: false` is normalized to
	 * `ephemeral: true` at workflow load time. Reading this field is still
	 * supported for legacy code paths but new code should rely on `ephemeral`.
	 *
	 * Default is `undefined` (NOT `false`) — `false` here would short-circuit
	 * `PersistenceHelper.applyStepOutput` and disable the v2 default-store
	 * rule for every step that didn't explicitly set the field.
	 */
	public set_var?: boolean;

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
			if (typeof obj === "string") newObj = mapper.replaceString(obj, ctx, data as ParamsDictionary);
			else mapper.replaceObjectStrings(newObj, ctx, data as ParamsDictionary);
		} catch (e) {
			console.log("MAPPER ERROR", e);
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
