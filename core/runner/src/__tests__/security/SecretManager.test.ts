import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	EnvironmentSecretProvider,
	InMemorySecretProvider,
	SecretManager,
	type SecretAccessEvent,
} from "../../security/SecretManager";

// ---------------------------------------------------------------------------
// EnvironmentSecretProvider
// ---------------------------------------------------------------------------

describe("EnvironmentSecretProvider", () => {
	const TEST_PREFIX = "BLOK_TEST_SM_";
	const envKeysToClean: string[] = [];

	function setTestEnv(key: string, value: string): void {
		process.env[key] = value;
		envKeysToClean.push(key);
	}

	afterEach(() => {
		for (const key of envKeysToClean) {
			delete process.env[key];
		}
		envKeysToClean.length = 0;
	});

	describe("get", () => {
		it("should return the value of an existing env var", async () => {
			setTestEnv("SM_TEST_KEY", "hello");
			const provider = new EnvironmentSecretProvider();

			const value = await provider.get("SM_TEST_KEY");
			expect(value).toBe("hello");
		});

		it("should return null for a missing env var", async () => {
			const provider = new EnvironmentSecretProvider();

			const value = await provider.get("SM_NONEXISTENT_KEY_XYZ_999");
			expect(value).toBeNull();
		});

		it("should apply the configured prefix when reading", async () => {
			setTestEnv(`${TEST_PREFIX}DB_URL`, "postgres://localhost");
			const provider = new EnvironmentSecretProvider({ prefix: TEST_PREFIX });

			const value = await provider.get("DB_URL");
			expect(value).toBe("postgres://localhost");
		});

		it("should return null when prefix+key does not match any env var", async () => {
			const provider = new EnvironmentSecretProvider({ prefix: "MISSING_PREFIX_" });

			const value = await provider.get("DB_URL");
			expect(value).toBeNull();
		});

		it("should return empty string for env var set to empty string", async () => {
			setTestEnv("SM_EMPTY_VAR", "");
			const provider = new EnvironmentSecretProvider();

			const value = await provider.get("SM_EMPTY_VAR");
			expect(value).toBe("");
		});
	});

	describe("set", () => {
		it("should set an environment variable", async () => {
			const provider = new EnvironmentSecretProvider();
			envKeysToClean.push("SM_SET_TEST");

			await provider.set("SM_SET_TEST", "my-value");
			expect(process.env["SM_SET_TEST"]).toBe("my-value");
		});

		it("should set an environment variable with prefix", async () => {
			const provider = new EnvironmentSecretProvider({ prefix: TEST_PREFIX });
			envKeysToClean.push(`${TEST_PREFIX}SET_WITH_PREFIX`);

			await provider.set("SET_WITH_PREFIX", "prefixed-value");
			expect(process.env[`${TEST_PREFIX}SET_WITH_PREFIX`]).toBe("prefixed-value");
		});

		it("should overwrite an existing environment variable", async () => {
			setTestEnv("SM_OVERWRITE_TEST", "old-value");
			const provider = new EnvironmentSecretProvider();

			await provider.set("SM_OVERWRITE_TEST", "new-value");
			expect(process.env["SM_OVERWRITE_TEST"]).toBe("new-value");
		});
	});

	describe("delete", () => {
		it("should remove an environment variable", async () => {
			setTestEnv("SM_DEL_TEST", "to-delete");
			const provider = new EnvironmentSecretProvider();

			await provider.delete("SM_DEL_TEST");
			expect(process.env["SM_DEL_TEST"]).toBeUndefined();
		});

		it("should remove an environment variable with prefix", async () => {
			setTestEnv(`${TEST_PREFIX}DEL_PREFIXED`, "to-delete");
			const provider = new EnvironmentSecretProvider({ prefix: TEST_PREFIX });

			await provider.delete("DEL_PREFIXED");
			expect(process.env[`${TEST_PREFIX}DEL_PREFIXED`]).toBeUndefined();
		});

		it("should not throw when deleting a non-existent key", async () => {
			const provider = new EnvironmentSecretProvider();

			await expect(provider.delete("SM_NONEXISTENT_KEY_DEL")).resolves.toBeUndefined();
		});
	});

	describe("list", () => {
		it("should list env vars matching the provider prefix", async () => {
			setTestEnv(`${TEST_PREFIX}LIST_A`, "a");
			setTestEnv(`${TEST_PREFIX}LIST_B`, "b");
			const provider = new EnvironmentSecretProvider({ prefix: TEST_PREFIX });

			const keys = await provider.list();
			expect(keys).toContain("LIST_A");
			expect(keys).toContain("LIST_B");
		});

		it("should strip the provider prefix from returned keys", async () => {
			setTestEnv(`${TEST_PREFIX}STRIPPED_KEY`, "value");
			const provider = new EnvironmentSecretProvider({ prefix: TEST_PREFIX });

			const keys = await provider.list();
			expect(keys).toContain("STRIPPED_KEY");
			// Should not contain the full prefixed key
			expect(keys).not.toContain(`${TEST_PREFIX}STRIPPED_KEY`);
		});

		it("should apply an additional prefix filter", async () => {
			setTestEnv(`${TEST_PREFIX}DB_HOST`, "localhost");
			setTestEnv(`${TEST_PREFIX}DB_PORT`, "5432");
			setTestEnv(`${TEST_PREFIX}API_KEY`, "abc");
			const provider = new EnvironmentSecretProvider({ prefix: TEST_PREFIX });

			const keys = await provider.list("DB_");
			expect(keys).toContain("DB_HOST");
			expect(keys).toContain("DB_PORT");
			expect(keys).not.toContain("API_KEY");
		});

		it("should return empty array when no env vars match", async () => {
			const provider = new EnvironmentSecretProvider({ prefix: "ZZZZZ_NOMATCH_" });

			const keys = await provider.list();
			expect(keys).toEqual([]);
		});
	});

	describe("exists", () => {
		it("should return true for an existing env var", async () => {
			setTestEnv("SM_EXISTS_TEST", "here");
			const provider = new EnvironmentSecretProvider();

			expect(await provider.exists("SM_EXISTS_TEST")).toBe(true);
		});

		it("should return false for a non-existent env var", async () => {
			const provider = new EnvironmentSecretProvider();

			expect(await provider.exists("SM_NONEXISTENT_EXISTS_TEST")).toBe(false);
		});

		it("should apply prefix when checking existence", async () => {
			setTestEnv(`${TEST_PREFIX}EXISTS_PREFIXED`, "present");
			const provider = new EnvironmentSecretProvider({ prefix: TEST_PREFIX });

			expect(await provider.exists("EXISTS_PREFIXED")).toBe(true);
			expect(await provider.exists("MISSING_PREFIXED")).toBe(false);
		});

		it("should return true for env var set to empty string", async () => {
			setTestEnv("SM_EXISTS_EMPTY", "");
			const provider = new EnvironmentSecretProvider();

			expect(await provider.exists("SM_EXISTS_EMPTY")).toBe(true);
		});
	});

	describe("case sensitivity", () => {
		it("should be case-sensitive by default", async () => {
			setTestEnv("SM_CASE_Test", "value");
			const provider = new EnvironmentSecretProvider();

			expect(await provider.get("SM_CASE_Test")).toBe("value");
			expect(await provider.get("SM_CASE_TEST")).toBeNull();
			expect(await provider.get("sm_case_test")).toBeNull();
		});

		it("should support case-insensitive lookups when configured", async () => {
			setTestEnv("SM_CASE_INSENSITIVE_KEY", "found-it");
			const provider = new EnvironmentSecretProvider({ caseSensitive: false });

			expect(await provider.get("SM_CASE_INSENSITIVE_KEY")).toBe("found-it");
			expect(await provider.get("sm_case_insensitive_key")).toBe("found-it");
			expect(await provider.get("Sm_Case_Insensitive_Key")).toBe("found-it");
		});

		it("should handle case-insensitive exists check", async () => {
			setTestEnv("SM_CI_EXISTS", "yep");
			const provider = new EnvironmentSecretProvider({ caseSensitive: false });

			expect(await provider.exists("SM_CI_EXISTS")).toBe(true);
			expect(await provider.exists("sm_ci_exists")).toBe(true);
		});

		it("should handle case-insensitive list", async () => {
			setTestEnv(`${TEST_PREFIX}CI_LIST_A`, "a");
			const provider = new EnvironmentSecretProvider({
				prefix: TEST_PREFIX,
				caseSensitive: false,
			});

			const lowerPrefixKeys = await provider.list();
			// The provider prefix is still TEST_PREFIX; case-insensitive matching
			// should still find keys with that prefix
			expect(lowerPrefixKeys.length).toBeGreaterThanOrEqual(1);
		});

		it("should handle case-insensitive delete", async () => {
			setTestEnv("SM_CI_DELETE_KEY", "delete-me");
			const provider = new EnvironmentSecretProvider({ caseSensitive: false });

			await provider.delete("sm_ci_delete_key");
			expect(process.env["SM_CI_DELETE_KEY"]).toBeUndefined();
		});
	});

	describe("name property", () => {
		it("should have name 'environment'", () => {
			const provider = new EnvironmentSecretProvider();
			expect(provider.name).toBe("environment");
		});
	});
});

// ---------------------------------------------------------------------------
// InMemorySecretProvider
// ---------------------------------------------------------------------------

describe("InMemorySecretProvider", () => {
	let provider: InMemorySecretProvider;

	beforeEach(() => {
		provider = new InMemorySecretProvider();
	});

	describe("set and get", () => {
		it("should store and retrieve a secret", async () => {
			await provider.set("API_KEY", "sk-12345");

			const value = await provider.get("API_KEY");
			expect(value).toBe("sk-12345");
		});

		it("should return null for a key that has not been set", async () => {
			const value = await provider.get("MISSING_KEY");
			expect(value).toBeNull();
		});

		it("should overwrite an existing secret", async () => {
			await provider.set("DB_PASS", "old-password");
			await provider.set("DB_PASS", "new-password");

			const value = await provider.get("DB_PASS");
			expect(value).toBe("new-password");
		});

		it("should handle empty string values", async () => {
			await provider.set("EMPTY", "");

			const value = await provider.get("EMPTY");
			expect(value).toBe("");
		});

		it("should handle secrets with metadata", async () => {
			await provider.set("TAGGED", "value", {
				version: "1",
				tags: { env: "test" },
				description: "A tagged secret",
			});

			const value = await provider.get("TAGGED");
			expect(value).toBe("value");
		});
	});

	describe("delete", () => {
		it("should remove a secret", async () => {
			await provider.set("TO_DELETE", "bye");
			await provider.delete("TO_DELETE");

			const value = await provider.get("TO_DELETE");
			expect(value).toBeNull();
		});

		it("should not throw when deleting a non-existent key", async () => {
			await expect(provider.delete("NONEXISTENT")).resolves.toBeUndefined();
		});

		it("should only delete the specified key", async () => {
			await provider.set("KEEP_A", "a");
			await provider.set("DELETE_B", "b");
			await provider.delete("DELETE_B");

			expect(await provider.get("KEEP_A")).toBe("a");
			expect(await provider.get("DELETE_B")).toBeNull();
		});
	});

	describe("list", () => {
		it("should list all keys when no prefix is given", async () => {
			await provider.set("KEY_1", "a");
			await provider.set("KEY_2", "b");
			await provider.set("OTHER", "c");

			const keys = await provider.list();
			expect(keys).toHaveLength(3);
			expect(keys).toContain("KEY_1");
			expect(keys).toContain("KEY_2");
			expect(keys).toContain("OTHER");
		});

		it("should filter keys by prefix", async () => {
			await provider.set("DB_HOST", "localhost");
			await provider.set("DB_PORT", "5432");
			await provider.set("API_KEY", "abc");

			const keys = await provider.list("DB_");
			expect(keys).toHaveLength(2);
			expect(keys).toContain("DB_HOST");
			expect(keys).toContain("DB_PORT");
		});

		it("should return empty array when store is empty", async () => {
			const keys = await provider.list();
			expect(keys).toEqual([]);
		});

		it("should return empty array when no keys match prefix", async () => {
			await provider.set("FOO", "bar");

			const keys = await provider.list("ZZZ_");
			expect(keys).toEqual([]);
		});
	});

	describe("exists", () => {
		it("should return true for an existing key", async () => {
			await provider.set("EXISTS_KEY", "value");

			expect(await provider.exists("EXISTS_KEY")).toBe(true);
		});

		it("should return false for a non-existent key", async () => {
			expect(await provider.exists("NONEXISTENT")).toBe(false);
		});
	});

	describe("TTL expiration via metadata.expiresAt", () => {
		it("should return null for an expired secret on get", async () => {
			const pastExpiry = Date.now() - 1000;
			await provider.set("EXPIRED", "old-value", { expiresAt: pastExpiry });

			const value = await provider.get("EXPIRED");
			expect(value).toBeNull();
		});

		it("should return the value for a non-expired secret", async () => {
			const futureExpiry = Date.now() + 60_000;
			await provider.set("VALID", "still-good", { expiresAt: futureExpiry });

			const value = await provider.get("VALID");
			expect(value).toBe("still-good");
		});

		it("should clean up expired secrets from the store on get", async () => {
			const pastExpiry = Date.now() - 1000;
			await provider.set("EXPIRED_CLEANUP", "old", { expiresAt: pastExpiry });

			// Trigger cleanup via get
			await provider.get("EXPIRED_CLEANUP");

			// The key should be removed from the store
			const stats = provider.getStats();
			expect(stats.keys).not.toContain("EXPIRED_CLEANUP");
		});

		it("should return false for exists on an expired secret", async () => {
			const pastExpiry = Date.now() - 1000;
			await provider.set("EXPIRED_EXISTS", "old", { expiresAt: pastExpiry });

			expect(await provider.exists("EXPIRED_EXISTS")).toBe(false);
		});

		it("should clean up expired secrets from the store on exists", async () => {
			const pastExpiry = Date.now() - 1000;
			await provider.set("EXPIRED_EXISTS_CLEANUP", "old", { expiresAt: pastExpiry });

			await provider.exists("EXPIRED_EXISTS_CLEANUP");

			const stats = provider.getStats();
			expect(stats.keys).not.toContain("EXPIRED_EXISTS_CLEANUP");
		});

		it("should return true for exists on a non-expired secret", async () => {
			const futureExpiry = Date.now() + 60_000;
			await provider.set("VALID_EXISTS", "ok", { expiresAt: futureExpiry });

			expect(await provider.exists("VALID_EXISTS")).toBe(true);
		});

		it("should not expire secrets that have no expiresAt metadata", async () => {
			await provider.set("NO_EXPIRY", "forever");

			const value = await provider.get("NO_EXPIRY");
			expect(value).toBe("forever");
		});
	});

	describe("getStats", () => {
		it("should report correct size and keys for an empty store", () => {
			const stats = provider.getStats();
			expect(stats.size).toBe(0);
			expect(stats.keys).toEqual([]);
		});

		it("should report correct size and keys after adding secrets", async () => {
			await provider.set("S1", "a");
			await provider.set("S2", "b");
			await provider.set("S3", "c");

			const stats = provider.getStats();
			expect(stats.size).toBe(3);
			expect(stats.keys).toHaveLength(3);
			expect(stats.keys).toContain("S1");
			expect(stats.keys).toContain("S2");
			expect(stats.keys).toContain("S3");
		});

		it("should update after deletions", async () => {
			await provider.set("X", "1");
			await provider.set("Y", "2");
			await provider.delete("X");

			const stats = provider.getStats();
			expect(stats.size).toBe(1);
			expect(stats.keys).toEqual(["Y"]);
		});
	});

	describe("clear", () => {
		it("should remove all secrets from the store", async () => {
			await provider.set("A", "1");
			await provider.set("B", "2");
			await provider.set("C", "3");

			provider.clear();

			const stats = provider.getStats();
			expect(stats.size).toBe(0);
			expect(stats.keys).toEqual([]);
		});

		it("should not throw when clearing an empty store", () => {
			expect(() => provider.clear()).not.toThrow();
		});

		it("should make previously set secrets inaccessible", async () => {
			await provider.set("BEFORE_CLEAR", "value");
			provider.clear();

			expect(await provider.get("BEFORE_CLEAR")).toBeNull();
			expect(await provider.exists("BEFORE_CLEAR")).toBe(false);
		});
	});

	describe("name property", () => {
		it("should have name 'memory'", () => {
			expect(provider.name).toBe("memory");
		});
	});
});

// ---------------------------------------------------------------------------
// SecretManager
// ---------------------------------------------------------------------------

describe("SecretManager", () => {
	const envKeysToClean: string[] = [];

	function setTestEnv(key: string, value: string): void {
		process.env[key] = value;
		envKeysToClean.push(key);
	}

	afterEach(() => {
		for (const key of envKeysToClean) {
			delete process.env[key];
		}
		envKeysToClean.length = 0;
	});

	describe("initialization", () => {
		it("should initialize with a single memory provider", () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
			});

			const providers = manager.getProviders();
			expect(providers).toHaveLength(1);
			expect(providers[0].name).toBe("memory");
		});

		it("should initialize with a single environment provider", () => {
			const manager = new SecretManager({
				providers: [{ type: "environment" }],
			});

			const providers = manager.getProviders();
			expect(providers).toHaveLength(1);
			expect(providers[0].name).toBe("environment");
		});

		it("should initialize with multiple providers in order", () => {
			const manager = new SecretManager({
				providers: [
					{ type: "memory" },
					{ type: "environment", config: { prefix: "TEST_" } },
				],
			});

			const providers = manager.getProviders();
			expect(providers).toHaveLength(2);
			expect(providers[0].name).toBe("memory");
			expect(providers[1].name).toBe("environment");
		});

		it("should initialize with cache disabled by default", () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
			});

			const stats = manager.getCacheStats();
			expect(stats.enabled).toBe(false);
		});

		it("should initialize with cache enabled when configured", () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
				cache: { enabled: true, ttlMs: 5000, maxSize: 10 },
			});

			const stats = manager.getCacheStats();
			expect(stats.enabled).toBe(true);
			expect(stats.maxSize).toBe(10);
			expect(stats.size).toBe(0);
		});
	});

	describe("getSecret", () => {
		it("should retrieve a secret from a memory provider", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
			});

			// Set via the underlying provider
			const providers = manager.getProviders();
			const memProvider = providers[0] as InMemorySecretProvider;
			await memProvider.set("MY_SECRET", "secret-value");

			const value = await manager.getSecret("MY_SECRET");
			expect(value).toBe("secret-value");
		});

		it("should retrieve a secret from an environment provider", async () => {
			setTestEnv("SM_MGR_ENV_KEY", "env-value");
			const manager = new SecretManager({
				providers: [{ type: "environment" }],
			});

			const value = await manager.getSecret("SM_MGR_ENV_KEY");
			expect(value).toBe("env-value");
		});

		it("should return null when secret is not found in any provider", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
			});

			const value = await manager.getSecret("NONEXISTENT");
			expect(value).toBeNull();
		});

		it("should use first provider that has the secret (provider chain)", async () => {
			setTestEnv("SM_CHAIN_KEY", "from-env");
			const manager = new SecretManager({
				providers: [
					{ type: "memory" },
					{ type: "environment" },
				],
			});

			// Set in memory provider (first in chain)
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			await memProvider.set("SM_CHAIN_KEY", "from-memory");

			const value = await manager.getSecret("SM_CHAIN_KEY");
			expect(value).toBe("from-memory");
		});

		it("should fall through to next provider when first does not have the secret", async () => {
			setTestEnv("SM_FALLTHROUGH", "from-env");
			const manager = new SecretManager({
				providers: [
					{ type: "memory" },
					{ type: "environment" },
				],
			});

			// Memory provider does not have SM_FALLTHROUGH
			const value = await manager.getSecret("SM_FALLTHROUGH");
			expect(value).toBe("from-env");
		});
	});

	describe("getSecretOrThrow", () => {
		it("should return the secret when it exists", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
			});
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			await memProvider.set("EXISTS", "found");

			const value = await manager.getSecretOrThrow("EXISTS");
			expect(value).toBe("found");
		});

		it("should throw when the secret does not exist", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
			});

			await expect(manager.getSecretOrThrow("MISSING")).rejects.toThrow(
				"Secret 'MISSING' not found in any provider"
			);
		});
	});

	describe("setSecret", () => {
		it("should write a secret to the first provider", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
			});

			await manager.setSecret("NEW_KEY", "new-value");

			const value = await manager.getSecret("NEW_KEY");
			expect(value).toBe("new-value");
		});

		it("should write to the first provider in a multi-provider setup", async () => {
			const manager = new SecretManager({
				providers: [
					{ type: "memory" },
					{ type: "environment" },
				],
			});

			await manager.setSecret("SET_CHAIN", "chain-value");

			// Should be in the memory provider (first)
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			expect(await memProvider.get("SET_CHAIN")).toBe("chain-value");
		});

		it("should update the cache when cache is enabled", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
				cache: { enabled: true, ttlMs: 60_000, maxSize: 100 },
			});

			await manager.setSecret("CACHED_SET", "cached-value");

			const stats = manager.getCacheStats();
			expect(stats.size).toBe(1);
		});
	});

	describe("deleteSecret", () => {
		it("should delete a secret from all providers", async () => {
			setTestEnv("SM_DEL_MULTI", "env-val");
			const manager = new SecretManager({
				providers: [
					{ type: "memory" },
					{ type: "environment" },
				],
			});

			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			await memProvider.set("SM_DEL_MULTI", "mem-val");

			await manager.deleteSecret("SM_DEL_MULTI");

			// Should be removed from memory provider
			expect(await memProvider.get("SM_DEL_MULTI")).toBeNull();
			// Should be removed from env
			expect(process.env["SM_DEL_MULTI"]).toBeUndefined();
		});

		it("should invalidate the cache entry", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
				cache: { enabled: true, ttlMs: 60_000, maxSize: 100 },
			});

			await manager.setSecret("DEL_CACHED", "value");
			expect(manager.getCacheStats().size).toBe(1);

			await manager.deleteSecret("DEL_CACHED");
			expect(manager.getCacheStats().size).toBe(0);
		});

		it("should not throw when deleting a non-existent key", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
			});

			await expect(manager.deleteSecret("NONEXISTENT_DEL")).resolves.toBeUndefined();
		});
	});

	describe("listSecrets", () => {
		it("should list all secrets from a single provider", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
			});
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			await memProvider.set("LIST_A", "a");
			await memProvider.set("LIST_B", "b");

			const keys = await manager.listSecrets();
			expect(keys).toContain("LIST_A");
			expect(keys).toContain("LIST_B");
		});

		it("should merge and deduplicate keys across multiple providers", async () => {
			setTestEnv("SM_LIST_SHARED", "env-val");
			setTestEnv("SM_LIST_ENV_ONLY", "env-only");
			const manager = new SecretManager({
				providers: [
					{ type: "memory" },
					{ type: "environment", config: { prefix: "SM_LIST_" } },
				],
			});
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			await memProvider.set("SHARED", "mem-val");
			await memProvider.set("MEM_ONLY", "mem-only");

			const keys = await manager.listSecrets();
			// Memory provider keys
			expect(keys).toContain("SHARED");
			expect(keys).toContain("MEM_ONLY");
			// Environment provider keys (stripped of SM_LIST_ prefix)
			expect(keys).toContain("ENV_ONLY");
		});

		it("should filter by prefix when provided", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
			});
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			await memProvider.set("DB_HOST", "localhost");
			await memProvider.set("DB_PORT", "5432");
			await memProvider.set("API_KEY", "abc");

			const keys = await manager.listSecrets("DB_");
			expect(keys).toContain("DB_HOST");
			expect(keys).toContain("DB_PORT");
			expect(keys).not.toContain("API_KEY");
		});
	});

	describe("exists", () => {
		it("should return true when secret exists in a provider", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
			});
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			await memProvider.set("EXISTS_CHECK", "yes");

			expect(await manager.exists("EXISTS_CHECK")).toBe(true);
		});

		it("should return false when secret does not exist in any provider", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
			});

			expect(await manager.exists("NO_SUCH_KEY")).toBe(false);
		});

		it("should return true if the secret is in the cache", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
				cache: { enabled: true, ttlMs: 60_000, maxSize: 100 },
			});

			// Set and get to populate cache
			await manager.setSecret("CACHED_EXISTS", "val");

			// Clear the underlying provider but cache should still have it
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			memProvider.clear();

			expect(await manager.exists("CACHED_EXISTS")).toBe(true);
		});

		it("should check providers when not in cache", async () => {
			setTestEnv("SM_EXISTS_ENV", "yes");
			const manager = new SecretManager({
				providers: [
					{ type: "memory" },
					{ type: "environment" },
				],
			});

			expect(await manager.exists("SM_EXISTS_ENV")).toBe(true);
		});
	});

	describe("cache behavior", () => {
		it("should cache secrets on first get and serve from cache on second get", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
				cache: { enabled: true, ttlMs: 60_000, maxSize: 100 },
			});
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			await memProvider.set("CACHE_TEST", "original");

			// First get - populates cache
			const first = await manager.getSecret("CACHE_TEST");
			expect(first).toBe("original");
			expect(manager.getCacheStats().size).toBe(1);

			// Modify the provider directly
			await memProvider.set("CACHE_TEST", "modified");

			// Second get - should still return cached value
			const second = await manager.getSecret("CACHE_TEST");
			expect(second).toBe("original");
		});

		it("should not cache when caching is disabled", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
				cache: { enabled: false, ttlMs: 0, maxSize: 0 },
			});
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			await memProvider.set("NO_CACHE", "value");

			await manager.getSecret("NO_CACHE");
			expect(manager.getCacheStats().size).toBe(0);
		});

		it("should evict LRU entries when cache reaches max size", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
				cache: { enabled: true, ttlMs: 60_000, maxSize: 2 },
			});
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;

			await memProvider.set("LRU_A", "a");
			await memProvider.set("LRU_B", "b");
			await memProvider.set("LRU_C", "c");

			// Populate cache with A, B
			await manager.getSecret("LRU_A");
			await manager.getSecret("LRU_B");
			expect(manager.getCacheStats().size).toBe(2);

			// Getting C should evict A (least recently used)
			await manager.getSecret("LRU_C");
			expect(manager.getCacheStats().size).toBe(2);

			// Modify A in the provider - if it was evicted, we should get the new value
			await memProvider.set("LRU_A", "a-modified");
			const valueA = await manager.getSecret("LRU_A");
			expect(valueA).toBe("a-modified");
		});

		it("should expire cached entries after TTL", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
				cache: { enabled: true, ttlMs: 50, maxSize: 100 },
			});
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			await memProvider.set("TTL_KEY", "initial");

			// Populate cache
			await manager.getSecret("TTL_KEY");
			expect(manager.getCacheStats().size).toBe(1);

			// Modify in provider
			await memProvider.set("TTL_KEY", "updated");

			// Wait for TTL to expire
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Should now get the updated value from the provider
			const value = await manager.getSecret("TTL_KEY");
			expect(value).toBe("updated");
		});
	});

	describe("clearCache", () => {
		it("should remove all cache entries", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
				cache: { enabled: true, ttlMs: 60_000, maxSize: 100 },
			});
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			await memProvider.set("CC_A", "a");
			await memProvider.set("CC_B", "b");

			await manager.getSecret("CC_A");
			await manager.getSecret("CC_B");
			expect(manager.getCacheStats().size).toBe(2);

			manager.clearCache();
			expect(manager.getCacheStats().size).toBe(0);
		});

		it("should force re-fetch from providers after clearing", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
				cache: { enabled: true, ttlMs: 60_000, maxSize: 100 },
			});
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			await memProvider.set("REFETCH", "old");

			// Populate cache
			await manager.getSecret("REFETCH");

			// Modify provider directly
			await memProvider.set("REFETCH", "new");

			// Should still return cached "old"
			expect(await manager.getSecret("REFETCH")).toBe("old");

			// Clear cache
			manager.clearCache();

			// Should now return "new" from provider
			expect(await manager.getSecret("REFETCH")).toBe("new");
		});
	});

	describe("resolveTemplate", () => {
		it("should resolve ${secret:KEY} patterns with actual values", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
			});
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			await memProvider.set("DB_USER", "admin");
			await memProvider.set("DB_PASS", "s3cret");

			const result = await manager.resolveTemplate(
				"postgres://${secret:DB_USER}:${secret:DB_PASS}@host/db"
			);
			expect(result).toBe("postgres://admin:s3cret@host/db");
		});

		it("should replace missing secrets with empty string", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
			});

			const result = await manager.resolveTemplate(
				"key=${secret:MISSING_KEY}"
			);
			expect(result).toBe("key=");
		});

		it("should return template unchanged when there are no placeholders", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
			});

			const template = "no-secrets-here";
			const result = await manager.resolveTemplate(template);
			expect(result).toBe(template);
		});

		it("should handle multiple occurrences of the same secret", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
			});
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			await memProvider.set("TOKEN", "abc123");

			const result = await manager.resolveTemplate(
				"${secret:TOKEN}-${secret:TOKEN}"
			);
			expect(result).toBe("abc123-abc123");
		});

		it("should resolve from environment provider in a chain", async () => {
			setTestEnv("SM_TPL_HOST", "db.example.com");
			const manager = new SecretManager({
				providers: [
					{ type: "memory" },
					{ type: "environment" },
				],
			});

			const result = await manager.resolveTemplate(
				"host=${secret:SM_TPL_HOST}"
			);
			expect(result).toBe("host=db.example.com");
		});

		it("should handle templates with mixed found and missing secrets", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
			});
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			await memProvider.set("FOUND", "yes");

			const result = await manager.resolveTemplate(
				"found=${secret:FOUND}&missing=${secret:NOPE}"
			);
			expect(result).toBe("found=yes&missing=");
		});

		it("should handle empty template", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
			});

			const result = await manager.resolveTemplate("");
			expect(result).toBe("");
		});
	});

	describe("audit events", () => {
		it("should not emit events when auditLog is false", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
				auditLog: false,
			});
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			await memProvider.set("AUDIT_OFF", "value");

			const events: SecretAccessEvent[] = [];
			manager.on("secretAccess", (e) => events.push(e));

			await manager.getSecret("AUDIT_OFF");
			expect(events).toHaveLength(0);
		});

		it("should emit a secretAccess event on getSecret when auditLog is true", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
				auditLog: true,
			});
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			await memProvider.set("AUDIT_GET", "value");

			const events: SecretAccessEvent[] = [];
			manager.on("secretAccess", (e) => events.push(e));

			await manager.getSecret("AUDIT_GET");

			expect(events.length).toBeGreaterThanOrEqual(1);
			const getEvent = events.find((e) => e.operation === "get" && e.key === "AUDIT_GET");
			expect(getEvent).toBeDefined();
			expect(getEvent!.success).toBe(true);
			expect(getEvent!.cached).toBe(false);
			expect(getEvent!.provider).toBe("memory");
			expect(getEvent!.timestamp).toBeDefined();
		});

		it("should emit event with cached: true when served from cache", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
				cache: { enabled: true, ttlMs: 60_000, maxSize: 100 },
				auditLog: true,
			});
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			await memProvider.set("AUDIT_CACHED", "cached-val");

			const events: SecretAccessEvent[] = [];
			manager.on("secretAccess", (e) => events.push(e));

			// First get - populates cache
			await manager.getSecret("AUDIT_CACHED");
			// Second get - from cache
			await manager.getSecret("AUDIT_CACHED");

			const cachedEvent = events.find(
				(e) => e.operation === "get" && e.key === "AUDIT_CACHED" && e.cached === true
			);
			expect(cachedEvent).toBeDefined();
			expect(cachedEvent!.provider).toBe("cache");
		});

		it("should emit event on setSecret", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
				auditLog: true,
			});

			const events: SecretAccessEvent[] = [];
			manager.on("secretAccess", (e) => events.push(e));

			await manager.setSecret("AUDIT_SET", "set-val");

			const setEvent = events.find((e) => e.operation === "set" && e.key === "AUDIT_SET");
			expect(setEvent).toBeDefined();
			expect(setEvent!.success).toBe(true);
			expect(setEvent!.provider).toBe("memory");
		});

		it("should emit event on deleteSecret", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
				auditLog: true,
			});
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			await memProvider.set("AUDIT_DEL", "value");

			const events: SecretAccessEvent[] = [];
			manager.on("secretAccess", (e) => events.push(e));

			await manager.deleteSecret("AUDIT_DEL");

			const delEvent = events.find((e) => e.operation === "delete" && e.key === "AUDIT_DEL");
			expect(delEvent).toBeDefined();
			expect(delEvent!.success).toBe(true);
		});

		it("should emit event on listSecrets", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
				auditLog: true,
			});

			const events: SecretAccessEvent[] = [];
			manager.on("secretAccess", (e) => events.push(e));

			await manager.listSecrets();

			const listEvent = events.find((e) => e.operation === "list");
			expect(listEvent).toBeDefined();
			expect(listEvent!.success).toBe(true);
			expect(listEvent!.key).toBeUndefined();
		});

		it("should emit event on exists", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
				auditLog: true,
			});
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			await memProvider.set("AUDIT_EXISTS", "value");

			const events: SecretAccessEvent[] = [];
			manager.on("secretAccess", (e) => events.push(e));

			await manager.exists("AUDIT_EXISTS");

			const existsEvent = events.find(
				(e) => e.operation === "exists" && e.key === "AUDIT_EXISTS"
			);
			expect(existsEvent).toBeDefined();
			expect(existsEvent!.success).toBe(true);
		});

		it("should emit event when getSecret returns null (not found in any provider)", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
				auditLog: true,
			});

			const events: SecretAccessEvent[] = [];
			manager.on("secretAccess", (e) => events.push(e));

			await manager.getSecret("AUDIT_NOT_FOUND");

			const noneEvent = events.find(
				(e) => e.operation === "get" && e.key === "AUDIT_NOT_FOUND" && e.provider === "none"
			);
			expect(noneEvent).toBeDefined();
			expect(noneEvent!.success).toBe(true);
		});

		it("should include ISO 8601 timestamp in events", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
				auditLog: true,
			});
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			await memProvider.set("AUDIT_TS", "value");

			const events: SecretAccessEvent[] = [];
			manager.on("secretAccess", (e) => events.push(e));

			await manager.getSecret("AUDIT_TS");

			expect(events.length).toBeGreaterThanOrEqual(1);
			// Validate ISO 8601 format
			const ts = events[0].timestamp;
			expect(new Date(ts).toISOString()).toBe(ts);
		});
	});

	describe("getProviders", () => {
		it("should return a copy of the providers array", () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }, { type: "environment" }],
			});

			const providers1 = manager.getProviders();
			const providers2 = manager.getProviders();

			expect(providers1).not.toBe(providers2);
			expect(providers1).toHaveLength(2);
			expect(providers2).toHaveLength(2);
		});
	});

	describe("getCacheStats", () => {
		it("should return accurate cache statistics", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
				cache: { enabled: true, ttlMs: 60_000, maxSize: 50 },
			});
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			await memProvider.set("STATS_A", "a");
			await memProvider.set("STATS_B", "b");

			await manager.getSecret("STATS_A");
			await manager.getSecret("STATS_B");

			const stats = manager.getCacheStats();
			expect(stats.size).toBe(2);
			expect(stats.maxSize).toBe(50);
			expect(stats.enabled).toBe(true);
		});
	});

	describe("error handling in provider chain", () => {
		it("should continue to next provider if first provider throws on get", async () => {
			setTestEnv("SM_ERR_FALLBACK", "env-fallback");
			const manager = new SecretManager({
				providers: [
					{ type: "memory" },
					{ type: "environment" },
				],
				auditLog: true,
			});

			// Create a faulty first provider by overriding its get method
			const faultyProvider = manager.getProviders()[0];
			const originalGet = faultyProvider.get.bind(faultyProvider);
			(faultyProvider as InMemorySecretProvider).get = async (_key: string) => {
				throw new Error("Provider failure");
			};

			const events: SecretAccessEvent[] = [];
			manager.on("secretAccess", (e) => events.push(e));

			const value = await manager.getSecret("SM_ERR_FALLBACK");
			expect(value).toBe("env-fallback");

			// Should have a failure event for the memory provider
			const failEvent = events.find(
				(e) => e.provider === "memory" && e.success === false
			);
			expect(failEvent).toBeDefined();
			expect(failEvent!.error).toBe("Provider failure");

			// Restore original
			(faultyProvider as InMemorySecretProvider).get = originalGet;
		});

		it("should throw when setSecret fails on all providers", async () => {
			const manager = new SecretManager({
				providers: [{ type: "memory" }],
			});

			// Override set to throw
			const memProvider = manager.getProviders()[0] as InMemorySecretProvider;
			const originalSet = memProvider.set.bind(memProvider);
			memProvider.set = async () => {
				throw new Error("Write failure");
			};

			await expect(manager.setSecret("FAIL_SET", "val")).rejects.toThrow(
				"Failed to set secret 'FAIL_SET' in any provider"
			);

			// Restore
			memProvider.set = originalSet;
		});
	});
});
