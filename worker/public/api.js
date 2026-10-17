// Shared helpers for every page. Data is only ever written with textContent or createElement.

export async function getJson(path) {
	const response = await fetch(path, { headers: { Accept: "application/json" } });
	return { status: response.status, body: await response.json().catch(() => ({})) };
}

export async function postJson(path, payload) {
	const response = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify(payload),
	});
	return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** Builds an element with text content (never markup). */
export function el(tag, text, className) {
	const node = document.createElement(tag);
	if (text !== undefined && text !== null) node.textContent = String(text);
	if (className) node.className = className;
	return node;
}

export function clear(node) {
	node.replaceChildren();
}

/** A table from column headings and rows of plain values. */
export function table(headings, rows) {
	const t = el("table");
	const thead = el("thead");
	const head = el("tr");
	for (const h of headings) head.append(el("th", h));
	thead.append(head);
	t.append(thead);
	const body = el("tbody");
	for (const row of rows) {
		const tr = el("tr");
		for (const value of row) tr.append(el("td", value === null || value === undefined ? "" : value));
		body.append(tr);
	}
	t.append(body);
	return t;
}

/** A card: heading plus whatever nodes are given. */
export function card(title, ...children) {
	const section = el("section", null, "card");
	section.append(el("h2", title), ...children);
	return section;
}
