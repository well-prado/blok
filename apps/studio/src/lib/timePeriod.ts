// @ts-nocheck
import type { TimePeriod } from "./filterTypes";

const RELATIVE_REGEX = /^(\d+)([mhd])$/;

export function parsePeriodString(s: string): TimePeriod | null {
	const match = s.trim().toLowerCase().match(RELATIVE_REGEX);
	if (!match) return null;
	const val = Number.parseInt(match[1], 10);
	if (Number.isNaN(val) || val <= 0) return null;
	return { type: "relative", value: s.trim().toLowerCase() };
}

export function periodToDateRange(period: TimePeriod, now = new Date()): { from: Date; to: Date } {
	if (period.type === "absolute") {
		return { from: new Date(period.from), to: new Date(period.to) };
	}

	const match = period.value.match(RELATIVE_REGEX);
	if (!match) {
		const from = new Date(now.getTime() - 60 * 60 * 1000);
		return { from, to: now };
	}

	const val = Number.parseInt(match[1], 10);
	const unit = match[2];

	let ms = 0;
	if (unit === "m") ms = val * 60 * 1000;
	else if (unit === "h") ms = val * 60 * 60 * 1000;
	else if (unit === "d") ms = val * 24 * 60 * 60 * 1000;

	return {
		from: new Date(now.getTime() - ms),
		to: now,
	};
}

export function formatTimePeriod(period: TimePeriod): string {
	if (period.type === "relative") {
		return `Last ${period.value}`;
	}

	const fromDate = new Date(period.from);
	const toDate = new Date(period.to);

	return `${fromDate.toLocaleString()} - ${toDate.toLocaleString()}`;
}

export function toDateTimeLocalString(d: Date): string {
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
