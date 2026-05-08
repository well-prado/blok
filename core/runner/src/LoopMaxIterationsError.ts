/**
 * Thrown when a `loop` step exceeds its `maxIterations` cap. Distinct
 * from generic Error so callers can `instanceof` discriminate (e.g. to
 * route to a tryCatch.catch arm or surface a 500 vs a 408).
 */
export class LoopMaxIterationsError extends Error {
	public readonly stepId: string;
	public readonly maxIterations: number;
	public readonly actualIterations: number;

	constructor(stepId: string, maxIterations: number, actualIterations: number) {
		super(
			`Loop "${stepId}" exceeded maxIterations=${maxIterations} (ran ${actualIterations} times). This is a hard safety cap to prevent infinite loops. Increase the cap if your loop legitimately runs longer, or check the \`while\` condition.`,
		);
		this.name = "LoopMaxIterationsError";
		this.stepId = stepId;
		this.maxIterations = maxIterations;
		this.actualIterations = actualIterations;
	}
}
