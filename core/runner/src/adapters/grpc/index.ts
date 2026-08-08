/**
 * Public exports for the gRPC runtime adapter.
 *
 * Consumers should import from `@blokjs/runner` (the package barrel)
 * rather than reaching into this directory directly.
 */

export { GrpcRuntimeAdapter } from "./GrpcRuntimeAdapter";
export { GrpcClientPool, buildCredentials } from "./GrpcClientPool";
export {
	GrpcHealthChecker,
	type HealthCheckerOptions,
	type HealthProbe,
} from "./GrpcHealthChecker";
export {
	GRPC_STATUS_MAP,
	type GrpcErrorContext,
	categoryToGrpcStatus,
	isServiceError,
	toBlokError,
} from "./GrpcErrors";
export {
	getNodeRuntimeService,
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
	BLOB_CAPABILITY,
	BlobStore,
	DEFAULT_BLOB_RETENTION_MS,
	DEFAULT_BLOB_THRESHOLD_BYTES,
	blobRetentionMs,
	blobStoreFromEnv,
	blobThresholdBytes,
	isBlobRef,
	type BlobRef,
	_resetBlobStoreForTests,
} from "./BlobStore";
export {
	DEFAULT_GRPC_PORTS,
	GRPC_DEFAULTS,
	type GrpcAdapterConfig,
	type KeepaliveConfig,
	type TlsConfig,
	type Transport,
} from "./types";
