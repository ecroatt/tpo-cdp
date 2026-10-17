import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildImportStatements } from "../src/import/build";
import { daysBefore, LAST_30_START, LAST_7_START, TODAY } from "../src/lib/time";
import { isCold } from "../src/segments/definitions";
import { engagementFor, newsletterPoints } from "../src/segments/engagement";
import { buildWhere, SOURCES, validateFilters, type Filters } from "../src/segments/filters";
import { handlePreview } from "../src/routes/segments";
import { makeEvent, postWebhook } from "./fixtures/webhook";
import {
	addAppUser,
	addDeviceLink,
	addEvent,
	addProfile,
	addSubscriber,
	addVisit,
	addVisitor,
	call,
	loginCookie,
	postJson,
	resetAll,
} from "./fixtures/cdp";

let cookie = "";

beforeAll(async () => {
	cookie = await loginCookie("203.0.113.22");
});

interface Preview {
	count: number;
	rows: { profile_id: string; email: string | null; source: string | null; status: string | null; signup: string | null; last_open: string | null; score: number }[];
	chart: { by_source: { group: string; count: number }[]; by_status: { group: string; count: number }[] };
}

async function preview(filters: unknown): Promise<Preview> {
	const response = await postJson("/api/segments/preview", { filters }, cookie);
	expect(response.status).toBe(200);
	return (await response.json()) as Preview;
}

const ids = (p: Preview) => p.rows.map((r) => r.profile_id).sort();

/**
 * TODAY is 2026-09-28, so the 30-day window starts 2026-08-29 and the 7-day window starts 2026-09-22.
 * Names say what each profile is for.
 */
async function seedSubscribers() {
	await resetAll();
	const sub = (id: string, source: string | null, signup: string, open: string | null, status: "active" | "unsubscribed" = "active") =>
		addSubscriber({ id, email: `${id}@x.com`, source, signup, open, status });
	await sub("ig_cold", "instagram", "2026-06-01", "2026-08-01");
	await sub("ig_28", "instagram", "2026-06-01", "2026-08-28");
	await sub("ig_29", "instagram", "2026-06-01", "2026-08-29");
	await sub("ig_never_28", "instagram", "2026-08-28", null);
	await sub("ig_never_29", "instagram", "2026-08-29", null);
	await sub("ig_unsub", "instagram", "2026-05-01", "2026-07-01", "unsubscribed");
	await sub("go_22", "google", "2026-08-10", "2026-09-22");
	await sub("go_21", "google", "2026-08-10", "2026-09-21");
	await sub("x_sub", "x", "2026-09-01", "2026-09-25");
	await sub("no_source", null, "2026-07-01", "2026-09-01");
}

describe("the brief's example and cold boundaries", () => {
	beforeEach(seedSubscribers);

	it("The brief's example returns exactly the expected fixture profiles", async () => {
		// "Signed up from Instagram and haven't opened in 30 days": last open < 2026-08-29, or never opened and signed up before it.
		const result = await preview({ sources: ["instagram"], not_opened_days: 30 });
		expect(ids(result)).toEqual(["ig_28", "ig_cold", "ig_never_28", "ig_unsub"]);
		expect(result.count).toBe(4);
	});

	it("Last open on 08-28 is cold; last open on 08-29 is not", async () => {
		const cold = ids(await preview({ cold: true }));
		expect(cold).toContain("ig_28");
		expect(cold).not.toContain("ig_29");
	});

	it("Never opened with signup 08-28 is cold; never opened with signup 08-29 is not", async () => {
		const cold = ids(await preview({ cold: true }));
		expect(cold).toContain("ig_never_28");
		expect(cold).not.toContain("ig_never_29");
	});

	it("An unsubscribed subscriber is never cold", async () => {
		expect(ids(await preview({ cold: true }))).toEqual(["ig_28", "ig_cold", "ig_never_28"]);
		// ...and it is on the "not cold" side, but still matches the literal "haven't opened" filter.
		expect(ids(await preview({ cold: false }))).toContain("ig_unsub");
		expect(ids(await preview({ not_opened_days: 30 }))).toContain("ig_unsub");
	});

	it("cold:false is the negation among subscribers and leaves out profiles without a newsletter row", async () => {
		await addProfile("app_only_1", "app_only", "app@y.com");
		const notCold = await preview({ cold: false });
		expect(ids(notCold)).toEqual(["go_21", "go_22", "ig_29", "ig_never_29", "ig_unsub", "no_source", "x_sub"]);
		const cold = await preview({ cold: true });
		expect(notCold.count + cold.count).toBe(10);
	});

	it("the SQL cold filter agrees with the isCold() definition for every subscriber", async () => {
		const { results } = await env.tpo_cdp
			.prepare("SELECT p.profile_id, s.status, s.signup_date, s.last_open_date FROM profiles p JOIN subscribers s ON s.email_norm = p.email_norm")
			.all<{ profile_id: string; status: string; signup_date: string; last_open_date: string | null }>();
		const sqlCold = new Set(ids(await preview({ cold: true })));
		for (const r of results) expect(sqlCold.has(r.profile_id), r.profile_id).toBe(isCold(r));
	});

	it("not_opened_days is a literal cutoff: TODAY minus N, exclusive", async () => {
		// N = 31 gives cutoff 2026-08-28, so last open 08-28 is not before it but 08-01 is.
		expect(ids(await preview({ sources: ["instagram"], not_opened_days: 31 }))).toEqual(["ig_cold", "ig_unsub"]);
		expect(ids(await preview({ sources: ["instagram"], not_opened_days: 30 }))).toContain("ig_28");
		// Never opened: compared on signup. N = 1 gives cutoff 09-27.
		expect(ids(await preview({ sources: ["instagram"], not_opened_days: 1 }))).toContain("ig_never_29");
		// N = 365 reaches back to 2025-09-28: nobody in the fixture opened that long ago.
		expect((await preview({ not_opened_days: 365 })).count).toBe(0);
	});
});

describe("each filter", () => {
	beforeEach(seedSubscribers);

	it("sources matches subscribers.source and accepts several", async () => {
		expect(ids(await preview({ sources: ["google", "x"] }))).toEqual(["go_21", "go_22", "x_sub"]);
	});

	it("status is an equality", async () => {
		expect(ids(await preview({ status: "unsubscribed" }))).toEqual(["ig_unsub"]);
		expect((await preview({ status: "active" })).count).toBe(9);
	});

	it("signup_from and signup_to are an inclusive range", async () => {
		expect(ids(await preview({ signup_from: "2026-08-28", signup_to: "2026-08-29" }))).toEqual(["ig_never_28", "ig_never_29"]);
		expect(ids(await preview({ signup_from: "2026-08-29" }))).toEqual(["ig_never_29", "x_sub"]);
		expect(ids(await preview({ signup_to: "2026-05-01" }))).toEqual(["ig_unsub"]);
	});

	it("kind filters by profile kind, and has_app by user_links", async () => {
		await addProfile("p_apponly", "app_only", "appy@y.com");
		await addAppUser("u_appy", "p_apponly");
		await addProfile("p_unknown", "unknown_app_user", null);
		await addAppUser("u_unknown", "p_unknown", null);
		await addAppUser("u_ig29", "ig_29");
		expect(ids(await preview({ kind: ["app_only"] }))).toEqual(["p_apponly"]);
		expect(ids(await preview({ kind: ["app_only", "unknown_app_user"] }))).toEqual(["p_apponly", "p_unknown"]);
		expect((await preview({ kind: ["subscriber"] })).count).toBe(10);
		expect(ids(await preview({ has_app: true }))).toEqual(["ig_29", "p_apponly", "p_unknown"]);
		const without = await preview({ has_app: false });
		expect(without.count).toBe(9);
		expect(ids(without)).not.toContain("ig_29");
	});

	it("app_active_days needs an owned app event on or after TODAY minus N, including events attributed by device", async () => {
		await addAppUser("u_a", "ig_29");
		await addAppUser("u_b", "ig_cold");
		await addAppUser("u_c", "go_22");
		// 10 days back is 2026-09-18: an event at 00:00:00 that day counts, one the second before does not.
		await addEvent({ id: "e_a", event: "app_open", user: "u_a", device: "d_a", ts: "2026-09-18T00:00:00Z" });
		await addEvent({ id: "e_b", event: "app_open", user: "u_b", device: "d_b", ts: "2026-09-17T23:59:59Z" });
		// u_c has no event of its own; an anonymous event on its device after the login is attributed to it.
		await addDeviceLink("d_c", "u_c", "2026-09-01T00:00:00Z");
		await addEvent({ id: "e_c", event: "read_story", user: null, device: "d_c", ts: "2026-09-27T00:00:00Z", properties: { story: "s" } });
		// An unowned anonymous event matches nobody.
		await addEvent({ id: "e_x", event: "app_open", user: null, device: "d_nobody", ts: "2026-09-27T00:00:00Z" });
		expect(ids(await preview({ app_active_days: 10 }))).toEqual(["go_22", "ig_29"]);
		expect(ids(await preview({ app_active_days: 11 }))).toEqual(["go_22", "ig_29", "ig_cold"]);
		expect(ids(await preview({ app_active_days: 1 }))).toEqual(["go_22"]);
		expect(daysBefore(TODAY, 10)).toBe("2026-09-18");
	});

	it("app_active_days has no upper bound: an owned event dated after TODAY counts", async () => {
		await addAppUser("u_future", "ig_29");
		await addEvent({ id: "e_future", event: "app_open", user: "u_future", device: "d_future", ts: "2026-10-05T00:00:00Z" });
		expect(ids(await preview({ app_active_days: 1 }))).toEqual(["ig_29"]);
		expect(ids(await preview({ app_active_days: 365 }))).toEqual(["ig_29"]);
	});

	it("min_site_visits has no upper bound: a linked visit dated after TODAY counts", async () => {
		await addVisitor("v_f1", "ig_29");
		await addVisitor("v_f2", "ig_cold");
		await addVisit("v_f1", "2026-09-10T00:00:00Z");
		await addVisit("v_f1", "2026-10-05T00:00:00Z");
		await addVisit("v_f2", "2026-10-05T00:00:00Z");
		expect(ids(await preview({ min_site_visits: 2 }))).toEqual(["ig_29"]);
		expect(ids(await preview({ min_site_visits: 1 }))).toEqual(["ig_29", "ig_cold"]);
	});

	it("min_site_visits counts linked visits in the last 30 days, with >= semantics", async () => {
		await addVisitor("v_1", "ig_29");
		await addVisitor("v_2", "ig_29");
		await addVisitor("v_3", "ig_cold");
		await addVisit("v_1", "2026-08-29T00:00:00Z");
		await addVisit("v_2", "2026-09-10T00:00:00Z");
		await addVisit("v_3", "2026-08-28T23:59:59Z");
		await addVisit("v_3", "2026-08-01T00:00:00Z");
		await addVisit("v_unlinked", "2026-09-10T00:00:00Z");
		expect(ids(await preview({ min_site_visits: 2 }))).toEqual(["ig_29"]);
		expect(ids(await preview({ min_site_visits: 1 }))).toEqual(["ig_29"]);
		expect(ids(await preview({ min_site_visits: 3 }))).toEqual([]);
		// Zero matches everyone, including profiles with no visits.
		expect((await preview({ min_site_visits: 0 })).count).toBe(10);
	});

	it("an empty filter object matches every profile", async () => {
		await addProfile("p_apponly", "app_only", "appy@y.com");
		expect((await preview({})).count).toBe(11);
	});

	it("filters combine with AND", async () => {
		expect(ids(await preview({ sources: ["instagram"], status: "active", cold: true, signup_from: "2026-08-01" }))).toEqual(["ig_never_28"]);
	});
});

describe("rows, count and chart come from the real database", () => {
	beforeEach(seedSubscribers);

	it("returns the first 50 rows, the full count, and chart counts that equal the DB", async () => {
		const statements = [];
		for (let i = 0; i < 55; i++) {
			const email = `bulk${String(i).padStart(2, "0")}@x.com`;
			statements.push(
				env.tpo_cdp.prepare("INSERT INTO profiles (profile_id, kind, email_norm, created_at) VALUES (?, 'subscriber', ?, '2026-09-01T00:00:00Z')").bind(`bulk_${String(i).padStart(2, "0")}`, email),
				env.tpo_cdp
					.prepare("INSERT INTO subscribers (email_norm, email_raw, signup_date, status, source, source_raw, last_open_date) VALUES (?, ?, '2026-07-01', ?, 'facebook', 'facebook', NULL)")
					.bind(email, email, i % 5 === 0 ? "unsubscribed" : "active"),
			);
		}
		await env.tpo_cdp.batch(statements);
		const result = await preview({});
		expect(result.count).toBe(65);
		expect(result.rows).toHaveLength(50);
		const bySource = Object.fromEntries(result.chart.by_source.map((g) => [g.group, g.count]));
		expect(bySource).toEqual({ facebook: 55, instagram: 6, google: 2, x: 1, none: 1 });
		const byStatus = Object.fromEntries(result.chart.by_status.map((g) => [g.group, g.count]));
		expect(byStatus).toEqual({ active: 53, unsubscribed: 12 });
		const dbCount = await env.tpo_cdp.prepare("SELECT COUNT(*) AS n FROM profiles").first<{ n: number }>();
		expect(dbCount!.n).toBe(result.count);
		expect(result.chart.by_source.reduce((a, g) => a + g.count, 0)).toBe(result.count);
	});

	it("chart counts follow the filter: a source filter and a status filter each narrow by_source and by_status", async () => {
		const toMap = (g: { group: string; count: number }[]) => Object.fromEntries(g.map((x) => [x.group, x.count]));
		// Instagram: ig_cold, ig_28, ig_29, ig_never_28, ig_never_29 active, ig_unsub unsubscribed.
		const ig = await preview({ sources: ["instagram"] });
		expect(ig.count).toBe(6);
		expect(toMap(ig.chart.by_source)).toEqual({ instagram: 6 });
		expect(toMap(ig.chart.by_status)).toEqual({ active: 5, unsubscribed: 1 });
		// Unsubscribed: only ig_unsub.
		const unsub = await preview({ status: "unsubscribed" });
		expect(toMap(unsub.chart.by_source)).toEqual({ instagram: 1 });
		expect(toMap(unsub.chart.by_status)).toEqual({ unsubscribed: 1 });
		// Active: 5 instagram, 2 google, 1 x, 1 with no source.
		const active = await preview({ status: "active" });
		expect(toMap(active.chart.by_source)).toEqual({ instagram: 5, google: 2, x: 1, none: 1 });
		expect(toMap(active.chart.by_status)).toEqual({ active: 9 });
	});

	it("each row carries profile_id, email, source, status, signup, last open and score", async () => {
		const result = await preview({ sources: ["x"] });
		expect(result.rows).toEqual([
			{ profile_id: "x_sub", email: "x_sub@x.com", source: "x", status: "active", signup: "2026-09-01", last_open: "2026-09-25", score: 3 },
		]);
	});

	it("orders rows by score, best first", async () => {
		const result = await preview({ sources: ["google"] });
		// go_22 opened 09-22 (3 points); go_21 opened 09-21 (1 point).
		expect(result.rows.map((r) => [r.profile_id, r.score])).toEqual([["go_22", 3], ["go_21", 1]]);
	});
});

/** Rows go in a scrambled order on purpose: the order must come from the preview, not from insertion. */
async function seedMany(rows: { id: string; source: string | null; status?: "active" | "unsubscribed"; open: string | null }[]) {
	const statements = [];
	for (const r of rows) {
		const email = `${r.id}@x.com`;
		statements.push(env.tpo_cdp.prepare("INSERT INTO profiles (profile_id, kind, email_norm, created_at) VALUES (?, 'subscriber', ?, '2026-09-01T00:00:00Z')").bind(r.id, r.source === null && r.status === undefined ? null : email));
		if (r.source !== null || r.status !== undefined) {
			statements.push(
				env.tpo_cdp
					.prepare("INSERT INTO subscribers (email_norm, email_raw, signup_date, status, source, source_raw, last_open_date) VALUES (?, ?, '2026-07-01', ?, ?, ?, ?)")
					.bind(email, email, r.status ?? "active", r.source, r.source, r.open),
			);
		}
	}
	for (let i = 0; i < statements.length; i += 50) await env.tpo_cdp.batch(statements.slice(i, i + 50));
}

describe("preview ordering done in JS", () => {
	beforeEach(resetAll);

	it("score ties are broken by profile_id ascending", async () => {
		// Open 2026-09-25 is 3 points, 2026-09-01 is 1 point (inside 30 days, before 7), never opened is 0.
		await seedMany([
			{ id: "t_c", source: "google", open: null },
			{ id: "s_z", source: "google", open: "2026-09-25" },
			{ id: "o_b", source: "google", open: "2026-09-01" },
			{ id: "t_a", source: "google", open: null },
			{ id: "s_b", source: "google", open: "2026-09-25" },
			{ id: "o_a", source: "google", open: "2026-09-01" },
			{ id: "t_b", source: "google", open: null },
			{ id: "s_m", source: "google", open: "2026-09-25" },
		]);
		const result = await preview({});
		expect(result.rows.map((r) => [r.profile_id, r.score])).toEqual([
			["s_b", 3], ["s_m", 3], ["s_z", 3], ["o_a", 1], ["o_b", 1], ["t_a", 0], ["t_b", 0], ["t_c", 0],
		]);
	});

	it("chart groups are ordered by count descending, then group name, with 'none' sorted like any name", async () => {
		await seedMany([
			{ id: "c1", source: "x", status: "unsubscribed", open: null },
			{ id: "c2", source: "podcast", open: null },
			{ id: "c3", source: "google", open: null },
			{ id: "c4", source: "facebook", open: null },
			{ id: "c5", source: "x", status: "unsubscribed", open: null },
			{ id: "c6", source: "facebook", open: null },
			{ id: "c7", source: "instagram", open: null },
			{ id: "c8", source: "google", open: null },
			{ id: "c9", source: "facebook", open: null },
		]);
		// Two profiles without a newsletter row: source 'none' and status 'none'.
		await addProfile("n1", "app_only", "n1@y.com");
		await addProfile("n2", "app_only", "n2@y.com");
		const result = await preview({});
		expect(result.count).toBe(11);
		// facebook 3; then a three-way tie at 2 (google, none, x); then a tie at 1 (instagram, podcast).
		expect(result.chart.by_source).toEqual([
			{ group: "facebook", count: 3 },
			{ group: "google", count: 2 },
			{ group: "none", count: 2 },
			{ group: "x", count: 2 },
			{ group: "instagram", count: 1 },
			{ group: "podcast", count: 1 },
		]);
		// active 7; then a tie at 2 where 'none' comes before 'unsubscribed'.
		expect(result.chart.by_status).toEqual([
			{ group: "active", count: 7 },
			{ group: "none", count: 2 },
			{ group: "unsubscribed", count: 2 },
		]);
	});

	it("with more than 50 matches the 50 returned are the highest scorers in order and the count is the full total", async () => {
		const pad = (n: number) => String(n).padStart(2, "0");
		const rows: Parameters<typeof seedMany>[0] = [];
		// Lowest scorers (0) have ids that sort first.
		for (let i = 0; i < 5; i++) rows.push({ id: `a_${i}`, source: "google", open: null });
		// 35 profiles at 1 point; only h_00..h_29 fit.
		for (let i = 34; i >= 0; i--) rows.push({ id: `h_${pad(i)}`, source: "google", open: "2026-09-01" });
		// 20 profiles at 3 points with ids that sort last.
		for (let i = 19; i >= 0; i--) rows.push({ id: `z_${pad(i)}`, source: "google", open: "2026-09-25" });
		await seedMany(rows);
		const result = await preview({});
		expect(result.count).toBe(60);
		expect(result.rows).toHaveLength(50);
		const expected = [
			...Array.from({ length: 20 }, (_, i) => `z_${pad(i)}`),
			...Array.from({ length: 30 }, (_, i) => `h_${pad(i)}`),
		];
		expect(result.rows.map((r) => r.profile_id)).toEqual(expected);
		const returned = new Set(result.rows.map((r) => r.profile_id));
		for (let i = 0; i < 5; i++) expect(returned.has(`a_${i}`)).toBe(false);
		for (let i = 30; i < 35; i++) expect(returned.has(`h_${pad(i)}`)).toBe(false);
		expect(result.chart.by_source).toEqual([{ group: "google", count: 60 }]);
	});
});

describe("twitter and X are one source", () => {
	beforeEach(resetAll);

	it("twitter web traffic and X subscribers both match sources:['x']", async () => {
		// Real import path: normalizeSource maps twitter -> x for subscribers.source AND web_events.source.
		const plan = buildImportStatements(
			{
				subscribersCsv: [
					"email,signup_date,status,acquisition_source,last_open_date",
					"s1@x.com,2026-08-10,active,X,2026-09-01",
					"s2@x.com,2026-08-11,active,twitter,2026-09-02",
					"s3@x.com,2026-08-12,active,Google,2026-09-03",
				].join("\n"),
				webEventsCsv: [
					"visitor_id,page,timestamp,utm_source,email",
					"v_t1,/a,2026-09-01 10:00:00,Twitter,s1@x.com",
					"v_t2,/b,2026-09-02 10:00:00,twitter,s3@x.com",
				].join("\n"),
				appUsersCsv: "user_id,email,created_at",
			},
			"2026-10-17T00:00:00Z",
		);
		await env.tpo_cdp.batch(plan.statements.map((s) => env.tpo_cdp.prepare(s.sql).bind(...s.params)));

		// Both the raw "X" subscriber and the raw "twitter" subscriber match.
		expect(ids(await preview({ sources: ["x"] }))).toHaveLength(2);
		expect((await preview({ sources: ["x"] })).rows.map((r) => r.email).sort()).toEqual(["s1@x.com", "s2@x.com"]);
		// Twitter web traffic is stored as source 'x', so it is the same source as the subscribers' X.
		const web = await env.tpo_cdp.prepare("SELECT COUNT(*) AS n FROM web_events WHERE source = 'x'").first<{ n: number }>();
		expect(web!.n).toBe(2);
		const rawTwitter = await env.tpo_cdp.prepare("SELECT COUNT(*) AS n FROM web_events WHERE source = 'twitter'").first<{ n: number }>();
		expect(rawTwitter!.n).toBe(0);
		// "twitter" is accepted as an alias in the filter and means the same thing.
		expect((await preview({ sources: ["twitter"] })).count).toBe(2);
		expect((await preview({ sources: ["Twitter", "x"] })).count).toBe(2);
	});

	it("the allowed sources are exactly the normalized sources of the real data", () => {
		expect([...SOURCES]).toEqual(["direct", "facebook", "google", "instagram", "podcast", "referral", "x"]);
	});
});

describe("invalid filters", () => {
	beforeEach(seedSubscribers);

	const bad = async (filters: unknown) => postJson("/api/segments/preview", { filters }, cookie);

	it("An unknown filter key gets a 400, and so does not_opened_days: -1", async () => {
		const unknown = await bad({ favourite_colour: "red" });
		expect(unknown.status).toBe(400);
		expect(((await unknown.json()) as any).error).toBe("invalid_filters");
		const negative = await bad({ not_opened_days: -1 });
		expect(negative.status).toBe(400);
	});

	it("rejects wrong types and out-of-range values", async () => {
		const cases: unknown[] = [
			{ not_opened_days: 0 },
			{ not_opened_days: 366 },
			{ not_opened_days: 1.5 },
			{ not_opened_days: "30" },
			{ app_active_days: 0 },
			{ app_active_days: 366 },
			{ min_site_visits: -1 },
			{ min_site_visits: 10001 },
			{ cold: "true" },
			{ cold: null },
			{ has_app: 1 },
			{ status: "ACTIVE" },
			{ status: "deleted" },
			{ signup_from: "2026-13-01" },
			{ signup_from: "2026-02-30" },
			{ signup_from: "08/01/2026" },
			{ signup_from: 20260801 },
			{ signup_from: "2026-09-01", signup_to: "2026-08-01" },
			{ sources: "instagram" },
			{ sources: [] },
			{ sources: [1] },
			{ sources: ["myspace"] },
			{ kind: ["admin"] },
			{ kind: [] },
			{ kind: "subscriber" },
			[],
			"cold",
			null,
		];
		for (const filters of cases) {
			const response = await bad(filters);
			expect(response.status, JSON.stringify(filters)).toBe(400);
		}
		expect((await postJson("/api/segments/preview", {}, cookie)).status).toBe(400);
		const notJson = await call("/api/segments/preview", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://cdp.test" }, body: "{nope" }, cookie);
		expect(notJson.status).toBe(400);
	});

	it("rejects a top-level body of null, an array, a string or a number", async () => {
		for (const body of [null, [], "x", 42]) {
			const response = await postJson("/api/segments/preview", body, cookie);
			expect(response.status, JSON.stringify(body)).toBe(400);
		}
	});

	it("rejects non-integer and string values for app_active_days and min_site_visits", async () => {
		for (const filters of [{ app_active_days: 1.5 }, { app_active_days: "7" }, { min_site_visits: 2.5 }, { min_site_visits: "2" }]) {
			const response = await bad(filters);
			expect(response.status, JSON.stringify(filters)).toBe(400);
		}
	});

	it("accepts the boundary values", async () => {
		for (const filters of [{ not_opened_days: 1 }, { not_opened_days: 365 }, { app_active_days: 365 }, { min_site_visits: 0 }, { min_site_visits: 10000 }, { signup_from: "2026-09-01", signup_to: "2026-09-01" }]) {
			expect((await bad(filters)).status, JSON.stringify(filters)).toBe(200);
		}
	});

	it("A SQL-injection-looking source value is rejected by the validator and never reaches SQL", async () => {
		const attack = "instagram') OR 1=1; DROP TABLE subscribers; --";
		expect(validateFilters({ sources: [attack] }).ok).toBe(false);
		expect(validateFilters({ signup_from: "2026-01-01' OR '1'='1" }).ok).toBe(false);
		expect(validateFilters({ kind: ["subscriber' OR 1=1 --"] }).ok).toBe(false);

		// Run the real handler against a D1 wrapper that records every statement prepared.
		const prepared: string[] = [];
		const watched = new Proxy(env.tpo_cdp, {
			get(target, prop) {
				const value = Reflect.get(target, prop, target);
				if (prop === "prepare") {
					return (sql: string) => {
						prepared.push(sql);
						return target.prepare(sql);
					};
				}
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as D1Database;
		const watchedEnv = { ...env, tpo_cdp: watched } as Env;
		const request = (body: unknown) =>
			new Request("https://cdp.test/api/segments/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

		const rejected = await handlePreview(request({ filters: { sources: [attack] } }), watchedEnv);
		expect(rejected.status).toBe(400);
		expect(JSON.stringify(await rejected.json())).not.toContain("DROP");
		// Rejected before any SQL was prepared, so buildWhere never saw the value.
		expect(prepared).toEqual([]);

		const accepted = await handlePreview(request({ filters: { sources: ["instagram"], signup_from: "2026-01-01" } }), watchedEnv);
		expect(accepted.status).toBe(200);
		expect(prepared.length).toBeGreaterThan(0);
		for (const sql of prepared) {
			expect(sql).not.toContain("instagram");
			expect(sql).not.toContain("2026-01-01");
		}
		const stillThere = await env.tpo_cdp.prepare("SELECT COUNT(*) AS n FROM subscribers").first<{ n: number }>();
		expect(stillThere!.n).toBe(10);
	});

	it("buildWhere emits fixed fragments and puts every value in binds", () => {
		const filters: Filters = {
			sources: ["instagram", "x"],
			status: "active",
			signup_from: "2026-08-01",
			signup_to: "2026-08-31",
			cold: true,
			not_opened_days: 30,
			kind: ["subscriber"],
			has_app: true,
			app_active_days: 7,
			min_site_visits: 2,
		};
		const { sql, binds } = buildWhere(filters);
		for (const value of ["instagram", "2026-08-01", "2026-08-31", "subscriber"]) expect(sql).not.toContain(value);
		expect(binds).toEqual([
			"instagram", "x", "active", "2026-08-01", "2026-08-31", "2026-08-29", "2026-08-29", "2026-08-29", "2026-08-29", "subscriber", "2026-09-21", "2026-08-29", 2,
		]);
		expect(sql.match(/\?/g)).toHaveLength(binds.length);
		expect(buildWhere({})).toEqual({ sql: "1 = 1", binds: [] });
	});
});

describe("engagement score", () => {
	beforeEach(async () => {
		await seedSubscribers();
		await addSubscriber({ id: "p_eng", email: "eng@x.com", source: "google", signup: "2026-07-01", open: "2026-09-25" });
		await addVisitor("v_e1", "p_eng");
		await addVisitor("v_e2", "p_eng");
		// Site: 1 point per linked visit on or after 2026-08-29 (no upper bound).
		await addVisit("v_e1", "2026-08-28T23:59:59Z"); // outside the window
		await addVisit("v_e1", "2026-08-29T00:00:00Z"); // 1
		await addVisit("v_e1", "2026-09-05T00:00:00Z"); // 2
		await addVisit("v_e1", "2026-09-10T00:00:00Z"); // 3
		await addVisit("v_e2", "2026-09-20T00:00:00Z"); // 4
		await addVisit("v_e2", "2026-10-01T00:00:00Z"); // 5 (after TODAY still counts)
		await addVisit("v_other", "2026-09-10T00:00:00Z"); // unlinked: not counted
		await addAppUser("u_e", "p_eng");
		const own = (id: string, event: string, ts: string, properties: object = {}) => addEvent({ id, event, user: "u_e", device: "d_e", ts, properties });
		await own("e1", "read_story", "2026-09-01T00:00:00Z", { story: "a" }); // 2
		await own("e2", "read_story", "2026-09-02T00:00:00Z", { story: "b" }); // 2
		await own("e3", "app_open", "2026-09-03T00:00:00Z"); // 1
		await own("e4", "link_click", "2026-09-04T00:00:00Z", { url: "https://x.test" }); // 1
		await own("e5", "login", "2026-09-05T00:00:00Z"); // 1
		await own("e6", "read_story", "2026-08-28T23:00:00Z", { story: "c" }); // outside the window
		await addDeviceLink("d_e", "u_e", "2026-09-06T00:00:00Z");
		await addEvent({ id: "e7", event: "read_story", user: null, device: "d_e", ts: "2026-09-10T00:00:00Z", properties: { story: "d" } }); // 2, attributed by device
		await addEvent({ id: "e8", event: "app_open", user: null, device: "d_x", ts: "2026-09-10T00:00:00Z" }); // unowned: 0
	});

	it("The engagement score matches a hand-computed fixture", async () => {
		// Newsletter: last open 2026-09-25 is on or after 2026-09-22, so 3.
		// Site: 5 linked visits in the window (08-29, 09-05, 09-10, 09-20, 10-01) x 1 = 5.
		// App: read_story 2 + 2 + 2 (the device-attributed one) = 6, plus app_open, link_click, login at 1 each = 3, so 9.
		// Total: 3 + 5 + 9 = 17.
		const detail = await engagementFor(env.tpo_cdp, "p_eng", "2026-09-25");
		expect(detail).toEqual({ score: 17, breakdown: { newsletter: 3, site: 5, app: 9 }, window_start: "2026-08-29" });
		const row = (await preview({ sources: ["google"] })).rows.find((r) => r.profile_id === "p_eng");
		expect(row!.score).toBe(17);
		const lookup = (await (await call("/api/lookup?q=p_eng", {}, cookie)).json()) as any;
		expect(lookup.engagement.score).toBe(17);
		expect(lookup.engagement.breakdown).toEqual({ newsletter: 3, site: 5, app: 9 });
	});

	it("newsletter points: 3 for the last 7 days, 1 for the last 30, otherwise 0", () => {
		expect(LAST_7_START).toBe("2026-09-22");
		expect(LAST_30_START).toBe("2026-08-29");
		expect(newsletterPoints("2026-09-22")).toBe(3);
		expect(newsletterPoints("2026-09-21")).toBe(1);
		expect(newsletterPoints("2026-08-29")).toBe(1);
		expect(newsletterPoints("2026-08-28")).toBe(0);
		expect(newsletterPoints(null)).toBe(0);
	});

	it("the SQL score and the lookup score agree for every profile", async () => {
		const all = await preview({});
		expect(all.count).toBe(11);
		for (const row of all.rows) {
			const detail = await engagementFor(env.tpo_cdp, row.profile_id, row.last_open);
			expect(row.score, row.profile_id).toBe(detail.score);
		}
		expect(all.rows[0].profile_id).toBe("p_eng");
	});
});

describe("webhook events and segments", () => {
	beforeEach(async () => {
		await seedSubscribers();
		await addAppUser("u_w", "go_21");
	});

	const scoreOf = async (profileId: string) => (await preview({})).rows.find((r) => r.profile_id === profileId)!.score;

	it("A webhook `read_story` changes the score and `app_active_days` membership with no restart", async () => {
		// go_21: google subscriber, last open 2026-09-21 (inside 30 days, outside 7), so newsletter 1 and no other points.
		expect(await scoreOf("go_21")).toBe(1);
		expect(ids(await preview({ app_active_days: 30 }))).toEqual([]);
		const lookupBefore = (await (await call("/api/lookup?q=u_w", {}, cookie)).json()) as any;
		expect(lookupBefore.engagement.score).toBe(1);

		const response = await postWebhook(makeEvent({ event: "read_story", user_id: "u_w", device_id: "d_w", timestamp: "2026-09-27T10:00:00Z", properties: { story: "a-story" } }));
		expect(response.status).toBe(200);

		// A read_story is worth 2 points: 1 + 2 = 3, in both the preview and the lookup.
		expect(await scoreOf("go_21")).toBe(3);
		expect(ids(await preview({ app_active_days: 30 }))).toEqual(["go_21"]);
		// 1 day back is 2026-09-27, and the event is dated that day, so it counts.
		expect(ids(await preview({ app_active_days: 1 }))).toEqual(["go_21"]);
		const lookupAfter = (await (await call("/api/lookup?q=u_w", {}, cookie)).json()) as any;
		expect(lookupAfter.engagement.score).toBe(3);
		expect(lookupAfter.engagement.breakdown).toEqual({ newsletter: 1, site: 0, app: 2 });
		// An app_open adds 1 more.
		await postWebhook(makeEvent({ event: "app_open", user_id: "u_w", device_id: "d_w", timestamp: "2026-09-27T11:00:00Z" }));
		expect(await scoreOf("go_21")).toBe(4);
	});

	it("A webhook login on a device attributes its earlier anonymous events to the profile in the segment query", async () => {
		await postWebhook(makeEvent({ event_id: "sa1", event: "read_story", device_id: "d_seg", timestamp: "2026-09-26T10:00:00Z", properties: { story: "s" } }));
		expect(ids(await preview({ app_active_days: 30 }))).toEqual([]);
		await postWebhook(makeEvent({ event_id: "sa2", event: "login", user_id: "u_w", device_id: "d_seg", timestamp: "2026-09-26T10:05:00Z" }));
		expect(ids(await preview({ app_active_days: 30 }))).toEqual(["go_21"]);
		// read_story 2 (device-attributed) + login 1 + newsletter 1.
		expect(await scoreOf("go_21")).toBe(4);
	});
});
