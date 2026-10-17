// D1 read budget: every UI call must read rows in proportion to the data, not to profiles x rows.
// Cloudflare's free plan allows 5M rows read per day, and the old per-profile full scans read tens of millions per call.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src";
import { recordRowsRead } from "../scripts/lib/rows-read";
import { loginCookie, resetAll } from "./fixtures/cdp";

const PROFILES = 1500;
const APP_USERS = 300;
const VISITS_PER_VISITOR = 2;

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
});

async function rowsReadBy(path: string, body?: unknown): Promise<{ status: number; rows: number }> {
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
	await response.arrayBuffer();
	await waitOnExecutionContext(ctx);
	return { status: response.status, rows: recorder.rowsRead() };
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
});
