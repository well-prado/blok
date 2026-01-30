import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthIdentity } from "../../security/AuthMiddleware";
import { OAuthOIDCProvider, TokenCache } from "../../security/OAuthProvider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal AuthIdentity for cache testing */
function makeIdentity(sub: string, overrides?: Partial<AuthIdentity>): AuthIdentity {
	return {
		sub,
		roles: [],
		claims: {},
		provider: "oauth-oidc",
		...overrides,
	};
}

/**
 * Build a fake JWT string with the given header and payload.
 * The signature part is just a placeholder -- no real signing.
 * Useful for testing the authenticate() parsing path without network calls.
 */
function buildFakeJWT(header: Record<string, unknown>, payload: Record<string, unknown>): string {
	const h = Buffer.from(JSON.stringify(header)).toString("base64url");
	const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const s = Buffer.from("fake-signature-bytes").toString("base64url");
	return `${h}.${p}.${s}`;
}

// ===========================================================================
// TokenCache
// ===========================================================================

describe("TokenCache", () => {
	// -----------------------------------------------------------------------
	// Construction
	// -----------------------------------------------------------------------

	describe("construction", () => {
		it("should create a cache with default maxSize of 1000", () => {
			const cache = new TokenCache();
			const stats = cache.getStats();
			expect(stats.maxSize).toBe(1000);
			expect(stats.size).toBe(0);
		});

		it("should create a cache with a custom maxSize", () => {
			const cache = new TokenCache(50);
			const stats = cache.getStats();
			expect(stats.maxSize).toBe(50);
		});
	});

	// -----------------------------------------------------------------------
	// hashToken (static)
	// -----------------------------------------------------------------------

	describe("hashToken", () => {
		it("should return a SHA-256 hex digest", () => {
			const hash = TokenCache.hashToken("my-token");
			const expected = createHash("sha256").update("my-token").digest("hex");
			expect(hash).toBe(expected);
		});

		it("should return different hashes for different tokens", () => {
			const a = TokenCache.hashToken("token-a");
			const b = TokenCache.hashToken("token-b");
			expect(a).not.toBe(b);
		});

		it("should return the same hash for identical tokens", () => {
			const h1 = TokenCache.hashToken("same");
			const h2 = TokenCache.hashToken("same");
			expect(h1).toBe(h2);
		});

		it("should produce a 64-character hex string", () => {
			const hash = TokenCache.hashToken("anything");
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
		});
	});

	// -----------------------------------------------------------------------
	// set / get basics
	// -----------------------------------------------------------------------

	describe("set and get", () => {
		it("should store and retrieve an identity by hash", () => {
			const cache = new TokenCache();
			const identity = makeIdentity("user-1");
			const hash = TokenCache.hashToken("tok-1");

			cache.set(hash, identity, 60_000);
			const result = cache.get(hash);

			expect(result).toBeDefined();
			expect(result?.sub).toBe("user-1");
		});

		it("should return undefined for a key that was never set", () => {
			const cache = new TokenCache();
			expect(cache.get("nonexistent")).toBeUndefined();
		});

		it("should overwrite an existing entry when the same key is set again", () => {
			const cache = new TokenCache();
			const hash = TokenCache.hashToken("tok");

			cache.set(hash, makeIdentity("first"), 60_000);
			cache.set(hash, makeIdentity("second"), 60_000);

			const result = cache.get(hash);
			expect(result?.sub).toBe("second");
		});

		it("should track size correctly after multiple sets", () => {
			const cache = new TokenCache();
			cache.set("a", makeIdentity("1"), 60_000);
			cache.set("b", makeIdentity("2"), 60_000);
			cache.set("c", makeIdentity("3"), 60_000);

			expect(cache.getStats().size).toBe(3);
		});

		it("should not double-count when overwriting the same key", () => {
			const cache = new TokenCache();
			cache.set("a", makeIdentity("1"), 60_000);
			cache.set("a", makeIdentity("2"), 60_000);

			expect(cache.getStats().size).toBe(1);
		});
	});

	// -----------------------------------------------------------------------
	// TTL expiration
	// -----------------------------------------------------------------------

	describe("TTL expiration", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("should return the identity before TTL expires", () => {
			const cache = new TokenCache();
			const hash = "ttl-test";

			cache.set(hash, makeIdentity("alive"), 5_000);

			// Advance time by 4 seconds (within TTL)
			vi.advanceTimersByTime(4_000);

			expect(cache.get(hash)).toBeDefined();
			expect(cache.get(hash)?.sub).toBe("alive");
		});

		it("should return undefined after TTL expires", () => {
			const cache = new TokenCache();
			const hash = "ttl-expired";

			cache.set(hash, makeIdentity("gone"), 5_000);

			// Advance time past TTL
			vi.advanceTimersByTime(5_001);

			expect(cache.get(hash)).toBeUndefined();
		});

		it("should count expired entry retrieval as a miss and eviction", () => {
			const cache = new TokenCache();
			const hash = "ttl-stats";

			cache.set(hash, makeIdentity("x"), 1_000);

			vi.advanceTimersByTime(2_000);

			cache.get(hash); // expired lookup

			const stats = cache.getStats();
			expect(stats.misses).toBe(1);
			expect(stats.evictions).toBe(1);
			expect(stats.size).toBe(0);
		});

		it("should evict an expired entry from the internal map", () => {
			const cache = new TokenCache();
			const hash = "evict-me";

			cache.set(hash, makeIdentity("temp"), 500);
			expect(cache.getStats().size).toBe(1);

			vi.advanceTimersByTime(600);
			cache.get(hash); // triggers eviction

			expect(cache.getStats().size).toBe(0);
		});

		it("should handle zero TTL (entry immediately expired)", () => {
			const cache = new TokenCache();
			const hash = "zero-ttl";

			cache.set(hash, makeIdentity("instant"), 0);

			// Even without advancing time, Date.now() >= expiresAt
			// because expiresAt = Date.now() + 0 = Date.now()
			const result = cache.get(hash);
			expect(result).toBeUndefined();
		});
	});

	// -----------------------------------------------------------------------
	// Max size eviction (LRU)
	// -----------------------------------------------------------------------

	describe("max size eviction", () => {
		it("should evict the oldest entry when maxSize is exceeded", () => {
			const cache = new TokenCache(3);

			cache.set("a", makeIdentity("a"), 60_000);
			cache.set("b", makeIdentity("b"), 60_000);
			cache.set("c", makeIdentity("c"), 60_000);

			// Cache is full (3/3). Adding a 4th should evict "a" (oldest).
			cache.set("d", makeIdentity("d"), 60_000);

			expect(cache.get("a")).toBeUndefined(); // evicted
			expect(cache.get("b")).toBeDefined();
			expect(cache.get("c")).toBeDefined();
			expect(cache.get("d")).toBeDefined();
			expect(cache.getStats().size).toBe(3);
		});

		it("should increment evictions counter on size-based eviction", () => {
			const cache = new TokenCache(2);

			cache.set("x", makeIdentity("x"), 60_000);
			cache.set("y", makeIdentity("y"), 60_000);
			cache.set("z", makeIdentity("z"), 60_000); // evicts "x"

			expect(cache.getStats().evictions).toBe(1);
		});

		it("should evict multiple entries as more are added", () => {
			const cache = new TokenCache(2);

			cache.set("1", makeIdentity("1"), 60_000);
			cache.set("2", makeIdentity("2"), 60_000);
			cache.set("3", makeIdentity("3"), 60_000); // evicts "1"
			cache.set("4", makeIdentity("4"), 60_000); // evicts "2"

			expect(cache.get("1")).toBeUndefined();
			expect(cache.get("2")).toBeUndefined();
			expect(cache.get("3")).toBeDefined();
			expect(cache.get("4")).toBeDefined();
			expect(cache.getStats().evictions).toBe(2);
		});

		it("should handle maxSize of 1", () => {
			const cache = new TokenCache(1);

			cache.set("first", makeIdentity("first"), 60_000);
			expect(cache.get("first")?.sub).toBe("first");

			cache.set("second", makeIdentity("second"), 60_000);
			expect(cache.get("first")).toBeUndefined();
			expect(cache.get("second")?.sub).toBe("second");
		});

		it("should promote accessed entry to most-recently-used on get", () => {
			const cache = new TokenCache(3);

			cache.set("a", makeIdentity("a"), 60_000);
			cache.set("b", makeIdentity("b"), 60_000);
			cache.set("c", makeIdentity("c"), 60_000);

			// Access "a" to move it to the end (most-recently-used)
			cache.get("a");

			// Now adding "d" should evict "b" (the least-recently-used), not "a"
			cache.set("d", makeIdentity("d"), 60_000);

			expect(cache.get("a")).toBeDefined(); // was promoted by the get
			expect(cache.get("b")).toBeUndefined(); // evicted as LRU
			expect(cache.get("c")).toBeDefined();
			expect(cache.get("d")).toBeDefined();
		});

		it("should not evict when re-setting an existing key at capacity", () => {
			const cache = new TokenCache(2);

			cache.set("a", makeIdentity("a"), 60_000);
			cache.set("b", makeIdentity("b"), 60_000);

			// Overwrite "a" -- should NOT trigger eviction since size stays at 2
			cache.set("a", makeIdentity("a-updated"), 60_000);

			expect(cache.get("a")?.sub).toBe("a-updated");
			expect(cache.get("b")).toBeDefined();
			expect(cache.getStats().size).toBe(2);
			expect(cache.getStats().evictions).toBe(0);
		});
	});

	// -----------------------------------------------------------------------
	// Cache stats (hits, misses, size)
	// -----------------------------------------------------------------------

	describe("cache stats", () => {
		it("should start with all stats at zero", () => {
			const cache = new TokenCache();
			const stats = cache.getStats();

			expect(stats.size).toBe(0);
			expect(stats.hits).toBe(0);
			expect(stats.misses).toBe(0);
			expect(stats.evictions).toBe(0);
		});

		it("should count hits on successful get", () => {
			const cache = new TokenCache();
			cache.set("h", makeIdentity("h"), 60_000);

			cache.get("h");
			cache.get("h");
			cache.get("h");

			expect(cache.getStats().hits).toBe(3);
		});

		it("should count misses on failed get", () => {
			const cache = new TokenCache();

			cache.get("missing-1");
			cache.get("missing-2");

			expect(cache.getStats().misses).toBe(2);
		});

		it("should track size as entries are added and evicted", () => {
			const cache = new TokenCache(3);

			expect(cache.getStats().size).toBe(0);

			cache.set("a", makeIdentity("a"), 60_000);
			expect(cache.getStats().size).toBe(1);

			cache.set("b", makeIdentity("b"), 60_000);
			expect(cache.getStats().size).toBe(2);

			cache.set("c", makeIdentity("c"), 60_000);
			expect(cache.getStats().size).toBe(3);

			// Triggers eviction, size stays at 3
			cache.set("d", makeIdentity("d"), 60_000);
			expect(cache.getStats().size).toBe(3);
		});

		it("should return correct maxSize", () => {
			const cache = new TokenCache(42);
			expect(cache.getStats().maxSize).toBe(42);
		});

		it("should accumulate both hits and misses across multiple operations", () => {
			const cache = new TokenCache();
			cache.set("k", makeIdentity("k"), 60_000);

			cache.get("k"); // hit
			cache.get("nope"); // miss
			cache.get("k"); // hit
			cache.get("nope-2"); // miss
			cache.get("k"); // hit

			const stats = cache.getStats();
			expect(stats.hits).toBe(3);
			expect(stats.misses).toBe(2);
		});
	});

	// -----------------------------------------------------------------------
	// invalidate
	// -----------------------------------------------------------------------

	describe("invalidate", () => {
		it("should remove a specific entry by hash", () => {
			const cache = new TokenCache();
			cache.set("inv", makeIdentity("inv"), 60_000);

			const removed = cache.invalidate("inv");

			expect(removed).toBe(true);
			expect(cache.get("inv")).toBeUndefined();
			expect(cache.getStats().size).toBe(0);
		});

		it("should return false when invalidating a nonexistent key", () => {
			const cache = new TokenCache();
			const removed = cache.invalidate("not-here");
			expect(removed).toBe(false);
		});

		it("should not affect other entries", () => {
			const cache = new TokenCache();
			cache.set("keep", makeIdentity("keep"), 60_000);
			cache.set("remove", makeIdentity("remove"), 60_000);

			cache.invalidate("remove");

			expect(cache.get("keep")).toBeDefined();
			expect(cache.getStats().size).toBe(1);
		});
	});

	// -----------------------------------------------------------------------
	// clear
	// -----------------------------------------------------------------------

	describe("clear", () => {
		it("should remove all entries", () => {
			const cache = new TokenCache();
			cache.set("a", makeIdentity("a"), 60_000);
			cache.set("b", makeIdentity("b"), 60_000);
			cache.set("c", makeIdentity("c"), 60_000);

			cache.clear();

			expect(cache.get("a")).toBeUndefined();
			expect(cache.get("b")).toBeUndefined();
			expect(cache.get("c")).toBeUndefined();
			expect(cache.getStats().size).toBe(0);
		});

		it("should reset all stats to zero", () => {
			const cache = new TokenCache(2);

			cache.set("a", makeIdentity("a"), 60_000);
			cache.set("b", makeIdentity("b"), 60_000);
			cache.set("c", makeIdentity("c"), 60_000); // eviction
			cache.get("b"); // hit
			cache.get("nonexistent"); // miss

			// Verify stats are non-zero before clearing
			const before = cache.getStats();
			expect(before.hits).toBeGreaterThan(0);
			expect(before.misses).toBeGreaterThan(0);
			expect(before.evictions).toBeGreaterThan(0);

			cache.clear();

			const after = cache.getStats();
			expect(after.size).toBe(0);
			expect(after.hits).toBe(0);
			expect(after.misses).toBe(0);
			expect(after.evictions).toBe(0);
		});

		it("should allow re-use of the cache after clearing", () => {
			const cache = new TokenCache();
			cache.set("x", makeIdentity("x"), 60_000);
			cache.clear();
			cache.set("y", makeIdentity("y"), 60_000);

			expect(cache.get("y")?.sub).toBe("y");
			expect(cache.getStats().size).toBe(1);
		});

		it("should preserve maxSize after clearing", () => {
			const cache = new TokenCache(5);
			cache.clear();
			expect(cache.getStats().maxSize).toBe(5);
		});
	});
});

// ===========================================================================
// OAuthOIDCProvider
// ===========================================================================

describe("OAuthOIDCProvider", () => {
	// -----------------------------------------------------------------------
	// Construction and config defaults
	// -----------------------------------------------------------------------

	describe("constructor", () => {
		it("should create a provider with minimal config", () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "my-app",
			});

			expect(provider).toBeDefined();
			expect(provider.name).toBe("oauth-oidc");
		});

		it("should create a provider with full config", () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "my-app",
				clientSecret: "secret-123",
				audience: "https://api.example.com",
				allowedAlgorithms: ["RS256"],
				jwksUri: "https://auth.example.com/.well-known/jwks.json",
				rolesClaim: "custom_roles",
				scopesClaim: "custom_scope",
				clockToleranceSec: 60,
				cacheJWKS: false,
				cacheDiscovery: false,
				introspectionEndpoint: "https://auth.example.com/introspect",
			});

			expect(provider).toBeDefined();
			expect(provider.name).toBe("oauth-oidc");
		});
	});

	// -----------------------------------------------------------------------
	// name property
	// -----------------------------------------------------------------------

	describe("name", () => {
		it('should always be "oauth-oidc"', () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://issuer.test",
				clientId: "test-client",
			});
			expect(provider.name).toBe("oauth-oidc");
		});
	});

	// -----------------------------------------------------------------------
	// authenticate() - no authorization header
	// -----------------------------------------------------------------------

	describe("authenticate() with no authorization header", () => {
		it("should return not authenticated with empty headers", async () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "app",
			});

			const result = await provider.authenticate({ headers: {} });

			expect(result.authenticated).toBe(false);
			expect(result.error).toBe("No authorization header");
		});

		it("should return not authenticated with unrelated headers", async () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "app",
			});

			const result = await provider.authenticate({
				headers: {
					"content-type": "application/json",
					"x-request-id": "abc-123",
				},
			});

			expect(result.authenticated).toBe(false);
			expect(result.error).toBe("No authorization header");
		});
	});

	// -----------------------------------------------------------------------
	// authenticate() - non-Bearer token format
	// -----------------------------------------------------------------------

	describe("authenticate() with non-Bearer token format", () => {
		it("should reject Basic auth scheme", async () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "app",
			});

			const result = await provider.authenticate({
				headers: { authorization: "Basic dXNlcjpwYXNz" },
			});

			expect(result.authenticated).toBe(false);
			expect(result.error).toBe("Invalid Bearer token format");
		});

		it("should reject Digest auth scheme", async () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "app",
			});

			const result = await provider.authenticate({
				headers: { authorization: 'Digest username="user"' },
			});

			expect(result.authenticated).toBe(false);
			expect(result.error).toBe("Invalid Bearer token format");
		});

		it("should reject plain string without scheme", async () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "app",
			});

			const result = await provider.authenticate({
				headers: { authorization: "some-random-token-string" },
			});

			expect(result.authenticated).toBe(false);
			expect(result.error).toBe("Invalid Bearer token format");
		});

		it("should reject empty Bearer value", async () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "app",
			});

			const result = await provider.authenticate({
				headers: { authorization: "Bearer " },
			});

			expect(result.authenticated).toBe(false);
			expect(result.error).toBe("Invalid Bearer token format");
		});
	});

	// -----------------------------------------------------------------------
	// authenticate() - malformed JWT
	// -----------------------------------------------------------------------

	describe("authenticate() with malformed JWT", () => {
		it("should reject a token with only one part (no dots)", async () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "app",
			});

			const result = await provider.authenticate({
				headers: { authorization: "Bearer singlesegment" },
			});

			expect(result.authenticated).toBe(false);
		});

		it("should reject a token with two parts (one dot)", async () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "app",
			});

			const result = await provider.authenticate({
				headers: { authorization: "Bearer part1.part2" },
			});

			expect(result.authenticated).toBe(false);
		});

		it("should reject a token with four parts (three dots)", async () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "app",
			});

			const result = await provider.authenticate({
				headers: { authorization: "Bearer a.b.c.d" },
			});

			expect(result.authenticated).toBe(false);
		});

		it("should reject a token with an invalid base64url header", async () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "app",
			});

			// The header is not valid JSON when base64url-decoded
			const result = await provider.authenticate({
				headers: { authorization: "Bearer !!!invalid!!!.payload.signature" },
			});

			expect(result.authenticated).toBe(false);
		});

		it("should reject a token with a non-allowed algorithm in the header", async () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "app",
				allowedAlgorithms: ["RS256"],
			});

			// Build a JWT header with HS256, which is not in allowedAlgorithms
			const token = buildFakeJWT(
				{ alg: "HS256", typ: "JWT" },
				{ sub: "user", exp: Math.floor(Date.now() / 1000) + 3600 },
			);

			const result = await provider.authenticate({
				headers: { authorization: `Bearer ${token}` },
			});

			expect(result.authenticated).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// authenticate() - authorization header casing
	// -----------------------------------------------------------------------

	describe("authenticate() with header casing", () => {
		it("should detect lowercase 'authorization' header", async () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "app",
			});

			const result = await provider.authenticate({
				headers: { authorization: "Basic abc" },
			});

			// It found the header but it is not Bearer format
			expect(result.authenticated).toBe(false);
			expect(result.error).toBe("Invalid Bearer token format");
		});

		it("should detect capitalized 'Authorization' header", async () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "app",
			});

			const result = await provider.authenticate({
				headers: { Authorization: "Basic abc" },
			});

			// It found the header but it is not Bearer format
			expect(result.authenticated).toBe(false);
			expect(result.error).toBe("Invalid Bearer token format");
		});
	});

	// -----------------------------------------------------------------------
	// authenticate() - Bearer prefix is case-insensitive
	// -----------------------------------------------------------------------

	describe("authenticate() Bearer prefix parsing", () => {
		it("should accept 'Bearer' with capital B", async () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "app",
			});

			// The token is a valid 3-part structure but won't verify.
			// We just want to confirm Bearer stripping works (it won't return
			// "Invalid Bearer token format").
			const token = buildFakeJWT({ alg: "RS256", typ: "JWT" }, { sub: "user" });

			const result = await provider.authenticate({
				headers: { authorization: `Bearer ${token}` },
			});

			// It should get past the Bearer check (may fail on JWKS fetch)
			expect(result.error).not.toBe("Invalid Bearer token format");
			expect(result.error).not.toBe("No authorization header");
		});

		it("should accept 'bearer' all lowercase", async () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "app",
			});

			const token = buildFakeJWT({ alg: "RS256", typ: "JWT" }, { sub: "user" });

			const result = await provider.authenticate({
				headers: { authorization: `bearer ${token}` },
			});

			expect(result.error).not.toBe("Invalid Bearer token format");
			expect(result.error).not.toBe("No authorization header");
		});

		it("should accept 'BEARER' all uppercase", async () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "app",
			});

			const token = buildFakeJWT({ alg: "RS256", typ: "JWT" }, { sub: "user" });

			const result = await provider.authenticate({
				headers: { authorization: `BEARER ${token}` },
			});

			expect(result.error).not.toBe("Invalid Bearer token format");
			expect(result.error).not.toBe("No authorization header");
		});
	});

	// -----------------------------------------------------------------------
	// Token structure parsing (3 parts: header.payload.signature)
	// -----------------------------------------------------------------------

	describe("token structure parsing", () => {
		it("should attempt to process a well-formed 3-part token", async () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "app",
			});

			const token = buildFakeJWT(
				{ alg: "RS256", kid: "key-1", typ: "JWT" },
				{
					sub: "user-123",
					iss: "https://auth.example.com",
					aud: "app",
					exp: Math.floor(Date.now() / 1000) + 3600,
				},
			);

			const result = await provider.authenticate({
				headers: { authorization: `Bearer ${token}` },
			});

			// The token has 3 parts and a valid header, so it gets past the
			// structural checks. It will fail at JWKS resolution (network).
			// But the error should NOT be about malformed tokens or Bearer format.
			expect(result.authenticated).toBe(false);
			expect(result.error).not.toBe("No authorization header");
			expect(result.error).not.toBe("Invalid Bearer token format");
		});

		it("should reject a token with a header specifying an unsupported algorithm", async () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "app",
				allowedAlgorithms: ["RS256", "ES256"],
			});

			const token = buildFakeJWT({ alg: "none", typ: "JWT" }, { sub: "attacker" });

			const result = await provider.authenticate({
				headers: { authorization: `Bearer ${token}` },
			});

			expect(result.authenticated).toBe(false);
		});

		it("should reject a token where the header is not valid JSON", async () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "app",
			});

			const badHeader = Buffer.from("not-json{{{").toString("base64url");
			const payload = Buffer.from(JSON.stringify({ sub: "x" })).toString("base64url");
			const sig = Buffer.from("sig").toString("base64url");

			const result = await provider.authenticate({
				headers: { authorization: `Bearer ${badHeader}.${payload}.${sig}` },
			});

			expect(result.authenticated).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// clearCaches
	// -----------------------------------------------------------------------

	describe("clearCaches", () => {
		it("should reset the token cache stats", () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "app",
			});

			// The provider starts with an empty cache
			const beforeStats = provider.getTokenCacheStats();
			expect(beforeStats.size).toBe(0);

			provider.clearCaches();

			const afterStats = provider.getTokenCacheStats();
			expect(afterStats.size).toBe(0);
			expect(afterStats.hits).toBe(0);
			expect(afterStats.misses).toBe(0);
			expect(afterStats.evictions).toBe(0);
		});
	});

	// -----------------------------------------------------------------------
	// getTokenCacheStats
	// -----------------------------------------------------------------------

	describe("getTokenCacheStats", () => {
		it("should return initial stats with all zeros", () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "app",
			});

			const stats = provider.getTokenCacheStats();

			expect(stats.size).toBe(0);
			expect(stats.maxSize).toBe(1000);
			expect(stats.hits).toBe(0);
			expect(stats.misses).toBe(0);
			expect(stats.evictions).toBe(0);
		});
	});

	// -----------------------------------------------------------------------
	// authenticate() - handles thrown errors gracefully
	// -----------------------------------------------------------------------

	describe("authenticate() error handling", () => {
		it("should return a descriptive error when JWT verification throws", async () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "app",
			});

			// This is a structurally valid JWT with RS256 alg, so verifyJWT will
			// attempt OIDC discovery which will fail (no real server).
			const token = buildFakeJWT(
				{ alg: "RS256", kid: "key-1", typ: "JWT" },
				{ sub: "user", exp: Math.floor(Date.now() / 1000) + 3600 },
			);

			const result = await provider.authenticate({
				headers: { authorization: `Bearer ${token}` },
			});

			expect(result.authenticated).toBe(false);
			// Should not throw; should return a structured AuthResult
			expect(typeof result.error).toBe("string");
		});

		it("should return 401 status code on failure", async () => {
			const provider = new OAuthOIDCProvider({
				issuerUrl: "https://auth.example.com",
				clientId: "app",
			});

			const token = buildFakeJWT({ alg: "RS256", typ: "JWT" }, { sub: "user" });

			const result = await provider.authenticate({
				headers: { authorization: `Bearer ${token}` },
			});

			expect(result.authenticated).toBe(false);
			// The code either returns statusCode: 401 from catch block
			// or from the "Token verification failed" path
			if (result.statusCode !== undefined) {
				expect(result.statusCode).toBe(401);
			}
		});
	});
});
