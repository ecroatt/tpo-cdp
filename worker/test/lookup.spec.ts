import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addAppUser, addDeviceLink, addEvent, addProfile, addSubscriber, addVisit, addVisitor, call, loginCookie, postJson, resetAll } from "./fixtures/cdp";
import { makeEvent, postWebhook } from "./fixtures/webhook";

let cookie = "";

beforeAll(async () => {
	cookie = await loginCookie("203.0.113.21");
});

async function lookup(q: string, session: string | null = cookie): Promise<Response> {
	return postJson("/api/lookup", { q }, session ?? undefined);
}

/**
 * Jane: instagram subscriber, last open 2026-08-01 (58 days before TODAY, so cold), two linked visitors,
 * one app account, and app events that are owned directly, attributed by device, or unowned.
 */
async function seedJane() {
	await resetAll();
	await addSubscriber({ id: "p_jane", email: "jane.doe@x.com", source: "instagram", signup: "2026-06-01", open: "2026-08-01" });
	await addVisitor("v_j1", "p_jane");
	await addVisitor("v_j2", "p_jane");
	// v_j1's first visit carries no email at all; it is attached only through visitor_links.
	await addVisit("v_j1", "2026-09-10T08:00:00Z", "/news/a");
	await addVisit("v_j1", "2026-09-12T08:00:00Z", "/news/b");
	await addVisit("v_j2", "2026-09-11T08:00:00Z", "/home");
	await addAppUser("u_jane", "p_jane", "2026-08-22");
	await addEvent({ id: "e_own", event: "read_story", user: "u_jane", device: "d_j", ts: "2026-09-20T10:00:00Z", properties: { story: "a-story" } });
	await addDeviceLink("d_j", "u_jane", "2026-09-15T00:00:00Z");
	// Anonymous, dated before the login: owned by the earliest link after it.
	await addEvent({ id: "e_anon_before", event: "app_open", user: null, device: "d_j", ts: "2026-09-10T10:00:00Z" });
	// Anonymous, dated after the login: owned by the latest link at or before it.
	await addEvent({ id: "e_anon_after", event: "app_open", user: null, device: "d_j", ts: "2026-09-25T10:00:00Z" });
	// Anonymous on a device that never logs in: belongs to nobody.
	await addEvent({ id: "e_unowned", event: "app_open", user: null, device: "d_nobody", ts: "2026-09-26T10:00:00Z" });
}

describe("lookup", () => {
	beforeEach(seedJane);

	it("An email with different case and spaces finds the profile", async () => {
		const response = await lookup("  Jane.DOE@X.com  ");
		expect(response.status).toBe(200);
		const body = (await response.json()) as any;
		expect(body.profile_id).toBe("p_jane");
		expect(body.kind).toBe("subscriber");
		expect(body.email).toBe("jane.doe@x.com");
		expect(body.newsletter).toEqual({
			signup_date: "2026-06-01",
			status: "active",
			source: "instagram",
			last_open_date: "2026-08-01",
			cold: true,
			days_since_open: 58,
		});
		expect(body.app_accounts).toEqual([{ user_id: "u_jane", created_at: "2026-08-22" }]);
	});

	it("Lookup by user_id, profile_id and visitor_id each return the same profile", async () => {
		const byEmail = await (await lookup("jane.doe@x.com")).json();
		for (const q of ["p_jane", "u_jane", "v_j1", "v_j2"]) {
			const response = await lookup(q);
			expect(response.status, q).toBe(200);
			expect(await response.json(), q).toEqual(byEmail);
		}
	});

	it("A partial email returns 404", async () => {
		for (const q of ["jane.doe", "jane.doe@x", "doe@x.com", "jane", "@x.com", "p_jan", "u_"]) {
			const response = await lookup(q);
			expect(response.status, q).toBe(404);
			expect(await response.json(), q).toEqual({ error: "not_found" });
		}
		expect((await call("/api/lookup", {}, cookie)).status).toBe(404);
	});

	it("The profile shows visits from an email-less visit on a linked visitor", async () => {
		const body = (await (await lookup("jane.doe@x.com")).json()) as any;
		expect(body.site_visits.visitor_ids).toEqual(["v_j1", "v_j2"]);
		expect(body.site_visits.total).toBe(3);
		const stored = await env.tpo_cdp.prepare("SELECT email_raw, email_norm FROM web_events WHERE visitor_id = 'v_j1'").all();
		expect(stored.results.every((r: any) => r.email_raw === null && r.email_norm === null)).toBe(true);
		// Newest first, across both visitor_ids.
		expect(body.site_visits.recent.map((v: any) => v.ts)).toEqual(["2026-09-12T08:00:00Z", "2026-09-11T08:00:00Z", "2026-09-10T08:00:00Z"]);
		expect(body.site_visits.recent.map((v: any) => v.visitor_id)).toEqual(["v_j1", "v_j2", "v_j1"]);
	});

	it("An anonymous event attributed by login is flagged", async () => {
		const body = (await (await lookup("u_jane")).json()) as any;
		const byId = Object.fromEntries(body.app_activity.recent.map((e: any) => [e.event_id, e]));
		expect(byId.e_own.attributed_from_device).toBe(false);
		expect(byId.e_anon_before.attributed_from_device).toBe(true);
		expect(byId.e_anon_after.attributed_from_device).toBe(true);
		expect(byId.e_anon_before.user_id).toBe("u_jane");
		expect(byId.e_own.properties).toEqual({ story: "a-story" });
		// The unowned event is stored but belongs to no profile.
		expect(byId.e_unowned).toBeUndefined();
		expect(body.app_activity.total).toBe(3);
		expect(body.app_activity.recent.map((e: any) => e.event_id)).toEqual(["e_anon_after", "e_own", "e_anon_before"]);
	});

	it("An unauthenticated request returns 401", async () => {
		const response = await lookup("jane.doe@x.com", null);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "unauthorized" });
	});

	it("shows the engagement score with its breakdown", async () => {
		const body = (await (await lookup("p_jane")).json()) as any;
		// Newsletter 0 (open 08-01 is before the window), site 3 visits, app: read_story 2 + two app_open 1 + 1 = 4.
		expect(body.engagement).toEqual({ score: 7, breakdown: { newsletter: 0, site: 3, app: 4 }, window_start: "2026-08-29" });
	});

	it("is never cached, so a new event shows on the very next request", async () => {
		const first = await lookup("p_jane");
		expect(first.headers.get("Cache-Control")).toBe("no-store");
		expect(((await first.json()) as any).app_activity.total).toBe(3);
		await addEvent({ id: "e_new", event: "link_click", user: "u_jane", device: "d_j", ts: "2026-09-29T10:00:00Z", properties: { url: "https://x.test" } });
		const second = (await (await lookup("p_jane")).json()) as any;
		expect(second.app_activity.total).toBe(4);
		expect(second.app_activity.recent[0].event_id).toBe("e_new");
		expect(second.engagement.breakdown.app).toBe(5);
	});

	it("returns an anonymous_visitor shape for a visitor_id that is not linked", async () => {
		await addVisit("v_anon", "2026-09-01T00:00:00Z", "/a");
		await addVisit("v_anon", "2026-09-02T00:00:00Z", "/b");
		const response = await lookup("v_anon");
		expect(response.status).toBe(200);
		const body = (await response.json()) as any;
		expect(body.kind).toBe("anonymous_visitor");
		expect(body.visits).toHaveLength(2);
		expect(body.visits[0].ts).toBe("2026-09-02T00:00:00Z");
		expect(body.profile_id).toBeUndefined();
	});

	it("returns 404 not_found when nothing matches", async () => {
		const response = await lookup("nobody@nowhere.com");
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not_found" });
	});

	it("caps site visits and app activity at the 100 most recent, newest first, with the full total", async () => {
		const statements = [];
		for (let i = 0; i < 105; i++) {
			const ts = `2026-09-${String(1 + Math.floor(i / 10)).padStart(2, "0")}T${String(i % 10).padStart(2, "0")}:00:00Z`;
			statements.push(
				env.tpo_cdp.prepare("INSERT INTO web_events (visitor_id, page, ts) VALUES (?, ?, ?)").bind("v_j1", `/bulk/${i}`, ts),
				env.tpo_cdp
					.prepare("INSERT INTO app_events (event_id, event, user_id, device_id, ts, properties, received_at) VALUES (?, 'app_open', 'u_jane', 'd_j', ?, '{}', ?)")
					.bind(`bulk_${i}`, ts, ts),
			);
		}
		await env.tpo_cdp.batch(statements);
		const body = (await (await lookup("p_jane")).json()) as any;
		expect(body.site_visits.total).toBe(108);
		expect(body.site_visits.recent).toHaveLength(100);
		expect(body.app_activity.total).toBe(108);
		expect(body.app_activity.recent).toHaveLength(100);
		for (const list of [body.site_visits.recent, body.app_activity.recent]) {
			const times = list.map((x: any) => x.ts);
			expect(times).toEqual([...times].sort().reverse());
		}
	});

	it("keeps the 100 newest rows and drops the oldest when over the cap", async () => {
		const statements = [];
		for (let i = 0; i < 105; i++) {
			const ts = `2026-09-${String(1 + Math.floor(i / 10)).padStart(2, "0")}T${String(i % 10).padStart(2, "0")}:00:00Z`;
			statements.push(
				env.tpo_cdp.prepare("INSERT INTO web_events (visitor_id, page, ts) VALUES (?, ?, ?)").bind("v_j1", `/bulk/${i}`, ts),
				env.tpo_cdp
					.prepare("INSERT INTO app_events (event_id, event, user_id, device_id, ts, properties, received_at) VALUES (?, 'app_open', 'u_jane', 'd_j', ?, '{}', ?)")
					.bind(`bulk_${i}`, ts, ts),
			);
		}
		await env.tpo_cdp.batch(statements);
		const body = (await (await lookup("p_jane")).json()) as any;
		const visits = body.site_visits.recent.map((x: any) => x.ts);
		const events = body.app_activity.recent.map((x: any) => x.ts);
		expect(visits[0]).toBe("2026-09-12T08:00:00Z");
		expect(events[0]).toBe("2026-09-25T10:00:00Z");
		// 108 rows each; the 100th newest is 2026-09-01T08, so only 09-01T00..T07 are dropped.
		expect(visits[99]).toBe("2026-09-01T08:00:00Z");
		expect(events[99]).toBe("2026-09-01T08:00:00Z");
		for (let h = 0; h < 8; h++) {
			const dropped = `2026-09-01T0${h}:00:00Z`;
			expect(visits).not.toContain(dropped);
			expect(events).not.toContain(dropped);
		}
	});

	it("returns 404 not_found for an empty q and a whitespace-only q", async () => {
		for (const q of ["", "  "]) {
			const response = await lookup(q);
			expect(response.status, JSON.stringify(q)).toBe(404);
			expect(await response.json(), JSON.stringify(q)).toEqual({ error: "not_found" });
		}
	});

	it("has no newsletter block for a profile without a subscriber row", async () => {
		await addProfile("p_unknown", "unknown_app_user", null);
		await addAppUser("u_unknown", "p_unknown", null);
		const body = (await (await lookup("u_unknown")).json()) as any;
		expect(body.kind).toBe("unknown_app_user");
		expect(body.email).toBeNull();
		expect(body.newsletter).toBeNull();
		expect(body.engagement.score).toBe(0);
	});

	it("flags a never-opened recent signup as not cold with no days since open", async () => {
		await addSubscriber({ id: "p_new", email: "new@x.com", source: null, signup: "2026-09-20", open: null });
		const body = (await (await lookup("new@x.com")).json()) as any;
		expect(body.newsletter.cold).toBe(false);
		expect(body.newsletter.days_since_open).toBeNull();
	});
});

describe("app_event_owner view", () => {
	beforeEach(resetAll);

	const owner = async (eventId: string) =>
		(await env.tpo_cdp.prepare("SELECT owner_user_id FROM app_event_owner WHERE event_id = ?").bind(eventId).first<{ owner_user_id: string | null }>())!.owner_user_id;

	it("gives an event with a user_id to that user, whatever the device links say", async () => {
		await addDeviceLink("d1", "u_other", "2026-09-01T00:00:00Z");
		await addEvent({ id: "e1", event: "app_open", user: "u_mine", device: "d1", ts: "2026-09-10T00:00:00Z" });
		expect(await owner("e1")).toBe("u_mine");
	});

	it("sends each anonymous event on a shared device to the user logged in at that time", async () => {
		await addDeviceLink("d1", "u_a", "2026-09-10T00:00:00Z");
		await addDeviceLink("d1", "u_b", "2026-09-20T00:00:00Z");
		await addEvent({ id: "before_a", event: "app_open", user: null, device: "d1", ts: "2026-09-05T00:00:00Z" });
		await addEvent({ id: "during_a", event: "app_open", user: null, device: "d1", ts: "2026-09-15T00:00:00Z" });
		await addEvent({ id: "at_b", event: "app_open", user: null, device: "d1", ts: "2026-09-20T00:00:00Z" });
		await addEvent({ id: "after_b", event: "app_open", user: null, device: "d1", ts: "2026-09-27T00:00:00Z" });
		expect(await owner("before_a")).toBe("u_a");
		expect(await owner("during_a")).toBe("u_a");
		expect(await owner("at_b")).toBe("u_b");
		expect(await owner("after_b")).toBe("u_b");
	});

	it("leaves an anonymous event on a device with no links unowned", async () => {
		await addEvent({ id: "lonely", event: "app_open", user: null, device: "d_none", ts: "2026-09-05T00:00:00Z" });
		expect(await owner("lonely")).toBeNull();
	});
});

describe("lookup after webhook events", () => {
	beforeEach(seedJane);

	it("A webhook event posted in the test shows up in a lookup made right after it", async () => {
		const before = (await (await lookup("u_jane")).json()) as any;
		expect(before.app_activity.total).toBe(3);
		const event = makeEvent({ event: "link_click", user_id: "u_jane", device_id: "d_j", timestamp: "2026-09-29T09:00:00Z", properties: { url: "https://example.test/offer" } });
		const posted = await postWebhook(event);
		expect(posted.status).toBe(200);
		expect(await posted.json()).toEqual({ status: "stored" });
		const after = (await (await lookup("u_jane")).json()) as any;
		expect(after.app_activity.total).toBe(4);
		expect(after.app_activity.recent[0]).toMatchObject({
			event_id: event.event_id,
			event: "link_click",
			ts: "2026-09-29T09:00:00Z",
			user_id: "u_jane",
			properties: { url: "https://example.test/offer" },
			attributed_from_device: false,
		});
		// Jane's seeded app points are 4 (read_story 2 + two app_open); the link_click adds 1.
		expect(after.engagement.breakdown.app).toBe(5);
		expect(after.app_activity.last_seen).toBe("2026-09-29T09:00:00Z");
	});

	it("An anonymous event attributed by login is flagged (events sent through the webhook)", async () => {
		// A new device with two anonymous events, then Jane logs in on it.
		await postWebhook(makeEvent({ event_id: "w_anon1", device_id: "d_wh", timestamp: "2026-09-21T08:00:00Z" }));
		await postWebhook(makeEvent({ event_id: "w_anon2", event: "read_story", device_id: "d_wh", timestamp: "2026-09-21T08:05:00Z", properties: { story: "morning-edition" } }));
		const unattributed = (await (await lookup("u_jane")).json()) as any;
		expect(unattributed.app_activity.recent.map((e: any) => e.event_id)).not.toContain("w_anon1");
		const login = await postWebhook(makeEvent({ event_id: "w_login", event: "login", user_id: "u_jane", device_id: "d_wh", timestamp: "2026-09-21T08:10:00Z" }));
		expect(login.status).toBe(200);
		const body = (await (await lookup("u_jane")).json()) as any;
		const byId = Object.fromEntries(body.app_activity.recent.map((e: any) => [e.event_id, e]));
		expect(byId.w_anon1.attributed_from_device).toBe(true);
		expect(byId.w_anon2.attributed_from_device).toBe(true);
		expect(byId.w_anon2.properties).toEqual({ story: "morning-edition" });
		expect(byId.w_login.attributed_from_device).toBe(false);
		expect(byId.w_login.user_id).toBe("u_jane");
		// Jane's 3 seeded events plus the 3 above.
		expect(body.app_activity.total).toBe(6);
	});
});

describe("lookup is POST only", () => {
	beforeEach(seedJane);

	it("GET /api/lookup?q=... does not run a lookup", async () => {
		for (const q of ["jane.doe@x.com", "p_jane"]) {
			const response = await call(`/api/lookup?q=${encodeURIComponent(q)}`, {}, cookie);
			expect(response.status, q).toBe(404);
			expect(await response.json(), q).toEqual({ error: "not_found" });
		}
	});

	it("a foreign Origin gets 403 and a non-JSON content type gets 403", async () => {
		const foreign = await call(
			"/api/lookup",
			{ method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ q: "p_jane" }) },
			cookie,
		);
		expect(foreign.status).toBe(403);
		const form = await call("/api/lookup", { method: "POST", headers: { "Content-Type": "text/plain", Origin: "https://cdp.test" }, body: JSON.stringify({ q: "p_jane" }) }, cookie);
		expect(form.status).toBe(403);
	});

	it("a body that is not JSON, or has no string q, finds nothing", async () => {
		const bad = await call("/api/lookup", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://cdp.test" }, body: "{nope" }, cookie);
		expect(bad.status).toBe(400);
		for (const body of [{}, { q: 42 }, { q: null }, { q: ["p_jane"] }]) {
			const response = await postJson("/api/lookup", body, cookie);
			expect(response.status, JSON.stringify(body)).toBe(404);
		}
	});
});
