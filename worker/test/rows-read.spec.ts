// D1 read budget: every UI call must read rows in proportion to the data, not to profiles x rows.
// Cloudflare's free plan allows 5M rows read per day, and the old per-profile full scans read tens of millions per call.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src";
import { runTool, validatePlan } from "../src/assistant/tools";
import { recordRowsRead } from "../scripts/lib/rows-read";
import { loginCookie, resetAll } from "./fixtures/cdp";

const PROFILES = 1500;
const APP_USERS = 300;
const VISITS_PER_VISITOR = 2;
/** Users a0..a99 also have a device with a login link and two anonymous events attributed through it. */
const LINKED_DEVICE_USERS = 100;
/** Each app user owns this many events directly (their own user_id). */
const OWN_EVENTS = 4;

/**
 * Linear budget: BUDGET_FACTOR x the number of seeded rows. A well-indexed call reads each table's rows
 * a small constant number of times (a table pass plus its index entries, and one more pass for an
 * aggregate or a join lookup), so 4 passes is generous. A per-profile full scan reads PROFILES x rows
 * (over 2 million here, against a budget near 35 thousand), so any quadratic query fails by a wide margin.
 */
const BUDGET_FACTOR = 4;

/**
 * Lookup budget: LOOKUP_FACTOR x the rows the looked-up profile owns (its visitor_links, user_links, web_events,
 * app_users and app_events rows) + LOOKUP_OVERHEAD for the resolve, profile and subscriber statements. Each owned row
 * may be read a few times (an index entry, the table row, and a count and a list query over it), so 10 is generous.
 * It does not grow with the table sizes, so a lookup that scans visitor_links or user_links (for example because
 * visitor_links(profile_id) or user_links(profile_id) lost its index) reads 1,500 or 300 rows per statement and fails.
 */
const LOOKUP_FACTOR = 10;
const LOOKUP_OVERHEAD = 30;

const BASE = "https://cdp.test";
let cookie = "";
let seeded = 0;
/** Events seeded by seedAppEvents: 300 x 4 own + 100 x 2 attributed + 200 x 2 unowned. */
const APP_EVENTS_SEEDED = APP_USERS * OWN_EVENTS + LINKED_DEVICE_USERS * 2 + (APP_USERS - LINKED_DEVICE_USERS) * 2;

async function insertAll(sql: string, rows: unknown[][]): Promise<void> {
	for (let i = 0; i < rows.length; i += 500) {
		await env.tpo_cdp.batch(rows.slice(i, i + 500).map((r) => env.tpo_cdp.prepare(sql).bind(...r)));
	}
	seeded += rows.length;
}

beforeAll(async () => {
	cookie = await loginCookie("203.0.113.40");
	await resetAll();
	const ids = Array.from({ length: PROFILES }, (_, i) => i);
	const sources = ["instagram", "google", "x"];
	await insertAll(
		"INSERT INTO profiles (profile_id, kind, email_norm, created_at) VALUES (?, 'subscriber', ?, '2026-09-01T00:00:00Z')",
		ids.map((i) => [`p${i}`, `u${i}@x.com`]),
	);
	await insertAll(
		"INSERT INTO subscribers (email_norm, email_raw, signup_date, status, source, source_raw, last_open_date) VALUES (?, ?, ?, 'active', ?, ?, ?)",
		ids.map((i) => [`u${i}@x.com`, `u${i}@x.com`, "2026-06-01", sources[i % 3], sources[i % 3], i % 2 === 0 ? "2026-07-01" : "2026-09-20"]),
	);
	await insertAll("INSERT INTO visitor_links (visitor_id, profile_id) VALUES (?, ?)", ids.map((i) => [`v${i}`, `p${i}`]));
	await insertAll(
		"INSERT INTO web_events (visitor_id, page, ts, source, source_raw) VALUES (?, ?, ?, NULL, NULL)",
		ids.flatMap((i) => Array.from({ length: VISITS_PER_VISITOR }, (_, k) => [`v${i}`, `/news/${k}`, `2026-09-${10 + k}T10:00:00Z`])),
	);
	const users = Array.from({ length: APP_USERS }, (_, i) => i);
	await insertAll("INSERT INTO app_users (user_id, email_raw, email_norm, created_at, origin) VALUES (?, NULL, NULL, '2026-08-22', 'csv')", users.map((i) => [`a${i}`]));
	await insertAll("INSERT INTO user_links (user_id, profile_id) VALUES (?, ?)", users.map((i) => [`a${i}`, `p${i}`]));
	await seedAppEvents(users);
});

/**
 * App side: 300 users x 4 own events (half of them before the 30-day window), 100 devices with a login link and 2 anonymous
 * events each (one before the link, one after: both owned by that user), and 200 devices that never log in with 2 unowned
 * anonymous events each. 1,800 events and 100 device links in all. A query that evaluates the app_event_owner view
 * once per profile reads about 300 x 1,800 rows and fails the budgets below.
 */
async function seedAppEvents(users: number[]): Promise<void> {
	const insert = "INSERT INTO app_events (event_id, event, user_id, device_id, ts, properties, received_at) VALUES (?, ?, ?, ?, ?, '{}', '2026-09-28T12:00:00Z')";
	const kinds = ["app_open", "read_story", "link_click", "login"];
	await insertAll(
		insert,
		users.flatMap((i) =>
			Array.from({ length: OWN_EVENTS }, (_, k) => [`ev_${i}_${k}`, kinds[k], `a${i}`, `own_${i}`, k === 0 && i % 2 === 1 ? "2026-07-15T08:00:00Z" : `2026-09-${10 + k}T0${k}:00:00Z`]),
		),
	);
	const linked = users.slice(0, LINKED_DEVICE_USERS);
	await insertAll("INSERT INTO device_links (device_id, user_id, seen_at) VALUES (?, ?, ?)", linked.map((i) => [`dv_${i}`, `a${i}`, "2026-09-05T00:00:00Z"]));
	await insertAll(
		insert,
		linked.flatMap((i) => [
			[`an_${i}_0`, "app_open", null, `dv_${i}`, "2026-09-01T10:00:00Z"],
			[`an_${i}_1`, "read_story", null, `dv_${i}`, "2026-09-20T10:00:00Z"],
		]),
	);
	await insertAll(
		insert,
		users.slice(LINKED_DEVICE_USERS).flatMap((i) => [
			[`un_${i}_0`, "app_open", null, `dd_${i}`, "2026-09-02T10:00:00Z"],
			[`un_${i}_1`, "app_open", null, `dd_${i}`, "2026-09-21T10:00:00Z"],
		]),
	);
}

async function rowsReadBy(path: string, body?: unknown): Promise<{ status: number; rows: number; body: any }> {
	const recorder = recordRowsRead(env.tpo_cdp);
	const headers: Record<string, string> = { Cookie: cookie };
	if (body !== undefined) {
		headers.Origin = BASE;
		headers["Content-Type"] = "application/json";
	}
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		new Request(BASE + path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }),
		{ ...env, tpo_cdp: recorder.db } as Env,
		ctx,
	);
	const text = await response.text();
	await waitOnExecutionContext(ctx);
	return { status: response.status, rows: recorder.rowsRead(), body: text === "" ? null : JSON.parse(text) };
}

describe("D1 rows read stay linear in the data", () => {
	it("lookup by email", async () => {
		// Lookup reads what one profile owns, not the whole database. u100 is p100: 1 visitor_links row,
		// 2 web_events, 1 user_links row and 1 app_users row (no app events), so 5 owned rows.
		const owned = 1 + VISITS_PER_VISITOR + 1 + 1;
		const { status, rows } = await rowsReadBy("/api/lookup?q=" + encodeURIComponent("U100@X.com"));
		expect(status).toBe(200);
		expect(rows).toBeLessThanOrEqual(LOOKUP_FACTOR * owned + LOOKUP_OVERHEAD);
		// Rule: the lookup budget (LOOKUP_FACTOR * owned + LOOKUP_OVERHEAD = 80) must stay below the
		// smaller link table, Math.min(PROFILES, APP_USERS) = 300, so a scan of visitor_links or user_links fails this test.
	});

	it("lookup of a profile with app activity reads in proportion to the events it owns", async () => {
		// u50 is p50: 1 visitor_links row, 2 web_events, 1 user_links row, 1 app_users row, 4 own events,
		// 1 device link and 2 anonymous events on that device (7 app rows besides the account). Events of the
		// other 299 users and the 200 unowned devices must not be read at all.
		const owned = 1 + VISITS_PER_VISITOR + 1 + 1 + OWN_EVENTS + 1 + 2;
		const recorder = recordRowsRead(env.tpo_cdp);
		const ctx = createExecutionContext();
		const response = await worker.fetch(new Request(BASE + "/api/lookup?q=a50", { headers: { Cookie: cookie } }), { ...env, tpo_cdp: recorder.db } as Env, ctx);
		const body = (await response.json()) as any;
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(body.app_activity.total).toBe(OWN_EVENTS + 2);
		expect(body.app_activity.recent.filter((e: any) => e.attributed_from_device)).toHaveLength(2);
		// 5 passes over the owned rows is far less than the 1,800 events a view scan reads per statement.
		expect(recorder.rowsRead()).toBeLessThanOrEqual(LOOKUP_FACTOR * owned + LOOKUP_OVERHEAD);
		expect(LOOKUP_FACTOR * owned + LOOKUP_OVERHEAD).toBeLessThan(APP_EVENTS_SEEDED);
	});

	it("lookup of a user whose device never logs in reads only the events it owns", async () => {
		// a150's device never logs in: only its 4 own events belong to it.
		const { status, rows } = await rowsReadBy("/api/lookup?q=a150");
		expect(status).toBe(200);
		expect(rows).toBeLessThanOrEqual(LOOKUP_FACTOR * (1 + VISITS_PER_VISITOR + 1 + 1 + OWN_EVENTS) + LOOKUP_OVERHEAD);
	});

	it("preview with no filters", async () => {
		const { status, rows } = await rowsReadBy("/api/segments/preview", { filters: {} });
		expect(status).toBe(200);
		expect(rows).toBeLessThanOrEqual(BUDGET_FACTOR * seeded);
	});

	it("preview of instagram and not opened in 30 days", async () => {
		const { status, rows } = await rowsReadBy("/api/segments/preview", { filters: { sources: ["instagram"], not_opened_days: 30 } });
		expect(status).toBe(200);
		expect(rows).toBeLessThanOrEqual(BUDGET_FACTOR * seeded);
	});

	it("preview with app_active_days reads in proportion to the events in the window", async () => {
		const { status, rows } = await rowsReadBy("/api/segments/preview", { filters: { app_active_days: 30 } });
		expect(status).toBe(200);
		expect(rows).toBeLessThanOrEqual(BUDGET_FACTOR * seeded);
	});

	it("preview with app_active_days and a source filter", async () => {
		const { status, rows } = await rowsReadBy("/api/segments/preview", { filters: { app_active_days: 30, sources: ["instagram"], has_app: true } });
		expect(status).toBe(200);
		expect(rows).toBeLessThanOrEqual(BUDGET_FACTOR * seeded);
	});

	it("the app-side previews return the right members", async () => {
		// Every app user has in-window events (the pre-window ones are only the first event of odd users).
		const { status, body } = await rowsReadBy("/api/segments/preview", { filters: { app_active_days: 30 } });
		expect(status).toBe(200);
		expect(body.count).toBe(APP_USERS);
		// Only the 300 profiles with an app account qualify; the 1,200 others have no events.
		const subscribers = await rowsReadBy("/api/segments/preview", { filters: { app_active_days: 30, kind: ["subscriber"] } });
		expect(subscribers.body.count).toBe(APP_USERS);
	});
});

describe("assistant tools stay within the read budget", () => {
	async function runRecorded(tool: string, input: unknown) {
		const checked = validatePlan(tool, input);
		if (!checked.ok) throw new Error("plan should be valid");
		const recorder = recordRowsRead(env.tpo_cdp);
		const result = await runTool(recorder.db, checked.plan);
		return { result, rows: recorder.rowsRead() };
	}

	const filterSets: Record<string, unknown>[] = [
		{},
		{ sources: ["instagram"], signup_from: "2026-08-01", signup_to: "2026-08-31", cold: true },
		{ sources: ["instagram"], not_opened_days: 30 },
		{ app_active_days: 30 },
		{ signup_from: "2026-08-29" },
	];

	for (const filters of filterSets) {
		const label = JSON.stringify(filters);
		it(`count_profiles, build_segment and engagement_ranking with ${label}`, async () => {
			for (const [tool, input] of [
				["count_profiles", { filters }],
				["build_segment", { filters }],
				["engagement_ranking", { limit: 100, filters }],
			] as const) {
				const { rows } = await runRecorded(tool, input);
				expect(rows, tool).toBeLessThanOrEqual(BUDGET_FACTOR * seeded);
			}
		});

		it(`top_pages (all and first_visit, with and without site pages) with ${label}`, async () => {
			for (const mode of ["all", "first_visit"]) {
				for (const include_site_pages of [false, true]) {
					const { rows } = await runRecorded("top_pages", { filters, mode, limit: 20, include_site_pages });
					expect(rows, `${mode} include_site_pages ${include_site_pages}`).toBeLessThanOrEqual(BUDGET_FACTOR * seeded);
				}
			}
		});

		it(`breakdown by every field with ${label}`, async () => {
			for (const by of ["source", "status", "signup_month", "kind", "cold"]) {
				const { rows } = await runRecorded("breakdown", { by, filters });
				expect(rows, by).toBeLessThanOrEqual(BUDGET_FACTOR * seeded);
			}
		});
	}

	it("returns the hand-derived numbers on the seeded data", async () => {
		// 1,500 profiles on sources i % 3, every visitor with two visits on /news/0 (09-10) and /news/1 (09-11).
		expect((await runRecorded("count_profiles", { filters: {} })).result.count).toBe(1500);
		expect((await runRecorded("count_profiles", { filters: { sources: ["x"] } })).result.count).toBe(500);
		expect((await runRecorded("breakdown", { by: "source" })).result.rows).toEqual([
			{ group: "google", count: 500 },
			{ group: "instagram", count: 500 },
			{ group: "x", count: 500 },
		]);
		// Even i opened 2026-07-01 (cold), odd i opened 2026-09-20 (not cold).
		expect((await runRecorded("breakdown", { by: "cold" })).result.rows).toEqual([
			{ group: "cold", count: 750 },
			{ group: "not cold", count: 750 },
		]);
		expect((await runRecorded("top_pages", { mode: "first_visit", limit: 20 })).result.rows).toEqual([{ page: "/news/0", profiles: 1500 }]);
		expect((await runRecorded("top_pages", { mode: "all", limit: 20 })).result.rows).toEqual([
			{ page: "/news/0", profiles: 1500 },
			{ page: "/news/1", profiles: 1500 },
		]);
		// No seeded page is a site page, so including them changes nothing.
		expect((await runRecorded("top_pages", { mode: "first_visit", limit: 20, include_site_pages: true })).result.rows).toEqual([{ page: "/news/0", profiles: 1500 }]);
		expect((await runRecorded("top_pages", { mode: "all", limit: 20, include_site_pages: true })).result.rows).toEqual([
			{ page: "/news/0", profiles: 1500 },
			{ page: "/news/1", profiles: 1500 },
		]);
	});
});
