import { clear, el, postJson, table } from "/api.js";
import { prefillQuestion } from "/prefill.js";
import { clearChart, drawChart } from "/charts.js";

const form = document.getElementById("ask");
const input = document.getElementById("question");
const status = document.getElementById("status");
const box = document.getElementById("answer-box");
const help = document.getElementById("unsupported-help");
const canvas = document.getElementById("chart");
const results = document.getElementById("results");

prefillQuestion(location.search, input);

const ERRORS = {
	400: "Please type a question of up to 500 characters.",
	429: "Too many questions. Wait a minute and try again.",
	422: "I could not turn that into a question about the audience. Try rephrasing it.",
	502: "The assistant is unavailable right now. Please try again in a moment.",
};

const BLOCKED = "That question looks like it names or identifies a person. Individual lookups belong on the Lookup page; ask about the audience as a whole here.";

const PROFILE_HEADINGS = ["Profile", "Email", "Source", "Status", "Signed up", "Last open", "Score"];

/** The table for a result, by tool. Returns null when the result has no rows to show. */
function resultTable(result) {
	if (!Array.isArray(result.rows)) return null;
	if (result.tool === "top_pages") return table(["Page", "Profiles"], result.rows.map((r) => [r.page, r.profiles]));
	if (result.tool === "breakdown") return table(["Group", "Count"], result.rows.map((r) => [r.group, r.count]));
	return table(
		PROFILE_HEADINGS,
		result.rows.map((r) => [r.profile_id, r.email, r.source, r.status, r.signup, r.last_open, r.score]),
	);
}

function showUnsupported() {
	const link = el("a", "Segments page");
	link.href = "/segments";
	help.replaceChildren("The assistant answers one question with one tool. For anything else, try the ", link, ".");
	help.hidden = false;
}

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	box.hidden = true;
	help.hidden = true;
	clear(results);
	clearChart(canvas);
	status.textContent = "Thinking...";
	const { status: code, body } = await postJson("/api/assistant", { question: input.value });
	if (code !== 200) {
		status.textContent = body.error === "blocked_pii" ? BLOCKED : (ERRORS[code] ?? "Something went wrong. Please try again.");
		return;
	}
	status.textContent = "";
	document.getElementById("answer").textContent = body.answer;
	document.getElementById("plan").textContent = JSON.stringify(body.plan, null, 2);
	document.getElementById("model-request").textContent = JSON.stringify(body.model_request, null, 2);
	if (body.result.tool === "unsupported") showUnsupported();
	if (body.result.chart) drawChart(canvas, body.result.chart);
	const rows = resultTable(body.result);
	if (rows) results.append(rows);
	box.hidden = false;
});
