import { type ConfigContext, type Context, Metrics, NodeBase, type ResponseContext } from "@blokjs/shared";
import type ParamsDictionary from "@blokjs/shared/dist/types/ParamsDictionary";
import { type Counter, type Gauge, type Histogram, metrics } from "@opentelemetry/api";
import { type Schema, type ValidationError, Validator } from "jsonschema";
import _ from "lodash";
import type { IBlokResponse } from "./BlokResponse";
import type Condition from "./types/Condition";
import type JsonLikeObject from "./types/JsonLikeObject";
import { applyStepOutput } from "./workflow/PersistenceHelper";

/**
 * OBS-01 — canonical per-node metrics on the `blok` meter. The legacy
 * un-prefixed `node*` family was retired (OBS-05 follow-up); `blokctl
 * profile`/`monitor` + the Grafana dashboard now read `blok_node_*`. These use
 * the correct failure signal (`errored`, from `BlokResponse.error`) rather than
 * the never-flipped `response.success`, so `blok_node_errors_total` actually
 * fires on a failing node. Lazily created once so they bind to the trigger's
 * MeterProvider at boot (and never re-created per execution).
 */
interface NodeInstruments {
	executions: Counter;
	duration: Histogram;
	errors: Counter;
	memory: Gauge;
	cpu: Gauge;
}
let _nodeInstruments: NodeInstruments | null = null;
function nodeInstruments(): NodeInstruments {
	if (!_nodeInstruments) {
		const meter = metrics.getMeter("blok");
		_nodeInstruments = {
			executions: meter.createCounter("blok_node_executions_total", {
				description: "Total node executions",
				unit: "1",
			}),
			duration: meter.createHistogram("blok_node_duration_seconds", {
				description: "Node execution duration in seconds",
				unit: "s",
			}),
			errors: meter.createCounter("blok_node_errors_total", { description: "Total node execution errors", unit: "1" }),
			memory: meter.createGauge("blok_node_memory_bytes", {
				description: "Peak node heap memory, in bytes",
				unit: "By",
			}),
			cpu: meter.createGauge("blok_node_cpu_usage", { description: "Node CPU usage", unit: "1" }),
		};
	}
	return _nodeInstruments;
}

/** Test-only: drop the cached node instruments so a fresh MeterProvider is picked up. */
export function _resetNodeInstrumentsForTests(): void {
	_nodeInstruments = null;
}

export default abstract class BlokService<T> extends NodeBase {
	public inputSchema: Schema;
	public outputSchema: Schema;
	private v: Validator;

	constructor() {
		super();
		this.inputSchema = {};
		this.outputSchema = {};
		this.v = new Validator();
	}

	public setSchemas(input: Schema, output: Schema) {
		this.inputSchema = input;
		this.outputSchema = output;
	}

	public getSchemas() {
		return {
			input: this.inputSchema,
			output: this.outputSchema,
		};
	}

	public async run(ctx: Context): Promise<ResponseContext> {
		const inst = nodeInstruments();

		const globalMetrics = new Metrics();
		globalMetrics.start();
		const response: ResponseContext = { success: true, data: {}, error: null };

		const start = performance.now();
		ctx.logger.log(`Running node: ${this.name} [${JSON.stringify(this.originalConfig)}]`);

		const config = _.cloneDeep(ctx.config) as ConfigContext;
		let opts: JsonLikeObject = (config as JsonLikeObject)[this.name] as unknown as JsonLikeObject;
		const data = ctx.response?.data || ctx.request?.body;
		const inputs = opts.inputs || opts.conditions;

		opts = this.blueprintMapper(
			opts as unknown as ParamsDictionary,
			ctx,
			data as ParamsDictionary,
		) as unknown as JsonLikeObject;
		await this.validate(inputs as JsonLikeObject, this.inputSchema);

		// Process node custom logic
		const result = await this.handle(ctx, inputs as JsonLikeObject);
		this.v.validate(result, this.outputSchema);
		const end = performance.now();

		// Truthful failure indicator. `defineNode.handle()` catches every
		// throw and stuffs it onto `BlokResponse.error` — so the previous
		// "Executed node" log line and the `response.success === false`
		// metrics counter at the bottom of run() were both wrong on the
		// error path (one always said success, the other never fired).
		// Read the BlokResponse's error field once and let the rest of the
		// method use it consistently.
		const blokResponse = result as IBlokResponse;
		const errored = blokResponse.error !== undefined && blokResponse.error !== null;

		// Per-node metrics on the `blok` meter. Duration is in seconds
		// (Prometheus histogram convention).
		const blokNodeAttrs = {
			env: process.env.NODE_ENV ?? "development",
			workflow_path: `${ctx.workflow_path}`,
			workflow_name: `${ctx.workflow_name}`,
			node_name: `${this.name}`,
		};
		inst.executions.add(1, blokNodeAttrs);
		inst.duration.record((end - start) / 1000, blokNodeAttrs);
		if (errored) {
			inst.errors.add(1, blokNodeAttrs);
		}

		// Surface failures clearly on the per-node log so operators don't
		// see a misleading "Executed node" line followed by a contradictory
		// "FAILED" line from RunnerSteps. The structured per-step log
		// emitted by RunnerSteps remains the canonical "step N/M" entry;
		// this one is the inner-node companion.
		if (errored) {
			const errMsg = blokResponse.error instanceof Error ? blokResponse.error.message : String(blokResponse.error);
			ctx.logger.log(`Node ${this.name} failed in ${(end - start).toFixed(2)}ms: ${errMsg}`);
		} else {
			ctx.logger.log(`Executed node: ${this.name} in ${(end - start).toFixed(2)}ms`);
		}

		// V2 persistence — runner-owned, declarative.
		// `ephemeral` skips, `spread` merges, `as` renames, default stores
		// at state[name].
		// Pass through the full IBlokResponse so the helper's error guard
		// (`success: false` / non-null `error`) skips state persistence on
		// the failure path — see PersistenceHelper.isErroredResult.
		applyStepOutput(ctx, this, result as IBlokResponse);

		// Hand the raw result back to the runner. RunnerSteps mirrors
		// response.data into ctx.response so adjacent-step access via
		// `ctx.prev` / `$.prev` keeps working.
		response.data = result;
		// Mirror the inner BlokResponse error state onto the outer envelope
		// the metrics block at the bottom of run() reads. Without this flip
		// the `if (response.success === false)` guard never matched, so
		// the `node_errors` OTel counter has been silently broken for every
		// defineNode-built step since v0.3.x.
		response.success = !errored;
		response.error = errored ? blokResponse.error : null;
		(response.data as unknown as BlokService<T>).contentType = this.contentType;

		globalMetrics.retry();
		globalMetrics.stop();
		const average = await globalMetrics.getMetrics();

		// `average.memory.max` is MB (MemoryUsage divides heapUsed by 1e6);
		// re-expand to bytes for the Prometheus base-unit `_bytes` convention.
		inst.memory.record(average.memory.max * 1_000_000, blokNodeAttrs);
		inst.cpu.record(average.cpu.usage, blokNodeAttrs);

		globalMetrics.clear();

		return response;
	}

	public abstract handle(
		ctx: Context,
		inputs: T | JsonLikeObject | Condition[],
	): Promise<IBlokResponse | BlokService<T>[]>;

	public async validate(obj: JsonLikeObject, schema: Schema): Promise<void> {
		const result = this.v.validate(obj, schema);
		if (result.valid === false) {
			const errors: string[] = [];
			for (let i = 0; i < result.errors.length; i++) {
				const error: ValidationError = result.errors[i];
				errors.push(`${error.property} ${error.message}`);
			}
			throw new Error(errors.join(", "));
		}
	}
}
