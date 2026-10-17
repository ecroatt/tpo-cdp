/** Minimal RFC 4180 parser: quoted fields, doubled quotes, CRLF or LF, optional BOM. */
export function parseCsv(text: string): Record<string, string>[] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (inQuotes) {
			if (ch === '"') {
				if (src[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ",") {
			row.push(field);
			field = "";
		} else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && src[i + 1] === "\n") i++;
			row.push(field);
			field = "";
			rows.push(row);
			row = [];
		} else {
			field += ch;
		}
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}

	// A line that is truly empty (no commas at all) is dropped here; rows of only
	// commas or spaces are kept so the importer can count them as blank rows.
	const lines = rows.filter((r) => !(r.length === 1 && r[0] === ""));
	if (lines.length === 0) return [];
	const header = lines[0].map((h) => h.trim());
	return lines.slice(1).map((r) => {
		const rec: Record<string, string> = {};
		header.forEach((h, idx) => {
			rec[h] = r[idx] ?? "";
		});
		return rec;
	});
}
