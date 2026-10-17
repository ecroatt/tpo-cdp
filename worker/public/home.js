const runAt = document.getElementById("run-at");
const body = document.querySelector("#report tbody");

async function load() {
	const response = await fetch("/api/import-report");
	if (!response.ok) {
		runAt.textContent = "Could not load the import report.";
		return;
	}
	const report = await response.json();
	runAt.textContent = report.run_at ? `Import run at ${report.run_at}` : "No import has run yet.";
	for (const { metric, value } of report.metrics) {
		const row = document.createElement("tr");
		const name = document.createElement("td");
		name.textContent = metric;
		const count = document.createElement("td");
		count.textContent = String(value);
		row.append(name, count);
		body.append(row);
	}
}

load();
