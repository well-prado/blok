// Cron schedules: reading one, and working out when it next happens. Nothing here waits or runs anything.
// Five fields, as in crontab: minute, hour, day of month, month, day of week.

export interface Schedule {
	minute: ReadonlySet<number>;
	hour: ReadonlySet<number>;
	day: ReadonlySet<number>;
	month: ReadonlySet<number>;
	/** 0 is Sunday. */
	weekday: ReadonlySet<number>;
	/** Whether the day of month and the day of week were left open with "*". */
	anyDay: boolean;
	anyWeekday: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const SHORT: Record<string, string> = {
	"@yearly": "0 0 1 1 *",
	"@annually": "0 0 1 1 *",
	"@monthly": "0 0 1 * *",
	"@weekly": "0 0 * * 0",
	"@daily": "0 0 * * *",
	"@midnight": "0 0 * * *",
	"@hourly": "0 * * * *",
};

function field(text: string, what: string, min: number, max: number, names?: string[]): Set<number> {
	const number = (raw: string): number => {
		const named = names?.indexOf(raw.toLowerCase()) ?? -1;
		const value = named >= 0 ? named + (names === MONTHS ? 1 : 0) : /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
		if (Number.isNaN(value)) throw new SyntaxError(`"${raw}" is not a ${what}`);
		if (value < min || value > max) throw new SyntaxError(`${what} ${raw} is outside ${min}-${max}`);
		return value;
	};
	const out = new Set<number>();
	for (const part of text.split(",")) {
		const [range, every, ...extra] = part.split("/");
		if (range === "" || extra.length > 0) throw new SyntaxError(`"${part}" is not a ${what}`);
		const step = every === undefined ? 1 : /^[1-9]\d*$/.test(every) ? Number(every) : Number.NaN;
		if (Number.isNaN(step)) throw new SyntaxError(`"${part}" has a step that is not a number above 0`);
		const [from, to, ...more] = range === "*" ? [String(min), String(max)] : range.split("-");
		if (more.length > 0 || to === "") throw new SyntaxError(`"${part}" is not a ${what}`);
		const start = number(from);
		// "5/15" means from 5 to the end, every 15.
		const end = to === undefined ? (every === undefined ? start : max) : number(to);
		if (end < start) throw new SyntaxError(`"${part}" runs backwards`);
		for (let value = start; value <= end; value += step) out.add(value);
	}
	return out;
}

/** Reads "0 2 * * *". Throws a SyntaxError that says which part is wrong. */
export function parseSchedule(text: string): Schedule {
	const fields = (SHORT[text.trim().toLowerCase()] ?? text).trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new SyntaxError(
			`it has ${fields.length} ${fields.length === 1 ? "part" : "parts"}, and a schedule has five: minute, hour, day of month, month, day of week`,
		);
	}
	const weekday = field(fields[4], "day of the week", 0, 7, WEEKDAYS);
	// Both 0 and 7 are Sunday.
	if (weekday.delete(7)) weekday.add(0);
	return {
		minute: field(fields[0], "minute", 0, 59),
		hour: field(fields[1], "hour", 0, 23),
		day: field(fields[2], "day of the month", 1, 31),
		month: field(fields[3], "month", 1, 12, MONTHS),
		weekday,
		anyDay: fields[2].startsWith("*"),
		anyWeekday: fields[4].startsWith("*"),
	};
}

const MINUTE = 60_000;
const formats = new Map<string, Intl.DateTimeFormat>();

/** Throws a RangeError when the name is not a time zone. */
export function timeZone(name: string): Intl.DateTimeFormat {
	let format = formats.get(name);
	if (!format) {
		format = new Intl.DateTimeFormat("en-US", {
			timeZone: name,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			weekday: "short",
		});
		formats.set(name, format);
	}
	return format;
}

interface Wall {
	month: number;
	day: number;
	weekday: number;
	hour: number;
	minute: number;
}
/** What a clock on the wall in that time zone shows at this moment. */
function wall(at: number, zone: string): Wall {
	if (zone === "UTC") {
		const date = new Date(at);
		return {
			month: date.getUTCMonth() + 1,
			day: date.getUTCDate(),
			weekday: date.getUTCDay(),
			hour: date.getUTCHours(),
			minute: date.getUTCMinutes(),
		};
	}
	const parts: Record<string, string> = {};
	for (const part of timeZone(zone).formatToParts(at)) parts[part.type] = part.value;
	return {
		month: Number(parts.month),
		day: Number(parts.day),
		weekday: WEEKDAYS.indexOf(parts.weekday.toLowerCase()),
		hour: Number(parts.hour),
		minute: Number(parts.minute),
	};
}

/**
 * The first moment after `after` that the schedule matches, to the minute.
 *
 * In a time zone that moves its clocks: a time the clocks skip does not run that day, and a time they
 * repeat runs twice. UTC, the default, has neither.
 */
export function nextRun(schedule: Schedule, after: Date, zone = "UTC"): Date {
	let at = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
	// Five years covers 29 February. A schedule with no match by then, such as 31 February, has none.
	const end = at + 5 * 366 * 24 * 60 * MINUTE;
	while (at < end) {
		const now = wall(at, zone);
		const day = schedule.day.has(now.day);
		const weekday = schedule.weekday.has(now.weekday);
		// As in crontab: when both the day of the month and the day of the week are given, either one is enough.
		const date =
			schedule.month.has(now.month) && (schedule.anyDay || schedule.anyWeekday ? day && weekday : day || weekday);
		if (!date) {
			// Jump to the next midnight on the wall. When the clocks moved on the way, land on the first minute of that day.
			const today = `${now.month}-${now.day}`;
			at += (24 * 60 - (now.hour * 60 + now.minute)) * MINUTE;
			const landed = wall(at, zone);
			if (`${landed.month}-${landed.day}` !== today && landed.hour * 60 + landed.minute > 0) {
				const there = `${landed.month}-${landed.day}`;
				for (
					let back = wall(at - MINUTE, zone);
					`${back.month}-${back.day}` === there;
					back = wall(at - MINUTE, zone)
				) {
					at -= MINUTE;
				}
			}
		} else if (!schedule.hour.has(now.hour)) at += (60 - now.minute) * MINUTE;
		else if (!schedule.minute.has(now.minute)) at += MINUTE;
		else return new Date(at);
	}
	throw new RangeError("it never happens");
}
