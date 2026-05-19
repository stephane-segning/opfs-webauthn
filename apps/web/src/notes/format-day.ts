/**
 * Render a day-bucket integer (`floor(unixSeconds / 86_400)`) as a
 * relative human string. Day-quantised by design — ADR 0004 — so we
 * never show a precise timestamp from disk.
 *
 * Buckets are computed in UTC; absolute dates render in UTC too so
 * users west of UTC don't see a one-day shift back for older notes.
 */

const SECONDS_PER_DAY = 86_400;

const unixDay = (epochMs: number): number =>
	Math.floor(epochMs / 1000 / SECONDS_PER_DAY);

export function formatDayBucket(
	day: number,
	now: number = Date.now(),
	locale = "en",
): string {
	const today = unixDay(now);
	const delta = today - day;
	if (delta <= 0) return "today";
	if (delta === 1) return "yesterday";
	if (delta < 7) return `${delta} days ago`;
	const dayDate = new Date(day * SECONDS_PER_DAY * 1000);
	const showYear = dayDate.getUTCFullYear() !== new Date(now).getUTCFullYear();
	return dayDate.toLocaleDateString(locale, {
		timeZone: "UTC",
		month: "short",
		day: "numeric",
		year: showYear ? "numeric" : undefined,
	});
}
