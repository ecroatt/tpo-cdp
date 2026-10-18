// Home page: headline tiles and the last import. Data is only ever written with textContent.

const LABELS = {
	subscribers_rows_read: "Subscriber rows read",
	subscribers_blank_rows: "Subscriber blank rows skipped",
	subscribers_invalid_email: "Subscriber rows skipped (invalid email)",
	subscribers_duplicates_merged: "Subscriber duplicates merged",
	app_users_rows_read: "App user rows read",
	app_users_blank_rows: "App user blank rows skipped",
	app_users_invalid_email: "App user rows with an invalid email",
	web_events_rows_read: "Web event rows read",
	web_events_blank_rows: "Web event blank rows skipped",
	web_events_invalid_rows: "Web event rows skipped (invalid)",
	web_events_invalid_email: "Web event rows with an invalid email",
	visitors_email_conflicts: "Web visitors seen with more than one email",
	visitors_unlinked: "Web visitors not linked to a profile",
	profiles_subscriber: "Subscriber profiles",
	profiles_app_only: "App-only profiles",
	profiles_unknown_app_user: "Unknown app user profiles",
	visitors_linked: "Web visitors linked to a profile",
	visits_linked: "Web visits linked to a profile",
	app_users_matched: "App users matched to a subscriber",
	app_users_app_only: "App users with no subscriber match",
};

const TILES = {
	people: "tile-people",
	active_subscribers: "tile-active-subscribers",
	app_users_linked: "tile-app-users",
	app_events_30d: "tile-app-events",
};

const runAt = document.getElementById("run-at");
const body = document.querySelector("#report tbody");
const overviewStatus = document.getElementById("overview-status");

const format = (n) => Number(n).toLocaleString("en-US");

async function loadOverview() {
	try {
		const response = await fetch("/api/overview", { headers: { Accept: "application/json" } });
		if (!response.ok) throw new Error("overview");
		const counts = await response.json();
		for (const [key, id] of Object.entries(TILES)) document.getElementById(id).textContent = format(counts[key]);
	} catch {
		for (const id of Object.values(TILES)) document.getElementById(id).textContent = "—";
		overviewStatus.textContent = "The counts could not be loaded.";
	}
}

async function loadReport() {
	try {
		const response = await fetch("/api/import-report", { headers: { Accept: "application/json" } });
		if (!response.ok) throw new Error("report");
		const report = await response.json();
		runAt.textContent = report.run_at ? `Import run at ${report.run_at}` : "No import has run yet.";
		for (const { metric, value } of report.metrics) {
			const row = document.createElement("tr");
			const name = document.createElement("td");
			name.textContent = Object.hasOwn(LABELS, metric) ? LABELS[metric] : metric;
			const count = document.createElement("td");
			count.className = "num";
			count.textContent = format(value);
			row.append(name, count);
			body.append(row);
		}
	} catch {
		runAt.textContent = "Could not load the import report.";
	}
}

loadOverview();
loadReport();
