/**
 * Patterns for the private values that must never reach the model. The same patterns are used twice:
 * scrubQuestion replaces them in the user's question, and sendToModel scans the whole request body for them.
 */

/** An email address: local part, "@", dotted domain. */
export const EMAIL_PATTERN = "[A-Za-z0-9._%+\\-]+@[A-Za-z0-9\\-]+(?:\\.[A-Za-z0-9\\-]+)*";

/** The ID shapes in the data: u_ (app user), d_ (device), v_ (visitor) and 32-hex profile ids. */
export const ID_PATTERNS = ["\\b[udv]_[A-Za-z0-9]+\\b", "\\b[0-9a-f]{32}\\b"];

/** True when `text` holds an email or one of the ID shapes. Fresh regexes each call, so no lastIndex state is shared. */
export function containsPrivateValue(text: string): boolean {
	if (new RegExp(EMAIL_PATTERN).test(text)) return true;
	return ID_PATTERNS.some((pattern) => new RegExp(pattern, "i").test(text));
}

/** Replaces emails with [email] and ids with [id]. Everything else is left as typed. */
export function scrubQuestion(question: string): string {
	let out = question.replace(new RegExp(EMAIL_PATTERN, "g"), "[email]");
	for (const pattern of ID_PATTERNS) out = out.replace(new RegExp(pattern, "gi"), "[id]");
	return out;
}
