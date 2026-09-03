export const CODE_MODE_ERROR_CODES = [
	"CODE_MODE_INVALID_CONTRACT",
	"CODE_MODE_SOURCE_TOO_LARGE",
	"CODE_MODE_STATIC_REJECTED",
	"CODE_MODE_BINDING_REJECTED",
	"CODE_MODE_POLICY_DENIED",
	"CODE_MODE_CALL_LIMIT",
	"CODE_MODE_NESTING_LIMIT",
	"CODE_MODE_PARALLELISM_LIMIT",
	"CODE_MODE_INPUT_LIMIT",
	"CODE_MODE_OUTPUT_LIMIT",
	"CODE_MODE_MEMORY_LIMIT",
	"CODE_MODE_TIMEOUT",
	"CODE_MODE_CANCELLED",
	"CODE_MODE_RUNTIME_ERROR",
	"CODE_MODE_HOST_UNSUPPORTED",
	"CODE_MODE_CLEANUP_FAILED",
] as const;

export type CodeModeErrorCode = (typeof CODE_MODE_ERROR_CODES)[number];

export class CodeModeError extends Error {
	readonly name = "CodeModeError";

	constructor(
		public readonly code: CodeModeErrorCode,
		message: string = code,
		public readonly issues?: readonly string[],
	) {
		super(message);
	}
}
