/**
 * Patterns for the private values that must never reach the model. The same patterns are used twice:
 * scrubQuestion replaces them in the user's question, and sendToModel scans the whole request body for them.
 * Every regex is built fresh per call, so no lastIndex state is shared between calls.
 */

/** An email address: local part, "@", dotted domain. Letters, marks and digits of any script. Used with the u flag. */
export const EMAIL_PATTERN = "[\\p{L}\\p{M}\\p{N}._%+\\-]+@[\\p{L}\\p{M}\\p{N}\\-]+(?:\\.[\\p{L}\\p{M}\\p{N}\\-]+)*";

/**
 * The ID shapes in the data: u_ (app user), d_ (device), v_ (visitor) and 32-hex profile ids.
 * The u_/d_/v_ pattern also takes "_" and "-" after the prefix and needs no word boundary before it
 * ("x_u_2b6447a3" counts), only that it does not start in the middle of a word ("opened_days" is not an id).
 */
export const ID_PATTERNS = ["(?<![A-Za-z0-9])[udv]_[A-Za-z0-9_-]+", "(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])"];

/** Invisible characters that can be hidden inside an address: format characters and default-ignorable code points. */
const IGNORABLE = "[\\p{Cf}\\p{Default_Ignorable_Code_Point}]";

/**
 * Forms of an email that the plain pattern misses: an "@" that is left over, %40, &#64; or &#x40;, a typed
 * backslash-u0040, "(at)" / "[at]" / "(dot)" / "[dot]", and the spelled-out "jane at gmail dot com".
 */
const DISGUISED_EMAIL_PATTERNS = [
	"@",
	"%40",
	"&#0*64(?![0-9])",
	"&#x0*40(?![0-9a-f])",
	"\\\\+u0040",
	"[(\\[{<]\\s*at\\s*[)\\]}>]",
	"[(\\[{<]\\s*dot\\s*[)\\]}>]",
	"\\bat\\s+[a-z0-9\\-]+\\s+dot\\s+[a-z]{2,}\\b",
	"\\bat\\s+[a-z0-9\\-]+\\.[a-z]{2,}\\b",
];

/** NFKC (a fullwidth "＠" becomes "@") with the invisible characters removed. */
export function canonicalText(text: string): string {
	return text.normalize("NFKC").replace(new RegExp(IGNORABLE, "gu"), "");
}

/** True when `text` holds an email written in a way the plain pattern misses (see DISGUISED_EMAIL_PATTERNS). */
export function hasDisguisedEmail(text: string): boolean {
	const clean = canonicalText(text);
	return DISGUISED_EMAIL_PATTERNS.some((pattern) => new RegExp(pattern, "i").test(clean));
}

/** True when `text` holds an email (plain or disguised) or one of the ID shapes. */
export function containsPrivateValue(text: string): boolean {
	const clean = canonicalText(text);
	if (new RegExp(EMAIL_PATTERN, "u").test(clean)) return true;
	if (ID_PATTERNS.some((pattern) => new RegExp(pattern, "i").test(clean))) return true;
	return hasDisguisedEmail(clean);
}

/** Replaces emails with [email] and ids with [id], after NFKC and removal of invisible characters. Everything else is left as typed. */
export function scrubQuestion(question: string): string {
	let out = canonicalText(question).replace(new RegExp(EMAIL_PATTERN, "gu"), "[email]");
	for (const pattern of ID_PATTERNS) out = out.replace(new RegExp(pattern, "gi"), "[id]");
	return out;
}
