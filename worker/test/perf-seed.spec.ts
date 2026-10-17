// The app-event seed that `npm run perf` loads into the local database.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { applyPerfSeed, buildPerfSeed } from "../scripts/lib/perf-seed";
import { ownedActivity, ownedWindowPoints } from "../src/lib/owned-events";
import { daysBefore, LAST_30_START, TODAY } from "../src/lib/time";
import { APP_POINTS_BINDS, APP_POINTS_CTE } from "../src/segments/engagement";
import { resetAll } from "./fixtures/cdp";

const users = Array.from({ length: 300 }, (_, i) => `u_perf_pool_${i}`);

describe("perf seed", () => {
	it("is the same on every build", () => {
		expect(buildPerfSeed(users)).toEqual(buildPerfSeed(users));
	});

	it("has about 5,000 events on 300 devices, dated from 85 days before TODAY to a few days after", () => {
		const seed = buildPerfSeed(users);
		expect(seed.devices).toBe(300);
		expect(seed.events.length).toBeGreaterThan(4500);
		expect(seed.events.length).toBeLessThan(5500);
		expect(new Set(seed.events.map((e) => e.deviceId)).size).toBe(300);
		expect(new Set(seed.events.map((e) => e.id)).size).toBe(seed.events.length);
		const first = daysBefore(TODAY, 85);
		const last = "2026-10-01T00:00:00Z";
		for (const e of seed.events) {
			expect(e.id.startsWith("perf_e_"), e.id).toBe(true);
			expect(e.deviceId.startsWith("perf_dev_"), e.deviceId).toBe(true);
			expect(e.ts >= first && e.ts <= last, e.ts).toBe(true);
			expect(e.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
		}
		expect(seed.events.some((e) => e.ts > `${TODAY}T23:59:59Z`)).toBe(true);
		const inWindow = seed.events.filter((e) => e.ts >= daysBefore(TODAY, 30)).length;
		expect(inWindow).toBeGreaterThan(1000);
		expect(inWindow).toBeLessThan(seed.events.length);
	});

	it("covers anonymous-then-login, shared, never-login and unknown-user devices", () => {
		const seed = buildPerfSeed(users);
		const byDevice = new Map<string, typeof seed.events>();
		for (const e of seed.events) byDevice.set(e.deviceId, [...(byDevice.get(e.deviceId) ?? []), e]);
		let neverLogin = 0;
		let shared = 0;
		let anonBeforeLogin = 0;
		let outOfOrderAnon = 0;
		for (const list of byDevice.values()) {
			const named = new Set(list.filter((e) => e.userId !== null).map((e) => e.userId));
			if (named.size === 0) neverLogin += 1;
			if (named.size >= 2) shared += 1;
			const firstLogin = list.filter((e) => e.event === "login").map((e) => e.ts).sort()[0];
			if (firstLogin !== undefined) {
				const before = list.filter((e) => e.userId === null && e.ts < firstLogin);
				if (before.length > 0) anonBeforeLogin += 1;
				outOfOrderAnon += list.filter((e) => e.userId === null && e.ts > firstLogin).length > 0 ? 1 : 0;
			}
		}
		expect(neverLogin).toBe(50);
		expect(shared).toBeGreaterThanOrEqual(60);
		expect(anonBeforeLogin).toBeGreaterThanOrEqual(150);
		expect(outOfOrderAnon).toBeGreaterThan(50);
		expect(seed.unknownUsers).toHaveLength(10);
		const named = new Set(seed.events.map((e) => e.userId));
		for (const unknown of seed.unknownUsers) {
			expect(named.has(unknown), unknown).toBe(true);
			expect(users).not.toContain(unknown);
		}
		// One device link per event that names a user, as the webhook writes them.
		expect(seed.links.length).toBe(seed.events.filter((e) => e.userId !== null).length);
	});

	it("rejects a user list that is too short to build shared devices", () => {
		expect(() => buildPerfSeed(["only_one"])).toThrow();
	});
});

describe("applyPerfSeed", () => {
	beforeEach(resetAll);

	const counts = async () =>
		(await env.tpo_cdp
			.prepare(
				"SELECT (SELECT COUNT(*) FROM app_events) AS events, (SELECT COUNT(*) FROM device_links) AS links, " +
					"(SELECT COUNT(*) FROM profiles) AS profiles, (SELECT COUNT(*) FROM user_links) AS user_links, (SELECT COUNT(*) FROM app_users) AS app_users",
			)
			.first<Record<string, number>>())!;

	it("loads the rows and a second run changes nothing", async () => {
		const seed = buildPerfSeed(users);
		await applyPerfSeed(env.tpo_cdp, seed);
		const first = await counts();
		expect(first.events).toBe(seed.events.length);
		expect(first.profiles).toBe(10);
		expect(first.user_links).toBe(10);
		expect(first.app_users).toBe(10);
		// Links are unique per (device, time, user), so same-second events on one device can share a row.
		expect(first.links).toBeGreaterThan(seed.links.length * 0.95);
		expect(first.links).toBeLessThanOrEqual(seed.links.length);
		await applyPerfSeed(env.tpo_cdp, seed);
		expect(await counts()).toEqual(first);
	});
});

describe("owner queries agree with the app_event_owner view on the seed", () => {
	beforeEach(resetAll);

	it("per-profile totals, window points and the segment CTE equal a join through the view", async () => {
		const seed = buildPerfSeed(users);
		const statements = users.flatMap((user, i) => [
			env.tpo_cdp.prepare("INSERT INTO profiles (profile_id, kind, email_norm, created_at) VALUES (?, 'app_only', NULL, '2026-09-01T00:00:00Z')").bind(`p_pool_${i}`),
			env.tpo_cdp.prepare("INSERT INTO app_users (user_id, email_raw, email_norm, created_at, origin) VALUES (?, NULL, NULL, '2026-08-01', 'csv')").bind(user),
			env.tpo_cdp.prepare("INSERT INTO user_links (user_id, profile_id) VALUES (?, ?)").bind(user, `p_pool_${i}`),
		]);
		for (let i = 0; i < statements.length; i += 100) await env.tpo_cdp.batch(statements.slice(i, i + 100));
		await applyPerfSeed(env.tpo_cdp, seed);

		const windowStart = LAST_30_START;
		const viaView = await env.tpo_cdp
			.prepare(
				"SELECT ul.profile_id AS profile_id, COUNT(*) AS total, " +
					"SUM(CASE WHEN o.ts >= ? THEN CASE WHEN o.event = 'read_story' THEN 2 ELSE 1 END ELSE 0 END) AS points, " +
					"SUM(o.attributed_from_device) AS from_device " +
					"FROM app_event_owner o JOIN user_links ul ON ul.user_id = o.owner_user_id GROUP BY ul.profile_id",
			)
			.bind(windowStart)
			.all<{ profile_id: string; total: number; points: number; from_device: number }>();
		expect(viaView.results.length).toBeGreaterThan(150);
		expect(viaView.results.reduce((sum, r) => sum + r.from_device, 0)).toBeGreaterThan(500);

		const expected = new Map(viaView.results.map((r) => [r.profile_id, r]));
		for (let i = 0; i < users.length; i++) {
			const profileId = `p_pool_${i}`;
			const activity = await ownedActivity(env.tpo_cdp, profileId, windowStart, 100);
			const want = expected.get(profileId);
			expect(activity.total, profileId).toBe(want?.total ?? 0);
			expect(activity.windowPoints, profileId).toBe(want?.points ?? 0);
			expect(await ownedWindowPoints(env.tpo_cdp, profileId, windowStart), profileId).toBe(want?.points ?? 0);
		}

		const cte = await env.tpo_cdp.prepare(`${APP_POINTS_CTE} SELECT profile_id, points FROM a`).bind(...APP_POINTS_BINDS).all<{ profile_id: string; points: number }>();
		const fromCte = new Map(cte.results.map((r) => [r.profile_id, r.points]));
		for (const [profileId, row] of expected) expect(fromCte.get(profileId) ?? 0, profileId).toBe(row.points ?? 0);
		expect([...fromCte.keys()].every((id) => expected.has(id))).toBe(true);
	});
});
