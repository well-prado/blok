/**
 * Authentication Middleware for Blok Triggers
 *
 * @deprecated Since v0.4.1. Will be removed in v0.5. This class ships as
 * example-grade code (HS256-only JWT verification, no JWKS, no key
 * rotation, non-constant-time API-key lookup) and is not wired into any
 * trigger. Production deployments should compose auth from a hardened
 * library (`jose`, `hono/jwt`, `node-jsonwebtoken`) at the trigger or
 * workflow layer instead. See `docs/d/security/cookbook.mdx` for the
 * recommended patterns.
 *
 * @example
 * ```typescript
 * // Recommended (jose):
 * import { jwtVerify } from "jose";
 * const { payload } = await jwtVerify(token, secret, { issuer, audience });
 * ```
 */

import { createHmac, timingSafeEqual } from "node:crypto";

let authMiddlewareWarningEmitted = false;
function emitAuthMiddlewareDeprecationWarning(): void {
	if (authMiddlewareWarningEmitted) return;
	authMiddlewareWarningEmitted = true;
	if (process.env.BLOK_SUPPRESS_AUTHMIDDLEWARE_WARNING === "1") return;
	console.warn(
		"[blok] AuthMiddleware (and JWTAuthProvider, APIKeyAuthProvider) is deprecated and will be removed in v0.5. " +
			"It ships as example-grade code, not production auth. " +
			"Use `jose`, `hono/jwt`, or `node-jsonwebtoken` at the trigger or workflow layer instead. " +
			"See docs/d/security/cookbook.mdx. " +
			"Set BLOK_SUPPRESS_AUTHMIDDLEWARE_WARNING=1 to silence.",
	);
}

export interface AuthIdentity {
	/** Unique identifier for the authenticated entity */
	sub: string;
	/** Display name */
	name?: string;
	/** Email address */
	email?: string;
	/** Assigned roles */
	roles: string[];
	/** Additional claims/metadata */
	claims: Record<string, unknown>;
	/** Authentication provider that verified this identity */
	provider: string;
	/** When the token/key was issued */
	issuedAt?: number;
	/** When the token/key expires */
	expiresAt?: number;
}

export interface AuthRequest {
	headers: Record<string, string | string[] | undefined>;
	query?: Record<string, string | string[] | undefined>;
	path?: string;
	method?: string;
}

export interface AuthResult {
	authenticated: boolean;
	identity?: AuthIdentity;
	error?: string;
	statusCode?: number;
}

/**
 * Base interface for authentication providers
 */
export interface AuthProvider {
	/** Unique name for this provider */
	readonly name: string;
	/** Try to authenticate the request */
	authenticate(request: AuthRequest): Promise<AuthResult>;
}

export interface AuthMiddlewareConfig {
	/** Authentication providers to use (tried in order) */
	providers: AuthProvider[];
	/** Paths to exclude from authentication (e.g., ["/health-check", "/metrics"]) */
	excludePaths?: string[];
	/** Whether authentication is required (default: true) */
	required?: boolean;
	/** Custom error handler */
	onAuthFailure?: (result: AuthResult, request: AuthRequest) => void;
}

/**
 * @deprecated Since v0.4.1. See file-level JSDoc; will be removed in v0.5.
 */
export class AuthMiddleware {
	private config: AuthMiddlewareConfig;

	constructor(config: AuthMiddlewareConfig) {
		this.config = {
			excludePaths: ["/health-check", "/metrics", "/health", "/liveness", "/readiness"],
			required: true,
			...config,
		};
		emitAuthMiddlewareDeprecationWarning();
	}

	/**
	 * Authenticate a request against all registered providers.
	 * Returns the first successful authentication result.
	 */
	async authenticate(request: AuthRequest): Promise<AuthResult> {
		// Check excluded paths
		if (request.path && this.isExcludedPath(request.path)) {
			return {
				authenticated: true,
				identity: {
					sub: "anonymous",
					roles: ["public"],
					claims: {},
					provider: "excluded-path",
				},
			};
		}

		// Try each provider in order
		for (const provider of this.config.providers) {
			const result = await provider.authenticate(request);
			if (result.authenticated) {
				return result;
			}
		}

		// No provider authenticated the request
		if (!this.config.required) {
			return {
				authenticated: true,
				identity: {
					sub: "anonymous",
					roles: ["public"],
					claims: {},
					provider: "anonymous",
				},
			};
		}

		const result: AuthResult = {
			authenticated: false,
			error: "Authentication required",
			statusCode: 401,
		};

		if (this.config.onAuthFailure) {
			this.config.onAuthFailure(result, request);
		}

		return result;
	}

	/**
	 * Express-compatible middleware function
	 */
	expressMiddleware() {
		return async (
			req: {
				headers: Record<string, string>;
				query: Record<string, string>;
				path: string;
				method: string;
				auth?: AuthIdentity;
			},
			res: { status: (code: number) => { json: (body: unknown) => void } },
			next: () => void,
		) => {
			const result = await this.authenticate({
				headers: req.headers,
				query: req.query,
				path: req.path,
				method: req.method,
			});

			if (!result.authenticated) {
				res.status(result.statusCode || 401).json({
					error: result.error || "Unauthorized",
				});
				return;
			}

			// Attach identity to request
			req.auth = result.identity;
			next();
		};
	}

	private isExcludedPath(path: string): boolean {
		return (this.config.excludePaths || []).some((excluded) => path === excluded || path.startsWith(`${excluded}/`));
	}
}

/**
 * JWT Authentication Provider
 *
 * Verifies JWT tokens from the Authorization: Bearer header.
 * Supports HS256 (shared secret) out of the box.
 */
export interface JWTAuthProviderConfig {
	/** Secret key for HS256 verification */
	secret: string;
	/** Expected issuer (iss claim) */
	issuer?: string;
	/** Expected audience (aud claim) */
	audience?: string;
	/** Header name to read token from (default: "authorization") */
	headerName?: string;
	/** Clock tolerance in seconds for exp/nbf validation (default: 30) */
	clockToleranceSec?: number;
	/** Map JWT claims to roles (claim name → role mapping function) */
	rolesClaim?: string;
}

/**
 * @deprecated Since v0.4.1. See file-level JSDoc; will be removed in v0.5.
 */
export class JWTAuthProvider implements AuthProvider {
	readonly name = "jwt";
	private config: JWTAuthProviderConfig;

	constructor(config: JWTAuthProviderConfig) {
		this.config = {
			headerName: "authorization",
			clockToleranceSec: 30,
			rolesClaim: "roles",
			...config,
		};
		emitAuthMiddlewareDeprecationWarning();
	}

	async authenticate(request: AuthRequest): Promise<AuthResult> {
		const headerValue = request.headers[this.config.headerName || "authorization"];
		if (!headerValue) {
			return { authenticated: false, error: "No authorization header" };
		}

		const token = String(headerValue).replace(/^Bearer\s+/i, "");
		if (!token || token === String(headerValue)) {
			return { authenticated: false, error: "Invalid Bearer token format" };
		}

		try {
			const payload = this.verifyToken(token);
			if (!payload) {
				return { authenticated: false, error: "Invalid token signature", statusCode: 401 };
			}

			// Validate expiry
			const now = Math.floor(Date.now() / 1000);
			const tolerance = this.config.clockToleranceSec || 30;

			const exp = typeof payload.exp === "number" ? payload.exp : undefined;
			const nbf = typeof payload.nbf === "number" ? payload.nbf : undefined;

			if (exp && exp + tolerance < now) {
				return { authenticated: false, error: "Token expired", statusCode: 401 };
			}

			if (nbf && nbf - tolerance > now) {
				return { authenticated: false, error: "Token not yet valid", statusCode: 401 };
			}

			// Validate issuer
			if (this.config.issuer && payload.iss !== this.config.issuer) {
				return { authenticated: false, error: "Invalid token issuer", statusCode: 401 };
			}

			// Validate audience
			if (this.config.audience) {
				const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
				if (!aud.includes(this.config.audience)) {
					return { authenticated: false, error: "Invalid token audience", statusCode: 401 };
				}
			}

			// Extract roles
			const rolesClaim = this.config.rolesClaim || "roles";
			const roles = Array.isArray(payload[rolesClaim])
				? (payload[rolesClaim] as string[])
				: typeof payload[rolesClaim] === "string"
					? [payload[rolesClaim] as string]
					: [];

			const iat = typeof payload.iat === "number" ? payload.iat : undefined;

			return {
				authenticated: true,
				identity: {
					sub: typeof payload.sub === "string" ? payload.sub : "unknown",
					name: payload.name as string | undefined,
					email: payload.email as string | undefined,
					roles,
					claims: payload,
					provider: "jwt",
					issuedAt: iat,
					expiresAt: exp,
				},
			};
		} catch (err) {
			return {
				authenticated: false,
				error: `Token verification failed: ${err instanceof Error ? err.message : String(err)}`,
				statusCode: 401,
			};
		}
	}

	/**
	 * Verify JWT token using HS256
	 */
	private verifyToken(token: string): Record<string, unknown> | null {
		const parts = token.split(".");
		if (parts.length !== 3) return null;

		const [headerB64, payloadB64, signatureB64] = parts;

		// Verify signature (HS256)
		const expectedSignature = createHmac("sha256", this.config.secret)
			.update(`${headerB64}.${payloadB64}`)
			.digest("base64url");

		const signatureBuffer = Buffer.from(signatureB64, "base64url");
		const expectedBuffer = Buffer.from(expectedSignature, "base64url");

		if (signatureBuffer.length !== expectedBuffer.length) return null;
		if (!timingSafeEqual(signatureBuffer, expectedBuffer)) return null;

		// Decode payload
		try {
			const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8"));
			return payload;
		} catch {
			return null;
		}
	}
}

/**
 * API Key Authentication Provider
 *
 * Verifies API keys from headers or query parameters.
 */
export interface APIKeyInfo {
	/** Name/label for this API key */
	name: string;
	/** Roles assigned to this key */
	roles: string[];
	/** Additional metadata */
	metadata?: Record<string, unknown>;
	/** Expiration timestamp (Unix seconds) */
	expiresAt?: number;
}

export interface APIKeyAuthProviderConfig {
	/** Map of API key → key info */
	keys: Map<string, APIKeyInfo>;
	/** Header name to read key from (default: "x-api-key") */
	headerName?: string;
	/** Query parameter name to read key from (default: "api_key") */
	queryParam?: string;
	/** Custom key validation function (e.g., for database lookups) */
	validate?: (key: string) => Promise<APIKeyInfo | null>;
}

/**
 * @deprecated Since v0.4.1. See file-level JSDoc; will be removed in v0.5.
 */
export class APIKeyAuthProvider implements AuthProvider {
	readonly name = "api-key";
	private config: APIKeyAuthProviderConfig;

	constructor(config: APIKeyAuthProviderConfig) {
		this.config = {
			headerName: "x-api-key",
			queryParam: "api_key",
			...config,
		};
		emitAuthMiddlewareDeprecationWarning();
	}

	async authenticate(request: AuthRequest): Promise<AuthResult> {
		// Try header first
		let apiKey = request.headers[this.config.headerName || "x-api-key"];
		if (Array.isArray(apiKey)) apiKey = apiKey[0];

		// Then try query param
		if (!apiKey && request.query) {
			let queryKey = request.query[this.config.queryParam || "api_key"];
			if (Array.isArray(queryKey)) queryKey = queryKey[0];
			apiKey = queryKey;
		}

		if (!apiKey) {
			return { authenticated: false, error: "No API key provided" };
		}

		// Try custom validator first
		if (this.config.validate) {
			const info = await this.config.validate(apiKey);
			if (info) {
				return this.buildResult(apiKey, info);
			}
			return { authenticated: false, error: "Invalid API key", statusCode: 401 };
		}

		// Check static keys
		const info = this.config.keys.get(apiKey);
		if (!info) {
			return { authenticated: false, error: "Invalid API key", statusCode: 401 };
		}

		return this.buildResult(apiKey, info);
	}

	private buildResult(key: string, info: APIKeyInfo): AuthResult {
		// Check expiry
		if (info.expiresAt && info.expiresAt < Math.floor(Date.now() / 1000)) {
			return { authenticated: false, error: "API key expired", statusCode: 401 };
		}

		return {
			authenticated: true,
			identity: {
				sub: info.name,
				name: info.name,
				roles: info.roles,
				claims: info.metadata || {},
				provider: "api-key",
				expiresAt: info.expiresAt,
			},
		};
	}
}
