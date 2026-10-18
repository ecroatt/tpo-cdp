// Fixtures for the assistant and chart tests: a small hand-countable data set plus a scripted fake model.
// Nothing here calls the real model, and the API key in the test environment is the fake one.
import { env } from "cloudflare:workers";
import { resetAll } from "./cdp";

export const FAKE_KEY = "test-fake-anthropic-key";
export const BASE = "https://cdp.test";

/** 32-hex profile_id for profile number k. Zero padded, so string order equals numeric order. */
export const pid = (k: number): string => k.toString(16).padStart(32, "0");

/** Page paths chosen so that none of them can appear in the system prompt (which lists the site's real sections). */
export const PAGE_A = "/news/alpha-census";
export const PAGE_B = "/news/bravo-census";
export const PAGE_C = "/news/charlie-census";
export const PAGE_D = "/news/delta-census";
export const PAGE_E = "/news/echo-census";
export const PAGE_F = "/news/foxtrot-census";
/** A content page that is not a site page, named in the spec. */
export const PICKS = "/shadrachs-picks";

export interface SubSeed {
	k: number;
	raw: string;
	norm: string;
	source: string;
	signup: string;
	status: "active" | "unsubscribed";
	open: string | null;
}

/**
 * TODAY is 2026-09-28: the 30-day window starts 2026-08-29 and the 7-day window starts 2026-09-22.
 * Cold = active and (open < 08-29, or never opened and signup < 08-29).
 */
export const SUBS: SubSeed[] = [
	{ k: 1, raw: " Jane.Doe+x@Gmail.com", norm: "jane.doe+x@gmail.com", source: "instagram", signup: "2026-08-05", status: "active", open: "2026-08-10" },
	{ k: 2, raw: "ava.stone@example.com", norm: "ava.stone@example.com", source: "instagram", signup: "2026-08-31", status: "active", open: null },
	{ k: 3, raw: "Ben.Ortiz@Example.com ", norm: "ben.ortiz@example.com", source: "instagram", signup: "2026-08-01", status: "active", open: "2026-09-20" },
	{ k: 4, raw: "cleo.park@example.com", norm: "cleo.park@example.com", source: "instagram", signup: "2026-08-20", status: "active", open: null },
	{ k: 5, raw: "dan.wu@example.com", norm: "dan.wu@example.com", source: "instagram", signup: "2026-08-15", status: "unsubscribed", open: "2026-08-28" },
	{ k: 6, raw: "eve.ruiz@example.com", norm: "eve.ruiz@example.com", source: "google", signup: "2026-08-10", status: "active", open: "2026-08-12" },
	{ k: 7, raw: "finn.bell@example.com", norm: "finn.bell@example.com", source: "instagram", signup: "2026-07-31", status: "active", open: "2026-08-01" },
	{ k: 8, raw: "gia.moss@example.com", norm: "gia.moss@example.com", source: "instagram", signup: "2026-08-18", status: "active", open: "2026-08-28" },
	{ k: 9, raw: "hal.lowe@example.com", norm: "hal.lowe@example.com", source: "instagram", signup: "2026-08-12", status: "active", open: "2026-08-29" },
	{ k: 10, raw: "ivy.cho@example.com", norm: "ivy.cho@example.com", source: "google", signup: "2026-09-02", status: "active", open: "2026-09-23" },
	{ k: 11, raw: "jon.kim@example.com", norm: "jon.kim@example.com", source: "x", signup: "2026-09-10", status: "active", open: "2026-09-22" },
	{ k: 12, raw: "kai.roy@example.com", norm: "kai.roy@example.com", source: "direct", signup: "2026-09-25", status: "active", open: null },
];

/** Profile 13 is an app_only profile: an app account, no newsletter row. */
export const APP_ONLY = { k: 13, raw: "Lena.Fox@Example.org", norm: "lena.fox@example.org" };

const USER_APP_ONLY = "u_9f8e7d6c";
const USER_BEN = "u_5a4b3c2d";

/** visitor -> profile number. */
const VISITORS: [string, number][] = [
	["v_1a2b3c4d01", 2],
	["v_1a2b3c4d02", 2],
	["v_1a2b3c4d03", 1],
	["v_1a2b3c4d04", 4],
	["v_1a2b3c4d08", 8],
	["v_1a2b3c4d10", 10],
	["v_1a2b3c4d11", 11],
];
/** An unlinked visitor: its visit must never be counted for anyone. */
const UNLINKED_VISITOR = "v_ffffffffff";

const VISITS: [string, string, string][] = [
	// Profile 2 has two visitors. The earliest visit (before signup) is on the second one.
	["v_1a2b3c4d01", PAGE_B, "2026-09-05T10:00:00Z"],
	["v_1a2b3c4d01", PAGE_C, "2026-09-06T10:00:00Z"],
	["v_1a2b3c4d02", PAGE_A, "2026-08-20T09:00:00Z"],
	["v_1a2b3c4d03", PAGE_D, "2026-07-01T08:00:00Z"],
	// Profiles 1, 4 and 8 are the brief's Q1 set (Instagram, signed up in August, cold). Every visit below is before 2026-08-29,
	// outside the 30-day window, so engagement scores and min_site_visits are unchanged.
	// Profile 1: earliest visit is the home page; its first content page is PAGE_D (07-01), before /shadrachs-picks (08-10).
	["v_1a2b3c4d03", "/", "2026-06-15T08:00:00Z"],
	["v_1a2b3c4d03", "/about", "2026-06-16T08:00:00Z"],
	["v_1a2b3c4d03", PICKS, "2026-08-10T08:00:00Z"],
	// Profile 4: the home page twice (counted once per profile); first content page is /shadrachs-picks.
	["v_1a2b3c4d04", "/", "2026-08-20T09:00:00Z"],
	["v_1a2b3c4d04", PICKS, "2026-08-21T09:00:00Z"],
	["v_1a2b3c4d04", "/", "2026-08-23T09:00:00Z"],
	["v_1a2b3c4d04", "/subscribe", "2026-08-24T09:00:00Z"],
	// Profile 8: earliest visit is /subscribe; first content page is PAGE_F (08-19).
	["v_1a2b3c4d08", "/subscribe", "2026-08-18T09:00:00Z"],
	["v_1a2b3c4d08", PAGE_F, "2026-08-19T09:00:00Z"],
	["v_1a2b3c4d08", PICKS, "2026-08-25T09:00:00Z"],
	["v_1a2b3c4d10", PAGE_A, "2026-08-25T09:00:00Z"],
	["v_1a2b3c4d10", PAGE_B, "2026-09-03T09:00:00Z"],
	["v_1a2b3c4d11", PAGE_B, "2026-09-11T09:00:00Z"],
	["v_1a2b3c4d11", PAGE_A, "2026-09-12T09:00:00Z"],
	["v_1a2b3c4d11", PAGE_A, "2026-09-13T09:00:00Z"],
	[UNLINKED_VISITOR, PAGE_E, "2026-08-01T09:00:00Z"],
];

const EVENTS: [string, string, string | null, string, string][] = [
	["evt_a1", "read_story", USER_APP_ONLY, "d_aa11bb22", "2026-09-20T10:00:00Z"],
	["evt_a2", "read_story", USER_APP_ONLY, "d_aa11bb22", "2026-09-21T10:00:00Z"],
	["evt_a3", "app_open", USER_APP_ONLY, "d_aa11bb22", "2026-09-22T10:00:00Z"],
	["evt_a4", "app_open", USER_APP_ONLY, "d_aa11bb22", "2026-07-01T10:00:00Z"],
	["evt_b1", "link_click", USER_BEN, "d_ee55ff66", "2026-09-10T10:00:00Z"],
	["evt_x1", "app_open", null, "d_cc33dd44", "2026-09-25T10:00:00Z"],
];

/** Every email string in the database, raw and normalized. None may ever reach the model. */
export const ALL_EMAILS: string[] = [
	...SUBS.flatMap((s) => [s.raw, s.norm]),
	APP_ONLY.raw,
	APP_ONLY.norm,
	"Ben.Ortiz@Example.com",
];

/** Every identifier in the database. None may ever reach the model. */
export const ALL_IDS: string[] = [
	...[...SUBS.map((s) => s.k), APP_ONLY.k].map(pid),
	...VISITORS.map(([v]) => v),
	UNLINKED_VISITOR,
	USER_APP_ONLY,
	USER_BEN,
	...new Set(EVENTS.map((e) => e[3])),
	...EVENTS.map((e) => e[0]),
];

/** The local parts of the emails, which are the only name-like strings in the data. */
export const ALL_NAME_LIKE: string[] = [...SUBS.map((s) => s.norm.split("@")[0]), APP_ONLY.norm.split("@")[0]];

export async function seedAssistantData(): Promise<void> {
	await resetAll();
	const db = env.tpo_cdp;
	const statements: D1PreparedStatement[] = [];
	for (const s of SUBS) {
		statements.push(
			db.prepare("INSERT INTO profiles (profile_id, kind, email_norm, created_at) VALUES (?, 'subscriber', ?, '2026-09-01T00:00:00Z')").bind(pid(s.k), s.norm),
			db
				.prepare("INSERT INTO subscribers (email_norm, email_raw, signup_date, status, source, source_raw, last_open_date) VALUES (?, ?, ?, ?, ?, ?, ?)")
				.bind(s.norm, s.raw, s.signup, s.status, s.source, s.source, s.open),
		);
	}
	statements.push(
		db.prepare("INSERT INTO profiles (profile_id, kind, email_norm, created_at) VALUES (?, 'app_only', ?, '2026-09-01T00:00:00Z')").bind(pid(APP_ONLY.k), APP_ONLY.norm),
	);
	for (const [visitor, k] of VISITORS) statements.push(db.prepare("INSERT INTO visitor_links (visitor_id, profile_id) VALUES (?, ?)").bind(visitor, pid(k)));
	for (const [visitor, page, ts] of VISITS) {
		statements.push(db.prepare("INSERT INTO web_events (visitor_id, page, ts, source, source_raw) VALUES (?, ?, ?, NULL, NULL)").bind(visitor, page, ts));
	}
	statements.push(
		db
			.prepare("INSERT INTO app_users (user_id, email_raw, email_norm, created_at, origin) VALUES (?, ?, ?, '2026-08-22', 'csv')")
			.bind(USER_APP_ONLY, APP_ONLY.raw, APP_ONLY.norm),
		db
			.prepare("INSERT INTO app_users (user_id, email_raw, email_norm, created_at, origin) VALUES (?, ?, ?, '2026-08-22', 'csv')")
			.bind(USER_BEN, "Ben.Ortiz@Example.com", "ben.ortiz@example.com"),
		db.prepare("INSERT INTO user_links (user_id, profile_id) VALUES (?, ?)").bind(USER_APP_ONLY, pid(APP_ONLY.k)),
		db.prepare("INSERT INTO user_links (user_id, profile_id) VALUES (?, ?)").bind(USER_BEN, pid(3)),
	);
	for (const [id, event, user, device, ts] of EVENTS) {
		const properties = event === "read_story" ? '{"story":"a-story"}' : "{}";
		statements.push(
			db
				.prepare("INSERT INTO app_events (event_id, event, user_id, device_id, ts, properties, received_at) VALUES (?, ?, ?, ?, ?, ?, '2026-09-28T12:00:00Z')")
				.bind(id, event, user, device, ts, properties),
		);
	}
	await db.batch(statements);
}

export interface ModelCall {
	url: string;
	init: RequestInit;
	/** The exact request body text. */
	body: string;
}

export interface ScriptedModel {
	calls: ModelCall[];
	fetch: typeof fetch;
}

export type ScriptedReply = { name: string; input: unknown } | { response: Response } | { error: Error };

/**
 * A fake `fetch` standing in for api.anthropic.com. It records every call and replies with a tool_use block
 * (preceded by a text block that the server must ignore), a raw Response, or a failure.
 */
export function scriptedModel(reply: ScriptedReply): ScriptedModel {
	const calls: ModelCall[] = [];
	const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		calls.push({ url: String(input), init: init ?? {}, body: String(init?.body ?? "") });
		if ("error" in reply) throw reply.error;
		if ("response" in reply) return reply.response;
		return new Response(
			JSON.stringify({
				id: "msg_test",
				type: "message",
				role: "assistant",
				content: [
					{ type: "text", text: "Ignored prose that must not be used." },
					{ type: "tool_use", id: "toolu_test", name: reply.name, input: reply.input },
				],
				stop_reason: "tool_use",
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	};
	return { calls, fetch: fake as typeof fetch };
}

/** An env whose database records every touch and fails it, to prove that no SQL ran. */
export function noSqlEnv(): { env: Env; touched: string[] } {
	const touched: string[] = [];
	const trap = (what: string) => () => {
		touched.push(what);
		throw new Error("no SQL expected");
	};
	const db = { prepare: trap("prepare"), batch: trap("batch"), exec: trap("exec"), withSession: trap("withSession"), dump: trap("dump") };
	return { env: { ...env, tpo_cdp: db as unknown as D1Database } as Env, touched };
}

export function askRequest(question: unknown): Request {
	return new Request(BASE + "/api/assistant", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: BASE },
		body: JSON.stringify({ question }),
	});
}

/** The three example questions from the brief with the plans the scripted model returns for them. */
export const Q1 = {
	question: "How many Instagram signups went cold last month?",
	reply: { name: "count_profiles", input: { filters: { sources: ["instagram"], signup_from: "2026-08-01", signup_to: "2026-08-31", cold: true } } },
};
export const Q2 = {
	question: "Build me a list of our most engaged readers",
	reply: { name: "engagement_ranking", input: { limit: 50 } },
};
/** The Q1 filters, which match profiles 1, 4 and 8. */
export const Q1_FILTERS = { sources: ["instagram"], signup_from: "2026-08-01", signup_to: "2026-08-31", cold: true };
export const Q3 = {
	question: "Which pages do new subscribers hit first?",
	reply: { name: "top_pages", input: { filters: { signup_from: "2026-08-29" }, mode: "first_visit" } },
};
