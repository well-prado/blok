/**
 * App-wide auth configuration (#1018) — the same `configure*()` + lazy default
 * shape `configureHistory()` / `configureSession()` use.
 *
 * ```ts
 * configureAuth({ users: new PostgresUserStore(pool), redirectAfterLogin: "/app" });
 * ```
 */

import { MemoryUserStore, SqliteUserStore, type UserStore } from "./user-store.js";

export interface AuthOptions {
	/** Where users live. Default: sqlite at `BLOK_AUTH_SQLITE_PATH` (memory under `NODE_ENV=test`). */
	users?: UserStore;
	/** Landing page after a successful login or registration. Default `/dashboard`. */
	redirectAfterLogin?: string;
	/** Landing page after logout, and where the guest guard sends people. Default `/login`. */
	redirectAfterLogout?: string;
	/** Reset-token lifetime in SECONDS. Default 3600 (one hour). */
	resetTokenTtl?: number;
	/** Failed logins allowed per IP+email before throttling. Default 5. */
	throttleLimit?: number;
	/** Throttle window in SECONDS. Default 60. */
	throttleWindow?: number;
	/** Signing secret for reset tokens. Defaults to `BLOK_SESSION_SECRET`. */
	secret?: string;
	/**
	 * Is a reverse proxy in front of this app? Only then may `X-Forwarded-For` /
	 * `X-Real-IP` / `CF-Connecting-IP` name the client for login throttling —
	 * they are ordinary headers anyone can set, and trusting them without a
	 * proxy lets an attacker mint a fresh throttle bucket per attempt.
	 * Default: `BLOK_TRUST_PROXY=1`.
	 */
	trustProxy?: boolean;
	/** Path a reset link points at. `:token` is substituted. Default `/reset-password/:token`. */
	resetPath?: string;
	/**
	 * Deliver the reset link. The kit cannot send email, so this is the seam:
	 * it is called with the raw token exactly once, and the token is never
	 * returned to a workflow step — so it never lands in `ctx.state`, a trace,
	 * or DevTools.
	 *
	 * Left unset, the link is logged (the dev equivalent of Laravel's `log`
	 * mail driver) so the flow is usable before a mailer exists.
	 */
	sendResetLink?: (link: { email: string; token: string; url: string }) => void | Promise<void>;
}

const DEFAULTS = {
	redirectAfterLogin: "/dashboard",
	redirectAfterLogout: "/login",
	resetTokenTtl: 3600,
	throttleLimit: 5,
	throttleWindow: 60,
	resetPath: "/reset-password/:token",
} as const;

let options: AuthOptions = {};
let users: UserStore | undefined;

/** Configure the auth kit. Call once at boot, before any request. */
export function configureAuth(next: AuthOptions): void {
	options = { ...options, ...next };
	if (next.users) users = next.users;
}

/** The resolved options, defaults applied. */
export function authOptions(): Required<Omit<AuthOptions, "users" | "secret" | "sendResetLink" | "trustProxy">> &
	Pick<AuthOptions, "secret" | "sendResetLink" | "trustProxy"> {
	return {
		redirectAfterLogin: options.redirectAfterLogin ?? DEFAULTS.redirectAfterLogin,
		redirectAfterLogout: options.redirectAfterLogout ?? DEFAULTS.redirectAfterLogout,
		resetTokenTtl: options.resetTokenTtl ?? DEFAULTS.resetTokenTtl,
		throttleLimit: options.throttleLimit ?? DEFAULTS.throttleLimit,
		throttleWindow: options.throttleWindow ?? DEFAULTS.throttleWindow,
		resetPath: options.resetPath ?? DEFAULTS.resetPath,
		...(options.trustProxy !== undefined ? { trustProxy: options.trustProxy } : {}),
		...(options.secret !== undefined ? { secret: options.secret } : {}),
		...(options.sendResetLink !== undefined ? { sendResetLink: options.sendResetLink } : {}),
	};
}

/**
 * The configured user store, built on first use.
 *
 * Default: SQLite at `BLOK_AUTH_SQLITE_PATH` (or `.blok/auth.db`) — except
 * under `NODE_ENV=test`, where it is in-memory so a suite needs no fixture and
 * no file. Same rule the runner's `createStore()` applies to the run store.
 */
export function getUserStore(): UserStore {
	if (!users) {
		users =
			options.users ??
			(process.env.NODE_ENV === "test"
				? new MemoryUserStore()
				: new SqliteUserStore(process.env.BLOK_AUTH_SQLITE_PATH || ".blok/auth.db"));
	}
	return users;
}

/** Test-only: drop the configuration and the memoised store. */
export function _resetAuth(): void {
	options = {};
	users = undefined;
}
