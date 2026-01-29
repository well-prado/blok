/**
 * Cloud Provider Pricing Models for Blok Runtime Cost Estimation
 *
 * Pricing is based on publicly available cloud provider rates as of 2026-01.
 * All costs are in USD.
 */

export type CloudProvider = "aws" | "gcp" | "azure" | "local";
export type RuntimeCostCategory = "in-process" | "docker" | "grpc" | "wasm";

export interface RuntimeCostModel {
	category: RuntimeCostCategory;
	baseCostPerExecution: number;
	costPerMsCpu: number;
	costPerMbMemorySecond: number;
	containerOverheadMs: number;
	networkCostPerCall: number;
}

/** Map RuntimeKind to cost category */
export function getRuntimeCategory(runtimeKind: string, stepType?: string): RuntimeCostCategory {
	if (runtimeKind === "wasm") return "wasm";
	if (runtimeKind === "nodejs" || runtimeKind === "bun" || stepType === "local" || stepType === "module")
		return "in-process";
	// go, java, rust, php, csharp, ruby, python3, docker — all use HTTP SDK containers
	return "docker";
}

/** Default cost models per provider and category */
export const PRICING: Record<CloudProvider, Record<RuntimeCostCategory, RuntimeCostModel>> = {
	aws: {
		"in-process": {
			category: "in-process",
			baseCostPerExecution: 0.0000002, // Lambda per-request ($0.20/million)
			costPerMsCpu: 0.0000000167, // Lambda GB-s pricing at 128MB
			costPerMbMemorySecond: 0.0000000167,
			containerOverheadMs: 0,
			networkCostPerCall: 0,
		},
		docker: {
			category: "docker",
			baseCostPerExecution: 0.0000002,
			costPerMsCpu: 0.0000000334, // Fargate vCPU-second pricing
			costPerMbMemorySecond: 0.0000000037,
			containerOverheadMs: 50, // Cold start for container
			networkCostPerCall: 0.000001, // Network transfer
		},
		grpc: {
			category: "grpc",
			baseCostPerExecution: 0.0000002,
			costPerMsCpu: 0.0000000167,
			costPerMbMemorySecond: 0.0000000167,
			containerOverheadMs: 5,
			networkCostPerCall: 0.000005, // gRPC call overhead
		},
		wasm: {
			category: "wasm",
			baseCostPerExecution: 0.0000001, // Minimal overhead
			costPerMsCpu: 0.00000001,
			costPerMbMemorySecond: 0.000000005,
			containerOverheadMs: 1,
			networkCostPerCall: 0,
		},
	},
	gcp: {
		"in-process": {
			category: "in-process",
			baseCostPerExecution: 0.0000004,
			costPerMsCpu: 0.00001,
			costPerMbMemorySecond: 0.0000025,
			containerOverheadMs: 0,
			networkCostPerCall: 0,
		},
		docker: {
			category: "docker",
			baseCostPerExecution: 0.0000004,
			costPerMsCpu: 0.0000324,
			costPerMbMemorySecond: 0.0000035,
			containerOverheadMs: 80,
			networkCostPerCall: 0.000001,
		},
		grpc: {
			category: "grpc",
			baseCostPerExecution: 0.0000004,
			costPerMsCpu: 0.00001,
			costPerMbMemorySecond: 0.0000025,
			containerOverheadMs: 5,
			networkCostPerCall: 0.000005,
		},
		wasm: {
			category: "wasm",
			baseCostPerExecution: 0.0000002,
			costPerMsCpu: 0.000000008,
			costPerMbMemorySecond: 0.000000004,
			containerOverheadMs: 1,
			networkCostPerCall: 0,
		},
	},
	azure: {
		"in-process": {
			category: "in-process",
			baseCostPerExecution: 0.0000002,
			costPerMsCpu: 0.000016,
			costPerMbMemorySecond: 0.000016,
			containerOverheadMs: 0,
			networkCostPerCall: 0,
		},
		docker: {
			category: "docker",
			baseCostPerExecution: 0.0000002,
			costPerMsCpu: 0.000034,
			costPerMbMemorySecond: 0.0000037,
			containerOverheadMs: 60,
			networkCostPerCall: 0.000001,
		},
		grpc: {
			category: "grpc",
			baseCostPerExecution: 0.0000002,
			costPerMsCpu: 0.000016,
			costPerMbMemorySecond: 0.000016,
			containerOverheadMs: 5,
			networkCostPerCall: 0.000005,
		},
		wasm: {
			category: "wasm",
			baseCostPerExecution: 0.0000001,
			costPerMsCpu: 0.00000001,
			costPerMbMemorySecond: 0.000000005,
			containerOverheadMs: 1,
			networkCostPerCall: 0,
		},
	},
	local: {
		"in-process": {
			category: "in-process",
			baseCostPerExecution: 0,
			costPerMsCpu: 0,
			costPerMbMemorySecond: 0,
			containerOverheadMs: 0,
			networkCostPerCall: 0,
		},
		docker: {
			category: "docker",
			baseCostPerExecution: 0,
			costPerMsCpu: 0,
			costPerMbMemorySecond: 0,
			containerOverheadMs: 50,
			networkCostPerCall: 0,
		},
		grpc: {
			category: "grpc",
			baseCostPerExecution: 0,
			costPerMsCpu: 0,
			costPerMbMemorySecond: 0,
			containerOverheadMs: 5,
			networkCostPerCall: 0,
		},
		wasm: {
			category: "wasm",
			baseCostPerExecution: 0,
			costPerMsCpu: 0,
			costPerMbMemorySecond: 0,
			containerOverheadMs: 1,
			networkCostPerCall: 0,
		},
	},
};

/** Default estimated durations (ms) by runtime category when no profiling data available */
export const DEFAULT_DURATIONS: Record<RuntimeCostCategory, number> = {
	"in-process": 10,
	docker: 100,
	grpc: 50,
	wasm: 5,
};

/** Default estimated memory (MB) by runtime category */
export const DEFAULT_MEMORY: Record<RuntimeCostCategory, number> = {
	"in-process": 64,
	docker: 256,
	grpc: 128,
	wasm: 32,
};
