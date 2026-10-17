// SPEC section 4. Requests are signed with the real HMAC against the miniflare WEBHOOK_SECRET; D1 is the real binding.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src";
import type { Limiter } from "../src/lib/limiter";
import { sign } from "../src/webhook/sign";
import { addAppUser, addDeviceLink, addEvent, addSubscriber, call, loginCookie, resetAll } from "./fixtures/cdp";
import { countRows, freshIp, makeEvent, postWebhook, SECRET, WEBHOOK_URL } from "./fixtures/webhook";

let cookie = "";

beforeAll(async () => {
	cookie = await loginCookie("203.0.113.23");
});

beforeEach(resetAll);

const nowSeconds = () => Math.floor(Date.now() / 1000);
const BAD_SIGNATURE = "0".repeat(64);

async function lookup(q: string): Promise<any> {
	const response = await call(`/api/lookup?q=${encodeURIComponent(q)}`, {}, cookie);
	expect(response.status, q).toBe(200);
	return response.json();
}

async function storedStatus(response: Response): Promise<string> {
	expect(response.status).toBe(200);
	return ((await response.json()) as { status: string }).status;
}

async function expectNothingStored(): Promise<void> {
	for (const table of ["app_events", "device_links", "app_users", "user_links", "profiles"] as const) {
		expect(await countRows(table), table).toBe(0);
	}
}

/** The side tables stay empty (used when app_events already holds the first copy of a duplicate). */
async function expectNoSideEffects(): Promise<void> {
	for (const table of ["device_links", "app_users", "user_links", "profiles"] as const) {
		expect(await countRows(table), table).toBe(0);
	}
}

const iso = (offsetSeconds: number) => new Date(Date.now() + offsetSeconds * 1000).toISOString().replace(/\.\d+Z$/, "Z");

async function seedJane(): Promise<void> {
	await addSubscriber({ id: "p_jane", email: "jane@x.com", source: "instagram", signup: "2026-06-01", open: "2026-08-01" });
	await addAppUser("u_jane", "p_jane");
}

describe("auth and limits", () => {
	it("A valid signature gets 200 stored", async () => {
		const event = makeEvent({ event: "read_story", device_id: "d_v", properties: { story: "a-story" } });
		const response = await postWebhook(event);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "stored" });
		const row = await env.tpo_cdp
			.prepare("SELECT event_id, event, user_id, device_id, ts, properties, received_at FROM app_events")
			.first<Record<string, string | null>>();
		expect(row).toMatchObject({
			event_id: event.event_id,
			event: "read_story",
			user_id: null,
			device_id: "d_v",
			ts: "2026-09-20T10:00:00Z",
			properties: '{"story":"a-story"}',
		});
		expect(row!.received_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
	});

	it("A bad signature gets 401 with an empty body", async () => {
		const wrong = await postWebhook(makeEvent(), { signature: BAD_SIGNATURE });
		expect(wrong.status).toBe(401);
		expect(await wrong.text()).toBe("");
		// Not hex, too short, empty and wrong-case-length signatures are the same bare 401.
		for (const signature of ["zz", "abcd", "", "G".repeat(64)]) {
			const response = await postWebhook(makeEvent(), { signature });
			expect(response.status, signature).toBe(401);
			expect(await response.text(), signature).toBe("");
		}
		// A signature made with another secret.
		const body = JSON.stringify(makeEvent());
		const ts = nowSeconds();
		const other = await postWebhook(body, { signature: await sign("some-other-secret", String(ts), body), timestamp: ts });
		expect(other.status).toBe(401);
		// Signing the body without the timestamp prefix does not verify either.
		const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		const bodyOnly = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		expect((await postWebhook(body, { signature: bodyOnly, timestamp: ts })).status).toBe(401);
		expect(await countRows("app_events")).toBe(0);
	});

	it("A missing header gets 401", async () => {
		const noSignature = await postWebhook(makeEvent(), { skipSignature: true });
		expect(noSignature.status).toBe(401);
		expect(await noSignature.text()).toBe("");
		const noTimestamp = await postWebhook(makeEvent(), { skipTimestamp: true });
		expect(noTimestamp.status).toBe(401);
		expect(await noTimestamp.text()).toBe("");
		expect((await postWebhook(makeEvent(), { skipTimestamp: true, skipSignature: true })).status).toBe(401);
		// A timestamp that is not a number is rejected the same way, even though it is correctly signed.
		expect((await postWebhook(makeEvent(), { timestamp: Number.NaN })).status).toBe(401);
		expect(await countRows("app_events")).toBe(0);
	});

	it("A timestamp 301 s old gets 401", async () => {
		const stale = await postWebhook(makeEvent(), { timestamp: nowSeconds() - 301 });
		expect(stale.status).toBe(401);
		expect(await stale.text()).toBe("");
		expect(await countRows("app_events")).toBe(0);
		// The window runs in both directions: 301 s ahead of the wall clock is rejected too.
		expect((await postWebhook(makeEvent(), { timestamp: nowSeconds() + 301 })).status).toBe(401);
		// Inside the window, on either side, is accepted.
		expect((await postWebhook(makeEvent(), { timestamp: nowSeconds() - 290 })).status).toBe(200);
		expect((await postWebhook(makeEvent(), { timestamp: nowSeconds() + 290 })).status).toBe(200);
	});

	it("A body changed after signing gets 401", async () => {
		const event = makeEvent();
		const signed = JSON.stringify(event);
		const changed = JSON.stringify({ ...event, device_id: "d_changed" });
		const response = await postWebhook(changed, { signedBody: signed });
		expect(response.status).toBe(401);
		expect(await response.text()).toBe("");
		// Whitespace is part of the raw bytes, so it breaks the signature too.
		expect((await postWebhook(signed + " ", { signedBody: signed })).status).toBe(401);
		expect(await countRows("app_events")).toBe(0);
	});

	it("A non-JSON content type gets 415", async () => {
		for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "text/html"]) {
			const response = await postWebhook(makeEvent(), { contentType });
			expect(response.status, contentType).toBe(415);
		}
		expect((await postWebhook(makeEvent(), { contentType: null })).status).toBe(415);
		// application/json with a charset parameter is still JSON.
		expect((await postWebhook(makeEvent(), { contentType: "application/json; charset=utf-8" })).status).toBe(200);
		// Auth runs before the content type check, so a bad signature with the wrong type is a 401.
		expect((await postWebhook(makeEvent(), { contentType: "text/plain", signature: BAD_SIGNATURE })).status).toBe(401);
		expect(await countRows("app_events")).toBe(1);
	});

	it("A 17 KB body gets 413", async () => {
		const big = JSON.stringify(makeEvent({ event: "link_click", properties: { url: "https://x.test/", pad: "x".repeat(17 * 1024) } }));
		expect(new TextEncoder().encode(big).length).toBeGreaterThan(17 * 1024);
		const response = await postWebhook(big);
		expect(response.status).toBe(413);
		// The size check runs before the signature check.
		expect((await postWebhook(big, { signature: BAD_SIGNATURE })).status).toBe(413);
		expect(await countRows("app_events")).toBe(0);
	});

	it("A body of exactly 16 KB is accepted and one byte more gets 413", async () => {
		const base = JSON.stringify(makeEvent());
		const pad = (bytes: number) => base + " ".repeat(bytes - new TextEncoder().encode(base).length);
		expect((await postWebhook(pad(16384))).status).toBe(200);
		expect((await postWebhook(pad(16385))).status).toBe(413);
	});

	it("A Content-Length header over 16 KB gets 413 before the body is read", async () => {
		// The body is tiny and unsigned: only the header can explain a 413.
		const response = await postWebhook("{}", { headers: { "Content-Length": "20000" }, signature: BAD_SIGNATURE });
		expect(response.status).toBe(413);
		expect(await countRows("app_events")).toBe(0);
	});

	it("A streamed body with no Content-Length gets 413 once it passes 16 KB, and the reader stops early", async () => {
		const big = JSON.stringify(makeEvent({ properties: { pad: "y".repeat(20 * 1024) } }));
		expect((await postWebhook(big, { stream: true })).status).toBe(413);
		// An endless stream: the handler must stop pulling shortly after 16 KB instead of reading all of it.
		let pulled = 0;
		const endless = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled += 1024;
				controller.enqueue(new Uint8Array(1024).fill(120));
				if (pulled > 4 * 1024 * 1024) controller.close();
			},
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request(WEBHOOK_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshIp(), "X-TPO-Timestamp": String(nowSeconds()), "X-TPO-Signature": BAD_SIGNATURE },
				body: endless,
				duplex: "half",
			} as RequestInit),
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(413);
		expect(pulled).toBeLessThanOrEqual(16384 + 64 * 1024);
	});

	it("Rate limit, with a fake limiter: 429, keyed on CF-Connecting-IP, before signature checking", async () => {
		const seen: string[] = [];
		const deny: Limiter = {
			limit: async ({ key }) => {
				seen.push(key);
				return { success: false };
			},
		};
		const fakeEnv = { ...env, WEBHOOK_LIMITER: deny } as Env;
		const ip = "198.51.100.77";
		const response = await postWebhook(makeEvent(), { ip, env: fakeEnv });
		expect(response.status).toBe(429);
		expect(seen).toEqual([ip]);
		// The 429 arrives before signature checking: a bad signature, no headers and a wrong content type all still get 429.
		expect((await postWebhook(makeEvent(), { ip, env: fakeEnv, signature: BAD_SIGNATURE })).status).toBe(429);
		expect((await postWebhook(makeEvent(), { ip, env: fakeEnv, skipSignature: true, skipTimestamp: true, contentType: "text/plain" })).status).toBe(429);
		expect(seen).toEqual([ip, ip, ip]);
		expect(await countRows("app_events")).toBe(0);
	});

	it("The limiter key is 'unknown' when CF-Connecting-IP is missing, and an allowed request goes through", async () => {
		const seen: string[] = [];
		const allow: Limiter = {
			limit: async ({ key }) => {
				seen.push(key);
				return { success: true };
			},
		};
		const response = await postWebhook(makeEvent(), { ip: null, env: { ...env, WEBHOOK_LIMITER: allow } as Env });
		expect(response.status).toBe(200);
		expect(seen).toEqual(["unknown"]);
	});

	it("Rate limit, real binding: one request with a unique IP through WEBHOOK_LIMITER gets 200", async () => {
		expect(typeof (env as unknown as { WEBHOOK_LIMITER: Limiter }).WEBHOOK_LIMITER.limit).toBe("function");
		const response = await postWebhook(makeEvent(), { ip: freshIp() });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "stored" });
	});

	it("GET gets 405", async () => {
		for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
			const response = await postWebhook("", { method });
			expect(response.status, method).toBe(405);
		}
		// 405 is the first check: it wins over a denying limiter.
		const deny: Limiter = { limit: async () => ({ success: false }) };
		expect((await postWebhook("", { method: "GET", env: { ...env, WEBHOOK_LIMITER: deny } as Env })).status).toBe(405);
	});
});

describe("validation", () => {
	it("A bad event type gets 400 and nothing is stored", async () => {
		const response = await postWebhook(makeEvent({ event: "purchase" }));
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_event" });
		await expectNothingStored();
	});

	it("read_story without a story gets 400", async () => {
		const badProperties = [{}, undefined, { story: "" }, { story: "Has Capitals" }, { story: "has space" }, { story: 5 }, { story: "a".repeat(121) }, { url: "https://x.test" }];
		for (const properties of badProperties) {
			const response = await postWebhook(makeEvent({ event: "read_story", user_id: "u_a", properties }));
			expect(response.status, JSON.stringify(properties)).toBe(400);
			expect(await response.json()).toEqual({ error: "invalid_event" });
		}
		await expectNothingStored();
		// 120 characters of [a-z0-9-] is the longest slug allowed.
		expect((await postWebhook(makeEvent({ event: "read_story", properties: { story: "a-1".repeat(40) } }))).status).toBe(200);
	});

	it("A timestamp 10 minutes in the future gets 400", async () => {
		const response = await postWebhook(makeEvent({ timestamp: iso(600) }));
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_event" });
		await expectNothingStored();
		// 4 minutes ahead is inside the 5 minute allowance.
		expect((await postWebhook(makeEvent({ timestamp: iso(240) }))).status).toBe(200);
		// The same instant 10 minutes ahead, written with an offset, is still in the future.
		const ahead = new Date(Date.now() + 600_000 + 2 * 3600_000);
		expect((await postWebhook(makeEvent({ timestamp: `${ahead.toISOString().slice(0, 19)}+02:00` }))).status).toBe(400);
	});

	it("login with a null user gets 400", async () => {
		const response = await postWebhook(makeEvent({ event: "login", user_id: null }));
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_event" });
		await expectNothingStored();
	});

	const rejected: [string, Record<string, unknown> | string][] = [
		["event_id empty", makeEvent({ event_id: "" })],
		["event_id 65 chars", makeEvent({ event_id: "e".repeat(65) })],
		["event_id with a space", makeEvent({ event_id: "bad id" })],
		["event_id with a dot", makeEvent({ event_id: "a.b" })],
		["event_id with a non-ASCII letter", makeEvent({ event_id: "café" })],
		["event_id a number", makeEvent({ event_id: 5 })],
		["event_id missing", makeEvent({ event_id: undefined })],
		["event a number", makeEvent({ event: 1 })],
		["event missing", makeEvent({ event: undefined })],
		["event in the wrong case", makeEvent({ event: "App_Open" })],
		["device_id missing", makeEvent({ device_id: undefined })],
		["device_id empty", makeEvent({ device_id: "" })],
		["device_id 65 chars", makeEvent({ device_id: "d".repeat(65) })],
		["device_id with a slash", makeEvent({ device_id: "d/1" })],
		["device_id a number", makeEvent({ device_id: 7 })],
		["device_id null", makeEvent({ device_id: null })],
		["user_id with a space", makeEvent({ user_id: "bad user" })],
		["user_id with a quote", makeEvent({ user_id: "u_a'; DROP TABLE app_users;--" })],
		["user_id 65 chars", makeEvent({ user_id: "u".repeat(65) })],
		["user_id empty", makeEvent({ user_id: "" })],
		["user_id a number", makeEvent({ user_id: 5 })],
		["timestamp without a zone", makeEvent({ timestamp: "2026-09-20T10:00:00" })],
		["timestamp a date only", makeEvent({ timestamp: "2026-09-20" })],
		["timestamp with a space instead of T", makeEvent({ timestamp: "2026-09-20 10:00:00Z" })],
		["timestamp not a date", makeEvent({ timestamp: "yesterday" })],
		["timestamp in month 13", makeEvent({ timestamp: "2026-13-20T10:00:00Z" })],
		["timestamp a number", makeEvent({ timestamp: 1789900000 })],
		["timestamp missing", makeEvent({ timestamp: undefined })],
		["properties an array", makeEvent({ properties: [] })],
		["properties a string", makeEvent({ properties: "x" })],
		["properties a number", makeEvent({ properties: 5 })],
		["properties null", makeEvent({ properties: null })],
		["link_click without a url", makeEvent({ event: "link_click", properties: {} })],
		["link_click with an ftp url", makeEvent({ event: "link_click", properties: { url: "ftp://x.test/a" } })],
		["link_click with a javascript url", makeEvent({ event: "link_click", properties: { url: "javascript:alert(1)" } })],
		["link_click with a relative url", makeEvent({ event: "link_click", properties: { url: "/news/a" } })],
		["link_click with text that is not a url", makeEvent({ event: "link_click", properties: { url: "not a url" } })],
		["link_click with a url over 2048 chars", makeEvent({ event: "link_click", properties: { url: "https://x.test/" + "a".repeat(2049 - 15) } })],
		["link_click with a url that is not a string", makeEvent({ event: "link_click", properties: { url: 5 } })],
		["an unknown top-level key", makeEvent({ extra: "x" })],
		["an unknown top-level key that is null", makeEvent({ source: null })],
		["a JSON array", "[]"],
		["JSON null", "null"],
		["a JSON string", '"x"'],
		["text that is not JSON", "{not json"],
		["an empty body", ""],
	];

	it.each(rejected)("rejects %s with 400 and stores nothing", async (_name, payload) => {
		const response = await postWebhook(payload);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_event" });
		await expectNothingStored();
	});

	it("accepts the boundary values and other valid shapes", async () => {
		const accepted: Record<string, unknown>[] = [
			makeEvent({ event_id: "e".repeat(64), device_id: "d".repeat(64), user_id: "A-b_9".repeat(12) }),
			makeEvent({ event: "link_click", properties: { url: "https://x.test/" + "a".repeat(2048 - 15) } }),
			makeEvent({ event: "link_click", properties: { url: "http://x.test/a?b=c", extra: [1, 2] } }),
			makeEvent({ properties: undefined }),
			makeEvent({ event: "login", user_id: "u_login" }),
			makeEvent({ event: "app_open", user_id: "u_open", properties: { anything: { nested: true } } }),
		];
		for (const event of accepted) expect((await postWebhook(event)).status, JSON.stringify(event).slice(0, 80)).toBe(200);
		expect(await countRows("app_events")).toBe(accepted.length);
	});

	it("A missing properties key is stored as {}", async () => {
		const event = makeEvent({ properties: undefined });
		await postWebhook(event);
		const row = await env.tpo_cdp.prepare("SELECT properties FROM app_events WHERE event_id = ?").bind(event.event_id).first<{ properties: string }>();
		expect(row!.properties).toBe("{}");
	});

	it("Timestamps with an offset or fractional seconds are stored as UTC YYYY-MM-DDTHH:MM:SSZ", async () => {
		const cases: [string, string][] = [
			["2026-09-20T12:00:00+02:00", "2026-09-20T10:00:00Z"],
			["2026-09-20T10:00:00.789Z", "2026-09-20T10:00:00Z"],
			["2026-09-19T23:30:00-05:00", "2026-09-20T04:30:00Z"],
			["2026-09-20T10:00:00z", "2026-09-20T10:00:00Z"],
		];
		for (const [sent, stored] of cases) {
			const event = makeEvent({ timestamp: sent });
			expect((await postWebhook(event)).status, sent).toBe(200);
			const row = await env.tpo_cdp.prepare("SELECT ts FROM app_events WHERE event_id = ?").bind(event.event_id).first<{ ts: string }>();
			expect(row!.ts, sent).toBe(stored);
		}
	});

	it("An invalid event with a bad signature is a 401, not a 400", async () => {
		const response = await postWebhook(makeEvent({ event: "purchase" }), { signature: BAD_SIGNATURE });
		expect(response.status).toBe(401);
		expect(await response.text()).toBe("");
	});
});

describe("storage and attribution", () => {
	it("A duplicate event_id gets 200 duplicate, and the row count stays 1", async () => {
		const event = makeEvent({ device_id: "d_dup" });
		expect(await storedStatus(await postWebhook(event))).toBe("stored");
		const second = await postWebhook(event);
		expect(second.status).toBe(200);
		expect(await second.json()).toEqual({ status: "duplicate" });
		expect(await countRows("app_events")).toBe(1);
	});

	it("A duplicate with a different payload keeps the first payload and writes nothing else", async () => {
		const first = makeEvent({ event_id: "e_same", event: "read_story", user_id: null, device_id: "d_first", timestamp: "2026-09-20T10:00:00Z", properties: { story: "first-story" } });
		expect(await storedStatus(await postWebhook(first))).toBe("stored");
		const second = { ...first, event: "login", user_id: "u_second_new", device_id: "d_second", timestamp: "2026-09-21T10:00:00Z", properties: { story: "second-story" } };
		expect(await storedStatus(await postWebhook(second))).toBe("duplicate");
		const rows = await env.tpo_cdp.prepare("SELECT event, user_id, device_id, ts, properties FROM app_events").all();
		expect(rows.results).toEqual([{ event: "read_story", user_id: null, device_id: "d_first", ts: "2026-09-20T10:00:00Z", properties: '{"story":"first-story"}' }]);
		// The duplicate's user and device are ignored: no device link, no new account, no new profile.
		await expectNoSideEffects();
	});

	it("An event with a user_id records a device link at the event time, and an anonymous one does not", async () => {
		await seedJane();
		await postWebhook(makeEvent({ event: "login", user_id: "u_jane", device_id: "d_link", timestamp: "2026-09-20T10:10:00Z" }));
		await postWebhook(makeEvent({ device_id: "d_anon_only", timestamp: "2026-09-20T10:11:00Z" }));
		const links = await env.tpo_cdp.prepare("SELECT device_id, user_id, seen_at FROM device_links").all();
		expect(links.results).toEqual([{ device_id: "d_link", user_id: "u_jane", seen_at: "2026-09-20T10:10:00Z" }]);
		// A known user creates no extra account or profile.
		expect(await countRows("profiles")).toBe(1);
		expect(await countRows("app_users")).toBe(1);
	});

	it("For out-of-order events (newer sent first), lookup lists them by event time and last seen = max", async () => {
		await seedJane();
		const sendAt = (id: string, timestamp: string) => postWebhook(makeEvent({ event_id: id, user_id: "u_jane", device_id: "d_ooo", timestamp }));
		// Sent newest first, then oldest, then the middle one.
		expect((await sendAt("e_newest", "2026-09-25T12:00:00Z")).status).toBe(200);
		expect((await sendAt("e_oldest", "2026-09-10T12:00:00Z")).status).toBe(200);
		expect((await sendAt("e_middle", "2026-09-18T12:00:00Z")).status).toBe(200);
		const body = await lookup("u_jane");
		expect(body.app_activity.total).toBe(3);
		expect(body.app_activity.recent.map((e: any) => e.event_id)).toEqual(["e_newest", "e_middle", "e_oldest"]);
		expect(body.app_activity.recent.map((e: any) => e.ts)).toEqual(["2026-09-25T12:00:00Z", "2026-09-18T12:00:00Z", "2026-09-10T12:00:00Z"]);
		expect(body.app_activity.last_seen).toBe("2026-09-25T12:00:00Z");
	});

	it("Anonymous events, then a login, then a lookup: the earlier events are attached and flagged", async () => {
		await seedJane();
		await postWebhook(makeEvent({ event_id: "a1", device_id: "d_x", timestamp: "2026-09-20T10:00:00Z" }));
		await postWebhook(makeEvent({ event_id: "a2", event: "read_story", device_id: "d_x", timestamp: "2026-09-20T10:05:00Z", properties: { story: "s-one" } }));
		// Before the login the anonymous events belong to nobody.
		expect((await lookup("u_jane")).app_activity.total).toBe(0);
		await postWebhook(makeEvent({ event_id: "a3", event: "login", user_id: "u_jane", device_id: "d_x", timestamp: "2026-09-20T10:10:00Z" }));
		const body = await lookup("u_jane");
		expect(body.app_activity.total).toBe(3);
		const byId = Object.fromEntries(body.app_activity.recent.map((e: any) => [e.event_id, e]));
		expect(byId.a1.attributed_from_device).toBe(true);
		expect(byId.a2.attributed_from_device).toBe(true);
		expect(byId.a3.attributed_from_device).toBe(false);
		expect(byId.a1.user_id).toBe("u_jane");
		expect(byId.a2.properties).toEqual({ story: "s-one" });
		// app_open 1 + read_story 2 + login 1; events are dated in the past and the window has no upper bound.
		expect(body.engagement.breakdown.app).toBe(4);
	});

	it("When the anonymous event is sent after the login but is dated before it, it is still attached", async () => {
		await seedJane();
		await postWebhook(makeEvent({ event_id: "l1", event: "login", user_id: "u_jane", device_id: "d_late", timestamp: "2026-09-20T10:10:00Z" }));
		expect((await postWebhook(makeEvent({ event_id: "late_anon", device_id: "d_late", timestamp: "2026-09-20T10:00:00Z" }))).status).toBe(200);
		const body = await lookup("u_jane");
		expect(body.app_activity.total).toBe(2);
		const late = body.app_activity.recent.find((e: any) => e.event_id === "late_anon");
		expect(late.attributed_from_device).toBe(true);
		expect(body.app_activity.recent.map((e: any) => e.event_id)).toEqual(["l1", "late_anon"]);
	});

	it("For a device that logs in as A and then B, each anonymous event goes to the right user by time", async () => {
		await addSubscriber({ id: "p_a", email: "a@x.com", source: "google", signup: "2026-06-01", open: "2026-08-01" });
		await addSubscriber({ id: "p_b", email: "b@x.com", source: "google", signup: "2026-06-02", open: "2026-08-02" });
		await addAppUser("u_a", "p_a");
		await addAppUser("u_b", "p_b");
		const send = (id: string, timestamp: string, user: string | null = null, event = "app_open") =>
			postWebhook(makeEvent({ event_id: id, event, user_id: user, device_id: "d_shared", timestamp }));
		await send("anon_before_all", "2026-09-20T09:00:00Z");
		await send("login_a", "2026-09-20T10:00:00Z", "u_a", "login");
		await send("anon_during_a", "2026-09-20T10:30:00Z");
		await send("login_b", "2026-09-20T11:00:00Z", "u_b", "login");
		await send("anon_during_b", "2026-09-20T11:30:00Z");
		// Sent last, but dated while A was logged in.
		await send("anon_late_for_a", "2026-09-20T10:45:00Z");
		const a = await lookup("u_a");
		const b = await lookup("u_b");
		expect(a.app_activity.recent.map((e: any) => e.event_id)).toEqual(["anon_late_for_a", "anon_during_a", "login_a", "anon_before_all"]);
		expect(b.app_activity.recent.map((e: any) => e.event_id)).toEqual(["anon_during_b", "login_b"]);
		expect(a.app_activity.total).toBe(4);
		expect(b.app_activity.total).toBe(2);
		expect(a.app_activity.recent.filter((e: any) => e.attributed_from_device).map((e: any) => e.event_id).sort()).toEqual([
			"anon_before_all",
			"anon_during_a",
			"anon_late_for_a",
		]);
		expect(b.app_activity.recent.filter((e: any) => e.attributed_from_device).map((e: any) => e.event_id)).toEqual(["anon_during_b"]);
	});

	it("An unknown user_id creates an unknown_app_user profile visible in lookup. Sending a second event for that user creates no second profile", async () => {
		const first = await postWebhook(makeEvent({ event_id: "n1", event: "login", user_id: "u_brand_new", device_id: "d_n", timestamp: "2026-09-20T10:00:00Z" }));
		expect(await storedStatus(first)).toBe("stored");
		expect(await countRows("profiles")).toBe(1);
		const created = await env.tpo_cdp
			.prepare("SELECT p.profile_id, p.kind, p.email_norm, l.user_id FROM profiles p JOIN user_links l ON l.profile_id = p.profile_id")
			.first<{ profile_id: string; kind: string; email_norm: string | null; user_id: string }>();
		expect(created).toMatchObject({ kind: "unknown_app_user", email_norm: null, user_id: "u_brand_new" });
		expect(created!.profile_id).toMatch(/^[0-9a-f]{32}$/);
		const account = await env.tpo_cdp.prepare("SELECT user_id, email_raw, email_norm, origin FROM app_users").all();
		expect(account.results).toEqual([{ user_id: "u_brand_new", email_raw: null, email_norm: null, origin: "webhook" }]);
		const body = await lookup("u_brand_new");
		expect(body.kind).toBe("unknown_app_user");
		expect(body.email).toBeNull();
		expect(body.profile_id).toBe(created!.profile_id);
		expect(body.app_activity.total).toBe(1);

		// A second event for the same user, then another login with a new event_id: still one profile, one account.
		expect((await postWebhook(makeEvent({ event_id: "n2", user_id: "u_brand_new", device_id: "d_n", timestamp: "2026-09-20T11:00:00Z" }))).status).toBe(200);
		expect((await postWebhook(makeEvent({ event_id: "n3", event: "login", user_id: "u_brand_new", device_id: "d_n2", timestamp: "2026-09-20T12:00:00Z" }))).status).toBe(200);
		expect(await countRows("profiles")).toBe(1);
		expect(await countRows("app_users")).toBe(1);
		expect(await countRows("user_links")).toBe(1);
		const again = await lookup("u_brand_new");
		expect(again.profile_id).toBe(created!.profile_id);
		expect(again.app_activity.total).toBe(3);
	});

	it("An anonymous event on a device that later logs in as an unknown user is attached to that new profile", async () => {
		await postWebhook(makeEvent({ event_id: "z1", device_id: "d_z", timestamp: "2026-09-20T10:00:00Z" }));
		await postWebhook(makeEvent({ event_id: "z2", event: "login", user_id: "u_zed", device_id: "d_z", timestamp: "2026-09-20T10:05:00Z" }));
		const body = await lookup("u_zed");
		expect(body.app_activity.recent.map((e: any) => [e.event_id, e.attributed_from_device])).toEqual([
			["z2", false],
			["z1", true],
		]);
	});

	it("A known user logging in from a second device keeps one profile and links both devices", async () => {
		await seedJane();
		await postWebhook(makeEvent({ event: "login", user_id: "u_jane", device_id: "d_phone", timestamp: "2026-09-20T10:00:00Z" }));
		await postWebhook(makeEvent({ event: "login", user_id: "u_jane", device_id: "d_tablet", timestamp: "2026-09-21T10:00:00Z" }));
		expect(await countRows("profiles")).toBe(1);
		expect(await countRows("device_links")).toBe(2);
		expect((await lookup("u_jane")).app_activity.total).toBe(2);
	});

	it("Webhook events and directly seeded rows resolve through the same ownership rules", async () => {
		await seedJane();
		await addDeviceLink("d_seed", "u_jane", "2026-09-15T00:00:00Z");
		await addEvent({ id: "seeded_anon", event: "app_open", user: null, device: "d_seed", ts: "2026-09-16T00:00:00Z" });
		await postWebhook(makeEvent({ event_id: "hook_anon", device_id: "d_seed", timestamp: "2026-09-17T00:00:00Z" }));
		const body = await lookup("u_jane");
		expect(body.app_activity.recent.map((e: any) => [e.event_id, e.attributed_from_device])).toEqual([
			["hook_anon", true],
			["seeded_anon", true],
		]);
	});
});

describe("security headers and generic errors on the webhook", () => {
	const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

	function expectHardeningHeaders(response: Response): void {
		expect(response.headers.get("Content-Security-Policy")).toBe(CSP);
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
	}

	it("A stored 200 carries the section 8 headers", async () => {
		const response = await postWebhook(makeEvent());
		expect(response.status).toBe(200);
		expectHardeningHeaders(response);
	});

	it("The bare 401 carries the section 8 headers and still has an empty body", async () => {
		const response = await postWebhook(makeEvent(), { signature: BAD_SIGNATURE });
		expect(response.status).toBe(401);
		expectHardeningHeaders(response);
		expect(await response.text()).toBe("");
	});

	it("A database failure gives 500 with exactly {\"error\":\"internal\"}, no stack text and the headers", async () => {
		const broken = {
			prepare: () => ({ bind: () => ({}) }),
			batch: async () => {
				throw new Error("SQLITE_ERROR: no such table: app_events\n    at Object.run (/secret/path/store.ts:12:34)");
			},
		};
		const failing = { ...env, tpo_cdp: broken } as unknown as Env;
		const response = await postWebhook(makeEvent(), { env: failing });
		expect(response.status).toBe(500);
		const text = await response.text();
		expect(text).toBe('{"error":"internal"}');
		expect(text).not.toMatch(/SQLITE|\bat\b|store\.ts|secret/);
		expectHardeningHeaders(response);
	});
});
