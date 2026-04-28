/**
 * Public exports for the gRPC runtime adapter.
 *
 * Consumers should import from `@blokjs/runner` (the package barrel)
 * rather than reaching into this directory directly.
 */

export { GrpcRuntimeAdapter } from "./GrpcRuntimeAdapter";
export { GrpcClientPool, buildCredentials } from "./GrpcClientPool";
export {
	GRPC_STATUS_MAP,
	type GrpcErrorContext,
	categoryToGrpcStatus,
	isServiceError,
	toBlokError,
} from "./GrpcErrors";
export {
	NodeRuntimeService,
	bufferToJson,
	decodeExecuteEvent,
	decodeExecuteResponse,
	encodeExecuteRequest,
	jsonToBuffer,
	type DecodedExecuteEvent,
	type DecodedExecuteResponse,
	type DecodedLogLine,
	type DecodedMetrics,
	type DecodedNodeError,
	type ExecuteEventProto,
	type ExecuteRequestProto,
	type ExecuteResponseProto,
	type LogLineProto,
	type MetricsProto,
	type NodeErrorProto,
	type NodeRefProto,
	type RuntimeStateProto,
	type StepInfoProto,
	type TriggerInfoProto,
	type WorkflowInfoProto,
	type ExecuteOptionsProto,
} from "./GrpcCodec";
export { buildChannelOptions, DEFAULT_HEALTH_SERVICE_CONFIG } from "./GrpcChannelOptions";
export {
	DEFAULT_GRPC_PORTS,
	GRPC_DEFAULTS,
	type GrpcAdapterConfig,
	type KeepaliveConfig,
	type TlsConfig,
	type Transport,
} from "./types";
