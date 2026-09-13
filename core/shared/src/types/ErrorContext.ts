import type ParamsDictionary from "./ParamsDictionary";

type ErrorContext = {
	message: string[] | string;
	code?: number;
	json?: ParamsDictionary;
	stack?: string;
	name?: string;
	/**
	 * #996 — response headers the trigger emits alongside the error status, so a
	 * middleware short-circuit can answer with `302 Location: /login` instead of
	 * a bare 401.
	 */
	headers?: Record<string, string>;
	/** #996 — raw `Set-Cookie` values; each becomes its own header. */
	cookies?: string[];
};

export default ErrorContext;
