type LoggerContext = {
	log(message: string): void;
	getLogs(): string[];
	getLogsAsText(): string;
	getLogsAsBase64(): string;
	logLevel(level: string, message: string): void;
	error(message: string, stack: string): void;
	/**
	 * Would a message at `level` (default `"info"`) actually be emitted? Lets a
	 * caller skip building an expensive message — the per-node config JSON in
	 * `BlokService.run` — that the logger would only drop. Optional: a logger
	 * that doesn't implement it is treated as always emitting.
	 */
	isLevelEnabled?(level?: string): boolean;
};

export default LoggerContext;
