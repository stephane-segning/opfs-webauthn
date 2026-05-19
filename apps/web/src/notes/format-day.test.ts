import { describe, expect, it } from "vitest";

import { formatDayBucket } from "./format-day";

const DAY_MS = 86_400_000;

function dayBucket(unixMs: number): number {
	return Math.floor(unixMs / DAY_MS);
}

describe("formatDayBucket", () => {
	it("returns 'today' for the current bucket", () => {
		const now = Date.parse("2026-05-19T12:00:00Z");
		expect(formatDayBucket(dayBucket(now), now)).toBe("today");
	});

	it("returns 'yesterday' for a 1-day delta", () => {
		const now = Date.parse("2026-05-19T12:00:00Z");
		expect(formatDayBucket(dayBucket(now) - 1, now)).toBe("yesterday");
	});

	it("returns 'N days ago' for buckets 2..6 days old", () => {
		const now = Date.parse("2026-05-19T12:00:00Z");
		for (let delta = 2; delta < 7; delta++) {
			expect(formatDayBucket(dayBucket(now) - delta, now)).toBe(
				`${delta} days ago`,
			);
		}
	});

	it("formats older buckets as a UTC calendar date (no off-by-one west of UTC)", () => {
		// A bucket that lands at UTC midnight; rendered in a local
		// timezone with `toLocaleDateString` and no `timeZone` option,
		// this would read "May 1" for west-of-UTC clients. Forcing UTC
		// keeps the displayed date matching the bucket.
		const day = dayBucket(Date.UTC(2026, 4, 2)); // 2026-05-02
		const now = Date.parse("2026-05-19T12:00:00Z");
		const out = formatDayBucket(day, now, "en-US");
		expect(out).toBe("May 2");
	});

	it("appends the year when the bucket is from another year", () => {
		const day = dayBucket(Date.UTC(2025, 2, 15)); // 2025-03-15
		const now = Date.parse("2026-05-19T12:00:00Z");
		const out = formatDayBucket(day, now, "en-US");
		expect(out).toMatch(/2025/);
		expect(out).toMatch(/Mar/);
	});
});
