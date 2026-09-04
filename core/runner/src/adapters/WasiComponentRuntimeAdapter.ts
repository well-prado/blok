import {
	BlokError,
	type Context,
	ErrorCategory,
	WASI_COMPONENT_CAPABILITIES,
	type WasiComponentExecutionRequest,
	WasiComponentExecutionRequestSchema,
	type WasiComponentExecutionResponse,
	WasiComponentExecutionResponseSchema,
	type WasiComponentManifestV1,
	type WasiComponentReadiness,
	parseWasiComponentManifest,
} from "@blokjs/shared";
import type RunnerNode from "../RunnerNode";
import type { ExecutionResult, RuntimeAdapter } from "./RuntimeAdapter";

/**
 * The host seam for `runtime.wasi`. A production implementation will be the
 * long-lived Rust/Wasmtime host described in ADR 0001. Keeping this interface
 * small makes lifecycle and policy behavior testable without embedding a
 * second WebAssembly engine in the TypeScript runner.
 */
export interface WasiComponentHost {
	readonly endpoint?: string;
	readiness(): Promise<WasiComponentReadiness>;
	execute(request: WasiComponentExecutionRequest, signal: AbortSignal): Promise<unknown>;
	close?(): Promise<void> | void;
}

export interface WasiComponentRuntimeAdapterOptions {
	readonly host?: WasiComponentHost;
	/** Capabilities approved by deployment policy for this host/tenant. */
	readonly approvedCapabilities?: readonly string[];
}

/**
 * First-class runner identity for a WASI Component Model node.
 *
 * This adapter intentionally has no default engine. Without an injected host
 * it fails closed with a configuration error. That prevents the legacy
 * `WasmRuntimeAdapter` pointer/JSON ABI from being mistaken for a component
 * implementation while allowing the real host to be added behind this seam.
 */
export class WasiComponentRuntimeAdapter implements RuntimeAdapter {
	public readonly kind = "wasi" as const;
	public readonly transport = "grpc" as const;
	public readonly endpoint?: string;

	private readonly host: WasiComponentHost | undefined;
	private readonly approvedCapabilities: ReadonlySet<string>;

	constructor(options: WasiComponentRuntimeAdapterOptions = {}) {
		this.host = options.host;
		this.endpoint = options.host?.endpoint;
		this.approvedCapabilities = new Set(options.approvedCapabilities ?? []);
	}

	/** Readiness is explicit so callers can distinguish absent, draining, and ready hosts. */
	async readiness(): Promise<WasiComponentReadiness> {
		if (!this.host) {
			return {
				status: "unavailable",
				contractVersion: "1",
				reason: "WASI component host is not configured",
			};
		}
		try {
			const readiness = await this.host.readiness();
			return readiness.contractVersion === "1"
				? readiness
				: {
						status: "unavailable",
						contractVersion: "1",
						reason: `unsupported host contract version: ${readiness.contractVersion}`,
					};
		} catch {
			return {
				status: "unavailable",
				contractVersion: "1",
				reason: "WASI component host readiness probe failed",
			};
		}
	}

	async execute(node: RunnerNode, ctx: Context): Promise<ExecutionResult> {
		const startedAt = performance.now();
		let deadlineExpired = () => false;
		let cleanupSignal: (() => void) | undefined;

		try {
			const manifest = this.readManifest(node);
			this.assertCapabilities(manifest, node);

			if (!this.host) {
				return this.failure(
					BlokError.configuration({
						code: "WASI_COMPONENT_HOST_NOT_CONFIGURED",
						message: "The runtime.wasi component host is not configured",
						description:
							"runtime.wasi requires a long-lived Component Model host; the runner does not embed or spawn one per step.",
						remediation:
							"Configure the supported Blok WASI host and inject it into WasiComponentRuntimeAdapter before executing this workflow.",
						node: node.name,
						runtimeKind: "runtime.wasi",
					}),
					startedAt,
				);
			}

			if (ctx.signal?.aborted) {
				return this.failure(
					this.cancelledError(node, "workflow cancellation reached the component boundary"),
					startedAt,
				);
			}

			const readiness = await this.readiness();
			if (readiness.status !== "ready") {
				throw BlokError.dependency({
					code: "WASI_COMPONENT_HOST_NOT_READY",
					message: `The runtime.wasi component host is ${readiness.status}`,
					description: readiness.reason ?? "The host is not accepting component executions.",
					remediation: "Wait for the host to become ready before dispatching runtime.wasi steps.",
					retryable: true,
					node: node.name,
					runtimeKind: "runtime.wasi",
				});
			}
			if (ctx.signal?.aborted) {
				return this.failure(
					this.cancelledError(node, "workflow cancellation arrived during host admission"),
					startedAt,
				);
			}

			const deadlineMs = this.executionDeadline(manifest, ctx);
			const signalState = executionSignal(ctx.signal, deadlineMs);
			deadlineExpired = signalState.deadlineExpired;
			cleanupSignal = signalState.cleanup;
			if (signalState.signal.aborted) {
				return this.failure(
					this.cancelledError(node, "workflow cancellation arrived before component admission"),
					startedAt,
				);
			}

			const request = WasiComponentExecutionRequestSchema.parse({
				contractVersion: "1",
				componentDigest: manifest.artifact.digest,
				exportName: manifest.exportName,
				input: resolvedInputs(ctx, node.name),
				request: {
					body: ctx.request.body,
					headers: stringMap(ctx.request.headers),
					params: stringMap(ctx.request.params),
					query: stringMap(ctx.request.query),
				},
				contentType: node.contentType || "application/json",
				deadlineMs,
				traceparent: readTraceparent(ctx),
			});

			const response = WasiComponentExecutionResponseSchema.parse(await this.host.execute(request, signalState.signal));
			return this.responseResult(response, startedAt);
		} catch (error: unknown) {
			if (ctx.signal?.aborted) {
				return this.failure(
					this.cancelledError(node, "workflow cancellation interrupted component execution"),
					startedAt,
				);
			}
			if (deadlineExpired()) {
				return this.failure(
					BlokError.timeout({
						code: "WASI_COMPONENT_DEADLINE_EXCEEDED",
						message: `WASI component node "${node.name}" exceeded its deadline`,
						node: node.name,
						runtimeKind: "runtime.wasi",
					}),
					startedAt,
				);
			}
			return this.failure(this.errorFromUnknown(error, node), startedAt);
		} finally {
			cleanupSignal?.();
		}
	}

	async close(): Promise<void> {
		await this.host?.close?.();
	}

	private readManifest(node: RunnerNode): WasiComponentManifestV1 {
		const value = (node as RunnerNode & { wasiComponent?: unknown }).wasiComponent;
		if (value === undefined) {
			throw BlokError.configuration({
				code: "WASI_COMPONENT_MANIFEST_REQUIRED",
				message: `runtime.wasi node "${node.name}" is missing a component manifest`,
				description:
					"A component path alone is not a runtime contract. The manifest pins the artifact digest, WIT world, WASI version, capabilities, and limits.",
				remediation: "Add a version 1 runtime.wasi manifest to the step and pin artifact.digest before deployment.",
				node: node.name,
				runtimeKind: "runtime.wasi",
			});
		}
		try {
			return parseWasiComponentManifest(value);
		} catch (error: unknown) {
			throw BlokError.validation({
				code: "WASI_COMPONENT_MANIFEST_INVALID",
				message: `runtime.wasi manifest for node "${node.name}" is invalid`,
				description: error instanceof Error ? error.message : "Manifest validation failed",
				remediation: "Validate the manifest against the versioned blok:runtime@1.0.0 contract.",
				details: { contractVersion: "1", runtime: "runtime.wasi" },
				node: node.name,
				runtimeKind: "runtime.wasi",
			});
		}
	}

	private assertCapabilities(manifest: WasiComponentManifestV1, node: RunnerNode): void {
		const knownCapabilities = new Set<string>(WASI_COMPONENT_CAPABILITIES);
		const undeclaredByPolicy = manifest.capabilityManifest.capabilities.filter(
			(capability) => !knownCapabilities.has(capability) || !this.approvedCapabilities.has(capability),
		);
		if (undeclaredByPolicy.length === 0) return;
		throw BlokError.permission({
			code: "WASI_COMPONENT_CAPABILITY_DENIED",
			message: `WASI component node "${node.name}" requests capabilities that are not approved`,
			description:
				"Component imports are deny-by-default. The host process does not grant a component any capability merely because it possesses it.",
			remediation: "Declare only the required logical capabilities and approve them in the deployment policy.",
			details: { deniedCapabilities: undeclaredByPolicy },
			node: node.name,
			runtimeKind: "runtime.wasi",
		});
	}

	private executionDeadline(manifest: WasiComponentManifestV1, ctx: Context): number {
		const stepDeadline = (ctx as Record<string, unknown>)._stepDeadlineMs;
		const requested = typeof stepDeadline === "number" && stepDeadline > 0 ? stepDeadline : 30_000;
		return Math.min(requested, manifest.limits?.maxDurationMs ?? requested);
	}

	private responseResult(response: WasiComponentExecutionResponse, startedAt: number): ExecutionResult {
		return {
			success: response.success,
			data: response.output,
			contentType: response.contentType,
			errors: response.error ? this.errorFromResponse(response.error) : null,
			logs: response.logs.map((line) => `[${line.level}] ${line.message}`),
			metrics: {
				duration_ms: response.metrics?.durationMs ?? performance.now() - startedAt,
				cpu_ms: response.metrics?.cpuMs,
				memory_bytes: response.metrics?.memoryBytes,
			},
		};
	}

	private errorFromResponse(error: NonNullable<WasiComponentExecutionResponse["error"]>): BlokError {
		const opts = {
			code: error.code,
			message: error.message,
			retryable: error.retryable,
			details: error.details,
			runtimeKind: "runtime.wasi",
		};
		switch (error.category) {
			case ErrorCategory.VALIDATION:
				return BlokError.validation(opts);
			case ErrorCategory.CONFIGURATION:
				return BlokError.configuration(opts);
			case ErrorCategory.DEPENDENCY:
				return BlokError.dependency(opts);
			case ErrorCategory.TIMEOUT:
				return BlokError.timeout(opts);
			case ErrorCategory.PERMISSION:
				return BlokError.permission(opts);
			case ErrorCategory.CANCELLED:
				return BlokError.cancelled(opts);
			case ErrorCategory.PROTOCOL:
				return BlokError.protocol(opts);
			case ErrorCategory.DATA:
				return BlokError.data(opts);
			default:
				return BlokError.internal(opts);
		}
	}

	private errorFromUnknown(error: unknown, node: RunnerNode): BlokError {
		if (error instanceof BlokError) return error;
		return BlokError.protocol({
			code: "WASI_COMPONENT_HOST_PROTOCOL_ERROR",
			message: error instanceof Error ? error.message : "WASI component host returned an invalid response",
			description: "The host response did not satisfy the versioned Component Model execution contract.",
			remediation: "Inspect the host conformance result and ensure it speaks blok:runtime@1.0.0.",
			node: node.name,
			runtimeKind: "runtime.wasi",
		});
	}

	private cancelledError(node: RunnerNode, description: string): BlokError {
		return BlokError.cancelled({
			code: "WASI_COMPONENT_CANCELLED",
			message: `WASI component node "${node.name}" was cancelled`,
			description,
			node: node.name,
			runtimeKind: "runtime.wasi",
		});
	}

	private failure(error: BlokError, startedAt: number): ExecutionResult {
		return {
			success: false,
			data: null,
			errors: error,
			metrics: { duration_ms: performance.now() - startedAt },
		};
	}
}

function resolvedInputs(ctx: Context, nodeName: string): unknown {
	const nodeConfig = (ctx.config as Record<string, unknown> | undefined)?.[nodeName] as
		| Record<string, unknown>
		| undefined;
	return nodeConfig?.inputs ?? ctx.response?.data ?? {};
}

function stringMap(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
}

function readTraceparent(ctx: Context): string | undefined {
	const headers = stringMap(ctx.request.headers);
	return headers.traceparent ?? headers.Traceparent;
}

function executionSignal(
	parent: AbortSignal | undefined,
	timeoutMs: number,
): {
	signal: AbortSignal;
	cleanup: () => void;
	deadlineExpired: () => boolean;
} {
	const controller = new AbortController();
	let expired = false;
	const timer = setTimeout(() => {
		expired = true;
		controller.abort();
	}, timeoutMs);
	const onAbort = () => controller.abort();
	if (parent?.aborted) onAbort();
	else parent?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", onAbort);
		},
		deadlineExpired: () => expired,
	};
}
