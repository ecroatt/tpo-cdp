/**
 * Patterns for the private values that must never reach the model. The same patterns are used twice:
 * scrubQuestion replaces them in the user's question, and sendToModel scans the whole request body for them.
 * Every regex is built fresh per call, so no lastIndex state is shared between calls.
 */

/** An email address: local part, "@", dotted domain. */
export const EMAIL_PATTERN = "[A-Za-z0-9._%+\\-]+@[A-Za-z0-9\\-]+(?:\\.[A-Za-z0-9\\-]+)*";

/**
 * The ID shapes in the data: u_ (app user), d_ (device), v_ (visitor) and 32-hex profile ids.
 * The u_/d_/v_ pattern also takes "_" and "-" after the prefix and needs no word boundary before it
 * ("x_u_2b6447a3" counts), only that it does not start in the middle of a word ("opened_days" is not an id).
 */
export const ID_PATTERNS = ["(?<![A-Za-z0-9])[udv]_[A-Za-z0-9_-]+", "\\b[0-9a-f]{32}\\b"];

/** Zero-width characters that can be hidden inside an address: U+200B to U+200D, U+2060 and U+FEFF. */
const ZERO_WIDTH = "[\\u200B-\\u200D\\u2060\\uFEFF]";

/**
 * Forms of an email that the plain pattern misses: an "@" that is left over, %40, &#64; or &#x40;, a typed
 * backslash-u0040, "(at)" / "[at]" / "(dot)" / "[dot]", and the spelled-out "jane at gmail dot com".
 */
const DISGUISED_EMAIL_PATTERNS = [
	"@",
	"%40",
	"&#0*64;",
	"&#x0*40;",
	"\\\\+u0040",
	"[(\\[]\\s*at\\s*[)\\]]",
	"[(\\[]\\s*dot\\s*[)\\]]",
	"\\bat\\s+[a-z0-9\\-]+\\s+dot\\s+[a-z]{2,}\\b",
];

/** NFKC (a fullwidth "＠" becomes "@") with the zero-width characters removed. */
function canonical(text: string): string {
	return text.normalize("NFKC").replace(new RegExp(ZERO_WIDTH, "g"), "");
}

/** True when `text` holds an email written in a way the plain pattern misses (see DISGUISED_EMAIL_PATTERNS). */
export function hasDisguisedEmail(text: string): boolean {
	const clean = canonical(text);
	return DISGUISED_EMAIL_PATTERNS.some((pattern) => new RegExp(pattern, "i").test(clean));
}

/** True when `text` holds an email (plain or disguised) or one of the ID shapes. */
export function containsPrivateValue(text: string): boolean {
	const clean = canonical(text);
	if (new RegExp(EMAIL_PATTERN).test(clean)) return true;
	if (ID_PATTERNS.some((pattern) => new RegExp(pattern, "i").test(clean))) return true;
	return hasDisguisedEmail(clean);
}

/** Replaces emails with [email] and ids with [id], after NFKC and zero-width removal. Everything else is left as typed. */
export function scrubQuestion(question: string): string {
	let out = canonical(question).replace(new RegExp(EMAIL_PATTERN, "g"), "[email]");
	for (const pattern of ID_PATTERNS) out = out.replace(new RegExp(pattern, "gi"), "[id]");
	return out;
}
