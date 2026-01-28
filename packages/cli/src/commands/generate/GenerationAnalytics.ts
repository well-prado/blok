/**
 * GenerationAnalytics - Tracks AI code generation metrics and error patterns
 *
 * Provides insight into:
 * - Success/failure rates by generation type
 * - Average attempt counts (measures prompt effectiveness)
 * - Common error patterns (guides prompt improvements)
 * - Generation duration tracking
 * - Per-prompt-version performance metrics
 */

export type GenerationType = "node" | "workflow" | "trigger";

export interface GenerationEvent {
	/** Unique ID for this generation event */
	id: string;
	/** Timestamp of the generation */
	timestamp: string;
	/** Type of generation: node, workflow, or trigger */
	type: GenerationType;
	/** Specific subtype (e.g., node style "function"/"class", trigger type "queue"/"cron") */
	subtype: string;
	/** Name of the generated artifact */
	name: string;
	/** Whether the generation produced valid output */
	success: boolean;
	/** Number of attempts used (1-3) */
	attempts: number;
	/** Duration in milliseconds */
	durationMs: number;
	/** Validation errors encountered (across all attempts) */
	errors: string[];
	/** Prompt version used */
	promptVersion: string;
}

export interface GenerationStats {
	/** Total generations attempted */
	totalGenerations: number;
	/** Successful generations */
	successCount: number;
	/** Failed generations (exhausted all attempts) */
	failureCount: number;
	/** Success rate as percentage (0-100) */
	successRate: number;
	/** Average number of attempts per generation */
	averageAttempts: number;
	/** Average duration in milliseconds */
	averageDurationMs: number;
	/** Most common error patterns (sorted by frequency) */
	topErrors: Array<{ pattern: string; count: number }>;
	/** Stats broken down by generation type */
	byType: Record<GenerationType, TypeStats>;
}

export interface TypeStats {
	total: number;
	success: number;
	failure: number;
	successRate: number;
	averageAttempts: number;
}

/**
 * In-memory analytics tracker for AI code generation
 *
 * Events are stored in memory for the duration of the CLI session.
 * Can be serialized to JSON for persistence if needed.
 */
export class GenerationAnalytics {
	private events: GenerationEvent[] = [];
	private static instance: GenerationAnalytics | null = null;

	static getInstance(): GenerationAnalytics {
		if (!GenerationAnalytics.instance) {
			GenerationAnalytics.instance = new GenerationAnalytics();
		}
		return GenerationAnalytics.instance;
	}

	/**
	 * Record a generation event
	 */
	recordEvent(event: Omit<GenerationEvent, "id" | "timestamp">): GenerationEvent {
		const fullEvent: GenerationEvent = {
			...event,
			id: this.generateId(),
			timestamp: new Date().toISOString(),
		};
		this.events.push(fullEvent);
		return fullEvent;
	}

	/**
	 * Create a timer for tracking generation duration
	 */
	startTimer(): () => number {
		const start = performance.now();
		return () => Math.round(performance.now() - start);
	}

	/**
	 * Get comprehensive statistics
	 */
	getStats(): GenerationStats {
		const total = this.events.length;

		if (total === 0) {
			return {
				totalGenerations: 0,
				successCount: 0,
				failureCount: 0,
				successRate: 0,
				averageAttempts: 0,
				averageDurationMs: 0,
				topErrors: [],
				byType: {
					node: { total: 0, success: 0, failure: 0, successRate: 0, averageAttempts: 0 },
					workflow: { total: 0, success: 0, failure: 0, successRate: 0, averageAttempts: 0 },
					trigger: { total: 0, success: 0, failure: 0, successRate: 0, averageAttempts: 0 },
				},
			};
		}

		const successCount = this.events.filter((e) => e.success).length;
		const failureCount = total - successCount;
		const totalAttempts = this.events.reduce((sum, e) => sum + e.attempts, 0);
		const totalDuration = this.events.reduce((sum, e) => sum + e.durationMs, 0);

		return {
			totalGenerations: total,
			successCount,
			failureCount,
			successRate: Math.round((successCount / total) * 100),
			averageAttempts: Math.round((totalAttempts / total) * 10) / 10,
			averageDurationMs: Math.round(totalDuration / total),
			topErrors: this.getTopErrors(),
			byType: {
				node: this.getTypeStats("node"),
				workflow: this.getTypeStats("workflow"),
				trigger: this.getTypeStats("trigger"),
			},
		};
	}

	/**
	 * Get stats for a specific generation type
	 */
	private getTypeStats(type: GenerationType): TypeStats {
		const typeEvents = this.events.filter((e) => e.type === type);
		const total = typeEvents.length;

		if (total === 0) {
			return { total: 0, success: 0, failure: 0, successRate: 0, averageAttempts: 0 };
		}

		const success = typeEvents.filter((e) => e.success).length;
		const failure = total - success;
		const totalAttempts = typeEvents.reduce((sum, e) => sum + e.attempts, 0);

		return {
			total,
			success,
			failure,
			successRate: Math.round((success / total) * 100),
			averageAttempts: Math.round((totalAttempts / total) * 10) / 10,
		};
	}

	/**
	 * Get the most common error patterns across all generations
	 */
	private getTopErrors(): Array<{ pattern: string; count: number }> {
		const errorCounts = new Map<string, number>();

		for (const event of this.events) {
			for (const error of event.errors) {
				// Normalize error patterns (remove specific values)
				const pattern = this.normalizeErrorPattern(error);
				errorCounts.set(pattern, (errorCounts.get(pattern) || 0) + 1);
			}
		}

		return Array.from(errorCounts.entries())
			.map(([pattern, count]) => ({ pattern, count }))
			.sort((a, b) => b.count - a.count)
			.slice(0, 10);
	}

	/**
	 * Normalize error messages to extract common patterns
	 */
	private normalizeErrorPattern(error: string): string {
		return error
			.replace(/TS\d+/, "TS****") // Normalize TypeScript error codes
			.replace(/"[^"]*"/, '"..."') // Normalize quoted strings
			.replace(/'\S+'/, "'...'") // Normalize single-quoted strings
			.replace(/line \d+/, "line N") // Normalize line numbers
			.replace(/column \d+/, "column N") // Normalize column numbers
			.replace(/at index \d+/, "at index N") // Normalize indices
			.trim();
	}

	/**
	 * Get events filtered by criteria
	 */
	getEvents(filter?: {
		type?: GenerationType;
		success?: boolean;
		since?: string;
	}): GenerationEvent[] {
		let filtered = [...this.events];

		if (filter?.type) {
			filtered = filtered.filter((e) => e.type === filter.type);
		}
		if (filter?.success !== undefined) {
			filtered = filtered.filter((e) => e.success === filter.success);
		}
		if (filter?.since) {
			filtered = filtered.filter((e) => e.timestamp >= filter.since!);
		}

		return filtered;
	}

	/**
	 * Get first-attempt success rate (measures prompt quality)
	 */
	getFirstAttemptSuccessRate(): number {
		if (this.events.length === 0) return 0;
		const firstAttemptSuccess = this.events.filter((e) => e.success && e.attempts === 1).length;
		return Math.round((firstAttemptSuccess / this.events.length) * 100);
	}

	/**
	 * Get success rate by prompt version
	 */
	getSuccessRateByPromptVersion(): Record<string, { total: number; success: number; rate: number }> {
		const byVersion: Record<string, { total: number; success: number }> = {};

		for (const event of this.events) {
			if (!byVersion[event.promptVersion]) {
				byVersion[event.promptVersion] = { total: 0, success: 0 };
			}
			byVersion[event.promptVersion].total++;
			if (event.success) {
				byVersion[event.promptVersion].success++;
			}
		}

		const result: Record<string, { total: number; success: number; rate: number }> = {};
		for (const [version, stats] of Object.entries(byVersion)) {
			result[version] = {
				...stats,
				rate: Math.round((stats.success / stats.total) * 100),
			};
		}

		return result;
	}

	/**
	 * Serialize all events to JSON for persistence
	 */
	toJSON(): string {
		return JSON.stringify({
			events: this.events,
			stats: this.getStats(),
			exportedAt: new Date().toISOString(),
		}, null, 2);
	}

	/**
	 * Import events from JSON
	 */
	fromJSON(json: string): void {
		const data = JSON.parse(json);
		if (data.events && Array.isArray(data.events)) {
			this.events.push(...data.events);
		}
	}

	/**
	 * Clear all events (useful for testing)
	 */
	clear(): void {
		this.events = [];
	}

	/**
	 * Reset the singleton instance (for testing)
	 */
	static resetInstance(): void {
		GenerationAnalytics.instance = null;
	}

	private generateId(): string {
		return `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	}
}

export default GenerationAnalytics;
