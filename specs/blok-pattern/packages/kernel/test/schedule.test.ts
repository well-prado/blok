// Reading a cron schedule and working out when it next happens.
import { expect, test } from "bun:test";
import { Cron } from "croner";
import { nextRun, parseSchedule } from "../src/schedule.ts";

const next = (text: string, after: string, zone?: string) =>
	nextRun(parseSchedule(text), new Date(after), zone).toISOString();
const why = (text: string) => {
	try {
		parseSchedule(text);
	} catch (err) {
		return (err as Error).message;
	}
};

test("a schedule is read the way crontab reads it", () => {
	// The next time is after the moment given, never that moment itself.
	expect(next("0 2 * * *", "2026-03-10T02:00:00Z")).toBe("2026-03-11T02:00:00.000Z");
	expect(next("0 2 * * *", "2026-03-10T01:59:59Z")).toBe("2026-03-10T02:00:00.000Z");
	// 13 March 2026 is a Friday, so after the last slot of the working week comes Monday morning.
	expect(next("*/15 9-17 * * mon-fri", "2026-03-13T17:45:00Z")).toBe("2026-03-16T09:00:00.000Z");
	expect(next("5/20 * * * *", "2026-03-10T00:26:00Z")).toBe("2026-03-10T00:45:00.000Z");
	expect(next("0 0 1 jan,jul *", "2026-03-10T00:00:00Z")).toBe("2026-07-01T00:00:00.000Z");
	expect(next("0 0 * * 7", "2026-03-10T00:00:00Z")).toBe("2026-03-15T00:00:00.000Z");
	expect(next("@daily", "2026-03-10T08:00:00Z")).toBe("2026-03-11T00:00:00.000Z");
	expect(next("@hourly", "2026-03-10T08:00:00Z")).toBe("2026-03-10T09:00:00.000Z");
	// The day of the month and the day of the week together mean either one: the first Friday, not Friday the 13th.
	expect(next("0 0 13 * fri", "2026-03-01T00:00:00Z")).toBe("2026-03-06T00:00:00.000Z");
	// A leap day is found, however far away.
	expect(next("0 0 29 2 *", "2026-03-01T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
});

test("a schedule that cannot be read says which part is wrong", () => {
	expect(why("0 2 * *")).toBe(
		"it has 4 parts, and a schedule has five: minute, hour, day of month, month, day of week",
	);
	expect(why("0 0 2 * * *")).toBe(
		"it has 6 parts, and a schedule has five: minute, hour, day of month, month, day of week",
	);
	expect(why("0 25 * * *")).toBe("hour 25 is outside 0-23");
	expect(why("0 0 0 * *")).toBe("day of the month 0 is outside 1-31");
	expect(why("*/0 * * * *")).toBe('"*/0" has a step that is not a number above 0');
	expect(why("0 0 * * funday")).toBe('"funday" is not a day of the week');
	expect(why("30-10 * * * *")).toBe('"30-10" runs backwards');
	expect(why("1,,2 * * * *")).toBe('"" is not a minute');
	expect(why("@sometimes")).toBe(
		"it has 1 part, and a schedule has five: minute, hour, day of month, month, day of week",
	);
	// It reads fine and names a day that does not exist.
	expect(() => nextRun(parseSchedule("0 0 31 2 *"), new Date(0))).toThrow("it never happens");
});

test("it agrees with an established cron library on common schedules, in three time zones", () => {
	const schedules = [
		"* * * * *",
		"*/5 * * * *",
		"0 * * * *",
		"30 4 * * *",
		"0 9-17 * * 1-5",
		"15 14 1 * *",
		"0 0 * * 0",
		"0 22 * * 1-5",
		"23 0-20/2 * * *",
		"5 4 * * sun",
		"0 0 1,15 * *",
		"0 12 * jan-mar mon",
		"59 23 31 12 *",
		"0 6 28-31 * *",
	];
	// Tokyo and São Paulo do not move their clocks. New York does, and these starts are far from the days it does.
	const zones = ["UTC", "Asia/Tokyo", "America/Sao_Paulo", "America/New_York"];
	const starts = ["2026-01-15T10:07:00Z", "2026-06-30T23:59:00Z", "2027-12-31T23:58:00Z", "2028-02-28T12:00:00Z"];
	let compared = 0;
	for (const text of schedules) {
		for (const zone of zones) {
			for (const start of starts) {
				const theirs = new Cron(text, { timezone: zone })
					.nextRuns(6, new Date(start))
					.map((date) => date.toISOString());
				const ours: string[] = [];
				let at = new Date(start);
				for (let i = 0; i < 6; i++) {
					at = nextRun(parseSchedule(text), at, zone);
					ours.push(at.toISOString());
				}
				expect({ text, zone, start, runs: ours }).toEqual({ text, zone, start, runs: theirs });
				compared += ours.length;
			}
		}
	}
	expect(compared).toBe(14 * 4 * 4 * 6);
});

test("where the clocks move: a skipped time does not run, a repeated time runs twice", () => {
	// New York, 8 March 2026: 02:00 becomes 03:00, so 02:30 does not happen that day.
	expect(next("30 2 * * *", "2026-03-07T12:00:00Z", "America/New_York")).toBe("2026-03-09T06:30:00.000Z");
	// New York, 1 November 2026: 02:00 becomes 01:00, so 01:30 happens twice, an hour apart.
	expect(next("30 1 * * *", "2026-10-31T12:00:00Z", "America/New_York")).toBe("2026-11-01T05:30:00.000Z");
	expect(next("30 1 * * *", "2026-11-01T05:30:00Z", "America/New_York")).toBe("2026-11-01T06:30:00.000Z");
	expect(next("30 1 * * *", "2026-11-01T06:30:00Z", "America/New_York")).toBe("2026-11-02T06:30:00.000Z");
	// Something that runs every hour keeps running every hour through both.
	expect(next("0 * * * *", "2026-11-01T05:00:00Z", "America/New_York")).toBe("2026-11-01T06:00:00.000Z");
	expect(next("0 * * * *", "2026-03-08T06:00:00Z", "America/New_York")).toBe("2026-03-08T07:00:00.000Z");

	// The day after a short day still starts at its first minute. 9 March 00:15 in New York is 04:15 UTC.
	expect(next("15 0 9 3 *", "2026-03-08T05:00:00Z", "America/New_York")).toBe("2026-03-09T04:15:00.000Z");
	// Havana moves its clocks at midnight, so 8 March 2026 has no 00:00 to 00:59. Its first minute is 01:00.
	expect(next("0 0 * * *", "2026-03-07T12:00:00Z", "America/Havana")).toBe("2026-03-09T04:00:00.000Z");
	expect(next("30 1 8 3 *", "2026-03-01T12:00:00Z", "America/Havana")).toBe("2026-03-08T05:30:00.000Z");

	expect(() => next("0 0 * * *", "2026-03-07T12:00:00Z", "Mars/Olympus")).toThrow(RangeError);
});
