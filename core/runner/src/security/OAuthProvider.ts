/**
 * OAuth 2.0 / OpenID Connect Authentication Provider for Blok
 *
 * Provides standards-compliant OIDC authentication with:
 * - OIDC Discovery (/.well-known/openid-configuration)
 * - JWKS-based public key retrieval and caching
 * - JWT verification using RS256 (RSA) and ES256 (ECDSA) via Node.js crypto
 * - Token claims validation (exp, nbf, iss, aud)
 * - Token introspection for opaque tokens (RFC 7662)
 * - LRU token cache with TTL-based expiry
 *
 * Uses only Node.js built-in modules (node:crypto, node:buffer).
 * No external JWT libraries required.
 *
 * @example
 * ```typescript
 * const oidcProvider = new OAuthOIDCProvider({
 *   issuerUrl: "https://auth.example.com",
 *   clientId: "my-app",
 *   audience: "https://api.example.com",
 * });
 *
 * const auth = new AuthMiddleware({
 *   providers: [oidcProvider],
 * });
 * ```
 */

import { createHash, createPublicKey, createVerify, type KeyObject } from "node:crypto";
import { Buffer } from "node:buffer";

import type { AuthProvider, AuthRequest, AuthResult, AuthIdentity } from "./AuthMiddleware";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the OAuth 2.0 / OIDC authentication provider
 */
export interface OAuthOIDCConfig {
	/** OIDC issuer URL (e.g. "https://auth.example.com") */
	issuerUrl: string;
	/** OAuth 2.0 client ID */
	clientId: string;
	/** OAuth 2.0 client secret (required for token introspection) */
	clientSecret?: string;
	/** Expected audience claim value */
	audience?: string;
	/** Allowed JWT signing algorithms (default: ["RS256", "ES256"]) */
	allowedAlgorithms?: string[];
	/** JWKS URI override (auto-discovered from OIDC metadata when omitted) */
	jwksUri?: string;
	/** JWT claim that contains user roles (default: "roles") */
	rolesClaim?: string;
	/** JWT claim that contains scopes (default: "scope") */
	scopesClaim?: string;
	/** Clock skew tolerance in seconds for exp/nbf checks (default: 30) */
	clockToleranceSec?: number;
	/** Whether to cache the JWKS key set (default: true) */
	cacheJWKS?: boolean;
	/** Whether to cache the OIDC discovery document (default: true) */
	cacheDiscovery?: boolean;
	/** Token introspection endpoint override (auto-discovered when omitted) */
	introspectionEndpoint?: string;
}

// ---------------------------------------------------------------------------
// OIDC Discovery types
// ---------------------------------------------------------------------------

/**
 * OpenID Connect Discovery document as defined in the OIDC specification
 *
 * @see https://openid.net/specs/openid-connect-discovery-1_0.html
 */
export interface OIDCDiscoveryDocument {
	/** Issuer identifier */
	issuer: string;
	/** URL of the authorization endpoint */
	authorization_endpoint: string;
	/** URL of the token endpoint */
	token_endpoint: string;
	/** URL of the userinfo endpoint */
	userinfo_endpoint: string;
	/** URL of the JWKS endpoint */
	jwks_uri: string;
	/** Supported OAuth 2.0 scopes */
	scopes_supported: string[];
	/** Supported OAuth 2.0 response types */
	response_types_supported: string[];
	/** Supported OpenID Connect claims */
	claims_supported: string[];
	/** Token introspection endpoint (optional, RFC 7662) */
	introspection_endpoint?: string;
	/** Additional fields that may appear in the discovery document */
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// JSON Web Key Set types
// ---------------------------------------------------------------------------

/**
 * JSON Web Key as defined in RFC 7517
 */
export interface JWK {
	/** Key type (e.g. "RSA", "EC") */
	kty: string;
	/** Key ID */
	kid: string;
	/** Key usage (e.g. "sig") */
	use?: string;
	/** Algorithm (e.g. "RS256", "ES256") */
	alg?: string;
	/** RSA modulus (base64url-encoded) */
	n?: string;
	/** RSA exponent (base64url-encoded) */
	e?: string;
	/** EC x-coordinate (base64url-encoded) */
	x?: string;
	/** EC y-coordinate (base64url-encoded) */
	y?: string;
	/** EC curve name (e.g. "P-256") */
	crv?: string;
}

/**
 * JSON Web Key Set as defined in RFC 7517
 */
export interface JWKS {
	/** Array of JSON Web Keys */
	keys: JWK[];
}

// ---------------------------------------------------------------------------
// JWT internal types
// ---------------------------------------------------------------------------

/** Decoded JWT header */
interface JWTHeader {
	alg: string;
	kid?: string;
	typ?: string;
}

/** Decoded JWT payload (arbitrary claims) */
interface JWTPayload {
	[key: string]: unknown;
	iss?: string;
	sub?: string;
	aud?: string | string[];
	exp?: number;
	nbf?: number;
	iat?: number;
}

/** Token introspection response per RFC 7662 */
interface IntrospectionResponse {
	active: boolean;
	sub?: string;
	client_id?: string;
	username?: string;
	scope?: string;
	exp?: number;
	iat?: number;
	iss?: string;
	aud?: string | string[];
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// TokenCache
// ---------------------------------------------------------------------------

/** Cache entry storing an identity and its expiration time */
interface TokenCacheEntry {
	identity: AuthIdentity;
	expiresAt: number;
}

/** Statistics returned by TokenCache.getStats() */
export interface TokenCacheStats {
	/** Number of entries currently in the cache */
	size: number;
	/** Maximum number of entries allowed */
	maxSize: number;
	/** Total number of cache hits */
	hits: number;
	/** Total number of cache misses */
	misses: number;
	/** Total number of entries evicted due to TTL or capacity */
	evictions: number;
}

/**
 * LRU-style token cache with TTL-based expiry.
 *
 * Caches validated token identities keyed by a SHA-256 hash of the raw token.
 * When the cache exceeds its maximum size the least-recently-used entry is
 * evicted.
 *
 * @example
 * ```typescript
 * const cache = new TokenCache(500);
 * const hash = cache.hashToken(rawJwt);
 *
 * // Store after validation
 * cache.set(hash, identity, 3600_000);
 *
 * // Retrieve on subsequent requests
 * const cached = cache.get(hash);
 * ```
 */
export class TokenCache {
	private cache: Map<string, TokenCacheEntry> = new Map();
	private readonly maxSize: number;
	private hits = 0;
	private misses = 0;
	private evictions = 0;

	constructor(maxSize: number = 1000) {
		this.maxSize = maxSize;
	}

	/**
	 * Retrieve a cached identity by token hash.
	 * Returns `undefined` if the entry is missing or has expired.
	 * Moves the entry to the end of the map (most-recently-used).
	 */
	get(tokenHash: string): AuthIdentity | undefined {
		const entry = this.cache.get(tokenHash);
		if (!entry) {
			this.misses++;
			return undefined;
		}

		// TTL check
		if (Date.now() >= entry.expiresAt) {
			this.cache.delete(tokenHash);
			this.evictions++;
			this.misses++;
			return undefined;
		}

		// Move to end (most-recently-used)
		this.cache.delete(tokenHash);
		this.cache.set(tokenHash, entry);

		this.hits++;
		return entry.identity;
	}

	/**
	 * Store an identity in the cache.
	 *
	 * @param tokenHash - SHA-256 hex hash of the raw token
	 * @param identity  - Validated identity to cache
	 * @param ttlMs     - Time-to-live in milliseconds
	 */
	set(tokenHash: string, identity: AuthIdentity, ttlMs: number): void {
		// If already present, delete first so re-insertion goes to end
		if (this.cache.has(tokenHash)) {
			this.cache.delete(tokenHash);
		}

		// Evict oldest entry if at capacity
		if (this.cache.size >= this.maxSize) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) {
				this.cache.delete(oldest);
				this.evictions++;
			}
		}

		this.cache.set(tokenHash, {
			identity,
			expiresAt: Date.now() + ttlMs,
		});
	}

	/**
	 * Invalidate (remove) a specific entry by token hash
	 */
	invalidate(tokenHash: string): boolean {
		return this.cache.delete(tokenHash);
	}

	/**
	 * Remove all entries from the cache and reset statistics
	 */
	clear(): void {
		this.cache.clear();
		this.hits = 0;
		this.misses = 0;
		this.evictions = 0;
	}

	/**
	 * Return cache performance statistics
	 */
	getStats(): TokenCacheStats {
		return {
			size: this.cache.size,
			maxSize: this.maxSize,
			hits: this.hits,
			misses: this.misses,
			evictions: this.evictions,
		};
	}

	/**
	 * Compute a SHA-256 hex digest suitable for use as a cache key
	 */
	static hashToken(token: string): string {
		return createHash("sha256").update(token).digest("hex");
	}
}

// ---------------------------------------------------------------------------
// OAuthOIDCProvider
// ---------------------------------------------------------------------------

/**
 * OAuth 2.0 / OpenID Connect Authentication Provider
 *
 * Validates JWT access tokens issued by an OIDC-compliant identity provider.
 * Automatically discovers OIDC metadata and JWKS endpoints, verifies token
 * signatures using RS256 or ES256, and validates standard claims.
 *
 * For opaque (non-JWT) tokens, falls back to RFC 7662 token introspection
 * when an introspection endpoint is configured or discovered.
 *
 * @example
 * ```typescript
 * const provider = new OAuthOIDCProvider({
 *   issuerUrl: "https://accounts.google.com",
 *   clientId: "my-client-id",
 *   audience: "https://api.example.com",
 * });
 *
 * const result = await provider.authenticate({
 *   headers: { authorization: "Bearer eyJhbGciOi..." },
 * });
 *
 * if (result.authenticated) {
 *   console.log("Authenticated:", result.identity?.sub);
 * }
 * ```
 */
export class OAuthOIDCProvider implements AuthProvider {
	readonly name = "oauth-oidc";

	private config: Required<
		Pick<
			OAuthOIDCConfig,
			"issuerUrl" | "clientId" | "allowedAlgorithms" | "rolesClaim" | "scopesClaim" | "clockToleranceSec" | "cacheJWKS" | "cacheDiscovery"
		>
	> &
		OAuthOIDCConfig;

	/** Cached OIDC discovery document */
	private discoveryCache: OIDCDiscoveryDocument | null = null;

	/** Cached JWKS keyset */
	private jwksCache: JWKS | null = null;

	/** Pre-imported Node.js KeyObjects keyed by kid */
	private keyObjectCache: Map<string, KeyObject> = new Map();

	/** Token result cache */
	private tokenCache: TokenCache;

	constructor(config: OAuthOIDCConfig) {
		this.config = {
			allowedAlgorithms: ["RS256", "ES256"],
			rolesClaim: "roles",
			scopesClaim: "scope",
			clockToleranceSec: 30,
			cacheJWKS: true,
			cacheDiscovery: true,
			...config,
		};
		this.tokenCache = new TokenCache();
	}

	// -----------------------------------------------------------------------
	// AuthProvider implementation
	// -----------------------------------------------------------------------

	/**
	 * Authenticate an incoming request by extracting and verifying the
	 * Bearer token from the Authorization header.
	 */
	async authenticate(request: AuthRequest): Promise<AuthResult> {
		const headerValue = request.headers["authorization"] ?? request.headers["Authorization"];
		if (!headerValue) {
			return { authenticated: false, error: "No authorization header" };
		}

		const raw = String(headerValue).replace(/^Bearer\s+/i, "");
		if (!raw || raw === String(headerValue)) {
			return { authenticated: false, error: "Invalid Bearer token format" };
		}

		// Check token cache first
		const tokenHash = TokenCache.hashToken(raw);
		const cachedIdentity = this.tokenCache.get(tokenHash);
		if (cachedIdentity) {
			return { authenticated: true, identity: cachedIdentity };
		}

		try {
			// Attempt JWT verification first
			const identity = await this.verifyJWT(raw);
			if (identity) {
				// Cache with TTL derived from token expiry
				const ttlMs = identity.expiresAt
					? (identity.expiresAt - Math.floor(Date.now() / 1000)) * 1000
					: 300_000; // 5 min fallback
				if (ttlMs > 0) {
					this.tokenCache.set(tokenHash, identity, ttlMs);
				}
				return { authenticated: true, identity };
			}

			// Fall back to introspection for opaque tokens
			const introspectionEndpoint =
				this.config.introspectionEndpoint ?? (await this.resolveIntrospectionEndpoint());

			if (introspectionEndpoint) {
				const introspectionResult = await this.introspectToken(raw, introspectionEndpoint);
				if (introspectionResult) {
					const ttlMs = introspectionResult.expiresAt
						? (introspectionResult.expiresAt - Math.floor(Date.now() / 1000)) * 1000
						: 300_000;
					if (ttlMs > 0) {
						this.tokenCache.set(tokenHash, introspectionResult, ttlMs);
					}
					return { authenticated: true, identity: introspectionResult };
				}
			}

			return { authenticated: false, error: "Token verification failed", statusCode: 401 };
		} catch (err) {
			return {
				authenticated: false,
				error: `OAuth authentication failed: ${err instanceof Error ? err.message : String(err)}`,
				statusCode: 401,
			};
		}
	}

	// -----------------------------------------------------------------------
	// OIDC Discovery
	// -----------------------------------------------------------------------

	/**
	 * Fetch and parse the OIDC discovery document from the issuer's
	 * `/.well-known/openid-configuration` endpoint.
	 *
	 * The result is cached when `cacheDiscovery` is enabled (default).
	 *
	 * @param issuerUrl - The OIDC issuer URL
	 * @returns Parsed OIDC discovery document
	 */
	async discoverConfiguration(issuerUrl: string): Promise<OIDCDiscoveryDocument> {
		if (this.config.cacheDiscovery && this.discoveryCache) {
			return this.discoveryCache;
		}

		const url = issuerUrl.replace(/\/+$/, "") + "/.well-known/openid-configuration";

		const response = await fetch(url, {
			method: "GET",
			headers: { Accept: "application/json" },
		});

		if (!response.ok) {
			throw new Error(
				`OIDC discovery failed: ${response.status} ${response.statusText} from ${url}`,
			);
		}

		const doc = (await response.json()) as OIDCDiscoveryDocument;

		// Validate required fields
		if (!doc.issuer || !doc.jwks_uri) {
			throw new Error("OIDC discovery document missing required fields (issuer, jwks_uri)");
		}

		if (this.config.cacheDiscovery) {
			this.discoveryCache = doc;
		}

		return doc;
	}

	// -----------------------------------------------------------------------
	// JWKS Management
	// -----------------------------------------------------------------------

	/**
	 * Fetch the JSON Web Key Set from the specified URI.
	 *
	 * The result is cached when `cacheJWKS` is enabled (default).
	 *
	 * @param jwksUri - URL of the JWKS endpoint
	 * @returns The parsed JWKS
	 */
	async fetchJWKS(jwksUri: string): Promise<JWKS> {
		if (this.config.cacheJWKS && this.jwksCache) {
			return this.jwksCache;
		}

		const response = await fetch(jwksUri, {
			method: "GET",
			headers: { Accept: "application/json" },
		});

		if (!response.ok) {
			throw new Error(
				`JWKS fetch failed: ${response.status} ${response.statusText} from ${jwksUri}`,
			);
		}

		const jwks = (await response.json()) as JWKS;

		if (!jwks.keys || !Array.isArray(jwks.keys)) {
			throw new Error("JWKS response missing 'keys' array");
		}

		if (this.config.cacheJWKS) {
			this.jwksCache = jwks;
			// Rebuild the key-object cache
			this.keyObjectCache.clear();
		}

		return jwks;
	}

	// -----------------------------------------------------------------------
	// Token introspection (RFC 7662)
	// -----------------------------------------------------------------------

	/**
	 * Introspect an opaque token via the RFC 7662 token introspection endpoint.
	 *
	 * Requires `clientId` and `clientSecret` for Basic authentication.
	 *
	 * @param token                - The raw token string
	 * @param introspectionEndpoint - URL of the introspection endpoint
	 * @returns Resolved AuthIdentity when the token is active, otherwise `null`
	 */
	async introspectToken(
		token: string,
		introspectionEndpoint: string,
	): Promise<AuthIdentity | null> {
		if (!this.config.clientSecret) {
			return null;
		}

		const credentials = Buffer.from(
			`${this.config.clientId}:${this.config.clientSecret}`,
		).toString("base64");

		const response = await fetch(introspectionEndpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Authorization: `Basic ${credentials}`,
				Accept: "application/json",
			},
			body: `token=${encodeURIComponent(token)}&token_type_hint=access_token`,
		});

		if (!response.ok) {
			return null;
		}

		const data = (await response.json()) as IntrospectionResponse;

		if (!data.active) {
			return null;
		}

		// Validate issuer if configured
		if (data.iss && data.iss !== this.config.issuerUrl) {
			return null;
		}

		// Extract roles from the introspection response
		const roles = this.extractRoles(data as Record<string, unknown>);

		return {
			sub: data.sub || data.client_id || "unknown",
			name: data.username,
			roles,
			claims: data as Record<string, unknown>,
			provider: this.name,
			issuedAt: data.iat,
			expiresAt: data.exp,
		};
	}

	// -----------------------------------------------------------------------
	// JWT Verification (core)
	// -----------------------------------------------------------------------

	/**
	 * Verify a JWT access token using the issuer's public keys.
	 *
	 * 1. Decodes the JWT header to determine `alg` and `kid`.
	 * 2. Resolves the JWKS (via discovery or explicit config).
	 * 3. Selects the matching JWK by `kid`.
	 * 4. Verifies the signature using RS256 or ES256.
	 * 5. Validates standard claims (exp, nbf, iss, aud).
	 *
	 * @param token - Raw JWT string
	 * @returns Resolved AuthIdentity on success, `null` on failure
	 */
	private async verifyJWT(token: string): Promise<AuthIdentity | null> {
		// Split and basic structure check
		const parts = token.split(".");
		if (parts.length !== 3) {
			return null;
		}

		const [headerB64, payloadB64, signatureB64] = parts;

		// Decode header
		let header: JWTHeader;
		try {
			header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf-8")) as JWTHeader;
		} catch {
			return null;
		}

		// Verify algorithm is allowed
		if (!this.config.allowedAlgorithms.includes(header.alg)) {
			return null;
		}

		// Resolve the public key
		const publicKey = await this.resolvePublicKey(header.alg, header.kid);
		if (!publicKey) {
			return null;
		}

		// Verify signature
		const signingInput = `${headerB64}.${payloadB64}`;
		const signature = Buffer.from(signatureB64, "base64url");

		const valid = this.verifySignature(header.alg, publicKey, signingInput, signature);
		if (!valid) {
			return null;
		}

		// Decode payload
		let payload: JWTPayload;
		try {
			payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8")) as JWTPayload;
		} catch {
			return null;
		}

		// Validate claims
		const claimsError = this.validateClaims(payload);
		if (claimsError) {
			return null;
		}

		// Extract roles
		const roles = this.extractRoles(payload as Record<string, unknown>);

		return {
			sub: (payload.sub as string) || "unknown",
			name: payload.name as string | undefined,
			email: payload.email as string | undefined,
			roles,
			claims: payload as Record<string, unknown>,
			provider: this.name,
			issuedAt: payload.iat,
			expiresAt: payload.exp,
		};
	}

	// -----------------------------------------------------------------------
	// Signature verification
	// -----------------------------------------------------------------------

	/**
	 * Verify a JWT signature using the given algorithm and public key.
	 *
	 * @param alg          - JWT algorithm (RS256 or ES256)
	 * @param key          - Node.js KeyObject containing the public key
	 * @param signingInput - The `header.payload` string that was signed
	 * @param signature    - Raw signature bytes
	 * @returns `true` if the signature is valid
	 */
	private verifySignature(
		alg: string,
		key: KeyObject,
		signingInput: string,
		signature: Buffer,
	): boolean {
		switch (alg) {
			case "RS256": {
				const verifier = createVerify("RSA-SHA256");
				verifier.update(signingInput);
				return verifier.verify(key, signature);
			}
			case "ES256": {
				// ECDSA signatures in JWTs use the raw (r || s) format.
				// Node.js crypto expects DER-encoded signatures, so we convert.
				const derSignature = this.rawEcdsaToDer(signature);
				const verifier = createVerify("SHA256");
				verifier.update(signingInput);
				return verifier.verify(key, derSignature);
			}
			default:
				return false;
		}
	}

	/**
	 * Convert a raw ECDSA signature (r || s, 64 bytes for P-256) to
	 * DER-encoded format expected by Node.js crypto.
	 *
	 * @param raw - Raw ECDSA signature bytes
	 * @returns DER-encoded signature buffer
	 */
	private rawEcdsaToDer(raw: Buffer): Buffer {
		const halfLen = raw.length / 2;
		const r = raw.subarray(0, halfLen);
		const s = raw.subarray(halfLen);

		const encodeInteger = (int: Buffer): Buffer => {
			// Trim leading zeros but keep one if highest bit is set
			let offset = 0;
			while (offset < int.length - 1 && int[offset] === 0) {
				offset++;
			}
			let trimmed = int.subarray(offset);

			// If the high bit is set, prepend a 0x00 byte
			if (trimmed[0] & 0x80) {
				trimmed = Buffer.concat([Buffer.from([0x00]), trimmed]);
			}

			return Buffer.concat([
				Buffer.from([0x02, trimmed.length]),
				trimmed,
			]);
		};

		const rDer = encodeInteger(r);
		const sDer = encodeInteger(s);

		return Buffer.concat([
			Buffer.from([0x30, rDer.length + sDer.length]),
			rDer,
			sDer,
		]);
	}

	// -----------------------------------------------------------------------
	// Key resolution
	// -----------------------------------------------------------------------

	/**
	 * Resolve a Node.js KeyObject for the given algorithm and key ID.
	 *
	 * Performs OIDC discovery and JWKS fetch as needed, then selects the
	 * appropriate JWK and imports it into a native KeyObject.
	 */
	private async resolvePublicKey(alg: string, kid?: string): Promise<KeyObject | null> {
		// Check KeyObject cache
		const cacheKey = kid ?? alg;
		const cached = this.keyObjectCache.get(cacheKey);
		if (cached) {
			return cached;
		}

		// Determine JWKS URI
		const jwksUri = await this.resolveJwksUri();
		if (!jwksUri) {
			return null;
		}

		// Fetch JWKS
		const jwks = await this.fetchJWKS(jwksUri);

		// Find matching key
		const jwk = this.selectKey(jwks, alg, kid);
		if (!jwk) {
			// If kid not found and we are using cache, try refreshing JWKS
			// (key rotation scenario)
			if (this.config.cacheJWKS && this.jwksCache) {
				this.jwksCache = null;
				this.keyObjectCache.clear();
				const refreshed = await this.fetchJWKS(jwksUri);
				const retryJwk = this.selectKey(refreshed, alg, kid);
				if (!retryJwk) {
					return null;
				}
				return this.importJWK(retryJwk);
			}
			return null;
		}

		const keyObject = this.importJWK(jwk);
		if (keyObject) {
			this.keyObjectCache.set(cacheKey, keyObject);
		}
		return keyObject;
	}

	/**
	 * Select a JWK from the key set that matches the algorithm and key ID.
	 */
	private selectKey(jwks: JWKS, alg: string, kid?: string): JWK | null {
		const candidates = jwks.keys.filter((k) => {
			// Key must be for signature verification
			if (k.use && k.use !== "sig") return false;
			// If alg is specified on the key, it must match
			if (k.alg && k.alg !== alg) return false;
			// Key type must match algorithm
			if (alg === "RS256" && k.kty !== "RSA") return false;
			if (alg === "ES256" && k.kty !== "EC") return false;
			return true;
		});

		if (candidates.length === 0) {
			return null;
		}

		// If kid is provided, find an exact match
		if (kid) {
			return candidates.find((k) => k.kid === kid) ?? null;
		}

		// Without kid, return the first matching candidate
		return candidates[0];
	}

	/**
	 * Import a JWK into a Node.js KeyObject using `crypto.createPublicKey`.
	 */
	private importJWK(jwk: JWK): KeyObject | null {
		try {
			if (jwk.kty === "RSA") {
				return createPublicKey({
					key: {
						kty: jwk.kty,
						n: jwk.n,
						e: jwk.e,
					},
					format: "jwk",
				});
			}

			if (jwk.kty === "EC") {
				return createPublicKey({
					key: {
						kty: jwk.kty,
						crv: jwk.crv,
						x: jwk.x,
						y: jwk.y,
					},
					format: "jwk",
				});
			}

			return null;
		} catch {
			return null;
		}
	}

	// -----------------------------------------------------------------------
	// Claims validation
	// -----------------------------------------------------------------------

	/**
	 * Validate standard JWT claims: exp, nbf, iss, aud.
	 *
	 * @returns An error message string if validation fails, `null` otherwise
	 */
	private validateClaims(payload: JWTPayload): string | null {
		const now = Math.floor(Date.now() / 1000);
		const tolerance = this.config.clockToleranceSec;

		// Check expiration
		if (payload.exp !== undefined && payload.exp + tolerance < now) {
			return "Token expired";
		}

		// Check not-before
		if (payload.nbf !== undefined && payload.nbf - tolerance > now) {
			return "Token not yet valid";
		}

		// Check issuer
		if (payload.iss && payload.iss !== this.config.issuerUrl) {
			return `Invalid issuer: expected ${this.config.issuerUrl}, got ${payload.iss}`;
		}

		// Check audience
		if (this.config.audience) {
			const aud = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
			if (!aud.includes(this.config.audience)) {
				return `Invalid audience: expected ${this.config.audience}`;
			}
		}

		return null;
	}

	// -----------------------------------------------------------------------
	// Role extraction
	// -----------------------------------------------------------------------

	/**
	 * Extract roles from token claims using the configured claim names.
	 *
	 * Checks the `rolesClaim` first (e.g. "roles"), then falls back
	 * to parsing space-delimited scopes from `scopesClaim` (e.g. "scope").
	 */
	private extractRoles(claims: Record<string, unknown>): string[] {
		const roles: string[] = [];

		// Extract from roles claim
		const rolesClaim = this.config.rolesClaim;
		const rolesValue = claims[rolesClaim];
		if (Array.isArray(rolesValue)) {
			roles.push(...(rolesValue as string[]));
		} else if (typeof rolesValue === "string") {
			roles.push(rolesValue);
		}

		// Extract from scopes claim (space-delimited string)
		const scopesClaim = this.config.scopesClaim;
		const scopesValue = claims[scopesClaim];
		if (typeof scopesValue === "string" && scopesValue.length > 0) {
			const scopeRoles = scopesValue.split(/\s+/).filter(Boolean);
			for (const s of scopeRoles) {
				if (!roles.includes(s)) {
					roles.push(s);
				}
			}
		}

		return roles;
	}

	// -----------------------------------------------------------------------
	// URI resolution helpers
	// -----------------------------------------------------------------------

	/**
	 * Resolve the JWKS URI, either from explicit config or via OIDC discovery
	 */
	private async resolveJwksUri(): Promise<string | null> {
		if (this.config.jwksUri) {
			return this.config.jwksUri;
		}

		try {
			const doc = await this.discoverConfiguration(this.config.issuerUrl);
			return doc.jwks_uri;
		} catch {
			return null;
		}
	}

	/**
	 * Resolve the token introspection endpoint from OIDC discovery
	 */
	private async resolveIntrospectionEndpoint(): Promise<string | null> {
		try {
			const doc = await this.discoverConfiguration(this.config.issuerUrl);
			return doc.introspection_endpoint ?? null;
		} catch {
			return null;
		}
	}

	// -----------------------------------------------------------------------
	// Cache management (public API for operational use)
	// -----------------------------------------------------------------------

	/**
	 * Clear all internal caches (discovery, JWKS, token cache).
	 * Useful during key rotation or configuration changes.
	 */
	clearCaches(): void {
		this.discoveryCache = null;
		this.jwksCache = null;
		this.keyObjectCache.clear();
		this.tokenCache.clear();
	}

	/**
	 * Return statistics from the token cache
	 */
	getTokenCacheStats(): TokenCacheStats {
		return this.tokenCache.getStats();
	}
}
