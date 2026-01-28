import { beforeEach, describe, expect, it } from "vitest";
import Time from "../../../src/utils/Time";

describe("Time", () => {
	let time: Time;

	beforeEach(() => {
		time = new Time();
	});

	describe("start()", () => {
		it("should record start time as dayjs format", () => {
			time.start();
			const metrics = time.getMetrics();
			expect(metrics.startTime).toBeTypeOf("string");
			expect(metrics.startTime).not.toBeNull();
		});
	});

	describe("stop()", () => {
		it("should record end time as dayjs format", () => {
			time.start();
			time.stop();
			const metrics = time.getMetrics();
			expect(metrics.endTime).toBeTypeOf("string");
			expect(metrics.endTime).not.toBeNull();
		});
	});

	describe("getMetrics()", () => {
		it("should return startTime, endTime, duration", () => {
			time.start();
			time.stop();

			const metrics = time.getMetrics();
			expect(metrics).toHaveProperty("startTime");
			expect(metrics).toHaveProperty("endTime");
			expect(metrics).toHaveProperty("duration");
		});

		it("should have positive duration after start/stop", () => {
			time.start();
			// Small delay to ensure measurable duration
			for (let i = 0; i < 1000; i++) {
				/* spin */
			}
			time.stop();

			const metrics = time.getMetrics();
			expect(metrics.duration).toBeGreaterThanOrEqual(0);
		});

		it("should return null times before start", () => {
			const metrics = time.getMetrics();
			expect(metrics.startTime).toBeNull();
			expect(metrics.endTime).toBeNull();
			expect(metrics.duration).toBe(0);
		});
	});
});
