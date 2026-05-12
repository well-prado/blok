import { createHmac } from "node:crypto";
import type { Context } from "@blokjs/shared";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AuditLogNode,
	CtxPublishManyNode,
	CtxPublishNode,
	ExprNode,
	HELPER_NODES,
	HmacVerifyNode,
	InMemoryKvNode,
	JsonSchemaNode,
	JwtVerifyNode,
	LogNode,
	MetricsEmitNode,
	RedisKvNode,
	ThrowNode,
	_resetAuditEventsForTests,
	_resetInMemoryKvForTests,
	_resetJwksCacheForTests,
	_teardownRedisForTests,
	getAuditEvents,
} from "../src/index";

function ctxFor(): Context {
	const state: Record<string, unknown> = {};
	return {
		id: "test-req",
		workflow_name: "test-wf",
		workflow_path: "/test",
		request: { body: {}, headers: {}, params: {}, query: {} },
		response: { data: {}, success: true, error: null },
		error: { message: [] },
		logger: {
			log: vi.fn(),
			logLevel: vi.fn(),
			error: vi.fn(),
			getLogs: () => [],
			getLogsAsText: () => "",
			getLogsAsBase64: () => "",
		},
		config: {},
		vars: state,
		state,
		env: {},
		eventLogger: null,
		_PRIVATE_: null,
	} as unknown as Context;
}

describe("@blokjs/helpers", () => {
	describe("HELPER_NODES barrel", () => {
		it("exports every helper at its canonical ref", () => {
			expect(Object.keys(HELPER_NODES).sort()).toEqual([
				"@blokjs/audit-log",
				"@blokjs/ctx-publish",
				"@blokjs/ctx-publish-many",
				"@blokjs/expr",
				"@blokjs/hmac-verify",
				"@blokjs/in-memory-kv",
				"@blokjs/json-schema",
				"@blokjs/jwt-verify",
				"@blokjs/log",
				"@blokjs/metrics-emit",
				"@blokjs/pubsub-publish",
				"@blokjs/redis-kv",
				"@blokjs/sse-publish",
				"@blokjs/sse-stream",
				"@blokjs/sse-subscribe",
				"@blokjs/throw",
				"@blokjs/worker-publish",
				"@blokjs/ws-broadcast",
				"@blokjs/ws-close",
				"@blokjs/ws-reply",
			]);
		});
	});

	describe("@blokjs/expr", () => {
		it("evaluates a literal expression", async () => {
			const ctx = ctxFor();
			const r = await ExprNode.handle(ctx, { expression: "1 + 2" });
			expect((r as { data: unknown }).data).toBe(3);
		});

		it("reads from ctx.state", async () => {
			const ctx = ctxFor();
			(ctx.state as Record<string, unknown>).counter = 5;
			const r = await ExprNode.handle(ctx, { expression: "ctx.state.counter * 10" });
			expect((r as { data: unknown }).data).toBe(50);
		});

		it("rejects an empty expression at validation time", async () => {
			const ctx = ctxFor();
			const r = await ExprNode.handle(ctx, { expression: "" });
			expect((r as { success: boolean }).success).toBe(false);
		});
	});

	describe("@blokjs/ctx-publish", () => {
		it("sets ctx.state[name] = value", async () => {
			const ctx = ctxFor();
			await CtxPublishNode.handle(ctx, { name: "userId", value: "u-1" });
			expect((ctx.state as Record<string, unknown>).userId).toBe("u-1");
			expect((ctx.vars as Record<string, unknown>).userId).toBe("u-1");
		});

		it("returns the published name + value", async () => {
			const ctx = ctxFor();
			const r = await CtxPublishNode.handle(ctx, { name: "x", value: 42 });
			expect((r as { data: { name: string; value: unknown } }).data).toEqual({ name: "x", value: 42 });
		});
	});

	describe("@blokjs/ctx-publish-many", () => {
		it("sets multiple ctx.state keys in one call", async () => {
			const ctx = ctxFor();
			await CtxPublishManyNode.handle(ctx, { values: { a: 1, b: "two", c: { nested: true } } });
			const state = ctx.state as Record<string, unknown>;
			expect(state.a).toBe(1);
			expect(state.b).toBe("two");
			expect(state.c).toEqual({ nested: true });
		});

		it("reports the count published", async () => {
			const ctx = ctxFor();
			const r = await CtxPublishManyNode.handle(ctx, { values: { a: 1, b: 2, c: 3 } });
			expect((r as { data: { count: number } }).data.count).toBe(3);
		});
	});

	describe("@blokjs/throw", () => {
		it("throws with the configured message", async () => {
			const ctx = ctxFor();
			const r = await ThrowNode.handle(ctx, { message: "boom" });
			// defineNode catches errors and routes them through mapErrorToGlobalError.
			expect((r as { success: boolean }).success).toBe(false);
			expect((r as { error: { message: string } }).error.message).toContain("boom");
		});
	});

	describe("@blokjs/log", () => {
		it("calls ctx.logger.logLevel for non-error levels", async () => {
			const ctx = ctxFor();
			await LogNode.handle(ctx, { level: "info", message: "hello" });
			expect(ctx.logger.logLevel).toHaveBeenCalledWith("info", "hello");
			await LogNode.handle(ctx, { level: "warn", message: "uh oh" });
			expect(ctx.logger.logLevel).toHaveBeenCalledWith("warn", "uh oh");
		});

		it("calls ctx.logger.error for error level", async () => {
			const ctx = ctxFor();
			await LogNode.handle(ctx, { level: "error", message: "boom" });
			expect(ctx.logger.error).toHaveBeenCalled();
		});
	});

	describe("@blokjs/audit-log", () => {
		afterEach(() => _resetAuditEventsForTests());

		it("appends an event to the ring", async () => {
			const ctx = ctxFor();
			await AuditLogNode.handle(ctx, { event: "user-deleted", attrs: { userId: "u1" } });
			const events = getAuditEvents();
			expect(events).toHaveLength(1);
			expect(events[0].event).toBe("user-deleted");
			expect(events[0].attrs).toEqual({ userId: "u1" });
			expect(events[0].timestamp).toBeGreaterThan(0);
			expect(events[0].requestId).toBe("test-req");
		});

		it("bounds the ring at 1000 entries", async () => {
			const ctx = ctxFor();
			for (let i = 0; i < 1010; i++) {
				await AuditLogNode.handle(ctx, { event: `evt-${i}` });
			}
			expect(getAuditEvents()).toHaveLength(1000);
			// First entry should now be evt-10 (oldest 10 dropped).
			expect(getAuditEvents()[0].event).toBe("evt-10");
		});
	});

	describe("@blokjs/metrics-emit", () => {
		it("returns the event + value (no exporter wired in tests)", async () => {
			const ctx = ctxFor();
			const r = await MetricsEmitNode.handle(ctx, { event: "request", value: 1 });
			expect((r as { data: { event: string; value: number } }).data).toEqual({
				event: "request",
				value: 1,
			});
		});
	});

	describe("@blokjs/in-memory-kv", () => {
		afterEach(() => _resetInMemoryKvForTests());

		it("set then get round-trips", async () => {
			const ctx = ctxFor();
			await InMemoryKvNode.handle(ctx, { action: "set", key: "user-1", value: { name: "Alice" } });
			const got = await InMemoryKvNode.handle(ctx, { action: "get", key: "user-1" });
			expect((got as { data: { value: unknown } }).data.value).toEqual({ name: "Alice" });
		});

		it("get on missing key returns undefined value", async () => {
			const ctx = ctxFor();
			const got = await InMemoryKvNode.handle(ctx, { action: "get", key: "missing" });
			expect((got as { data: { value: unknown } }).data.value).toBeUndefined();
		});

		it("delete removes the entry", async () => {
			const ctx = ctxFor();
			await InMemoryKvNode.handle(ctx, { action: "set", key: "x", value: 1 });
			const r = await InMemoryKvNode.handle(ctx, { action: "delete", key: "x" });
			expect((r as { data: { deleted: boolean } }).data.deleted).toBe(true);
			const got = await InMemoryKvNode.handle(ctx, { action: "get", key: "x" });
			expect((got as { data: { value: unknown } }).data.value).toBeUndefined();
		});

		it("list returns all entries when no prefix", async () => {
			const ctx = ctxFor();
			await InMemoryKvNode.handle(ctx, { action: "set", key: "a", value: 1 });
			await InMemoryKvNode.handle(ctx, { action: "set", key: "b", value: 2 });
			const r = await InMemoryKvNode.handle(ctx, { action: "list" });
			const entries = (r as { data: unknown }).data as { key: string; value: unknown }[];
			expect(entries).toHaveLength(2);
		});

		it("list filters by prefix", async () => {
			const ctx = ctxFor();
			await InMemoryKvNode.handle(ctx, { action: "set", key: "user-1", value: { name: "A" } });
			await InMemoryKvNode.handle(ctx, { action: "set", key: "user-2", value: { name: "B" } });
			await InMemoryKvNode.handle(ctx, { action: "set", key: "post-1", value: { title: "P" } });
			const r = await InMemoryKvNode.handle(ctx, { action: "list", prefix: "user-" });
			const entries = (r as { data: unknown }).data as { key: string; value: unknown }[];
			expect(entries).toHaveLength(2);
			expect(entries.every((e) => e.key.startsWith("user-"))).toBe(true);
		});

		it("clear wipes the store", async () => {
			const ctx = ctxFor();
			await InMemoryKvNode.handle(ctx, { action: "set", key: "x", value: 1 });
			await InMemoryKvNode.handle(ctx, { action: "set", key: "y", value: 2 });
			const r = await InMemoryKvNode.handle(ctx, { action: "clear" });
			expect((r as { data: { count: number } }).data.count).toBe(2);
			const list = await InMemoryKvNode.handle(ctx, { action: "list" });
			expect((list as { data: unknown }).data).toEqual([]);
		});
	});

	describe("@blokjs/json-schema", () => {
		it("returns valid: true on matching data", async () => {
			const ctx = ctxFor();
			const r = await JsonSchemaNode.handle(ctx, {
				schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
				data: { name: "Alice" },
			});
			expect((r as { data: { valid: boolean } }).data.valid).toBe(true);
		});

		it("throws on validation failure", async () => {
			const ctx = ctxFor();
			const r = await JsonSchemaNode.handle(ctx, {
				schema: { type: "object", required: ["name"] },
				data: { otherField: "x" },
			});
			expect((r as { success: boolean }).success).toBe(false);
			expect((r as { error: { message: string } }).error.message).toContain("validation failed");
		});
	});

	// ====================================================================
	// @blokjs/jwt-verify — production JWT auth helper
	// ====================================================================
	//
	// Tokens are minted in-process via jose's `SignJWT` so the success path
	// exercises the same library being verified — that's intentional, since
	// any divergence between sign and verify would be a jose internal bug
	// that affects production users equally. The failure paths use
	// hand-crafted invalid tokens or tokens signed with a different secret
	// to exercise each `unauthorized()` reason.
	describe("@blokjs/jwt-verify", () => {
		const SECRET = "super-secret-not-for-prod-use";
		const ISSUER = "https://test.example.com";
		const AUDIENCE = "test-api";

		beforeEach(() => {
			_resetJwksCacheForTests();
		});

		async function signHs256(claims: Record<string, unknown>, opts: { exp?: string } = {}): Promise<string> {
			const key = new TextEncoder().encode(SECRET);
			let token = new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt();
			if (claims.iss === undefined) token = token.setIssuer(ISSUER);
			if (claims.aud === undefined) token = token.setAudience(AUDIENCE);
			token = token.setExpirationTime(opts.exp ?? "1h");
			return token.sign(key);
		}

		// ---- success paths --------------------------------------------------

		it("verifies a valid HS256 token + surfaces decoded claims", async () => {
			const ctx = ctxFor();
			const token = await signHs256({ sub: "user-42", role: "admin" });
			const r = await JwtVerifyNode.handle(ctx, {
				token,
				secret: SECRET,
				issuer: ISSUER,
				audience: AUDIENCE,
			});
			expect((r as { success: boolean }).success).toBe(true);
			const data = (r as { data: { claims: Record<string, unknown>; subject?: string; issuer?: string } }).data;
			expect(data.claims.sub).toBe("user-42");
			expect(data.claims.role).toBe("admin");
			expect(data.subject).toBe("user-42");
			expect(data.issuer).toBe(ISSUER);
		});

		it("accepts an array of allowed audiences", async () => {
			const ctx = ctxFor();
			const token = await signHs256({ sub: "u1", aud: "internal-tools" });
			const r = await JwtVerifyNode.handle(ctx, {
				token,
				secret: SECRET,
				audience: ["test-api", "internal-tools"],
				issuer: ISSUER,
			});
			expect((r as { success: boolean }).success).toBe(true);
		});

		it("accepts an array of allowed issuers", async () => {
			const ctx = ctxFor();
			const token = await signHs256({ sub: "u1", iss: "https://other.example.com" });
			const r = await JwtVerifyNode.handle(ctx, {
				token,
				secret: SECRET,
				issuer: ["https://test.example.com", "https://other.example.com"],
				audience: AUDIENCE,
			});
			expect((r as { success: boolean }).success).toBe(true);
		});

		it("respects a custom algorithm allowlist", async () => {
			const ctx = ctxFor();
			const token = await signHs256({ sub: "u1" });
			const r = await JwtVerifyNode.handle(ctx, {
				token,
				secret: SECRET,
				algorithms: ["HS256", "HS384"],
				issuer: ISSUER,
				audience: AUDIENCE,
			});
			expect((r as { success: boolean }).success).toBe(true);
		});

		it("verifies an RS256 token signed with a generated keypair via publicKey", async () => {
			const ctx = ctxFor();
			const { publicKey, privateKey } = await generateKeyPair("RS256");
			const token = await new SignJWT({ sub: "user-rsa" })
				.setProtectedHeader({ alg: "RS256" })
				.setIssuedAt()
				.setIssuer(ISSUER)
				.setAudience(AUDIENCE)
				.setExpirationTime("1h")
				.sign(privateKey);
			const pkPem = await exportSPKI(publicKey);

			const r = await JwtVerifyNode.handle(ctx, {
				token,
				publicKey: pkPem,
				issuer: ISSUER,
				audience: AUDIENCE,
			});
			expect((r as { success: boolean }).success).toBe(true);
			const data = (r as { data: { subject?: string } }).data;
			expect(data.subject).toBe("user-rsa");
		});

		// ---- failure modes (each → 401 with structured reason) ---------------

		async function expectUnauthorized(
			args: Parameters<typeof JwtVerifyNode.handle>[1],
			expectedReason: string,
		): Promise<void> {
			const ctx = ctxFor();
			const r = await JwtVerifyNode.handle(ctx, args);
			expect((r as { success: boolean }).success).toBe(false);
			const errAny = (r as { error: unknown }).error as {
				context?: { code?: number; json?: { reason?: string } };
			};
			expect(errAny?.context?.code).toBe(401);
			expect(errAny?.context?.json?.reason).toBe(expectedReason);
		}

		it("rejects an empty token with reason=missing_token", async () => {
			await expectUnauthorized({ token: "", secret: SECRET }, "missing_token");
		});

		it("rejects a malformed token with reason=malformed_token", async () => {
			await expectUnauthorized({ token: "not.a.real.jwt", secret: SECRET }, "malformed_token");
		});

		it("rejects a token signed with a different secret with reason=invalid_signature", async () => {
			const tokenSignedWithOther = await new SignJWT({ sub: "u1" })
				.setProtectedHeader({ alg: "HS256" })
				.setIssuedAt()
				.setIssuer(ISSUER)
				.setAudience(AUDIENCE)
				.setExpirationTime("1h")
				.sign(new TextEncoder().encode("a-different-secret"));
			await expectUnauthorized(
				{ token: tokenSignedWithOther, secret: SECRET, issuer: ISSUER, audience: AUDIENCE },
				"invalid_signature",
			);
		});

		it("rejects an expired token with reason=token_expired", async () => {
			const ctx = ctxFor();
			const expired = await new SignJWT({ sub: "u1" })
				.setProtectedHeader({ alg: "HS256" })
				.setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
				.setIssuer(ISSUER)
				.setAudience(AUDIENCE)
				.setExpirationTime(Math.floor(Date.now() / 1000) - 60)
				.sign(new TextEncoder().encode(SECRET));
			const r = await JwtVerifyNode.handle(ctx, {
				token: expired,
				secret: SECRET,
				issuer: ISSUER,
				audience: AUDIENCE,
			});
			expect((r as { success: boolean }).success).toBe(false);
			expect((r as { error: { context?: { json?: { reason?: string } } } }).error.context?.json?.reason).toBe(
				"token_expired",
			);
		});

		it("rejects an issuer mismatch with reason=issuer_mismatch", async () => {
			const token = await signHs256({ sub: "u1", iss: "https://wrong.example.com" });
			await expectUnauthorized({ token, secret: SECRET, issuer: ISSUER, audience: AUDIENCE }, "issuer_mismatch");
		});

		it("rejects an audience mismatch with reason=audience_mismatch", async () => {
			const token = await signHs256({ sub: "u1", aud: "wrong-audience" });
			await expectUnauthorized({ token, secret: SECRET, issuer: ISSUER, audience: AUDIENCE }, "audience_mismatch");
		});

		it("rejects when no key source is configured", async () => {
			const ctx = ctxFor();
			const token = await signHs256({ sub: "u1" });
			const r = await JwtVerifyNode.handle(ctx, { token });
			expect((r as { success: boolean }).success).toBe(false);
			// Zod refine fires before the node runs, so this surfaces as a
			// validation error message rather than the structured 401. Either
			// way the call FAILS — the contract is "exactly one key source".
			expect((r as { error: { message: string } }).error.message).toContain("Exactly one of");
		});

		it("rejects when multiple key sources are configured (refine)", async () => {
			const ctx = ctxFor();
			const token = await signHs256({ sub: "u1" });
			const r = await JwtVerifyNode.handle(ctx, {
				token,
				secret: SECRET,
				publicKey: "irrelevant",
			});
			expect((r as { success: boolean }).success).toBe(false);
			expect((r as { error: { message: string } }).error.message).toContain("Exactly one of");
		});

		it("rejects an HS256 token when the allowlist requires RS256", async () => {
			const token = await signHs256({ sub: "u1" });
			await expectUnauthorized(
				{
					token,
					secret: SECRET,
					algorithms: ["RS256"],
					issuer: ISSUER,
					audience: AUDIENCE,
				},
				"algorithm_not_allowed",
			);
		});

		it("populates convenience aliases (subject/issuer/audience/expiresAt) from the verified payload", async () => {
			const ctx = ctxFor();
			const token = await signHs256({ sub: "alice", role: "ops" });
			const r = await JwtVerifyNode.handle(ctx, {
				token,
				secret: SECRET,
				issuer: ISSUER,
				audience: AUDIENCE,
			});
			const data = (
				r as {
					data: {
						subject?: string;
						issuer?: string;
						audience?: string | string[];
						expiresAt?: number;
					};
				}
			).data;
			expect(data.subject).toBe("alice");
			expect(data.issuer).toBe(ISSUER);
			expect(data.audience).toBe(AUDIENCE);
			expect(typeof data.expiresAt).toBe("number");
			expect(data.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
		});
	});

	// ====================================================================
	// @blokjs/redis-kv — production KV helper backed by ioredis
	// ====================================================================
	//
	// Tests are gated on REDIS_URL because they hit a real Redis. Local
	// dev: `docker run -p 6379:6379 redis:7` then `REDIS_URL=redis://
	// localhost:6379 bun run --filter @blokjs/helpers test`. CI runners
	// without Redis simply skip — no fake-server dance, no mocks. The
	// node's own protection lives at the boundary (dynamic ioredis
	// import, REDIS_URL default), so the skip just means we don't
	// exercise the round-trip; the unit-shape tests below run
	// regardless to keep schema regressions detectable.
	const REDIS_URL = process.env.REDIS_URL;
	const redisDescribe = REDIS_URL !== undefined ? describe : describe.skip;

	redisDescribe("@blokjs/redis-kv (live, REDIS_URL set)", () => {
		const KEY_PREFIX = `blok:test:${process.pid}:`;

		afterEach(async () => {
			// Clean up any keys this test wrote so subsequent runs against
			// a long-lived Redis don't see stale state.
			const ctx = ctxFor();
			const r = await RedisKvNode.handle(ctx, { action: "list", prefix: KEY_PREFIX });
			const data = (r as { data?: { entries?: { key: string }[] } }).data;
			const entries = data?.entries ?? [];
			for (const { key } of entries) {
				await RedisKvNode.handle(ctx, { action: "delete", key });
			}
		});

		afterAll(async () => {
			await _teardownRedisForTests();
		});

		it("set then get round-trips a JSON-encoded value", async () => {
			const ctx = ctxFor();
			const key = `${KEY_PREFIX}round-trip`;
			await RedisKvNode.handle(ctx, { action: "set", key, value: { name: "Alice", count: 7 } });
			const got = await RedisKvNode.handle(ctx, { action: "get", key });
			const data = (got as { data: { exists: boolean; value: unknown } }).data;
			expect(data.exists).toBe(true);
			expect(data.value).toEqual({ name: "Alice", count: 7 });
		});

		it("get on a missing key reports exists=false", async () => {
			const ctx = ctxFor();
			const r = await RedisKvNode.handle(ctx, { action: "get", key: `${KEY_PREFIX}nope` });
			const data = (r as { data: { exists: boolean; value?: unknown } }).data;
			expect(data.exists).toBe(false);
			expect(data.value).toBeUndefined();
		});

		it("delete removes the entry", async () => {
			const ctx = ctxFor();
			const key = `${KEY_PREFIX}to-delete`;
			await RedisKvNode.handle(ctx, { action: "set", key, value: 1 });
			const del = await RedisKvNode.handle(ctx, { action: "delete", key });
			expect((del as { data: { deleted: boolean } }).data.deleted).toBe(true);
			const get = await RedisKvNode.handle(ctx, { action: "get", key });
			expect((get as { data: { exists: boolean } }).data.exists).toBe(false);
		});

		it("ttlMs causes the key to expire", async () => {
			const ctx = ctxFor();
			const key = `${KEY_PREFIX}ttl`;
			await RedisKvNode.handle(ctx, { action: "set", key, value: { x: 1 }, ttlMs: 50 });
			const before = await RedisKvNode.handle(ctx, { action: "get", key });
			expect((before as { data: { exists: boolean } }).data.exists).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const after = await RedisKvNode.handle(ctx, { action: "get", key });
			expect((after as { data: { exists: boolean } }).data.exists).toBe(false);
		});

		it("list with prefix filters via SCAN MATCH", async () => {
			const ctx = ctxFor();
			await RedisKvNode.handle(ctx, { action: "set", key: `${KEY_PREFIX}a`, value: 1 });
			await RedisKvNode.handle(ctx, { action: "set", key: `${KEY_PREFIX}b`, value: 2 });
			const r = await RedisKvNode.handle(ctx, { action: "list", prefix: KEY_PREFIX });
			const entries = (r as { data: { entries: { key: string; value: unknown }[] } }).data.entries;
			expect(entries.length).toBeGreaterThanOrEqual(2);
			const keys = entries.map((e) => e.key).sort();
			expect(keys).toContain(`${KEY_PREFIX}a`);
			expect(keys).toContain(`${KEY_PREFIX}b`);
		});
	});

	// ====================================================================
	// @blokjs/hmac-verify — webhook signature verification
	// ====================================================================
	describe("@blokjs/hmac-verify", () => {
		const SECRET = "webhook-secret-for-tests";

		// Helper — sign a payload the same way the verifier expects
		// supplies us. Mirrors how a real webhook provider signs the
		// outgoing payload before sending; the helper just verifies what
		// they computed using the same algo + key.
		function sign(payload: string, secret = SECRET, algorithm = "sha256"): string {
			return createHmac(algorithm, secret).update(payload).digest("hex");
		}

		// ---- success path ---------------------------------------------------

		it("verifies a valid HMAC-SHA256 signature with no prefix", async () => {
			const ctx = ctxFor();
			const payload = '{"event":"push","repo":"acme/widgets"}';
			const signature = sign(payload);
			const r = await HmacVerifyNode.handle(ctx, { signature, payload, secret: SECRET });
			expect((r as { success: boolean }).success).toBe(true);
			const data = (r as { data: { verified: boolean; algorithm: string; signatureLength: number } }).data;
			expect(data.verified).toBe(true);
			expect(data.algorithm).toBe("sha256");
			expect(data.signatureLength).toBe(64); // sha256 hex = 64 chars
		});

		it("verifies with a prefix (GitHub X-Hub-Signature-256 shape)", async () => {
			const ctx = ctxFor();
			const payload = '{"hello":"world"}';
			const signature = `sha256=${sign(payload)}`;
			const r = await HmacVerifyNode.handle(ctx, {
				signature,
				payload,
				secret: SECRET,
				prefix: "sha256=",
			});
			expect((r as { success: boolean }).success).toBe(true);
		});

		it("verifies with sha512 when explicitly chosen", async () => {
			const ctx = ctxFor();
			const payload = "high-security-payload";
			const signature = sign(payload, SECRET, "sha512");
			const r = await HmacVerifyNode.handle(ctx, {
				signature,
				payload,
				secret: SECRET,
				algorithm: "sha512",
			});
			expect((r as { success: boolean }).success).toBe(true);
			expect((r as { data: { algorithm: string; signatureLength: number } }).data.algorithm).toBe("sha512");
			expect((r as { data: { signatureLength: number } }).data.signatureLength).toBe(128); // sha512 hex = 128
		});

		// ---- failure modes (each → 401 with structured reason) -------------

		async function expectUnauthorized(
			args: Parameters<typeof HmacVerifyNode.handle>[1],
			expectedReason: string,
		): Promise<void> {
			const ctx = ctxFor();
			const r = await HmacVerifyNode.handle(ctx, args);
			expect((r as { success: boolean }).success).toBe(false);
			const errAny = (r as { error: unknown }).error as {
				context?: { code?: number; json?: { reason?: string } };
			};
			expect(errAny?.context?.code).toBe(401);
			expect(errAny?.context?.json?.reason).toBe(expectedReason);
		}

		it("rejects empty signature with reason=missing_signature", async () => {
			await expectUnauthorized({ signature: "", payload: "{}", secret: SECRET }, "missing_signature");
		});

		it("rejects empty secret with reason=misconfigured", async () => {
			await expectUnauthorized({ signature: "deadbeef", payload: "{}", secret: "" }, "misconfigured");
		});

		it("rejects signature missing the configured prefix with reason=malformed_signature", async () => {
			const payload = "{}";
			const sigWithoutPrefix = sign(payload); // no 'sha256=' prefix
			await expectUnauthorized(
				{ signature: sigWithoutPrefix, payload, secret: SECRET, prefix: "sha256=" },
				"malformed_signature",
			);
		});

		it("rejects signature with wrong length (e.g. sha1 supplied when sha256 expected)", async () => {
			const payload = "{}";
			const sha1 = sign(payload, SECRET, "sha1"); // 40 hex chars
			// Default algorithm is sha256 → 64 hex; length mismatch fires first.
			await expectUnauthorized({ signature: sha1, payload, secret: SECRET }, "invalid_signature");
		});

		it("rejects non-hex signature with reason=invalid_signature", async () => {
			const payload = "{}";
			// 64 chars but contains 'g' (not a hex digit)
			const garbage = "g".repeat(64);
			await expectUnauthorized({ signature: garbage, payload, secret: SECRET }, "invalid_signature");
		});

		it("rejects when payload was tampered (signature was for different content)", async () => {
			const ctx = ctxFor();
			const originalPayload = '{"action":"push"}';
			const signature = sign(originalPayload);
			const tamperedPayload = '{"action":"delete-everything"}';
			const r = await HmacVerifyNode.handle(ctx, {
				signature,
				payload: tamperedPayload,
				secret: SECRET,
			});
			expect((r as { success: boolean }).success).toBe(false);
			const errAny = (r as { error: { context?: { json?: { reason?: string } } } }).error;
			expect(errAny.context?.json?.reason).toBe("invalid_signature");
		});

		it("rejects when secret is wrong (attacker doesn't have the shared secret)", async () => {
			const payload = '{"event":"push"}';
			const signatureWithAttackerSecret = sign(payload, "attacker-guessed-secret");
			await expectUnauthorized(
				{ signature: signatureWithAttackerSecret, payload, secret: SECRET },
				"invalid_signature",
			);
		});
	});
});
