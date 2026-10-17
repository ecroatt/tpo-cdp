/**
 * The only place emails are trimmed or lowercased.
 * Returns null for an empty value or one without exactly one "@".
 */
export function normalizeEmail(value: string | null | undefined): string | null {
	if (value == null) return null;
	const cleaned = value.trim().toLowerCase();
	if (cleaned === "") return null;
	if (cleaned.split("@").length !== 2) return null;
	return cleaned;
}

/** The raw email text as imported, or null when it is empty or only whitespace. Never alters the text. */
export function emailRawOrNull(value: string | null | undefined): string | null {
	if (value == null || value.trim() === "") return null;
	return value;
}
