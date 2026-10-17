/** Wall-clock UTC timestamp as `YYYY-MM-DDTHH:MM:SSZ`. Used only for session expiry and similar plumbing. */
export function nowIso(now: Date = new Date()): string {
	return now.toISOString().replace(/\.\d+Z$/, "Z");
}
