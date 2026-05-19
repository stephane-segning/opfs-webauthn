/**
 * Render a day-bucket integer (`floor(unixSeconds / 86_400)`) as a
 * relative human string. Day-quantised by design — ADR 0004 — so we
 * never show a precise timestamp from disk.
 */

const SECONDS_PER_DAY = 86_400;

export function formatDayBucket(
	day: number,
	now: number = Date.now(),
	locale = "en",
): string {
	const today = Math.floor(now / 1000 / SECONDS_PER_DAY);
	const delta = today - day;
	if (delta <= 0) return "today";
	if (delta === 1) return "yesterday";
	if (delta < 7) return `${delta} days ago`;
	const date = new Date(day * SECONDS_PER_DAY * 1000);
	return date.toLocaleDateString(locale, {
		month: "short",
		day: "numeric",
		year:
			date.getUTCFullYear() === new Date(now).getUTCFullYear()
				? undefined
				: "numeric",
	});
}
