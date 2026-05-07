import fs from "node:fs";
import { type ChannelCredentials, type Client, credentials as grpcCredentials } from "@grpc/grpc-js";
import { buildChannelOptions } from "./GrpcChannelOptions";
import { NodeRuntimeService } from "./GrpcCodec";
import type { GrpcAdapterConfig, TlsConfig } from "./types";

/**
 * Pool of gRPC clients keyed by `(host, port)`. One persistent client per
 * endpoint for the lifetime of the pool — no per-request TCP/HTTP/2
 * handshake.
 *
 * Adapters request a client via {@link get}; the pool creates it on first
 * use and caches it. {@link close} drains all clients, used during graceful
 * shutdown.
 *
 * Single Responsibility: lifecycle of `Client` instances. The pool does not
 * encode requests, decode responses, or interpret errors — those belong to
 * {@link GrpcCodec} and {@link GrpcErrors}.
 */
export class GrpcClientPool {
	private readonly clients: Map<string, Client> = new Map();

	/**
	 * Get (or lazily create) a client for the given config's `(host, port)`.
	 * Subsequent calls with the same endpoint return the same instance.
	 */
	get(config: GrpcAdapterConfig): Client {
		const endpoint = `${config.host}:${config.port}`;
		const existing = this.clients.get(endpoint);
		if (existing) return existing;

		const creds = buildCredentials(config.tls);
		const options = buildChannelOptions(config);
		const ServiceCtor = NodeRuntimeService as unknown as new (
			endpoint: string,
			credentials: ChannelCredentials,
			options: ReturnType<typeof buildChannelOptions>,
		) => Client;

		const client = new ServiceCtor(endpoint, creds, options);
		this.clients.set(endpoint, client);
		return client;
	}

	/**
	 * Close a client for a specific endpoint. Returns true if a client was
	 * present and closed.
	 */
	closeEndpoint(host: string, port: number): boolean {
		const endpoint = `${host}:${port}`;
		const client = this.clients.get(endpoint);
		if (!client) return false;
		client.close();
		this.clients.delete(endpoint);
		return true;
	}

	/**
	 * Drain the pool. Closes every cached client.
	 */
	close(): void {
		for (const client of this.clients.values()) {
			try {
				client.close();
			} catch {
				/* swallow — best-effort cleanup during shutdown */
			}
		}
		this.clients.clear();
	}

	/** How many clients the pool currently holds. */
	size(): number {
		return this.clients.size;
	}
}

/**
 * Build channel credentials from a {@link TlsConfig}. When `tls` is omitted
 * returns insecure credentials (plaintext channel) — appropriate for loopback
 * dev only.
 *
 * `BLOK_GRPC_REQUIRE_TLS=true` causes the adapter to throw at startup when an
 * insecure channel targets a non-loopback host.
 */
export function buildCredentials(tls?: TlsConfig): ChannelCredentials {
	if (!tls) return grpcCredentials.createInsecure();

	if (tls.insecureSkipVerify) {
		// Verified-server-via-handshake-skipped is genuinely insecure. We log
		// at adapter startup; here we just produce the credentials object.
		return grpcCredentials.createInsecure();
	}

	const ca = tls.caCertPath ? fs.readFileSync(tls.caCertPath) : null;
	const clientCert = tls.clientCertPath ? fs.readFileSync(tls.clientCertPath) : null;
	const clientKey = tls.clientKeyPath ? fs.readFileSync(tls.clientKeyPath) : null;

	return grpcCredentials.createSsl(ca ?? null, clientKey ?? null, clientCert ?? null);
}
