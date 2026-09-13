/**
 * `@blokjs/inertia` security surface (#1013) — history encryption,
 * `clearHistory` on logout, and the `can` / `authorize` authorization
 * convention. Re-exported from the package barrel.
 */

export {
	ENCRYPT_HISTORY_MIDDLEWARE,
	configureHistory,
	encryptHistoryMiddleware,
	historyMarks,
	historyNode,
	historyOptions,
	logoutNode,
	logoutResponse,
	markHistory,
	resolveClearHistory,
	resolveEncryptHistory,
} from "./history.js";
export type { HistoryMarks, HistoryOptions, LogoutOptions } from "./history.js";
export { authorize, authorizeNode, can } from "./authorize.js";
export type { AbilityRule } from "./authorize.js";
