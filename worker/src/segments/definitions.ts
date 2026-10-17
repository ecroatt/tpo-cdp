import { LAST_30_START, TODAY, daysBetween } from "../lib/time";

export interface SubscriberFacts {
	status: string | null;
	signup_date: string | null;
	last_open_date: string | null;
}

/**
 * The Cold definition (SPEC section 0): active, and last opened before the 30-day window, or never opened
 * and signed up before it. The SQL twin is COLD_SQL in filters.ts; a test keeps the two in agreement.
 */
export function isCold(s: SubscriberFacts): boolean {
	if (s.status !== "active") return false;
	if (s.last_open_date !== null) return s.last_open_date < LAST_30_START;
	return s.signup_date !== null && s.signup_date < LAST_30_START;
}

/** Days from the last open to TODAY, or null when the person never opened. */
export function daysSinceOpen(lastOpen: string | null): number | null {
	return lastOpen === null ? null : daysBetween(lastOpen, TODAY);
}
