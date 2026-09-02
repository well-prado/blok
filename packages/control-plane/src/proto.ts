import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GrpcObject, ServiceDefinition } from "@grpc/grpc-js";
import { type ServiceClientConstructor, loadPackageDefinition } from "@grpc/grpc-js";
import { type Options, loadSync } from "@grpc/proto-loader";

export interface ProtoRequestEnvelope {
	contractVersion: string;
	requestId: string;
	sessionId: string;
	turnId: string;
	deadlineUnixMs: string;
	payloadJson: Buffer;
	metadata: Record<string, string>;
}

export interface ProtoResponseEnvelope {
	contractVersion: string;
	requestId: string;
	status: string;
	code: string;
	message: string;
	payloadJson: Buffer;
	lastSequence: string;
}

export interface ProtoStreamEventsRequest {
	contractVersion: string;
	requestId: string;
	sessionId: string;
	afterSequence: string;
	limit: number;
	follow: boolean;
	deadlineUnixMs: string;
}

export interface ProtoEventEnvelope {
	contractVersion: string;
	sessionId: string;
	sequence: string;
	eventId: string;
	turnId: string;
	kind: string;
	visibility: string;
	payloadJson: Buffer;
	occurredAt: string;
	replayed: boolean;
	terminal: boolean;
}

export interface ProtoHealthRequest {
	contractVersion: string;
	service: string;
}

export interface ProtoHealthResponse {
	contractVersion: string;
	serverInstanceId: string;
	processAlive: boolean;
	storeReady: boolean;
	executionReady: boolean;
	status: string;
	message: string;
}

export interface ProtoCapabilitiesResponse {
	contractVersion: string;
	supportedVersions: string[];
	operations: string[];
	maxRequestBytes: number;
	maxResponseBytes: number;
	maxEventBytes: number;
	supportsCursorResume: boolean;
	supportsAuthentication: boolean;
	supportsDeadlines: boolean;
	supportsCancellation: boolean;
}

export interface HarnessControlPlaneServiceDefinition {
	service: ServiceDefinition;
}

export interface HarnessControlPlaneNamespace extends GrpcObject {
	HarnessControlPlane: HarnessControlPlaneServiceDefinition & ServiceClientConstructor;
}

const PROTO_LOADER_OPTIONS: Options = {
	keepCase: false,
	longs: String,
	enums: String,
	defaults: true,
	oneofs: true,
};

function resolveProtoPath(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(here, "../proto/blok/harness/control/v1/control.proto");
}

let namespace: HarnessControlPlaneNamespace | undefined;

function getNamespace(): HarnessControlPlaneNamespace {
	if (namespace) return namespace;
	const loaded = loadPackageDefinition(loadSync(resolveProtoPath(), PROTO_LOADER_OPTIONS)) as unknown as GrpcObject;
	const blok = loaded.blok as GrpcObject;
	const harness = blok.harness as GrpcObject;
	const control = harness.control as GrpcObject;
	namespace = control.v1 as unknown as HarnessControlPlaneNamespace;
	return namespace;
}

export function getHarnessControlPlaneService(): ServiceDefinition {
	return (getNamespace().HarnessControlPlane as HarnessControlPlaneServiceDefinition).service;
}

export function getHarnessControlPlaneClientConstructor(): ServiceClientConstructor {
	return getNamespace().HarnessControlPlane;
}
