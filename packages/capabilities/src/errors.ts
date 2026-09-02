export const WORKSPACE_FILESYSTEM_ERROR_CODES = [
	"WORKSPACE_FS_INVALID_ROOT",
	"WORKSPACE_FS_INVALID_PATH",
	"WORKSPACE_FS_PATH_ESCAPE",
	"WORKSPACE_FS_SYMLINK_DISALLOWED",
	"WORKSPACE_FS_HARDLINK_DISALLOWED",
	"WORKSPACE_FS_SPECIAL_FILE_DISALLOWED",
	"WORKSPACE_FS_NOT_FOUND",
	"WORKSPACE_FS_PERMISSION_DENIED",
	"WORKSPACE_FS_INVALID_TARGET",
	"WORKSPACE_FS_BINARY_FILE",
	"WORKSPACE_FS_INVALID_ENCODING",
	"WORKSPACE_FS_QUERY_INVALID",
	"WORKSPACE_FS_SIZE_LIMIT",
	"WORKSPACE_FS_FILE_LIMIT",
	"WORKSPACE_FS_MATCH_LIMIT",
	"WORKSPACE_FS_LINE_LIMIT",
	"WORKSPACE_FS_TIME_LIMIT",
	"WORKSPACE_FS_CANCELLED",
	"WORKSPACE_FS_VERSION_REQUIRED",
	"WORKSPACE_FS_VERSION_CONFLICT",
	"WORKSPACE_FS_PATCH_INVALID",
	"WORKSPACE_FS_WATCH_OVERFLOW",
	"WORKSPACE_FS_POLICY_DENIED",
	"WORKSPACE_FS_POLICY_INVALID",
	"WORKSPACE_FS_ATOMIC_REPLACE_UNSUPPORTED",
] as const;

export type WorkspaceFilesystemErrorCode = (typeof WORKSPACE_FILESYSTEM_ERROR_CODES)[number];

export class WorkspaceFilesystemError extends Error {
	readonly code: WorkspaceFilesystemErrorCode;
	readonly operation?: string;
	readonly relativePath?: string;

	constructor(
		code: WorkspaceFilesystemErrorCode,
		message?: string,
		details?: { operation?: string; relativePath?: string },
	) {
		super(message ?? code);
		this.name = "WorkspaceFilesystemError";
		this.code = code;
		this.operation = details?.operation;
		this.relativePath = details?.relativePath;
	}
}
