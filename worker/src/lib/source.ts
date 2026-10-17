const SOURCE_ALIASES: Record<string, string> = { twitter: "x" };

/** One source map for subscriber acquisition_source and web utm_source. */
export function normalizeSource(value: string | null | undefined): string | null {
	if (value == null) return null;
	const cleaned = value.trim().toLowerCase();
	if (cleaned === "") return null;
	return SOURCE_ALIASES[cleaned] ?? cleaned;
}
