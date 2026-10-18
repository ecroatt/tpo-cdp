// Headline tiles. Takes the tile elements (keyed by count name), the status element and the fetch
// response (null if the fetch itself failed). Numbers are only ever written with textContent.

const format = (n) => Number(n).toLocaleString("en-US");

export async function renderOverview(tiles, status, response) {
	try {
		if (!response || !response.ok) throw new Error("overview");
		const counts = await response.json();
		for (const [key, element] of Object.entries(tiles)) element.textContent = format(counts[key]);
		status.textContent = "";
	} catch {
		for (const element of Object.values(tiles)) element.textContent = "—";
		status.textContent = "The counts could not be loaded.";
	}
}
