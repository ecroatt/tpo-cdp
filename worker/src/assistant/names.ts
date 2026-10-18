import { canonicalText } from "./scrub";

/** The letter runs of the lowercased question. */
function wordsOf(question: string): string[] {
	return canonicalText(question).toLowerCase().match(/\p{L}+/gu) ?? [];
}

/**
 * The email local-part starts that a first and last name can make: "a.b", "a_b" and "ab" for each adjacent pair.
 * A start counts only when a digit or the "@" follows it directly (see the range below).
 */
function candidates(words: string[]): string[] {
	const found = new Set<string>();
	for (let i = 0; i + 1 < words.length; i++) {
		const [a, b] = [words[i], words[i + 1]];
		found.add(`${a}.${b}`);
		found.add(`${a}_${b}`);
		found.add(`${a}${b}`);
	}
	return [...found];
}

/**
 * True when two adjacent words in the question are the first and last name from a stored email's local part.
 *
 * For a candidate `c`, the range `email_norm >= c || '0' AND email_norm < c || 'A'` holds exactly the emails that
 * start with `c` followed by a digit or "@" (the characters between "0" and "A" are the digits, ":;<=>?" and "@").
 * The candidates travel as one JSON array parameter read by json_each, so the statement binds a single value
 * however long the question is, and each candidate is an index range on the unique index of profiles.email_norm:
 * only the matching rows are read.
 */
export async function questionNamesSomeone(db: D1Database, question: string): Promise<boolean> {
	const all = candidates(wordsOf(question));
	if (all.length === 0) return false;
	const hit = await db
		.prepare(
			"SELECT 1 AS hit FROM json_each(?) AS c JOIN profiles AS p " +
				"ON p.email_norm >= c.value || '0' AND p.email_norm < c.value || 'A' LIMIT 1",
		)
		.bind(JSON.stringify(all))
		.first();
	return hit !== null;
}
