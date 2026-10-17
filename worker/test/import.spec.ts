import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { buildImportStatements, renderSql, type Statement } from "../src/import/build";
import { parseCsv } from "../src/import/csv";
import { normalizeEmail } from "../src/lib/email";
import { normalizeSource } from "../src/lib/source";
import { appUsersCsv, subscribersCsv, webEventsCsv } from "./fixtures/import";

const TABLES = ["profiles", "subscribers", "web_events", "visitor_links", "app_users", "user_links", "import_report"];

async function reset() {
	await env.tpo_cdp.batch(TABLES.map((t) => env.tpo_cdp.prepare(`DELETE FROM ${t}`)));
}

const run = (statements: Statement[]) =>
	env.tpo_cdp.batch(statements.map((s) => env.tpo_cdp.prepare(s.sql).bind(...s.params)));

async function runImport(runAt: string, input = { subscribersCsv, webEventsCsv, appUsersCsv }) {
	const plan = buildImportStatements(input, runAt);
	await run(plan.statements);
	return plan;
}

async function report(runAt: string): Promise<Record<string, number>> {
	const { results } = await env.tpo_cdp
		.prepare("SELECT metric, value FROM import_report WHERE run_at = ?")
		.bind(runAt)
		.all<{ metric: string; value: number }>();
	return Object.fromEntries(results.map((r) => [r.metric, r.value]));
}

const count = async (table: string) =>
	(await env.tpo_cdp.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

describe("normalizeEmail", () => {
	it("trims, lowercases, keeps Gmail dots and +tags, returns null for blank or no-@ input", () => {
		expect(normalizeEmail("  Jane.Doe+Tag@Gmail.com ")).toBe("jane.doe+tag@gmail.com");
		expect(normalizeEmail("")).toBeNull();
		expect(normalizeEmail("   ")).toBeNull();
		expect(normalizeEmail(null)).toBeNull();
		expect(normalizeEmail("no-at-sign")).toBeNull();
		expect(normalizeEmail("a@b@c.com")).toBeNull();
	});
});

describe("normalizeSource", () => {
	it("maps twitter -> x, Instagram -> instagram and empty -> null", () => {
		expect(normalizeSource("twitter")).toBe("x");
		expect(normalizeSource("Twitter")).toBe("x");
		expect(normalizeSource("X")).toBe("x");
		expect(normalizeSource("Instagram")).toBe("instagram");
		expect(normalizeSource("")).toBeNull();
		expect(normalizeSource("  ")).toBeNull();
		expect(normalizeSource(null)).toBeNull();
	});
});

describe("parseCsv", () => {
	it("handles quotes, doubled quotes, CRLF and a BOM", () => {
		const rows = parseCsv('﻿a,b\r\n"x,1","he said ""hi"""\r\n');
		expect(rows).toEqual([{ a: "x,1", b: 'he said "hi"' }]);
	});
});

describe("import", () => {
	beforeEach(reset);

	it("merges subscribers ' A@x.com' and 'a@x.com ' into one row and the report counts 1 merge", async () => {
		await runImport("2026-10-17T10:00:00Z");
		const { results } = await env.tpo_cdp
			.prepare("SELECT * FROM subscribers WHERE email_norm = ?")
			.bind("a@x.com")
			.all<Record<string, string>>();
		expect(results).toHaveLength(1);
		// Earliest signup wins; last open is the max across the group.
		expect(results[0].signup_date).toBe("2026-08-10");
		expect(results[0].last_open_date).toBe("2026-09-20");
		expect(results[0].source).toBe("instagram");
		expect((await report("2026-10-17T10:00:00Z")).subscribers_duplicates_merged).toBe(1);
	});

	it("skips blank rows and counts them (and invalid emails)", async () => {
		await runImport("2026-10-17T10:00:00Z");
		const r = await report("2026-10-17T10:00:00Z");
		expect(r.subscribers_blank_rows).toBe(2);
		expect(r.subscribers_invalid_email).toBe(1);
		expect(r.subscribers_rows_read).toBe(6);
		// a, b, c and d.o'brien+tag
		expect(await count("subscribers")).toBe(4);
		expect(r.profiles_subscriber).toBe(4);
	});

	it("links a visitor through a visit with email '  B@X.com' and attaches that visitor's email-less visits", async () => {
		await runImport("2026-10-17T10:00:00Z");
		const profile = await env.tpo_cdp
			.prepare("SELECT profile_id FROM profiles WHERE email_norm = ?")
			.bind("b@x.com")
			.first<{ profile_id: string }>();
		const link = await env.tpo_cdp
			.prepare("SELECT profile_id FROM visitor_links WHERE visitor_id = ?")
			.bind("v_1")
			.first<{ profile_id: string }>();
		expect(link?.profile_id).toBe(profile?.profile_id);

		const { results } = await env.tpo_cdp
			.prepare(
				"SELECT w.page, w.source FROM web_events w JOIN visitor_links l ON l.visitor_id = w.visitor_id " +
					"WHERE l.profile_id = ? ORDER BY w.ts",
			)
			.bind(profile!.profile_id)
			.all<{ page: string; source: string | null }>();
		// The duplicate (visitor, page, ts) row is ignored; the two email-less visits still attach.
		expect(results.map((r) => r.page)).toEqual(["/news/a", "/news/b", "/news/c"]);
		expect(results[0].source).toBe("x");

		// v_2 has no email and v_3's email matches nobody: both stay unlinked.
		expect(await count("visitor_links")).toBe(1);
		const r = await report("2026-10-17T10:00:00Z");
		expect(r.visitors_unlinked).toBe(1);
		expect(r.visits_linked).toBe(3);
	});

	it("gives an app user matching a subscriber that subscriber's profile and an unmatched one an app_only profile", async () => {
		await runImport("2026-10-17T10:00:00Z");
		const sub = await env.tpo_cdp
			.prepare("SELECT profile_id, kind FROM profiles WHERE email_norm = ?")
			.bind("c@x.com")
			.first<{ profile_id: string; kind: string }>();
		expect(sub?.kind).toBe("subscriber");
		const matched = await env.tpo_cdp
			.prepare("SELECT profile_id FROM user_links WHERE user_id = ?")
			.bind("u_match")
			.first<{ profile_id: string }>();
		expect(matched?.profile_id).toBe(sub?.profile_id);

		const only = await env.tpo_cdp
			.prepare("SELECT p.kind, p.profile_id FROM user_links l JOIN profiles p ON p.profile_id = l.profile_id WHERE l.user_id = ?")
			.bind("u_only")
			.first<{ kind: string; profile_id: string }>();
		expect(only?.kind).toBe("app_only");
		// Two user_ids with the same unmatched email share one app_only profile.
		const only2 = await env.tpo_cdp
			.prepare("SELECT profile_id FROM user_links WHERE user_id = ?")
			.bind("u_only2")
			.first<{ profile_id: string }>();
		expect(only2?.profile_id).toBe(only?.profile_id);
		const r = await report("2026-10-17T10:00:00Z");
		expect(r.app_users_matched).toBe(1);
		expect(r.app_users_app_only).toBe(2);
		expect(r.profiles_app_only).toBe(1);
	});

	it("gives identical row counts and identical profile_ids when run twice", async () => {
		await runImport("2026-10-17T10:00:00Z");
		const snapshot = async () => ({
			counts: await Promise.all(TABLES.filter((t) => t !== "import_report").map(count)),
			ids: (
				await env.tpo_cdp
					.prepare("SELECT profile_id, email_norm FROM profiles ORDER BY email_norm")
					.all<{ profile_id: string; email_norm: string }>()
			).results,
		});
		const first = await snapshot();
		await runImport("2026-10-17T11:00:00Z");
		const second = await snapshot();
		expect(second).toEqual(first);
		expect(first.ids.every((p) => /^[0-9a-f]{32}$/.test(p.profile_id))).toBe(true);
		// Each run writes its own report rows.
		expect(await count("import_report")).toBe(2 * Object.keys(await report("2026-10-17T10:00:00Z")).length);
	});

	it("mints random profile_ids, not ones derived from the email", async () => {
		const ids = async () =>
			(await env.tpo_cdp.prepare("SELECT profile_id FROM profiles ORDER BY email_norm").all<{ profile_id: string }>()).results.map(
				(p) => p.profile_id,
			);
		await runImport("2026-10-17T10:00:00Z");
		const first = await ids();
		await reset();
		await runImport("2026-10-17T10:00:00Z");
		const second = await ids();
		expect(second).toHaveLength(first.length);
		expect(second.some((id, i) => id !== first[i])).toBe(true);
	});

	it("renders SQL with escaped values that runs the same as the bound form", async () => {
		const plan = buildImportStatements({ subscribersCsv, webEventsCsv, appUsersCsv }, "2026-10-17T10:00:00Z");
		const sql = renderSql(plan.statements);
		expect(sql).toContain("'d.o''brien+tag@x.com'");
		expect(sql.split("\n").length).toBeGreaterThan(5);
		await env.tpo_cdp.exec(sql);
		const r = await report("2026-10-17T10:00:00Z");
		expect(r.profiles_subscriber).toBe(4);
		expect(await count("subscribers")).toBe(4);
		const quoted = await env.tpo_cdp
			.prepare("SELECT email_raw FROM subscribers WHERE email_norm = ?")
			.bind("d.o'brien+tag@x.com")
			.first<{ email_raw: string }>();
		expect(quoted?.email_raw).toBe("d.o'brien+tag@x.com");
	});

	it("keeps an injection-looking value as data", () => {
		const csv = "email,signup_date,status,acquisition_source,last_open_date\nx@y.com,2026-08-01,active,\"'); DROP TABLE profiles;--\",\n";
		const plan = buildImportStatements({ subscribersCsv: csv, webEventsCsv: "visitor_id,page,timestamp,utm_source,email\n", appUsersCsv: "user_id,email,created_at\n" }, "2026-10-17T10:00:00Z");
		for (const s of plan.statements) expect(s.sql).not.toContain("DROP TABLE");
		expect(renderSql(plan.statements)).toContain("'''); DROP TABLE profiles;--'");
	});
});
