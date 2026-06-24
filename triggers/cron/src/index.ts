/**
 * @blokjs/trigger-cron
 *
 * Cron/scheduled trigger for Blok workflows.
 * Execute workflows on a schedule using cron expressions.
 *
 * Features:
 * - Standard cron expression syntax
 * - Timezone-aware scheduling
 * - Overlap prevention
 * - Manual trigger support
 * - Job management API
 *
 * @example
 * ```typescript
 * import { CronTrigger } from "@blokjs/trigger-cron";
 *
 * class MyCronTrigger extends CronTrigger {
 *   protected nodes = myNodes;
 *   protected workflows = myWorkflows;
 * }
 *
 * const trigger = new MyCronTrigger();
 * await trigger.listen();
 *
 * // List all scheduled jobs
 * const jobs = trigger.getJobs();
 *
 * // Manually trigger a job
 * await trigger.triggerJob("cron-my-workflow-abc123");
 * ```
 *
 * Workflow Definition:
 * ```typescript
 * workflow({
 *   name: "daily-cleanup",
 *   version: "1.0.0",
 *   trigger: {
 *     cron: {
 *       schedule: "0 2 * * *",  // Run at 2 AM daily
 *       timezone: "America/New_York",
 *       overlap: false,
 *     },
 *   },
 *   steps: [ ... ],
 * });
 * ```
 *
 * Cron Expression Format:
 * ```
 * * * * * * *
 * │ │ │ │ │ │
 * │ │ │ │ │ └── Day of week (0-7, Sun=0,7)
 * │ │ │ │ └──── Month (1-12)
 * │ │ │ └────── Day of month (1-31)
 * │ │ └──────── Hour (0-23)
 * │ └────────── Minute (0-59)
 * └──────────── Second (0-59, optional)
 * ```
 *
 * Common schedules:
 * - "* * * * *" - Every minute
 * - "0 * * * *" - Every hour
 * - "0 0 * * *" - Every day at midnight
 * - "0 0 * * 0" - Every Sunday at midnight
 * - "0 0 1 * *" - First day of every month
 */

// Core exports
export {
	CronTrigger,
	type ScheduledJob,
	type CronExecutionContext,
} from "./CronTrigger";

// Re-export types from helper for convenience
export type { CronTriggerOpts } from "@blokjs/helper";
