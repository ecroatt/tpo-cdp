// Direct D1 seeding helpers for the lookup and segment tests. Rows go straight into the real tables.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../src";

const DATA_TABLES = [
	"profiles",
	"subscribers",
	"web_events",
	"visitor_links",
	"app_users",
	"user_links",
	"app_events",
	"device_links",
];

export async function resetAll(): Promise<void> {
	await env.tpo_cdp.batch(DATA_TABLES.map((t) => env.tpo_cdp.prepare(`DELETE FROM ${t}`)));
}

export async function addProfile(id: string, kind: "subscriber" | "app_only" | "unknown_app_user", email: string | null): Promise<void> {
	await env.tpo_cdp
		.prepare("INSERT INTO profiles (profile_id, kind, email_norm, created_at) VALUES (?, ?, ?, ?)")
		.bind(id, kind, email, "2026-09-01T00:00:00Z")
		.run();
}

export interface SubscriberSeed {
	id: string;
	email: string;
	source: string | null;
	status?: "active" | "unsubscribed";
	signup: string;
	open: string | null;
}

/** A subscriber profile plus its subscribers row. `email` must already be normalized. */
export async function addSubscriber(s: SubscriberSeed): Promise<void> {
	await addProfile(s.id, "subscriber", s.email);
	await env.tpo_cdp
		.prepare("INSERT INTO subscribers (email_norm, email_raw, signup_date, status, source, source_raw, last_open_date) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.bind(s.email, s.email, s.signup, s.status ?? "active", s.source, s.source, s.open)
		.run();
}

export async function addVisitor(visitorId: string, profileId: string | null): Promise<void> {
	if (profileId === null) return;
	await env.tpo_cdp.prepare("INSERT INTO visitor_links (visitor_id, profile_id) VALUES (?, ?)").bind(visitorId, profileId).run();
}

let visitSeq = 0;
export async function addVisit(visitorId: string, ts: string, page = "/news/a", source: string | null = null): Promise<void> {
	visitSeq += 1;
	await env.tpo_cdp
		.prepare("INSERT INTO web_events (visitor_id, page, ts, source, source_raw) VALUES (?, ?, ?, ?, ?)")
		.bind(visitorId, `${page}?n=${visitSeq}`, ts, source, source)
		.run();
}

export async function addAppUser(userId: string, profileId: string, createdAt: string | null = "2026-08-22"): Promise<void> {
	await env.tpo_cdp
		.prepare("INSERT INTO app_users (user_id, email_raw, email_norm, created_at, origin) VALUES (?, NULL, NULL, ?, 'csv')")
		.bind(userId, createdAt)
		.run();
	await env.tpo_cdp.prepare("INSERT INTO user_links (user_id, profile_id) VALUES (?, ?)").bind(userId, profileId).run();
}

export async function addEvent(e: { id: string; event: string; user: string | null; device: string; ts: string; properties?: object }): Promise<void> {
	await env.tpo_cdp
		.prepare("INSERT INTO app_events (event_id, event, user_id, device_id, ts, properties, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.bind(e.id, e.event, e.user, e.device, e.ts, JSON.stringify(e.properties ?? {}), "2026-09-28T12:00:00Z")
		.run();
}

export async function addDeviceLink(device: string, user: string, seenAt: string): Promise<void> {
	await env.tpo_cdp.prepare("INSERT INTO device_links (device_id, user_id, seen_at) VALUES (?, ?, ?)").bind(device, user, seenAt).run();
}

const BASE = "https://cdp.test";

/** Calls the Worker the way a browser would. Pass `cookie` for an authenticated session. */
export async function call(path: string, init: RequestInit = {}, cookie?: string): Promise<Response> {
	const headers = new Headers(init.headers);
	if (cookie) headers.set("Cookie", cookie);
	const ctx = createExecutionContext();
	const response = await worker.fetch(new Request(BASE + path, { redirect: "manual", ...init, headers }), env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

/** Logs in with the dummy test password and returns the cookie pair. `ip` keeps each file's login limiter key separate. */
export async function loginCookie(ip: string): Promise<string> {
	const response = await call("/login", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": ip },
		body: new URLSearchParams({ password: "test-ui-password" }),
	});
	return response.headers.get("Set-Cookie")!.split(";")[0];
}

/** POST JSON with the same-origin Origin header the CSRF gate requires. */
export function postJson(path: string, body: unknown, cookie?: string): Promise<Response> {
	return call(path, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify(body) }, cookie);
}
