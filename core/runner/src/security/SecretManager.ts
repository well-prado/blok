/**
 * Secret Management for Blok Framework
 *
 * Provides a unified interface for secret management across multiple providers:
 * - HashiCorp Vault (KV v2 engine via REST API)
 * - AWS Secrets Manager (via @aws-sdk/client-secrets-manager)
 * - GCP Secret Manager (via @google-cloud/secret-manager)
 * - Environment Variables (process.env)
 * - In-Memory (for testing)
 *
 * Features:
 * - Provider chain: try providers in order, first match wins
 * - Caching layer with TTL and max size (LRU eviction)
 * - Audit event emission for secret access tracking
 * - Template resolution for `${secret:KEY}` patterns
 *
 * @example
 * ```typescript
 * import {
 *   SecretManager,
 *   EnvironmentSecretProvider,
 *   InMemorySecretProvider,
 * } from "@blok/runner";
 *
 * // Simple setup with environment variables
 * const secrets = new SecretManager({
 *   providers: [
 *     { type: "environment", config: { prefix: "BLOK_SECRET_" } },
 *   ],
 *   cache: { enabled: true, ttlMs: 60_000, maxSize: 100 },
 *   auditLog: true,
 * });
 *
 * const dbPassword = await secrets.getSecret("DB_PASSWORD");
 * const connStr = await secrets.resolveTemplate(
 *   "postgres://user:${secret:DB_PASSWORD}@host/db"
 * );
 * ```
 */

import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * Metadata associated with a stored secret
 */
export interface SecretMetadata {
	/** Version identifier for the secret */
	version?: string;
	/** Unix timestamp (ms) when the secret expires */
	expiresAt?: number;
	/** Arbitrary key-value tags */
	tags?: Record<string, string>;
	/** Human-readable description of the secret */
	description?: string;
}

/**
 * Interface that all secret providers must implement
 */
export interface SecretProvider {
	/** Unique name identifying this provider instance */
	readonly name: string;

	/**
	 * Retrieve a secret value by key
	 * @param key - The secret key to look up
	 * @returns The secret value, or null if not found
	 */
	get(key: string): Promise<string | null>;

	/**
	 * Store or update a secret value
	 * @param key - The secret key
	 * @param value - The secret value
	 * @param metadata - Optional metadata to associate with the secret
	 */
	set(key: string, value: string, metadata?: SecretMetadata): Promise<void>;

	/**
	 * Delete a secret by key
	 * @param key - The secret key to delete
	 */
	delete(key: string): Promise<void>;

	/**
	 * List secret keys, optionally filtered by prefix
	 * @param prefix - Optional prefix to filter keys
	 * @returns Array of secret key names
	 */
	list(prefix?: string): Promise<string[]>;

	/**
	 * Check whether a secret exists
	 * @param key - The secret key to check
	 * @returns True if the secret exists
	 */
	exists(key: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Event emitted when a secret is accessed
 */
export interface SecretAccessEvent {
	/** Type of operation */
	operation: "get" | "set" | "delete" | "list" | "exists";
	/** Secret key (omitted for list operations) */
	key?: string;
	/** Provider that served the request */
	provider: string;
	/** Whether the operation succeeded */
	success: boolean;
	/** Whether the result came from cache */
	cached: boolean;
	/** ISO 8601 timestamp */
	timestamp: string;
	/** Error message if the operation failed */
	error?: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for an environment variable secret provider
 */
export interface EnvironmentProviderConfig {
	type: "environment";
	config?: {
		/** Prefix prepended to key names when reading env vars (e.g., "BLOK_SECRET_") */
		prefix?: string;
		/** Whether key lookups are case-sensitive (default: true) */
		caseSensitive?: boolean;
	};
}

/**
 * Configuration for the in-memory secret provider
 */
export interface InMemoryProviderConfig {
	type: "memory";
	config?: Record<string, never>;
}

/**
 * Configuration for the HashiCorp Vault secret provider
 */
export interface VaultProviderConfig {
	type: "vault";
	config: {
		/** Vault server address (e.g., "https://vault.example.com:8200") */
		address: string;
		/** Authentication token */
		token?: string;
		/** Vault namespace (enterprise feature) */
		namespace?: string;
		/** KV mount path (default: "secret") */
		mountPath?: string;
		/** API version (default: "v1") */
		apiVersion?: string;
	};
}

/**
 * Configuration for the AWS Secrets Manager provider
 */
export interface AWSSecretsProviderConfig {
	type: "aws";
	config: {
		/** AWS region (e.g., "us-east-1") */
		region: string;
		/** AWS access key ID (falls back to SDK defaults if omitted) */
		accessKeyId?: string;
		/** AWS secret access key */
		secretAccessKey?: string;
		/** AWS profile name from credentials file */
		profile?: string;
	};
}

/**
 * Configuration for the GCP Secret Manager provider
 */
export interface GCPSecretProviderConfig {
	type: "gcp";
	config: {
		/** GCP project ID */
		projectId: string;
		/** Path to service account key file */
		keyFile?: string;
	};
}

/**
 * Union of all supported provider configurations
 */
export type SecretProviderConfig =
	| EnvironmentProviderConfig
	| InMemoryProviderConfig
	| VaultProviderConfig
	| AWSSecretsProviderConfig
	| GCPSecretProviderConfig;

/**
 * Cache configuration for the secret manager
 */
export interface SecretCacheConfig {
	/** Whether caching is enabled */
	enabled: boolean;
	/** Time-to-live in milliseconds */
	ttlMs: number;
	/** Maximum number of cached entries (LRU eviction) */
	maxSize: number;
}

/**
 * Top-level configuration for SecretManager
 */
export interface SecretManagerConfig {
	/** Ordered list of provider configurations; first match wins */
	providers: SecretProviderConfig[];
	/** Optional caching layer */
	cache?: SecretCacheConfig;
	/** Whether to emit audit events on secret access (default: false) */
	auditLog?: boolean;
}

// ---------------------------------------------------------------------------
// Cache Entry
// ---------------------------------------------------------------------------

interface CacheEntry {
	value: string;
	expiresAt: number;
}

// ---------------------------------------------------------------------------
// EnvironmentSecretProvider
// ---------------------------------------------------------------------------

/**
 * Secret provider backed by process.env
 *
 * Reads environment variables, optionally with a prefix. Supports
 * case-insensitive lookups when configured.
 *
 * @example
 * ```typescript
 * const provider = new EnvironmentSecretProvider({ prefix: "APP_" });
 * // Reads process.env.APP_DATABASE_URL
 * const dbUrl = await provider.get("DATABASE_URL");
 * ```
 */
export class EnvironmentSecretProvider implements SecretProvider {
	readonly name = "environment";
	private prefix: string;
	private caseSensitive: boolean;

	constructor(config?: { prefix?: string; caseSensitive?: boolean }) {
		this.prefix = config?.prefix ?? "";
		this.caseSensitive = config?.caseSensitive ?? true;
	}

	/**
	 * Retrieve an environment variable value
	 * @param key - Variable name (without prefix)
	 */
	async get(key: string): Promise<string | null> {
		const envKey = this.resolveKey(key);
		const value = process.env[envKey];
		return value !== undefined ? value : null;
	}

	/**
	 * Set an environment variable (primarily useful for testing)
	 * @param key - Variable name (without prefix)
	 * @param value - Value to set
	 */
	async set(key: string, value: string, _metadata?: SecretMetadata): Promise<void> {
		const envKey = this.resolveKey(key);
		process.env[envKey] = value;
	}

	/**
	 * Delete an environment variable
	 * @param key - Variable name (without prefix)
	 */
	async delete(key: string): Promise<void> {
		const envKey = this.resolveKey(key);
		delete process.env[envKey];
	}

	/**
	 * List environment variable names matching the configured prefix
	 * @param prefix - Additional prefix to filter by (applied after the provider prefix)
	 */
	async list(prefix?: string): Promise<string[]> {
		const fullPrefix = this.prefix + (prefix ?? "");
		const keys = Object.keys(process.env).filter((k) => {
			const candidate = this.caseSensitive ? k : k.toUpperCase();
			const match = this.caseSensitive ? fullPrefix : fullPrefix.toUpperCase();
			return candidate.startsWith(match);
		});

		// Strip the provider prefix from returned keys
		return keys.map((k) => k.slice(this.prefix.length));
	}

	/**
	 * Check whether an environment variable exists
	 * @param key - Variable name (without prefix)
	 */
	async exists(key: string): Promise<boolean> {
		const envKey = this.resolveKey(key);
		return envKey in process.env;
	}

	/**
	 * Build the full environment variable name from a logical key
	 */
	private resolveKey(key: string): string {
		const fullKey = this.prefix + key;
		if (this.caseSensitive) {
			return fullKey;
		}
		// For case-insensitive mode, find the matching key in process.env
		const upper = fullKey.toUpperCase();
		const match = Object.keys(process.env).find((k) => k.toUpperCase() === upper);
		return match ?? fullKey;
	}
}

// ---------------------------------------------------------------------------
// InMemorySecretProvider
// ---------------------------------------------------------------------------

/**
 * In-memory secret provider for testing and development
 *
 * Stores secrets in a Map with full CRUD support. Provides stats
 * for debugging and verification.
 *
 * @example
 * ```typescript
 * const provider = new InMemorySecretProvider();
 * await provider.set("API_KEY", "test-key-123");
 * const key = await provider.get("API_KEY"); // "test-key-123"
 * console.log(provider.getStats()); // { size: 1, keys: ["API_KEY"] }
 * ```
 */
export class InMemorySecretProvider implements SecretProvider {
	readonly name = "memory";
	private store: Map<string, { value: string; metadata?: SecretMetadata }> = new Map();

	/**
	 * Retrieve a secret from the in-memory store
	 * @param key - The secret key
	 */
	async get(key: string): Promise<string | null> {
		const entry = this.store.get(key);
		if (!entry) return null;

		// Check expiration
		if (entry.metadata?.expiresAt && entry.metadata.expiresAt < Date.now()) {
			this.store.delete(key);
			return null;
		}

		return entry.value;
	}

	/**
	 * Store a secret in the in-memory store
	 * @param key - The secret key
	 * @param value - The secret value
	 * @param metadata - Optional metadata
	 */
	async set(key: string, value: string, metadata?: SecretMetadata): Promise<void> {
		this.store.set(key, { value, metadata });
	}

	/**
	 * Delete a secret from the in-memory store
	 * @param key - The secret key
	 */
	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}

	/**
	 * List all secret keys, optionally filtered by prefix
	 * @param prefix - Optional prefix filter
	 */
	async list(prefix?: string): Promise<string[]> {
		const keys = Array.from(this.store.keys());
		if (!prefix) return keys;
		return keys.filter((k) => k.startsWith(prefix));
	}

	/**
	 * Check whether a secret exists in the store
	 * @param key - The secret key
	 */
	async exists(key: string): Promise<boolean> {
		if (!this.store.has(key)) return false;

		// Check expiration
		const entry = this.store.get(key)!;
		if (entry.metadata?.expiresAt && entry.metadata.expiresAt < Date.now()) {
			this.store.delete(key);
			return false;
		}

		return true;
	}

	/**
	 * Get debug statistics about the in-memory store
	 * @returns Object with size and list of keys
	 */
	getStats(): { size: number; keys: string[] } {
		return {
			size: this.store.size,
			keys: Array.from(this.store.keys()),
		};
	}

	/**
	 * Clear all secrets from the store
	 */
	clear(): void {
		this.store.clear();
	}
}

// ---------------------------------------------------------------------------
// VaultSecretProvider
// ---------------------------------------------------------------------------

/**
 * HashiCorp Vault secret provider (KV v2 engine)
 *
 * Communicates with Vault via its HTTP REST API using the native `fetch` API.
 * Supports token-based authentication, namespaces, and configurable mount paths.
 *
 * @example
 * ```typescript
 * const vault = new VaultSecretProvider({
 *   address: "https://vault.example.com:8200",
 *   token: process.env.VAULT_TOKEN,
 *   mountPath: "secret",
 * });
 *
 * const dbPassword = await vault.get("database/credentials");
 * ```
 */
export class VaultSecretProvider implements SecretProvider {
	readonly name = "vault";
	private address: string;
	private token: string;
	private namespace: string | undefined;
	private mountPath: string;
	private apiVersion: string;

	constructor(config: {
		address: string;
		token?: string;
		namespace?: string;
		mountPath?: string;
		apiVersion?: string;
	}) {
		this.address = config.address.replace(/\/+$/, "");
		this.token = config.token ?? "";
		this.namespace = config.namespace;
		this.mountPath = config.mountPath ?? "secret";
		this.apiVersion = config.apiVersion ?? "v1";
	}

	/**
	 * Read a secret from Vault KV v2
	 * @param key - The secret path within the mount
	 */
	async get(key: string): Promise<string | null> {
		const url = this.buildUrl("data", key);

		const response = await fetch(url, {
			method: "GET",
			headers: this.buildHeaders(),
		});

		if (response.status === 404) return null;

		if (!response.ok) {
			const body = await response.text();
			throw new Error(`Vault GET failed (${response.status}): ${body}`);
		}

		const json = (await response.json()) as {
			data?: { data?: Record<string, unknown> };
		};

		// KV v2 nests the actual data under data.data
		const value = json.data?.data?.value;
		if (typeof value === "string") return value;

		// If the secret has multiple fields, return as JSON
		if (json.data?.data && typeof json.data.data === "object") {
			return JSON.stringify(json.data.data);
		}

		return null;
	}

	/**
	 * Write a secret to Vault KV v2
	 * @param key - The secret path within the mount
	 * @param value - The secret value
	 * @param metadata - Optional metadata (stored as custom_metadata)
	 */
	async set(key: string, value: string, metadata?: SecretMetadata): Promise<void> {
		const url = this.buildUrl("data", key);

		const body: Record<string, unknown> = {
			data: { value },
		};

		if (metadata) {
			body.options = {};
			if (metadata.version) {
				(body.options as Record<string, unknown>).cas = Number.parseInt(metadata.version, 10);
			}
		}

		const response = await fetch(url, {
			method: "POST",
			headers: this.buildHeaders(),
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const responseBody = await response.text();
			throw new Error(`Vault POST failed (${response.status}): ${responseBody}`);
		}

		// Set custom metadata if provided
		if (metadata?.tags || metadata?.description) {
			await this.setMetadata(key, metadata);
		}
	}

	/**
	 * Delete a secret from Vault KV v2
	 * @param key - The secret path within the mount
	 */
	async delete(key: string): Promise<void> {
		const url = this.buildUrl("metadata", key);

		const response = await fetch(url, {
			method: "DELETE",
			headers: this.buildHeaders(),
		});

		if (!response.ok && response.status !== 404) {
			const body = await response.text();
			throw new Error(`Vault DELETE failed (${response.status}): ${body}`);
		}
	}

	/**
	 * List secret keys under a given path prefix
	 * @param prefix - Optional path prefix
	 */
	async list(prefix?: string): Promise<string[]> {
		const path = prefix ?? "";
		const url = this.buildUrl("metadata", path) + "?list=true";

		const response = await fetch(url, {
			method: "LIST",
			headers: this.buildHeaders(),
		});

		if (response.status === 404) return [];

		if (!response.ok) {
			const body = await response.text();
			throw new Error(`Vault LIST failed (${response.status}): ${body}`);
		}

		const json = (await response.json()) as {
			data?: { keys?: string[] };
		};

		return json.data?.keys ?? [];
	}

	/**
	 * Check whether a secret exists in Vault
	 * @param key - The secret path within the mount
	 */
	async exists(key: string): Promise<boolean> {
		const url = this.buildUrl("data", key);

		const response = await fetch(url, {
			method: "GET",
			headers: this.buildHeaders(),
		});

		return response.ok;
	}

	/**
	 * Update the Vault token (e.g., after token renewal)
	 * @param token - The new Vault token
	 */
	setToken(token: string): void {
		this.token = token;
	}

	/**
	 * Build the full URL for a Vault KV v2 API call
	 */
	private buildUrl(operation: "data" | "metadata", path: string): string {
		const cleanPath = path.replace(/^\/+|\/+$/g, "");
		return `${this.address}/${this.apiVersion}/${this.mountPath}/${operation}/${cleanPath}`;
	}

	/**
	 * Build common HTTP headers for Vault requests
	 */
	private buildHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};

		if (this.token) {
			headers["X-Vault-Token"] = this.token;
		}

		if (this.namespace) {
			headers["X-Vault-Namespace"] = this.namespace;
		}

		return headers;
	}

	/**
	 * Set custom metadata on a secret in Vault KV v2
	 */
	private async setMetadata(key: string, metadata: SecretMetadata): Promise<void> {
		const url = this.buildUrl("metadata", key);

		const body: Record<string, unknown> = {
			custom_metadata: {
				...metadata.tags,
				...(metadata.description ? { description: metadata.description } : {}),
			},
		};

		const response = await fetch(url, {
			method: "POST",
			headers: this.buildHeaders(),
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			// Non-fatal: metadata update failure should not break the set operation
			const responseBody = await response.text();
			console.warn(`Vault metadata update failed (${response.status}): ${responseBody}`);
		}
	}
}

// ---------------------------------------------------------------------------
// AWSSecretsProvider
// ---------------------------------------------------------------------------

/**
 * AWS Secrets Manager provider
 *
 * Uses the `@aws-sdk/client-secrets-manager` SDK, loaded dynamically at
 * first use to avoid hard dependencies.
 *
 * @example
 * ```typescript
 * const aws = new AWSSecretsProvider({
 *   region: "us-east-1",
 * });
 *
 * const apiKey = await aws.get("prod/api-key");
 * ```
 */
export class AWSSecretsProvider implements SecretProvider {
	readonly name = "aws";
	private region: string;
	private accessKeyId: string | undefined;
	private secretAccessKey: string | undefined;
	private profile: string | undefined;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private client: any = null;

	constructor(config: {
		region: string;
		accessKeyId?: string;
		secretAccessKey?: string;
		profile?: string;
	}) {
		this.region = config.region;
		this.accessKeyId = config.accessKeyId;
		this.secretAccessKey = config.secretAccessKey;
		this.profile = config.profile;
	}

	/**
	 * Retrieve a secret from AWS Secrets Manager
	 * @param key - The secret name or ARN
	 */
	async get(key: string): Promise<string | null> {
		const client = await this.getClient();
		const { GetSecretValueCommand } = await this.getSDK();

		try {
			const result = await client.send(new GetSecretValueCommand({ SecretId: key }));
			return result.SecretString ?? null;
		} catch (err: unknown) {
			if (this.isAWSError(err, "ResourceNotFoundException")) {
				return null;
			}
			throw err;
		}
	}

	/**
	 * Create or update a secret in AWS Secrets Manager
	 * @param key - The secret name
	 * @param value - The secret value
	 * @param metadata - Optional metadata (tags and description supported)
	 */
	async set(key: string, value: string, metadata?: SecretMetadata): Promise<void> {
		const client = await this.getClient();
		const sdk = await this.getSDK();

		// Try to update first, create if it does not exist
		try {
			await client.send(
				new sdk.UpdateSecretCommand({
					SecretId: key,
					SecretString: value,
					...(metadata?.description ? { Description: metadata.description } : {}),
				}),
			);
		} catch (err: unknown) {
			if (this.isAWSError(err, "ResourceNotFoundException")) {
				const createParams: Record<string, unknown> = {
					Name: key,
					SecretString: value,
				};

				if (metadata?.description) {
					createParams.Description = metadata.description;
				}

				if (metadata?.tags) {
					createParams.Tags = Object.entries(metadata.tags).map(([Key, Value]) => ({
						Key,
						Value,
					}));
				}

				await client.send(new sdk.CreateSecretCommand(createParams));
			} else {
				throw err;
			}
		}
	}

	/**
	 * Delete a secret from AWS Secrets Manager
	 * @param key - The secret name or ARN
	 */
	async delete(key: string): Promise<void> {
		const client = await this.getClient();
		const { DeleteSecretCommand } = await this.getSDK();

		try {
			await client.send(
				new DeleteSecretCommand({
					SecretId: key,
					ForceDeleteWithoutRecovery: true,
				}),
			);
		} catch (err: unknown) {
			if (!this.isAWSError(err, "ResourceNotFoundException")) {
				throw err;
			}
		}
	}

	/**
	 * List secrets in AWS Secrets Manager, optionally filtered by name prefix
	 * @param prefix - Optional name prefix filter
	 */
	async list(prefix?: string): Promise<string[]> {
		const client = await this.getClient();
		const { ListSecretsCommand } = await this.getSDK();

		const secrets: string[] = [];
		let nextToken: string | undefined;

		do {
			const params: Record<string, unknown> = {
				MaxResults: 100,
				...(nextToken ? { NextToken: nextToken } : {}),
			};

			if (prefix) {
				params.Filters = [{ Key: "name", Values: [prefix] }];
			}

			const result = await client.send(new ListSecretsCommand(params));

			if (result.SecretList) {
				for (const secret of result.SecretList) {
					if (secret.Name) {
						secrets.push(secret.Name);
					}
				}
			}

			nextToken = result.NextToken;
		} while (nextToken);

		return secrets;
	}

	/**
	 * Check whether a secret exists in AWS Secrets Manager
	 * @param key - The secret name or ARN
	 */
	async exists(key: string): Promise<boolean> {
		const client = await this.getClient();
		const { DescribeSecretCommand } = await this.getSDK();

		try {
			await client.send(new DescribeSecretCommand({ SecretId: key }));
			return true;
		} catch (err: unknown) {
			if (this.isAWSError(err, "ResourceNotFoundException")) {
				return false;
			}
			throw err;
		}
	}

	/**
	 * Lazily initialize and cache the AWS SecretsManager client
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private async getClient(): Promise<any> {
		if (this.client) return this.client;

		const { SecretsManagerClient } = await this.getSDK();

		const clientConfig: Record<string, unknown> = {
			region: this.region,
		};

		if (this.accessKeyId && this.secretAccessKey) {
			clientConfig.credentials = {
				accessKeyId: this.accessKeyId,
				secretAccessKey: this.secretAccessKey,
			};
		}

		if (this.profile) {
			// When a profile is specified, set the AWS_PROFILE env var so
			// the SDK default credential chain picks it up.
			process.env.AWS_PROFILE = this.profile;
		}

		this.client = new SecretsManagerClient(clientConfig);
		return this.client;
	}

	/**
	 * Dynamically import the AWS Secrets Manager SDK
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private async getSDK(): Promise<any> {
		try {
			// @ts-ignore -- optional peer dependency, loaded dynamically at runtime
			return await import("@aws-sdk/client-secrets-manager");
		} catch {
			throw new Error(
				"AWS Secrets Manager SDK not found. Install it with: npm install @aws-sdk/client-secrets-manager",
			);
		}
	}

	/**
	 * Type-safe check for AWS SDK error names
	 */
	private isAWSError(err: unknown, code: string): boolean {
		return typeof err === "object" && err !== null && "name" in err && (err as { name: string }).name === code;
	}
}

// ---------------------------------------------------------------------------
// GCPSecretProvider
// ---------------------------------------------------------------------------

/**
 * Google Cloud Secret Manager provider
 *
 * Uses the `@google-cloud/secret-manager` SDK, loaded dynamically at
 * first use to avoid hard dependencies.
 *
 * @example
 * ```typescript
 * const gcp = new GCPSecretProvider({
 *   projectId: "my-project",
 * });
 *
 * const apiKey = await gcp.get("api-key");
 * ```
 */
export class GCPSecretProvider implements SecretProvider {
	readonly name = "gcp";
	private projectId: string;
	private keyFile: string | undefined;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private client: any = null;

	constructor(config: { projectId: string; keyFile?: string }) {
		this.projectId = config.projectId;
		this.keyFile = config.keyFile;
	}

	/**
	 * Retrieve the latest version of a secret from GCP Secret Manager
	 * @param key - The secret ID
	 */
	async get(key: string): Promise<string | null> {
		const client = await this.getClient();

		try {
			const [version] = await client.accessSecretVersion({
				name: `projects/${this.projectId}/secrets/${key}/versions/latest`,
			});

			const payload = version.payload?.data;
			if (!payload) return null;

			if (typeof payload === "string") return payload;
			if (payload instanceof Uint8Array || Buffer.isBuffer(payload)) {
				return Buffer.from(payload).toString("utf-8");
			}

			return null;
		} catch (err: unknown) {
			if (this.isGCPNotFoundError(err)) {
				return null;
			}
			throw err;
		}
	}

	/**
	 * Create a secret and add a version, or add a new version to an existing secret
	 * @param key - The secret ID
	 * @param value - The secret value
	 * @param metadata - Optional metadata (tags mapped to GCP labels)
	 */
	async set(key: string, value: string, metadata?: SecretMetadata): Promise<void> {
		const client = await this.getClient();
		const parent = `projects/${this.projectId}`;
		const secretName = `${parent}/secrets/${key}`;

		// Try to create the secret resource first
		try {
			const createRequest: Record<string, unknown> = {
				parent,
				secretId: key,
				secret: {
					replication: { automatic: {} },
					...(metadata?.tags ? { labels: metadata.tags } : {}),
				},
			};

			await client.createSecret(createRequest);
		} catch (err: unknown) {
			// 6 = ALREADY_EXISTS - that is fine, we will add a version
			if (!this.isGCPError(err, 6)) {
				throw err;
			}
		}

		// Add the secret version with the actual payload
		await client.addSecretVersion({
			parent: secretName,
			payload: {
				data: Buffer.from(value, "utf-8"),
			},
		});
	}

	/**
	 * Delete a secret from GCP Secret Manager
	 * @param key - The secret ID
	 */
	async delete(key: string): Promise<void> {
		const client = await this.getClient();

		try {
			await client.deleteSecret({
				name: `projects/${this.projectId}/secrets/${key}`,
			});
		} catch (err: unknown) {
			if (!this.isGCPNotFoundError(err)) {
				throw err;
			}
		}
	}

	/**
	 * List secrets in the GCP project, optionally filtered by prefix
	 * @param prefix - Optional prefix filter applied to secret IDs
	 */
	async list(prefix?: string): Promise<string[]> {
		const client = await this.getClient();
		const parent = `projects/${this.projectId}`;

		const [secrets] = await client.listSecrets({ parent });
		const names: string[] = [];

		for (const secret of secrets) {
			// Extract secret ID from the full resource name
			const fullName: string = secret.name ?? "";
			const parts = fullName.split("/");
			const secretId = parts[parts.length - 1];

			if (secretId) {
				if (!prefix || secretId.startsWith(prefix)) {
					names.push(secretId);
				}
			}
		}

		return names;
	}

	/**
	 * Check whether a secret exists in GCP Secret Manager
	 * @param key - The secret ID
	 */
	async exists(key: string): Promise<boolean> {
		const client = await this.getClient();

		try {
			await client.getSecret({
				name: `projects/${this.projectId}/secrets/${key}`,
			});
			return true;
		} catch (err: unknown) {
			if (this.isGCPNotFoundError(err)) {
				return false;
			}
			throw err;
		}
	}

	/**
	 * Lazily initialize and cache the GCP Secret Manager client
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private async getClient(): Promise<any> {
		if (this.client) return this.client;

		try {
			// @ts-ignore -- optional peer dependency, loaded dynamically at runtime
			const module = await import("@google-cloud/secret-manager");
			const { SecretManagerServiceClient } = module;

			const options: Record<string, unknown> = {};
			if (this.keyFile) {
				options.keyFilename = this.keyFile;
			}

			this.client = new SecretManagerServiceClient(options);
			return this.client;
		} catch {
			throw new Error("GCP Secret Manager SDK not found. Install it with: npm install @google-cloud/secret-manager");
		}
	}

	/**
	 * Check for GCP "not found" errors (gRPC status code 5)
	 */
	private isGCPNotFoundError(err: unknown): boolean {
		return this.isGCPError(err, 5);
	}

	/**
	 * Check for specific gRPC error codes from the GCP SDK
	 */
	private isGCPError(err: unknown, code: number): boolean {
		return typeof err === "object" && err !== null && "code" in err && (err as { code: number }).code === code;
	}
}

// ---------------------------------------------------------------------------
// SecretManager
// ---------------------------------------------------------------------------

/** Regex for matching `${secret:KEY}` patterns in template strings */
const SECRET_TEMPLATE_REGEX = /\$\{secret:([^}]+)\}/g;

/**
 * Unified Secret Manager for the Blok Framework
 *
 * Orchestrates multiple secret providers with a provider chain (first match
 * wins), optional caching, and audit event emission.
 *
 * @example
 * ```typescript
 * const manager = new SecretManager({
 *   providers: [
 *     { type: "vault", config: { address: "https://vault:8200", token: "s.xxx" } },
 *     { type: "environment", config: { prefix: "BLOK_" } },
 *   ],
 *   cache: { enabled: true, ttlMs: 300_000, maxSize: 500 },
 *   auditLog: true,
 * });
 *
 * manager.on("secretAccess", (event) => {
 *   console.log(`[audit] ${event.operation} ${event.key} via ${event.provider}`);
 * });
 *
 * const password = await manager.getSecretOrThrow("DB_PASSWORD");
 * const connStr = await manager.resolveTemplate(
 *   "postgres://admin:${secret:DB_PASSWORD}@db:5432/app"
 * );
 * ```
 */
export class SecretManager extends EventEmitter {
	private providers: SecretProvider[] = [];
	private cache: Map<string, CacheEntry> = new Map();
	private cacheConfig: SecretCacheConfig;
	private auditLog: boolean;
	private cacheAccessOrder: string[] = [];

	constructor(config: SecretManagerConfig) {
		super();
		this.cacheConfig = config.cache ?? { enabled: false, ttlMs: 0, maxSize: 0 };
		this.auditLog = config.auditLog ?? false;

		// Initialize providers in order
		for (const providerConfig of config.providers) {
			this.providers.push(this.createProvider(providerConfig));
		}
	}

	/**
	 * Retrieve a secret value by key
	 *
	 * Checks the cache first (if enabled), then queries each provider
	 * in order until a value is found.
	 *
	 * @param key - The secret key
	 * @returns The secret value, or null if not found in any provider
	 */
	async getSecret(key: string): Promise<string | null> {
		// Check cache
		if (this.cacheConfig.enabled) {
			const cached = this.getCached(key);
			if (cached !== undefined) {
				this.emitAccess("get", key, "cache", true, true);
				return cached;
			}
		}

		// Query providers in order
		for (const provider of this.providers) {
			try {
				const value = await provider.get(key);
				if (value !== null) {
					if (this.cacheConfig.enabled) {
						this.setCache(key, value);
					}
					this.emitAccess("get", key, provider.name, true, false);
					return value;
				}
			} catch (err) {
				this.emitAccess("get", key, provider.name, false, false, errorMessage(err));
				// Continue to next provider
			}
		}

		this.emitAccess("get", key, "none", true, false);
		return null;
	}

	/**
	 * Retrieve a secret or throw if it does not exist
	 *
	 * @param key - The secret key
	 * @returns The secret value
	 * @throws Error if the secret is not found in any provider
	 */
	async getSecretOrThrow(key: string): Promise<string> {
		const value = await this.getSecret(key);
		if (value === null) {
			throw new Error(`Secret '${key}' not found in any provider`);
		}
		return value;
	}

	/**
	 * Store a secret value in the first writable provider
	 *
	 * @param key - The secret key
	 * @param value - The secret value
	 * @param metadata - Optional metadata to associate with the secret
	 */
	async setSecret(key: string, value: string, metadata?: SecretMetadata): Promise<void> {
		let written = false;

		for (const provider of this.providers) {
			try {
				await provider.set(key, value, metadata);
				written = true;

				// Update cache
				if (this.cacheConfig.enabled) {
					this.setCache(key, value);
				}

				this.emitAccess("set", key, provider.name, true, false);
				break;
			} catch (err) {
				this.emitAccess("set", key, provider.name, false, false, errorMessage(err));
				// Continue to next provider
			}
		}

		if (!written) {
			throw new Error(`Failed to set secret '${key}' in any provider`);
		}
	}

	/**
	 * Delete a secret from all providers that contain it
	 *
	 * @param key - The secret key
	 */
	async deleteSecret(key: string): Promise<void> {
		// Invalidate cache
		this.cache.delete(key);
		this.cacheAccessOrder = this.cacheAccessOrder.filter((k) => k !== key);

		for (const provider of this.providers) {
			try {
				await provider.delete(key);
				this.emitAccess("delete", key, provider.name, true, false);
			} catch (err) {
				this.emitAccess("delete", key, provider.name, false, false, errorMessage(err));
			}
		}
	}

	/**
	 * List secret keys across all providers, optionally filtered by prefix
	 *
	 * Merges results from all providers and deduplicates.
	 *
	 * @param prefix - Optional prefix filter
	 * @returns Deduplicated array of secret key names
	 */
	async listSecrets(prefix?: string): Promise<string[]> {
		const allKeys = new Set<string>();

		for (const provider of this.providers) {
			try {
				const keys = await provider.list(prefix);
				for (const key of keys) {
					allKeys.add(key);
				}
				this.emitAccess("list", undefined, provider.name, true, false);
			} catch (err) {
				this.emitAccess("list", undefined, provider.name, false, false, errorMessage(err));
			}
		}

		return Array.from(allKeys);
	}

	/**
	 * Check whether a secret exists in any provider
	 *
	 * @param key - The secret key
	 * @returns True if the secret exists in at least one provider
	 */
	async exists(key: string): Promise<boolean> {
		// Check cache first
		if (this.cacheConfig.enabled) {
			const cached = this.getCached(key);
			if (cached !== undefined) {
				return true;
			}
		}

		for (const provider of this.providers) {
			try {
				const found = await provider.exists(key);
				if (found) {
					this.emitAccess("exists", key, provider.name, true, false);
					return true;
				}
			} catch (err) {
				this.emitAccess("exists", key, provider.name, false, false, errorMessage(err));
			}
		}

		return false;
	}

	/**
	 * Resolve `${secret:KEY}` patterns in a template string
	 *
	 * Replaces every occurrence of `${secret:SOME_KEY}` with the actual
	 * secret value from the provider chain. Missing secrets are replaced
	 * with an empty string.
	 *
	 * @param template - The template string with `${secret:...}` placeholders
	 * @returns The resolved string with secret values substituted
	 *
	 * @example
	 * ```typescript
	 * const resolved = await manager.resolveTemplate(
	 *   "mongodb://${secret:MONGO_USER}:${secret:MONGO_PASS}@host/db"
	 * );
	 * ```
	 */
	async resolveTemplate(template: string): Promise<string> {
		const matches: { placeholder: string; key: string }[] = [];
		let match: RegExpExecArray | null;

		// Reset regex state
		SECRET_TEMPLATE_REGEX.lastIndex = 0;

		while ((match = SECRET_TEMPLATE_REGEX.exec(template)) !== null) {
			matches.push({ placeholder: match[0], key: match[1] });
		}

		if (matches.length === 0) return template;

		// Resolve all secrets in parallel
		const resolutions = await Promise.all(
			matches.map(async (m) => ({
				placeholder: m.placeholder,
				value: (await this.getSecret(m.key)) ?? "",
			})),
		);

		let result = template;
		for (const resolution of resolutions) {
			result = result.split(resolution.placeholder).join(resolution.value);
		}

		return result;
	}

	/**
	 * Get the list of configured providers
	 * @returns Array of provider instances
	 */
	getProviders(): SecretProvider[] {
		return [...this.providers];
	}

	/**
	 * Get current cache statistics
	 * @returns Object with cache size and hit information
	 */
	getCacheStats(): { size: number; maxSize: number; enabled: boolean } {
		return {
			size: this.cache.size,
			maxSize: this.cacheConfig.maxSize,
			enabled: this.cacheConfig.enabled,
		};
	}

	/**
	 * Clear the secret cache
	 */
	clearCache(): void {
		this.cache.clear();
		this.cacheAccessOrder = [];
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	/**
	 * Create a provider instance from its configuration
	 */
	private createProvider(config: SecretProviderConfig): SecretProvider {
		switch (config.type) {
			case "environment":
				return new EnvironmentSecretProvider(config.config);

			case "memory":
				return new InMemorySecretProvider();

			case "vault":
				return new VaultSecretProvider(config.config);

			case "aws":
				return new AWSSecretsProvider(config.config);

			case "gcp":
				return new GCPSecretProvider(config.config);

			default: {
				const exhaustive: never = config;
				throw new Error(`Unknown secret provider type: ${(exhaustive as SecretProviderConfig).type}`);
			}
		}
	}

	/**
	 * Retrieve a value from the cache, returning undefined if not found or expired
	 */
	private getCached(key: string): string | undefined {
		const entry = this.cache.get(key);
		if (!entry) return undefined;

		if (Date.now() > entry.expiresAt) {
			this.cache.delete(key);
			this.cacheAccessOrder = this.cacheAccessOrder.filter((k) => k !== key);
			return undefined;
		}

		// Move to end of access order (LRU)
		this.cacheAccessOrder = this.cacheAccessOrder.filter((k) => k !== key);
		this.cacheAccessOrder.push(key);

		return entry.value;
	}

	/**
	 * Store a value in the cache with TTL, evicting LRU entries if at capacity
	 */
	private setCache(key: string, value: string): void {
		// Evict if at capacity
		while (this.cache.size >= this.cacheConfig.maxSize && this.cacheAccessOrder.length > 0) {
			const evict = this.cacheAccessOrder.shift();
			if (evict) {
				this.cache.delete(evict);
			}
		}

		this.cache.set(key, {
			value,
			expiresAt: Date.now() + this.cacheConfig.ttlMs,
		});

		// Update access order
		this.cacheAccessOrder = this.cacheAccessOrder.filter((k) => k !== key);
		this.cacheAccessOrder.push(key);
	}

	/**
	 * Emit a secret access audit event
	 */
	private emitAccess(
		operation: SecretAccessEvent["operation"],
		key: string | undefined,
		provider: string,
		success: boolean,
		cached: boolean,
		error?: string,
	): void {
		if (!this.auditLog) return;

		const event: SecretAccessEvent = {
			operation,
			key,
			provider,
			success,
			cached,
			timestamp: new Date().toISOString(),
			...(error ? { error } : {}),
		};

		this.emit("secretAccess", event);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely extract an error message from an unknown thrown value
 */
function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
