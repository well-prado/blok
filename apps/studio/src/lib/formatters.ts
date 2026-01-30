/** Format milliseconds to human-readable duration. */
export function formatDuration(ms: number | undefined): string {
	if (ms === undefined || ms === null) return "—";
	if (ms < 1) return "<1ms";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const mins = Math.floor(ms / 60000);
	const secs = Math.round((ms % 60000) / 1000);
	return `${mins}m ${secs}s`;
}

/** Format bytes to human-readable size. */
export function formatBytes(bytes: number | undefined): string {
	if (bytes === undefined || bytes === null) return "—";
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
	if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)}MB`;
	return `${(bytes / 1073741824).toFixed(1)}GB`;
}

/** Format a timestamp to relative time (e.g. "2s ago"). */
export function formatRelativeTime(timestamp: number): string {
	const diff = Date.now() - timestamp;
	if (diff < 1000) return "just now";
	if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
	if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
	if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
	return `${Math.floor(diff / 86400000)}d ago`;
}

/** Format a timestamp to absolute time. */
export function formatTimestamp(timestamp: number): string {
	return new Date(timestamp).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

/** Format a percentage (0-1 scale). */
export function formatPercent(value: number): string {
	if (value === 0) return "0%";
	if (value < 0.01) return "<1%";
	return `${(value * 100).toFixed(1)}%`;
}

/** Truncate a string. */
export function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str;
	return `${str.slice(0, maxLen - 1)}\u2026`;
}
