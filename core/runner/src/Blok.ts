import { type ConfigContext, type Context, Metrics, NodeBase, type ResponseContext } from "@blokjs/shared";
import type ParamsDictionary from "@blokjs/shared/dist/types/ParamsDictionary";
import { type Counter, type Gauge, type Histogram, metrics } from "@opentelemetry/api";
import { type Schema, type ValidationError, Validator } from "jsonschema";
import _ from "lodash";
import type { IBlokResponse } from "./BlokResponse";
import type RunnerNode from "./RunnerNode";
import type Condition from "./types/Condition";
import type JsonLikeObject from "./types/JsonLikeObject";
import { applyStepOutput } from "./workflow/PersistenceHelper";

/**
 * OBS-01 (T3) — canonical per-node metrics on the `blok` meter, alongside the
 * legacy un-prefixed `node*` family (retired in a later migration step). Unlike
 * the legacy counters these use the correct failure signal (`errored`, derived
 * from the node's `BlokResponse.error`) rather than the never-flipped local
 * `response.success`, so `blok_node_errors_total` actually fires on a failing
 * node. Lazily created so they bind to the trigger's MeterProvider at boot.
 */
interface NodeInstruments {
	executions: Counter;
	duration: Histogram;
	errors: Counter;
	// Legacy un-prefixed family — still queried by `blokctl profile`/`monitor` +
	// the Grafana dashboard. Cached here (created once) instead of being recreated
	// on every node execution; consumer migration to `blok_node_*` + removal is a
	// follow-up (needs live-Prometheus dashboard verification).
	legacyExecution: Counter;
	legacyTime: Gauge;
	legacyMem: Gauge;
	legacyMemAverage: Gauge;
	legacyMemMin: Gauge;
	legacyMemTotal: Gauge;
	legacyMemFree: Gauge;
	legacyCpu: Gauge;
	legacyCpuAverage: Gauge;
	legacyCpuTotal: Gauge;
	legacyErrors: Counter;
}
let _nodeInstruments: NodeInstruments | null = null;
function nodeInstruments(): NodeInstruments {
	if (!_nodeInstruments) {
		const meter = metrics.getMeter("blok");
		const def = metrics.getMeter("default");
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
			legacyExecution: def.createCounter("node", { description: "Node requests" }),
			legacyTime: def.createGauge("node_time", { description: "Node elapsed time" }),
			legacyMem: def.createGauge("node_memory", { description: "Node memory usage" }),
			legacyMemAverage: def.createGauge("node_memory_average", { description: "Node memory average" }),
			legacyMemMin: def.createGauge("node_memory_usage_min", { description: "Node memory usage min" }),
			legacyMemTotal: def.createGauge("node_memory_total", { description: "Node memory total" }),
			legacyMemFree: def.createGauge("node_memory_free", { description: "Node memory free" }),
			legacyCpu: def.createGauge("node_cpu", { description: "Node cpu usage" }),
			legacyCpuAverage: def.createGauge("node_cpu_average", { description: "Node cpu average" }),
			legacyCpuTotal: def.createGauge("node_cpu_total", { description: "Node cpu total" }),
			legacyErrors: def.createCounter("node_errors", { description: "Node errors" }),
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

		inst.legacyExecution.add(1, {
			env: process.env.NODE_ENV,
			workflow_path: `${ctx.workflow_path}`,
			workflow_name: `${ctx.workflow_name}`,
			node_name: `${this.name}`,
			node: (this as unknown as RunnerNode).node,
		});

		inst.legacyTime.record(end - start, {
			env: process.env.NODE_ENV,
			workflow_path: `${ctx.workflow_path}`,
			workflow_name: `${ctx.workflow_name}`,
			node_name: `${this.name}`,
			node: (this as unknown as RunnerNode).node,
		});

		// OBS-01 (T3) — canonical `blok_node_*` mirrors of the above, on the
		// `blok` meter. Duration is in seconds (Prometheus histogram convention).
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

		inst.legacyMem.record(average.memory.max, {
			env: process.env.NODE_ENV,
			workflow_path: `${ctx.workflow_path}`,
			workflow_name: `${ctx.workflow_name}`,
			node_name: `${this.name}`,
			node: (this as unknown as RunnerNode).node,
		});

		inst.legacyMemAverage.record(average.memory.total, {
			env: process.env.NODE_ENV,
			workflow_path: `${ctx.workflow_path}`,
			workflow_name: `${ctx.workflow_name}`,
			node_name: `${this.name}`,
			node: (this as unknown as RunnerNode).node,
		});

		inst.legacyMemMin.record(average.memory.min, {
			env: process.env.NODE_ENV,
			workflow_path: `${ctx.workflow_path}`,
			workflow_name: `${ctx.workflow_name}`,
			node_name: `${this.name}`,
			node: (this as unknown as RunnerNode).node,
		});

		inst.legacyMemTotal.record(average.memory.global_memory, {
			env: process.env.NODE_ENV,
			workflow_path: `${ctx.workflow_path}`,
			workflow_name: `${ctx.workflow_name}`,
			node_name: `${this.name}`,
			node: (this as unknown as RunnerNode).node,
		});

		inst.legacyMemFree.record(average.memory.global_free_memory, {
			env: process.env.NODE_ENV,
			workflow_path: `${ctx.workflow_path}`,
			workflow_name: `${ctx.workflow_name}`,
			node_name: `${this.name}`,
			node: (this as unknown as RunnerNode).node,
		});

		inst.legacyCpu.record(average.cpu.usage, {
			env: process.env.NODE_ENV,
			workflow_path: `${ctx.workflow_path}`,
			workflow_name: `${ctx.workflow_name}`,
			node_name: `${this.name}`,
			node: (this as unknown as RunnerNode).node,
		});

		inst.legacyCpuAverage.record(average.cpu.average, {
			env: process.env.NODE_ENV,
			workflow_path: `${ctx.workflow_path}`,
			workflow_name: `${ctx.workflow_name}`,
			node_name: `${this.name}`,
			node: (this as unknown as RunnerNode).node,
		});

		inst.legacyCpuTotal.record(average.cpu.total, {
			env: process.env.NODE_ENV,
			workflow_path: `${ctx.workflow_path}`,
			workflow_name: `${ctx.workflow_name}`,
			node_name: `${this.name}`,
			node: (this as unknown as RunnerNode).node,
		});

		globalMetrics.clear();

		// OBS-01 — fire the per-node error counter on the TRUE failure signal.
		// Previously this checked the local `response.success`, which is
		// initialized to `true` and never flipped here (the real error lands on
		// `BlokResponse.error`, captured above as `errored`), so `node_errors`
		// NEVER incremented — per-node error counts were silently always zero.
		if (errored) {
			inst.legacyErrors.add(1, {
				env: process.env.NODE_ENV,
				workflow_path: `${ctx.workflow_path}`,
				workflow_name: `${ctx.workflow_name}`,
				node_name: `${this.name}`,
				node: (this as unknown as RunnerNode).node,
			});
		}

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
