import { card, clear, el, postJson, table } from "/api.js";

const form = document.getElementById("search");
const input = document.getElementById("q");
const status = document.getElementById("status");
const results = document.getElementById("results");

function definition(pairs) {
	const dl = el("dl");
	for (const [name, value] of pairs) {
		dl.append(el("dt", name), el("dd", value === null || value === undefined ? "none" : value));
	}
	return dl;
}

function renderProfile(p) {
	const e = p.engagement;
	results.append(
		card(
			"Profile",
			definition([
				["Profile ID", p.profile_id],
				["Kind", p.kind],
				["Email", p.email],
				["Engagement score", `${e.score} (newsletter ${e.breakdown.newsletter}, site ${e.breakdown.site}, app ${e.breakdown.app}; since ${e.window_start})`],
			]),
		),
	);

	if (p.newsletter) {
		const n = p.newsletter;
		results.append(
			card(
				"Newsletter",
				definition([
					["Signed up", n.signup_date],
					["Status", n.status],
					["Source", n.source],
					["Last open", n.last_open_date],
					["Days since open", n.days_since_open],
					["Cold", n.cold ? "yes" : "no"],
				]),
			),
		);
	} else {
		results.append(card("Newsletter", el("p", "Not a newsletter subscriber.")));
	}

	const visits = p.site_visits;
	results.append(
		card(
			"Site visits",
			el("p", `${visits.total} total across ${visits.visitor_ids.length} visitor ID(s): ${visits.visitor_ids.join(", ") || "none"}. Showing the ${visits.recent.length} most recent.`),
			table(["Time", "Page", "Visitor", "Source"], visits.recent.map((v) => [v.ts, v.page, v.visitor_id, v.source])),
		),
	);

	const app = p.app_activity;
	const accounts = p.app_accounts.map((a) => `${a.user_id} (created ${a.created_at ?? "unknown"})`).join(", ") || "none";
	results.append(
		card(
			"App activity",
			el("p", `App accounts: ${accounts}. ${app.total} events total; showing the ${app.recent.length} most recent.`),
			table(["Time", "Event", "User", "Device", "Via device login"], app.recent.map((ev) => [ev.ts, ev.event, ev.user_id, ev.device_id, ev.attributed_from_device ? "yes" : ""])),
		),
	);
}

function renderAnonymous(p) {
	results.append(
		card(
			"Anonymous visitor",
			el("p", `${p.visitor_id} is not linked to a profile. ${p.total} visits; showing the ${p.visits.length} most recent.`),
			table(["Time", "Page", "Source"], p.visits.map((v) => [v.ts, v.page, v.source])),
		),
	);
}

async function search(q) {
	clear(results);
	status.textContent = "Searching...";
	const { status: code, body } = await postJson("/api/lookup", { q });
	if (code === 404) {
		status.textContent = "No exact match. Try the full email, a profile ID, a user ID or a visitor ID.";
		return;
	}
	if (code !== 200) {
		status.textContent = "Something went wrong. Please try again.";
		return;
	}
	status.textContent = "";
	if (body.kind === "anonymous_visitor") renderAnonymous(body);
	else renderProfile(body);
}

form.addEventListener("submit", (event) => {
	event.preventDefault();
	search(input.value);
});
