// Deterministic app-event seed for `npm run perf` (local D1 only). Pure: no network, no node imports.
// Every ID starts with "perf_" and the generator uses a fixed random seed, so the same users give the same rows
// and INSERT OR IGNORE makes a re-run change nothing.
import { TODAY } from "../../src/lib/time";

export interface SeedEvent {
	id: string;
	event: string;
	userId: string | null;
	deviceId: string;
	ts: string;
	properties: string;
}

export interface SeedLink {
	deviceId: string;
	userId: string;
	seenAt: string;
}

export interface PerfSeed {
	events: SeedEvent[];
	/** One device_links row per event that carries a user_id, as the webhook writes them. */
	links: SeedLink[];
	/** user_ids that no CSV knows, as the webhook would have created them (app_users + unknown_app_user profile + user_links). */
	unknownUsers: string[];
	devices: number;
}

const DAY_MS = 86_400_000;
const TODAY_MS = Date.parse(`${TODAY}T00:00:00Z`);
/** Events run from this many days before TODAY to a few days after it. */
const DAYS_BEFORE = 85;
const DAYS_AFTER = 3;
const MIN_TIME = TODAY_MS - DAYS_BEFORE * DAY_MS;
const MAX_TIME = TODAY_MS + DAYS_AFTER * DAY_MS;

/** mulberry32: a small seeded generator, so the seed is the same on every run. */
function generator(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

/**
 * About 5,000 events over about 300 devices, spread over the 85 days before TODAY and 3 days after, using `userIds`
 * (existing app users):
 *   - 120 devices that are anonymous first, then log in, then keep going (some events still anonymous after the login);
 *   - 60 shared devices: user A logs in, then user B, with anonymous events in between and after;
 *   - 50 devices that never log in (anonymous events that belong to nobody);
 *   - 30 devices of 10 unknown users (not in any CSV);
 *   - 40 devices of logged-in users only.
 * Anonymous events dated before a login are included, so some belong to a user through a login that happens later.
 */
export function buildPerfSeed(userIds: string[]): PerfSeed {
	if (userIds.length < 2) throw new Error("need at least two app users to seed");
	const random = generator(20260928);
	const int = (min: number, max: number): number => min + Math.floor(random() * (max - min + 1));
	const pick = <T>(list: readonly T[]): T => list[int(0, list.length - 1)];
	const pool = userIds.slice(0, 220);
	const unknownUsers = Array.from({ length: 10 }, (_, i) => `perf_unknown_user_${String(i).padStart(2, "0")}`);

	const events: SeedEvent[] = [];
	const links: SeedLink[] = [];
	let device = 0;
	let sequence = 0;

	const clampTime = (ms: number): number => Math.min(MAX_TIME, Math.max(MIN_TIME, ms));
	const randomTime = (from: number, to: number): number => clampTime(from + Math.floor(random() * Math.max(1, to - from)));

	const add = (deviceId: string, userId: string | null, name: string, at: number): void => {
		sequence += 1;
		const ts = iso(clampTime(at));
		let properties: Record<string, string> = {};
		if (name === "read_story") properties = { story: `perf-story-${int(1, 60)}` };
		if (name === "link_click") properties = { url: `https://example.com/perf/${int(1, 40)}` };
		events.push({ id: `perf_e_${String(sequence).padStart(5, "0")}`, event: name, userId, deviceId, ts, properties: JSON.stringify(properties) });
		if (userId !== null) links.push({ deviceId, userId, seenAt: ts });
	};
	const activity = (): string => {
		const r = random();
		return r < 0.45 ? "app_open" : r < 0.85 ? "read_story" : "link_click";
	};
	const nextDevice = (): string => `perf_dev_${String(device++).padStart(3, "0")}`;

	for (let i = 0; i < 120; i++) {
		const deviceId = nextDevice();
		const user = pick(pool);
		const login = randomTime(MIN_TIME + 3 * DAY_MS, MAX_TIME - DAY_MS);
		for (let k = int(2, 6); k > 0; k--) add(deviceId, null, activity(), randomTime(login - 3 * DAY_MS, login));
		add(deviceId, user, "login", login);
		for (let k = int(6, 16); k > 0; k--) add(deviceId, user, activity(), randomTime(login, login + 20 * DAY_MS));
		for (let k = int(0, 3); k > 0; k--) add(deviceId, null, activity(), randomTime(login, login + 20 * DAY_MS));
	}

	for (let i = 0; i < 60; i++) {
		const deviceId = nextDevice();
		const a = pick(pool);
		let b = pick(pool);
		if (b === a) b = pool[(pool.indexOf(a) + 1) % pool.length];
		const loginA = randomTime(MIN_TIME + 2 * DAY_MS, MAX_TIME - 8 * DAY_MS);
		const loginB = clampTime(loginA + int(1, 5) * DAY_MS);
		for (let k = int(1, 3); k > 0; k--) add(deviceId, null, activity(), randomTime(loginA - 2 * DAY_MS, loginA));
		add(deviceId, a, "login", loginA);
		for (let k = int(2, 5); k > 0; k--) add(deviceId, a, activity(), randomTime(loginA, loginB));
		for (let k = int(2, 4); k > 0; k--) add(deviceId, null, activity(), randomTime(loginA, loginB));
		add(deviceId, b, "login", loginB);
		for (let k = int(2, 5); k > 0; k--) add(deviceId, b, activity(), randomTime(loginB, loginB + 10 * DAY_MS));
		for (let k = int(2, 4); k > 0; k--) add(deviceId, null, activity(), randomTime(loginB, loginB + 10 * DAY_MS));
	}

	for (let i = 0; i < 50; i++) {
		const deviceId = nextDevice();
		const start = randomTime(MIN_TIME, MAX_TIME - 10 * DAY_MS);
		for (let k = int(5, 23); k > 0; k--) add(deviceId, null, activity(), randomTime(start, start + 10 * DAY_MS));
	}

	for (let i = 0; i < 30; i++) {
		const deviceId = nextDevice();
		const user = unknownUsers[i % unknownUsers.length];
		const login = randomTime(MIN_TIME + DAY_MS, MAX_TIME - 12 * DAY_MS);
		add(deviceId, user, "login", login);
		for (let k = int(3, 12); k > 0; k--) add(deviceId, user, activity(), randomTime(login, login + 12 * DAY_MS));
	}

	for (let i = 0; i < 40; i++) {
		const deviceId = nextDevice();
		const user = pick(pool);
		const start = randomTime(MIN_TIME, MAX_TIME - 15 * DAY_MS);
		for (let k = int(8, 24); k > 0; k--) add(deviceId, user, activity(), randomTime(start, start + 15 * DAY_MS));
	}

	return { events, links, unknownUsers, devices: device };
}

const BATCH = 50;
const ATTEMPTS = 5;

/**
 * Runs the statements in batches. The local wrangler proxy sometimes drops a connection (ECONNRESET) on a long run of
 * requests; every statement here is INSERT OR IGNORE, so running a batch again after a dropped connection is safe.
 */
async function runBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
	for (let i = 0; i < statements.length; i += BATCH) {
		const batch = statements.slice(i, i + BATCH);
		for (let attempt = 1; ; attempt++) {
			try {
				await db.batch(batch);
				break;
			} catch (err) {
				if (attempt >= ATTEMPTS) throw err;
			}
		}
	}
}

/**
 * Writes the seed with INSERT OR IGNORE (a second run changes nothing). Call it with the raw database binding, not the
 * counting wrapper, so seeding is not part of any measured call.
 */
export async function applyPerfSeed(db: D1Database, seed: PerfSeed): Promise<void> {
	const created = `${TODAY}T00:00:00Z`;
	// Same shape as the webhook: the profile gets a random id and is only minted when no user_links row exists for the user,
	// so a re-run adds nothing. The three statements of a user run in one batch so last_insert_rowid() is that profile.
	for (const user of seed.unknownUsers) {
		await runBatches(db, [
			db.prepare("INSERT OR IGNORE INTO app_users (user_id, email_raw, email_norm, created_at, origin) VALUES (?, NULL, NULL, ?, 'webhook')").bind(user, TODAY),
			db
				.prepare(
					"INSERT INTO profiles (profile_id, kind, email_norm, created_at) SELECT lower(hex(randomblob(16))), 'unknown_app_user', NULL, ? " +
						"WHERE NOT EXISTS (SELECT 1 FROM user_links WHERE user_id = ?)",
				)
				.bind(created, user),
			db
				.prepare(
					"INSERT OR IGNORE INTO user_links (user_id, profile_id) SELECT ?, profile_id FROM profiles WHERE rowid = last_insert_rowid() " +
						"AND NOT EXISTS (SELECT 1 FROM user_links WHERE user_id = ?)",
				)
				.bind(user, user),
		]);
	}
	await runBatches(
		db,
		seed.events.map((e) =>
			db
				.prepare("INSERT OR IGNORE INTO app_events (event_id, event, user_id, device_id, ts, properties, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
				.bind(e.id, e.event, e.userId, e.deviceId, e.ts, e.properties, e.ts),
		),
	);
	await runBatches(
		db,
		seed.links.map((l) => db.prepare("INSERT OR IGNORE INTO device_links (device_id, user_id, seen_at) VALUES (?, ?, ?)").bind(l.deviceId, l.userId, l.seenAt)),
	);
}
