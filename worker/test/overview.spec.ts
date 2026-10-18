// SPEC 9 headline tiles: GET /api/overview.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/session";
import { addAppUser, addEvent, addProfile, addSubscriber, call, loginCookie, postJson, resetAll } from "./fixtures/cdp";

let cookie = "";

beforeAll(async () => {
	cookie = await loginCookie("203.0.113.70");
	await resetAll();
	// Five profiles of all three kinds: 3 subscribers (2 active, 1 unsubscribed), 1 app_only, 1 unknown_app_user.
	await addSubscriber({ id: "p1", email: "one@x.com", source: "instagram", signup: "2026-06-01", open: null });
	await addSubscriber({ id: "p2", email: "two@x.com", source: "google", signup: "2026-06-02", open: null });
	await addSubscriber({ id: "p3", email: "three@x.com", source: "x", status: "unsubscribed", signup: "2026-06-03", open: null });
	await addProfile("p4", "app_only", "four@x.com");
	await addProfile("p5", "unknown_app_user", null);
	// Three app users, hence three user_links: two from the CSV, one created by the webhook.
	await addAppUser("a1", "p1");
	await addAppUser("a2", "p4");
	await env.tpo_cdp.prepare("INSERT INTO app_users (user_id, email_raw, email_norm, created_at, origin) VALUES (?, NULL, NULL, NULL, 'webhook')").bind("w1").run();
	await env.tpo_cdp.prepare("INSERT INTO user_links (user_id, profile_id) VALUES (?, ?)").bind("w1", "p5").run();
	// Five events. The 30-day window starts 2026-08-29: two events are before it, three count (the last is after TODAY).
	await addEvent({ id: "e1", event: "app_open", user: "a1", device: "d1", ts: "2026-07-01T10:00:00Z" });
	await addEvent({ id: "e2", event: "app_open", user: "a1", device: "d1", ts: "2026-08-28T23:59:59Z" });
	await addEvent({ id: "e3", event: "read_story", user: "a2", device: "d2", ts: "2026-08-29T00:00:00Z" });
	await addEvent({ id: "e4", event: "app_open", user: "w1", device: "d3", ts: "2026-09-20T09:00:00Z" });
	await addEvent({ id: "e5", event: "login", user: null, device: "d4", ts: "2026-10-05T09:00:00Z" });
});

describe("GET /api/overview", () => {
	it("returns the hand-derived counts on a seeded fixture", async () => {
		const response = await call("/api/overview", {}, cookie);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ people: 5, active_subscribers: 2, app_users_linked: 3, app_events_30d: 3 });
	});

	it("without a session it returns 401", async () => {
		const response = await call("/api/overview");
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "unauthorized" });
	});

	it("with an expired session it returns 401", async () => {
		const token = "f".repeat(64);
		await env.tpo_cdp
			.prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
			.bind(await sha256Hex(token), "2026-10-16T00:00:00Z", "2026-10-16T12:00:00Z")
			.run();
		const response = await call("/api/overview", {}, `__Host-session=${token}`);
		expect(response.status).toBe(401);
	});

	it("POST /api/overview returns 404", async () => {
		const response = await postJson("/api/overview", {}, cookie);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not_found" });
	});
});
