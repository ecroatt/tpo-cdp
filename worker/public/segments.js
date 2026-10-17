import { clear, el, postJson, table } from "/api.js";

// Matches SOURCES and KINDS in src/segments/filters.ts; the server validates whatever is sent.
const SOURCES = ["direct", "facebook", "google", "instagram", "podcast", "referral", "x"];
const KINDS = ["subscriber", "app_only", "unknown_app_user"];

const form = document.getElementById("filters");
const status = document.getElementById("status");
const count = document.getElementById("count");
const results = document.getElementById("results");

function checkboxes(containerId, name, values) {
	const container = document.getElementById(containerId);
	for (const value of values) {
		const label = el("label", ` ${value}`);
		const box = document.createElement("input");
		box.type = "checkbox";
		box.name = name;
		box.value = value;
		label.prepend(box);
		container.append(label);
	}
}

checkboxes("sources", "sources", SOURCES);
checkboxes("kinds", "kind", KINDS);

function readFilters() {
	const data = new FormData(form);
	const filters = {};
	const sources = data.getAll("sources");
	if (sources.length) filters.sources = sources;
	const kind = data.getAll("kind");
	if (kind.length) filters.kind = kind;
	for (const key of ["status", "signup_from", "signup_to"]) {
		if (data.get(key)) filters[key] = data.get(key);
	}
	for (const key of ["cold", "has_app"]) {
		if (data.get(key)) filters[key] = data.get(key) === "true";
	}
	for (const key of ["not_opened_days", "app_active_days", "min_site_visits"]) {
		if (data.get(key) !== "") filters[key] = Number(data.get(key));
	}
	return filters;
}

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	clear(results);
	count.textContent = "";
	status.textContent = "Loading...";
	const { status: code, body } = await postJson("/api/segments/preview", { filters: readFilters() });
	if (code === 400) {
		status.textContent = `Those filters are not valid: ${body.reason ?? "check the values"}.`;
		return;
	}
	if (code !== 200) {
		status.textContent = "Something went wrong. Please try again.";
		return;
	}
	status.textContent = "";
	count.textContent = `${body.count} profiles match. Showing the first ${body.rows.length}, best engagement first.`;
	results.append(
		table(
			["Profile", "Email", "Source", "Status", "Signed up", "Last open", "Score"],
			body.rows.map((r) => [r.profile_id, r.email, r.source, r.status, r.signup, r.last_open, r.score]),
		),
	);
});
