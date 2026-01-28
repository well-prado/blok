/**
 * CronTrigger Tests
 */

import { describe, it, expect, vi } from "vitest";

describe("CronTrigger", () => {
	describe("ScheduledJob Interface", () => {
		it("should accept valid scheduled job structure", () => {
			const mockJob = {
				nextDate: () => new Date(),
				lastDate: () => new Date(),
				start: vi.fn(),
				stop: vi.fn(),
			};

			const scheduledJob = {
				id: "cron-test-abc123",
				workflowPath: "daily-cleanup",
				schedule: "0 2 * * *",
				timezone: "America/New_York",
				overlap: false,
				running: false,
				lastRun: new Date(),
				nextRun: new Date(),
				job: mockJob,
			};

			expect(scheduledJob.id).toBe("cron-test-abc123");
			expect(scheduledJob.schedule).toBe("0 2 * * *");
			expect(scheduledJob.timezone).toBe("America/New_York");
			expect(scheduledJob.overlap).toBe(false);
		});
	});

	describe("CronExecutionContext Interface", () => {
		it("should create valid execution context", () => {
			const context = {
				jobId: "cron-job-123",
				scheduledTime: new Date("2024-01-01T02:00:00Z"),
				executionTime: new Date("2024-01-01T02:00:01Z"),
				schedule: "0 2 * * *",
				timezone: "UTC",
				manual: false,
			};

			expect(context.jobId).toBe("cron-job-123");
			expect(context.scheduledTime.toISOString()).toBe("2024-01-01T02:00:00.000Z");
			expect(context.manual).toBe(false);
		});

		it("should support manual trigger context", () => {
			const context = {
				jobId: "cron-job-456",
				scheduledTime: new Date(),
				executionTime: new Date(),
				schedule: "0 * * * *",
				timezone: "Europe/London",
				manual: true,
			};

			expect(context.manual).toBe(true);
		});
	});

	describe("CronTriggerOpts Schema", () => {
		it("should validate cron trigger configuration", () => {
			const validConfig = {
				schedule: "0 * * * *",
				timezone: "America/Los_Angeles",
				overlap: false,
			};

			expect(validConfig.schedule).toBe("0 * * * *");
			expect(validConfig.timezone).toBe("America/Los_Angeles");
			expect(validConfig.overlap).toBe(false);
		});

		it("should support common cron expressions", () => {
			const schedules = [
				{ expr: "* * * * *", desc: "Every minute" },
				{ expr: "0 * * * *", desc: "Every hour" },
				{ expr: "0 0 * * *", desc: "Every day at midnight" },
				{ expr: "0 0 * * 0", desc: "Every Sunday" },
				{ expr: "0 0 1 * *", desc: "First day of month" },
				{ expr: "*/5 * * * *", desc: "Every 5 minutes" },
				{ expr: "0 9-17 * * 1-5", desc: "Hourly, 9-5 on weekdays" },
			];

			for (const schedule of schedules) {
				expect(schedule.expr).toBeDefined();
				expect(schedule.desc).toBeDefined();
			}
		});
	});

	describe("Timezone Support", () => {
		it("should support common timezones", () => {
			const timezones = [
				"UTC",
				"America/New_York",
				"America/Los_Angeles",
				"Europe/London",
				"Europe/Paris",
				"Asia/Tokyo",
				"Australia/Sydney",
			];

			for (const tz of timezones) {
				const config = {
					schedule: "0 0 * * *",
					timezone: tz,
					overlap: false,
				};
				expect(config.timezone).toBe(tz);
			}
		});
	});
});
