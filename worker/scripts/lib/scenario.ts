// The simulator's event scenario (SPEC section 4, "Simulator"). Pure: no network, no node imports, so tests run it too.

/** Two users from data/app_users.csv that match newsletter subscribers, so a live lookup shows a full profile. User IDs are not PII. */
export const PRIMARY_USER = "u_2b6447a3";
export const SECOND_USER = "u_baba14aa";
/** A user_id that is in no CSV. Every run reuses it, so the first run creates one profile and later runs add events to it. */
export const NEWCOMER_USER = "u_sim_newcomer";

export interface ScenarioStep {
	/** Printed next to the status code. Never contains an email. */
	label: string;
	body: Record<string, unknown>;
	/** The status word the webhook answers with on a 200. */
	expect: "stored" | "duplicate";
}

/**
 * The eleven requests of one run. `runId` makes event and device IDs unique to the run, so the script can be run again;
 * the one duplicate re-sends an event from this same run. Event times are at or before `nowMs` (never in the future).
 */
export function buildScenario(runId: string, nowMs: number): ScenarioStep[] {
	const phone = `d_sim_${runId}_phone`;
	const tablet = `d_sim_${runId}_tablet`;
	const at = (secondsAgo: number): string => new Date(Math.floor(nowMs / 1000) * 1000 - secondsAgo * 1000).toISOString().replace(/\.\d+Z$/, "Z");
	let n = 0;
	const event = (name: string, secondsAgo: number, deviceId: string, userId: string | null, properties: Record<string, unknown> = {}) => {
		n += 1;
		return { event_id: `sim_${runId}_${String(n).padStart(2, "0")}`, event: name, user_id: userId, device_id: deviceId, timestamp: at(secondsAgo), properties };
	};

	const anonymousOpen = event("app_open", 600, phone, null);
	const anonymousRead = event("read_story", 540, phone, null, { story: "sim-morning-briefing" });
	const login = event("login", 480, phone, PRIMARY_USER);
	const laterRead = event("read_story", 300, phone, PRIMARY_USER, { story: "sim-evening-edition" });
	const laterClick = event("link_click", 240, phone, PRIMARY_USER, { url: "https://example.com/sim-offer" });
	const outOfOrder = event("app_open", 1200, phone, null);
	const unknownLogin = event("login", 200, tablet, NEWCOMER_USER);
	const unknownOpen = event("app_open", 150, tablet, NEWCOMER_USER);
	const secondLogin = event("login", 100, phone, SECOND_USER);
	const afterSecondLogin = event("app_open", 60, phone, null);

	return [
		{ label: "anonymous app_open", body: anonymousOpen, expect: "stored" },
		{ label: "anonymous read_story", body: anonymousRead, expect: "stored" },
		{ label: "login (user 1, same device)", body: login, expect: "stored" },
		{ label: "later read_story (user 1)", body: laterRead, expect: "stored" },
		{ label: "later link_click (user 1)", body: laterClick, expect: "stored" },
		{ label: "duplicate of the later read_story", body: { ...laterRead }, expect: "duplicate" },
		{ label: "out-of-order anonymous app_open (older)", body: outOfOrder, expect: "stored" },
		{ label: "login (unknown user)", body: unknownLogin, expect: "stored" },
		{ label: "app_open (unknown user)", body: unknownOpen, expect: "stored" },
		{ label: "login (user 2, same device as user 1)", body: secondLogin, expect: "stored" },
		{ label: "anonymous app_open after user 2 logged in", body: afterSecondLogin, expect: "stored" },
	];
}

/** One output line: the label and the status code, plus the stored/duplicate word on a 200. Nothing else is printed. */
export function formatResult(label: string, status: number, responseText: string): string {
	let word = "";
	if (status === 200) {
		try {
			const parsed = JSON.parse(responseText) as { status?: unknown };
			if (parsed.status === "stored" || parsed.status === "duplicate") word = ` ${parsed.status}`;
		} catch {
			word = "";
		}
	}
	return `${label}: ${status}${word}`;
}
