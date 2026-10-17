/** The single "today" for all business logic. Nothing else reads the wall clock for time windows. */
export const TODAY = "2026-09-28";

/** Calendar arithmetic on a YYYY-MM-DD string, in UTC. Never reads the wall clock. */
export function daysBefore(date: string, days: number): string {
	const ms = Date.parse(`${date}T00:00:00Z`) - days * 86_400_000;
	return new Date(ms).toISOString().slice(0, 10);
}

/** Whole days from `start` to `end` (both YYYY-MM-DD); positive when `end` is later. */
export function daysBetween(start: string, end: string): number {
	return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

/** "Last 30 days": dates >= this (SPEC section 0). No upper bound. */
export const LAST_30_START = daysBefore(TODAY, 30);
/** "Last 7 days": dates >= this (SPEC section 0 gives 2026-09-22, the 7 calendar days ending on TODAY). */
export const LAST_7_START = daysBefore(TODAY, 6);
