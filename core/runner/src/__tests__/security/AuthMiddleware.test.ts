import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	APIKeyAuthProvider,
	type APIKeyInfo,
	AuthMiddleware,
	type AuthRequest,
	JWTAuthProvider,
} from "../../security/AuthMiddleware";

// Helper: create a valid JWT token
function createJWT(payload: Record<string, unknown>, secret: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
	return `${header}.${body}.${signature}`;
}

describe("JWTAuthProvider", () => {
	const secret = "test-secret-key-for-hmac-256";

	it("should authenticate valid JWT token", async () => {
		const provider = new JWTAuthProvider({ secret });

		const token = createJWT(
			{
				sub: "user-123",
				name: "Test User",
				email: "test@example.com",
				roles: ["admin"],
				iat: Math.floor(Date.now() / 1000),
				exp: Math.floor(Date.now() / 1000) + 3600,
			},
			secret,
		);

		const result = await provider.authenticate({
			headers: { authorization: `Bearer ${token}` },
		});

		expect(result.authenticated).toBe(true);
		expect(result.identity?.sub).toBe("user-123");
		expect(result.identity?.name).toBe("Test User");
		expect(result.identity?.email).toBe("test@example.com");
		expect(result.identity?.roles).toEqual(["admin"]);
		expect(result.identity?.provider).toBe("jwt");
	});

	it("should reject expired JWT token", async () => {
		const provider = new JWTAuthProvider({ secret, clockToleranceSec: 0 });

		const token = createJWT(
			{
				sub: "user-123",
				exp: Math.floor(Date.now() / 1000) - 100,
			},
			secret,
		);

		const result = await provider.authenticate({
			headers: { authorization: `Bearer ${token}` },
		});

		expect(result.authenticated).toBe(false);
		expect(result.error).toContain("expired");
	});

	it("should reject token with invalid signature", async () => {
		const provider = new JWTAuthProvider({ secret });

		const token = createJWT({ sub: "user-123", exp: Math.floor(Date.now() / 1000) + 3600 }, "wrong-secret");

		const result = await provider.authenticate({
			headers: { authorization: `Bearer ${token}` },
		});

		expect(result.authenticated).toBe(false);
		expect(result.error).toContain("Invalid token signature");
	});

	it("should reject request without authorization header", async () => {
		const provider = new JWTAuthProvider({ secret });

		const result = await provider.authenticate({
			headers: {},
		});

		expect(result.authenticated).toBe(false);
		expect(result.error).toContain("No authorization header");
	});

	it("should reject non-Bearer token format", async () => {
		const provider = new JWTAuthProvider({ secret });

		const result = await provider.authenticate({
			headers: { authorization: "Basic dXNlcjpwYXNz" },
		});

		expect(result.authenticated).toBe(false);
		expect(result.error).toContain("Invalid Bearer token");
	});

	it("should validate issuer when configured", async () => {
		const provider = new JWTAuthProvider({ secret, issuer: "blok-auth" });

		const validToken = createJWT(
			{
				sub: "user-123",
				iss: "blok-auth",
				exp: Math.floor(Date.now() / 1000) + 3600,
			},
			secret,
		);

		const invalidToken = createJWT(
			{
				sub: "user-123",
				iss: "other-issuer",
				exp: Math.floor(Date.now() / 1000) + 3600,
			},
			secret,
		);

		const validResult = await provider.authenticate({
			headers: { authorization: `Bearer ${validToken}` },
		});
		const invalidResult = await provider.authenticate({
			headers: { authorization: `Bearer ${invalidToken}` },
		});

		expect(validResult.authenticated).toBe(true);
		expect(invalidResult.authenticated).toBe(false);
		expect(invalidResult.error).toContain("issuer");
	});

	it("should validate audience when configured", async () => {
		const provider = new JWTAuthProvider({ secret, audience: "blok-api" });

		const validToken = createJWT(
			{
				sub: "user-123",
				aud: "blok-api",
				exp: Math.floor(Date.now() / 1000) + 3600,
			},
			secret,
		);

		const result = await provider.authenticate({
			headers: { authorization: `Bearer ${validToken}` },
		});

		expect(result.authenticated).toBe(true);
	});

	it("should extract roles from custom claim", async () => {
		const provider = new JWTAuthProvider({ secret, rolesClaim: "permissions" });

		const token = createJWT(
			{
				sub: "user-123",
				permissions: ["read", "write"],
				exp: Math.floor(Date.now() / 1000) + 3600,
			},
			secret,
		);

		const result = await provider.authenticate({
			headers: { authorization: `Bearer ${token}` },
		});

		expect(result.authenticated).toBe(true);
		expect(result.identity?.roles).toEqual(["read", "write"]);
	});

	it("should handle malformed JWT gracefully", async () => {
		const provider = new JWTAuthProvider({ secret });

		const result = await provider.authenticate({
			headers: { authorization: "Bearer not.a.valid.jwt" },
		});

		expect(result.authenticated).toBe(false);
	});
});

describe("APIKeyAuthProvider", () => {
	it("should authenticate valid API key from header", async () => {
		const keys = new Map<string, APIKeyInfo>([["test-key-123", { name: "test-service", roles: ["admin"] }]]);

		const provider = new APIKeyAuthProvider({ keys });

		const result = await provider.authenticate({
			headers: { "x-api-key": "test-key-123" },
		});

		expect(result.authenticated).toBe(true);
		expect(result.identity?.sub).toBe("test-service");
		expect(result.identity?.roles).toEqual(["admin"]);
		expect(result.identity?.provider).toBe("api-key");
	});

	it("should authenticate from query parameter", async () => {
		const keys = new Map<string, APIKeyInfo>([["query-key", { name: "query-svc", roles: ["viewer"] }]]);

		const provider = new APIKeyAuthProvider({ keys });

		const result = await provider.authenticate({
			headers: {},
			query: { api_key: "query-key" },
		});

		expect(result.authenticated).toBe(true);
		expect(result.identity?.sub).toBe("query-svc");
	});

	it("should reject invalid API key", async () => {
		const keys = new Map<string, APIKeyInfo>([["valid-key", { name: "svc", roles: [] }]]);

		const provider = new APIKeyAuthProvider({ keys });

		const result = await provider.authenticate({
			headers: { "x-api-key": "invalid-key" },
		});

		expect(result.authenticated).toBe(false);
		expect(result.error).toContain("Invalid API key");
	});

	it("should reject expired API key", async () => {
		const keys = new Map<string, APIKeyInfo>([
			[
				"expired-key",
				{
					name: "svc",
					roles: [],
					expiresAt: Math.floor(Date.now() / 1000) - 100,
				},
			],
		]);

		const provider = new APIKeyAuthProvider({ keys });

		const result = await provider.authenticate({
			headers: { "x-api-key": "expired-key" },
		});

		expect(result.authenticated).toBe(false);
		expect(result.error).toContain("expired");
	});

	it("should use custom header name", async () => {
		const keys = new Map<string, APIKeyInfo>([["custom-key", { name: "svc", roles: [] }]]);

		const provider = new APIKeyAuthProvider({
			keys,
			headerName: "x-custom-auth",
		});

		const result = await provider.authenticate({
			headers: { "x-custom-auth": "custom-key" },
		});

		expect(result.authenticated).toBe(true);
	});

	it("should support custom validate function", async () => {
		const provider = new APIKeyAuthProvider({
			keys: new Map(),
			validate: async (key: string) => {
				if (key === "dynamic-key") {
					return { name: "dynamic-svc", roles: ["service"] };
				}
				return null;
			},
		});

		const validResult = await provider.authenticate({
			headers: { "x-api-key": "dynamic-key" },
		});
		const invalidResult = await provider.authenticate({
			headers: { "x-api-key": "nope" },
		});

		expect(validResult.authenticated).toBe(true);
		expect(invalidResult.authenticated).toBe(false);
	});

	it("should reject when no key provided", async () => {
		const provider = new APIKeyAuthProvider({ keys: new Map() });

		const result = await provider.authenticate({ headers: {} });

		expect(result.authenticated).toBe(false);
		expect(result.error).toContain("No API key");
	});
});

describe("AuthMiddleware", () => {
	const secret = "test-secret-key-for-hmac-256";

	it("should try providers in order", async () => {
		const keys = new Map<string, APIKeyInfo>([["my-key", { name: "api-svc", roles: ["service"] }]]);

		const middleware = new AuthMiddleware({
			providers: [new JWTAuthProvider({ secret }), new APIKeyAuthProvider({ keys })],
		});

		const result = await middleware.authenticate({
			headers: { "x-api-key": "my-key" },
		});

		expect(result.authenticated).toBe(true);
		expect(result.identity?.provider).toBe("api-key");
	});

	it("should skip excluded paths", async () => {
		const middleware = new AuthMiddleware({
			providers: [],
			excludePaths: ["/health-check"],
		});

		const result = await middleware.authenticate({
			headers: {},
			path: "/health-check",
		});

		expect(result.authenticated).toBe(true);
		expect(result.identity?.provider).toBe("excluded-path");
	});

	it("should allow anonymous when not required", async () => {
		const middleware = new AuthMiddleware({
			providers: [],
			required: false,
		});

		const result = await middleware.authenticate({
			headers: {},
			path: "/some-endpoint",
		});

		expect(result.authenticated).toBe(true);
		expect(result.identity?.sub).toBe("anonymous");
		expect(result.identity?.provider).toBe("anonymous");
	});

	it("should reject when required and no provider matches", async () => {
		const middleware = new AuthMiddleware({
			providers: [new JWTAuthProvider({ secret })],
			required: true,
		});

		const result = await middleware.authenticate({
			headers: {},
			path: "/api/data",
		});

		expect(result.authenticated).toBe(false);
		expect(result.statusCode).toBe(401);
	});

	it("should call onAuthFailure callback", async () => {
		const onFailure = vi.fn();

		const middleware = new AuthMiddleware({
			providers: [],
			required: true,
			onAuthFailure: onFailure,
		});

		await middleware.authenticate({
			headers: {},
			path: "/protected",
		});

		expect(onFailure).toHaveBeenCalledOnce();
	});

	it("should provide Express-compatible middleware", async () => {
		const keys = new Map<string, APIKeyInfo>([["my-key", { name: "svc", roles: ["admin"] }]]);

		const middleware = new AuthMiddleware({
			providers: [new APIKeyAuthProvider({ keys })],
		});

		const expressMiddleware = middleware.expressMiddleware();

		// Test successful auth
		const req: any = {
			headers: { "x-api-key": "my-key" },
			query: {},
			path: "/api/data",
			method: "GET",
		};
		const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
		const next = vi.fn();

		await expressMiddleware(req, res, next);

		expect(next).toHaveBeenCalled();
		expect(req.auth).toBeDefined();
		expect(req.auth.sub).toBe("svc");
	});

	it("should reject in Express middleware when unauthenticated", async () => {
		const middleware = new AuthMiddleware({
			providers: [],
			required: true,
		});

		const expressMiddleware = middleware.expressMiddleware();

		const req: any = {
			headers: {},
			query: {},
			path: "/api/data",
			method: "GET",
		};
		const jsonMock = vi.fn();
		const res: any = { status: vi.fn().mockReturnValue({ json: jsonMock }) };
		const next = vi.fn();

		await expressMiddleware(req, res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(401);
	});
});
