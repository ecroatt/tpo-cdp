// Fills the question box from ?q= on the Assistant page. It only sets the text: the user presses Ask.

const MAX_QUESTION_LENGTH = 500;

/** Sets `textarea.value` to the first 500 characters of the `q` parameter in `search`, if it is non-empty. */
export function prefillQuestion(search, textarea) {
	const q = new URLSearchParams(search).get("q");
	if (q) textarea.value = q.slice(0, MAX_QUESTION_LENGTH);
}
