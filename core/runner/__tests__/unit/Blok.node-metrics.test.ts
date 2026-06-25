import type { Context } from "@blokjs/shared";
import { metrics } from "@opentelemetry/api";
import {
	AggregationTemporality,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { _resetNodeInstrumentsForTests } from "../../src/Blok";
import { defineNode } from "../../src/defineNode";

function ctxFor(name: string, inputs: Record<string, unknown>): Context {
	return {
		id: "t",
		workflow_name: "wf-metrics",
		workflow_path: "/wf-metrics",
		request: { body: {}, headers: {}, query: {}, params: {} },
		response: { data: {}, success: true, error: null },
		error: { message: [] },
		logger: {
			log: vi.fn(),
			logLevel: vi.fn(),
			error: vi.fn(),
			getLogs: vi.fn(() => []),
			getLogsAsText: vi.fn(() => ""),
			getLogsAsBase64: vi.fn(() => ""),
		},
		config: { [name]: { inputs } },
		vars: {},
		state: {},
		env: {},
		eventLogger: null,
		_PRIVATE_: null,
	} as unknown as Context;
}

describe("BlokService.run — OBS-01 node metrics", () => {
	let reader: PeriodicExportingMetricReader;

	beforeAll(() => {
		reader = new PeriodicExportingMetricReader({
			exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
			exportIntervalMillis: 2 ** 31 - 1,
		});
		metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
		_resetNodeInstrumentsForTests();
	});

	afterAll(async () => {
		await metrics.disable();
		_resetNodeInstrumentsForTests();
	});

	async function metricByName(name: string) {
		const { resourceMetrics } = await reader.collect();
		return resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name);
	}

	it("emits blok_node_executions_total + blok_node_duration_seconds on success", async () => {
		const node = defineNode({
			name: "ok-node",
			description: "",
			input: z.object({ v: z.number() }),
			output: z.object({ r: z.number() }),
			async execute(_ctx, input) {
				return { r: input.v * 2 };
			},
		});
		await node.run(ctxFor("ok-node", { v: 5 }));

		expect(await metricByName("blok_node_executions_total")).toBeDefined();
		expect(await metricByName("blok_node_duration_seconds")).toBeDefined();
	});

	it("fires blok_node_errors_total on a failing node, and NOT the retired legacy node_* family", async () => {
		const node = defineNode({
			name: "boom-node",
			description: "",
			input: z.object({}),
			output: z.object({}),
			async execute() {
				throw new Error("kaboom");
			},
		});
		await node.run(ctxFor("boom-node", {}));

		const errs = await metricByName("blok_node_errors_total");
		expect(errs).toBeDefined();
		const point = errs?.dataPoints.find((p) => (p.attributes as Record<string, unknown>).node_name === "boom-node");
		expect(point).toBeDefined();
		expect((point?.value as number) ?? 0).toBeGreaterThanOrEqual(1);

		// The legacy un-prefixed family is retired — none of it should emit.
		expect(await metricByName("node_errors")).toBeUndefined();
		expect(await metricByName("node_time")).toBeUndefined();
		expect(await metricByName("node_memory")).toBeUndefined();
		expect(await metricByName("node_cpu")).toBeUndefined();
	});

	it("emits blok_node_memory_bytes + blok_node_cpu_usage on success", async () => {
		const node = defineNode({
			name: "metered-node",
			description: "",
			input: z.object({}),
			output: z.object({}),
			async execute() {
				return {};
			},
		});
		await node.run(ctxFor("metered-node", {}));

		const mem = await metricByName("blok_node_memory_bytes");
		const cpu = await metricByName("blok_node_cpu_usage");
		expect(mem).toBeDefined();
		expect(cpu).toBeDefined();
		expect(
			mem?.dataPoints.find((p) => (p.attributes as Record<string, unknown>).node_name === "metered-node"),
		).toBeDefined();
	});

	it("does NOT fire node errors on a successful node", async () => {
		const node = defineNode({
			name: "clean-node",
			description: "",
			input: z.object({}),
			output: z.object({}),
			async execute() {
				return {};
			},
		});
		await node.run(ctxFor("clean-node", {}));

		const errs = await metricByName("blok_node_errors_total");
		const cleanPoint = errs?.dataPoints.find(
			(p) => (p.attributes as Record<string, unknown>).node_name === "clean-node",
		);
		expect(cleanPoint).toBeUndefined();
	});
});
