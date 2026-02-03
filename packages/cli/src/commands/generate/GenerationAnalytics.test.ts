/**
 * GenerationAnalytics Tests
 *
 * Tests the analytics tracking system for AI code generation metrics
 */

import { beforeEach, describe, expect, it } from "vitest";
import { GenerationAnalytics } from "./GenerationAnalytics.js";

describe("GenerationAnalytics", () => {
	let analytics: GenerationAnalytics;

	beforeEach(() => {
		GenerationAnalytics.resetInstance();
		analytics = GenerationAnalytics.getInstance();
		analytics.clear();
	});

	describe("singleton pattern", () => {
		it("should return the same instance", () => {
			const a = GenerationAnalytics.getInstance();
			const b = GenerationAnalytics.getInstance();
			expect(a).toBe(b);
		});

		it("should create new instance after reset", () => {
			const a = GenerationAnalytics.getInstance();
			GenerationAnalytics.resetInstance();
			const b = GenerationAnalytics.getInstance();
			expect(a).not.toBe(b);
		});
	});

	describe("recordEvent", () => {
		it("should record a generation event and return it with id and timestamp", () => {
			const event = analytics.recordEvent({
				type: "node",
				subtype: "function",
				name: "fetch-user",
				success: true,
				attempts: 1,
				durationMs: 2500,
				errors: [],
				promptVersion: "create-fn-node@2.0.0",
			});

			expect(event.id).toBeTruthy();
			expect(event.id).toMatch(/^gen_/);
			expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(event.type).toBe("node");
			expect(event.success).toBe(true);
		});

		it("should track multiple events", () => {
			analytics.recordEvent({
				type: "node",
				subtype: "function",
				name: "node1",
				success: true,
				attempts: 1,
				durationMs: 1000,
				errors: [],
				promptVersion: "v1",
			});
			analytics.recordEvent({
				type: "workflow",
				subtype: "http",
				name: "wf1",
				success: false,
				attempts: 3,
				durationMs: 5000,
				errors: ["Error 1"],
				promptVersion: "v1",
			});

			const events = analytics.getEvents();
			expect(events.length).toBe(2);
		});
	});

	describe("getStats - empty", () => {
		it("should return zero stats when no events recorded", () => {
			const stats = analytics.getStats();
			expect(stats.totalGenerations).toBe(0);
			expect(stats.successCount).toBe(0);
			expect(stats.failureCount).toBe(0);
			expect(stats.successRate).toBe(0);
			expect(stats.averageAttempts).toBe(0);
			expect(stats.averageDurationMs).toBe(0);
			expect(stats.topErrors).toEqual([]);
		});
	});

	describe("getStats - with data", () => {
		beforeEach(() => {
			// 3 successes, 1 failure
			analytics.recordEvent({
				type: "node",
				subtype: "function",
				name: "n1",
				success: true,
				attempts: 1,
				durationMs: 1000,
				errors: [],
				promptVersion: "v1",
			});
			analytics.recordEvent({
				type: "node",
				subtype: "function",
				name: "n2",
				success: true,
				attempts: 2,
				durationMs: 3000,
				errors: ["Missing import"],
				promptVersion: "v1",
			});
			analytics.recordEvent({
				type: "workflow",
				subtype: "http",
				name: "w1",
				success: true,
				attempts: 1,
				durationMs: 2000,
				errors: [],
				promptVersion: "v2",
			});
			analytics.recordEvent({
				type: "trigger",
				subtype: "queue",
				name: "t1",
				success: false,
				attempts: 3,
				durationMs: 8000,
				errors: ["Missing TriggerBase", "Missing createContext"],
				promptVersion: "v1",
			});
		});

		it("should calculate correct totals", () => {
			const stats = analytics.getStats();
			expect(stats.totalGenerations).toBe(4);
			expect(stats.successCount).toBe(3);
			expect(stats.failureCount).toBe(1);
		});

		it("should calculate correct success rate", () => {
			const stats = analytics.getStats();
			expect(stats.successRate).toBe(75);
		});

		it("should calculate correct average attempts", () => {
			const stats = analytics.getStats();
			// (1 + 2 + 1 + 3) / 4 = 1.75
			expect(stats.averageAttempts).toBe(1.8);
		});

		it("should calculate correct average duration", () => {
			const stats = analytics.getStats();
			// (1000 + 3000 + 2000 + 8000) / 4 = 3500
			expect(stats.averageDurationMs).toBe(3500);
		});

		it("should provide per-type breakdown", () => {
			const stats = analytics.getStats();

			expect(stats.byType.node.total).toBe(2);
			expect(stats.byType.node.success).toBe(2);
			expect(stats.byType.node.successRate).toBe(100);

			expect(stats.byType.workflow.total).toBe(1);
			expect(stats.byType.workflow.success).toBe(1);
			expect(stats.byType.workflow.successRate).toBe(100);

			expect(stats.byType.trigger.total).toBe(1);
			expect(stats.byType.trigger.success).toBe(0);
			expect(stats.byType.trigger.successRate).toBe(0);
		});

		it("should track top error patterns", () => {
			const stats = analytics.getStats();
			expect(stats.topErrors.length).toBeGreaterThan(0);
			// Errors should be sorted by frequency
			for (let i = 1; i < stats.topErrors.length; i++) {
				expect(stats.topErrors[i].count).toBeLessThanOrEqual(stats.topErrors[i - 1].count);
			}
		});
	});

	describe("getEvents - filtering", () => {
		beforeEach(() => {
			analytics.recordEvent({
				type: "node",
				subtype: "function",
				name: "n1",
				success: true,
				attempts: 1,
				durationMs: 1000,
				errors: [],
				promptVersion: "v1",
			});
			analytics.recordEvent({
				type: "workflow",
				subtype: "http",
				name: "w1",
				success: false,
				attempts: 3,
				durationMs: 5000,
				errors: ["Error"],
				promptVersion: "v1",
			});
			analytics.recordEvent({
				type: "trigger",
				subtype: "queue",
				name: "t1",
				success: true,
				attempts: 2,
				durationMs: 3000,
				errors: ["Retried"],
				promptVersion: "v2",
			});
		});

		it("should filter by type", () => {
			const nodes = analytics.getEvents({ type: "node" });
			expect(nodes.length).toBe(1);
			expect(nodes[0].name).toBe("n1");
		});

		it("should filter by success", () => {
			const successes = analytics.getEvents({ success: true });
			expect(successes.length).toBe(2);

			const failures = analytics.getEvents({ success: false });
			expect(failures.length).toBe(1);
		});

		it("should filter by type and success combined", () => {
			const failedWorkflows = analytics.getEvents({ type: "workflow", success: false });
			expect(failedWorkflows.length).toBe(1);
			expect(failedWorkflows[0].name).toBe("w1");
		});

		it("should return all events when no filter", () => {
			const all = analytics.getEvents();
			expect(all.length).toBe(3);
		});
	});

	describe("getFirstAttemptSuccessRate", () => {
		it("should return 0 when no events", () => {
			expect(analytics.getFirstAttemptSuccessRate()).toBe(0);
		});

		it("should calculate first-attempt success rate correctly", () => {
			// 2 first-attempt successes out of 4 total
			analytics.recordEvent({
				type: "node",
				subtype: "function",
				name: "n1",
				success: true,
				attempts: 1,
				durationMs: 1000,
				errors: [],
				promptVersion: "v1",
			});
			analytics.recordEvent({
				type: "node",
				subtype: "function",
				name: "n2",
				success: true,
				attempts: 2,
				durationMs: 3000,
				errors: [],
				promptVersion: "v1",
			});
			analytics.recordEvent({
				type: "node",
				subtype: "function",
				name: "n3",
				success: true,
				attempts: 1,
				durationMs: 1000,
				errors: [],
				promptVersion: "v1",
			});
			analytics.recordEvent({
				type: "node",
				subtype: "function",
				name: "n4",
				success: false,
				attempts: 3,
				durationMs: 8000,
				errors: ["Error"],
				promptVersion: "v1",
			});

			expect(analytics.getFirstAttemptSuccessRate()).toBe(50);
		});
	});

	describe("getSuccessRateByPromptVersion", () => {
		it("should break down success rate by prompt version", () => {
			analytics.recordEvent({
				type: "node",
				subtype: "function",
				name: "n1",
				success: true,
				attempts: 1,
				durationMs: 1000,
				errors: [],
				promptVersion: "create-fn-node@1.0.0",
			});
			analytics.recordEvent({
				type: "node",
				subtype: "function",
				name: "n2",
				success: false,
				attempts: 3,
				durationMs: 5000,
				errors: ["Error"],
				promptVersion: "create-fn-node@1.0.0",
			});
			analytics.recordEvent({
				type: "node",
				subtype: "function",
				name: "n3",
				success: true,
				attempts: 1,
				durationMs: 1000,
				errors: [],
				promptVersion: "create-fn-node@2.0.0",
			});
			analytics.recordEvent({
				type: "node",
				subtype: "function",
				name: "n4",
				success: true,
				attempts: 2,
				durationMs: 3000,
				errors: [],
				promptVersion: "create-fn-node@2.0.0",
			});

			const rates = analytics.getSuccessRateByPromptVersion();

			expect(rates["create-fn-node@1.0.0"]).toBeDefined();
			expect(rates["create-fn-node@1.0.0"].total).toBe(2);
			expect(rates["create-fn-node@1.0.0"].rate).toBe(50);

			expect(rates["create-fn-node@2.0.0"]).toBeDefined();
			expect(rates["create-fn-node@2.0.0"].total).toBe(2);
			expect(rates["create-fn-node@2.0.0"].rate).toBe(100);
		});
	});

	describe("serialization", () => {
		it("should serialize to JSON", () => {
			analytics.recordEvent({
				type: "node",
				subtype: "function",
				name: "n1",
				success: true,
				attempts: 1,
				durationMs: 1000,
				errors: [],
				promptVersion: "v1",
			});

			const json = analytics.toJSON();
			const parsed = JSON.parse(json);

			expect(parsed.events).toBeDefined();
			expect(parsed.events.length).toBe(1);
			expect(parsed.stats).toBeDefined();
			expect(parsed.exportedAt).toBeTruthy();
		});

		it("should import from JSON", () => {
			const exportData = {
				events: [
					{
						id: "gen_imported_1",
						timestamp: "2026-01-28T00:00:00Z",
						type: "node",
						subtype: "function",
						name: "imported-node",
						success: true,
						attempts: 1,
						durationMs: 1000,
						errors: [],
						promptVersion: "v1",
					},
				],
			};

			analytics.fromJSON(JSON.stringify(exportData));

			const events = analytics.getEvents();
			expect(events.length).toBe(1);
			expect(events[0].name).toBe("imported-node");
		});
	});

	describe("startTimer", () => {
		it("should measure duration", async () => {
			const getElapsed = analytics.startTimer();

			// Wait a small amount of time
			await new Promise((resolve) => setTimeout(resolve, 50));

			const elapsed = getElapsed();
			expect(elapsed).toBeGreaterThanOrEqual(40); // Allow some tolerance
			expect(elapsed).toBeLessThan(200);
		});
	});

	describe("error pattern normalization", () => {
		it("should normalize TypeScript error codes in top errors", () => {
			analytics.recordEvent({
				type: "node",
				subtype: "function",
				name: "n1",
				success: false,
				attempts: 3,
				durationMs: 5000,
				errors: ['TS2304: Cannot find name "defineNode"', "TS2307: Cannot find module '@blokjs/runner'"],
				promptVersion: "v1",
			});
			analytics.recordEvent({
				type: "node",
				subtype: "function",
				name: "n2",
				success: false,
				attempts: 3,
				durationMs: 5000,
				errors: ['TS2304: Cannot find name "z"'],
				promptVersion: "v1",
			});

			const stats = analytics.getStats();
			// TS2304 errors should be normalized to the same pattern
			const ts2304 = stats.topErrors.filter((e) => e.pattern.includes("TS****"));
			expect(ts2304.length).toBeGreaterThan(0);
		});
	});

	describe("clear", () => {
		it("should clear all events", () => {
			analytics.recordEvent({
				type: "node",
				subtype: "function",
				name: "n1",
				success: true,
				attempts: 1,
				durationMs: 1000,
				errors: [],
				promptVersion: "v1",
			});

			analytics.clear();

			const events = analytics.getEvents();
			expect(events.length).toBe(0);
		});
	});
});
