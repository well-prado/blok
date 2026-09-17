/**
 * `@blokjs/auth` — the server half of Blok's auth starter kit (#1018).
 *
 * Password hashing, login/logout/register/reset nodes, login throttling, and a
 * six-method {@link UserStore} with a SQLite default. No ORM: the store is an
 * interface an app implements over whatever database it already has (a `pg`
 * example and a Drizzle one are in the README).
 *
 * ```ts
 * // src/Nodes.ts
 * import { AUTH_NODES } from "@blokjs/auth";
 * import { SESSION_NODES } from "@blokjs/session";
 * export default { ...SESSION_NODES, ...AUTH_NODES };
 *
 * // src/Workflows.ts
 * import { AUTH_KIT_CHAIN, authKitMiddleware } from "@blokjs/auth";
 * import { authWorkflows } from "@blokjs/auth/examples";
 * export default { ...(await authKitMiddleware()), ...(await authWorkflows()) };
 * setGlobalMiddleware([...AUTH_KIT_CHAIN]);
 * ```
 *
 * Requires `BLOK_SESSION_SECRET` and `BLOK_FLASH_SECRET` — see `.env.example`.
 */

export { DEFAULT_SCRYPT, type ScryptParams, decoyHash, hashPassword, verifyPassword } from "./password.js";
export {
	type AuthUser,
	type AuthPgClient,
	DuplicateEmailError,
	MemoryUserStore,
	PostgresUserStore,
	type NewUser,
	type PostgresUserStoreOptions,
	type ResetTokenRecord,
	SqliteUserStore,
	type UserStore,
	normalizeEmail,
} from "./user-store.js";
export { type AuthOptions, _resetAuth, authOptions, configureAuth, getUserStore } from "./config.js";
export {
	type ThrottleBackend,
	type ThrottleVerdict,
	_resetThrottle,
	clearThrottle,
	hitThrottle,
	setThrottleBackend,
	throttleKey,
	trustsProxyHeaders,
} from "./throttle.js";
export { consumeResetToken, createResetToken, hashResetToken } from "./tokens.js";
export {
	AUTH_NODES,
	bounceNode,
	currentUserNode,
	forgotPasswordNode,
	loginNode,
	logoutNode,
	registerNode,
	resetPasswordNode,
	resetTokenNode,
} from "./nodes.js";
export { AUTH_GUARD, AUTH_KIT_CHAIN, authKitMiddleware, requireAuth } from "./middleware.js";
export {
	type ForgotPasswordInput,
	ForgotPasswordSchema,
	type LoginInput,
	LoginSchema,
	MIN_PASSWORD,
	type RegisterInput,
	RegisterSchema,
	type ResetPasswordInput,
	ResetPasswordSchema,
} from "./schemas.js";
