/**
 * `@blokjs/session` — signed, HttpOnly server-side sessions for Blok (#1018).
 *
 * The cookie carries an opaque, signed session id and nothing else; the data
 * lives in a pluggable store (`memory`, `sqlite` by default, `redis` when
 * `REDIS_URL` is set). It is independent of `@blokjs/auth` — anything that
 * needs per-visitor server state can use it on its own.
 *
 * ```ts
 * import { SESSION_NODES, createSessionMiddleware } from "@blokjs/session";
 * // src/Nodes.ts
 * export default { ...SESSION_NODES };
 * // src/Workflows.ts
 * export default { "inertia.session": await createSessionMiddleware() };
 * ```
 *
 * Requires `BLOK_SESSION_SECRET` — see `.env.example`.
 */

export {
	SESSION_COOKIE,
	SESSION_MAX_AGE,
	type SessionCookieOptions,
	clearSessionCookie,
	newSessionId,
	readSessionCookie,
	sessionSetCookie,
	signSessionId,
	verifySessionId,
} from "./cookie.js";
export { SESSION_SECRET_ENV, resolveSessionSecret } from "./secret.js";
export {
	MemorySessionStore,
	PostgresSessionStore,
	type PostgresSessionStoreOptions,
	RedisSessionStore,
	type SessionRecord,
	type SessionPgClient,
	type SessionStore,
	type SessionStoreType,
	type SqliteDatabase,
	type SqliteStatement,
	SqliteSessionStore,
	createSessionStore,
	ensureSqliteDir,
	openSqlite,
} from "./store.js";
export {
	_resetSession,
	type SessionOptions,
	type StartSessionOptions,
	type SessionState,
	configureSession,
	destroySession,
	getSessionStore,
	loadSession,
	markSession,
	regenerateSession,
	replaceSession,
	saveSession,
	sessionOf,
	startSession,
} from "./session.js";
export {
	SESSION_NODES,
	sessionForgetNode,
	sessionGetNode,
	sessionLoadNode,
	sessionRegenerateNode,
	sessionSetNode,
} from "./nodes.js";
export {
	SESSION_MIDDLEWARE,
	SESSION_STEP_ID,
	type SessionMiddlewareOptions,
	createSessionMiddleware,
	sessionMiddleware,
} from "./middleware.js";
