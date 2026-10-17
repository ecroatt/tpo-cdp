import { json } from "../http/security";
import { normalizeEmail } from "../lib/email";
import { engagementFor } from "../segments/engagement";
import { daysSinceOpen, isCold } from "../segments/definitions";

const RECENT_LIMIT = 100;
const MAX_QUERY_LENGTH = 200;

interface ProfileRow {
	profile_id: string;
	kind: string;
	email_norm: string | null;
}

type Found = { type: "profile"; profileId: string } | { type: "visitor"; visitorId: string } | null;

/** Exact matching only: email (normalized), then profile_id, user_id, visitor_id. */
async function resolve(db: D1Database, q: string): Promise<Found> {
	if (q.includes("@")) {
		const email = normalizeEmail(q);
		if (email !== null) {
			const hit = await db.prepare("SELECT profile_id FROM profiles WHERE email_norm = ?").bind(email).first<{ profile_id: string }>();
			if (hit) return { type: "profile", profileId: hit.profile_id };
		}
	}
	const byId = await db.prepare("SELECT profile_id FROM profiles WHERE profile_id = ?").bind(q).first<{ profile_id: string }>();
	if (byId) return { type: "profile", profileId: byId.profile_id };
	const byUser = await db.prepare("SELECT profile_id FROM user_links WHERE user_id = ?").bind(q).first<{ profile_id: string }>();
	if (byUser) return { type: "profile", profileId: byUser.profile_id };
	const byVisitor = await db.prepare("SELECT profile_id FROM visitor_links WHERE visitor_id = ?").bind(q).first<{ profile_id: string }>();
	if (byVisitor) return { type: "profile", profileId: byVisitor.profile_id };
	const anonymous = await db.prepare("SELECT 1 AS found FROM web_events WHERE visitor_id = ? LIMIT 1").bind(q).first();
	return anonymous ? { type: "visitor", visitorId: q } : null;
}

function parseProperties(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return {};
	}
}

async function anonymousVisitor(db: D1Database, visitorId: string): Promise<Response> {
	const total = await db.prepare("SELECT COUNT(*) AS n FROM web_events WHERE visitor_id = ?").bind(visitorId).first<{ n: number }>();
	const { results } = await db
		.prepare("SELECT visitor_id, page, ts, source FROM web_events WHERE visitor_id = ? ORDER BY ts DESC, id DESC LIMIT 100")
		.bind(visitorId)
		.all();
	return json({ kind: "anonymous_visitor", visitor_id: visitorId, total: total?.n ?? 0, visits: results });
}

async function profileView(db: D1Database, profileId: string): Promise<Response> {
	const profile = (await db.prepare("SELECT profile_id, kind, email_norm FROM profiles WHERE profile_id = ?").bind(profileId).first<ProfileRow>())!;
	const subscriber =
		profile.email_norm === null
			? null
			: await db
					.prepare("SELECT signup_date, status, source, last_open_date FROM subscribers WHERE email_norm = ?")
					.bind(profile.email_norm)
					.first<{ signup_date: string | null; status: string | null; source: string | null; last_open_date: string | null }>();
	const accounts = await db
		.prepare("SELECT u.user_id, u.created_at FROM user_links l JOIN app_users u ON u.user_id = l.user_id WHERE l.profile_id = ? ORDER BY u.user_id")
		.bind(profileId)
		.all();
	const visitors = await db.prepare("SELECT visitor_id FROM visitor_links WHERE profile_id = ? ORDER BY visitor_id").bind(profileId).all<{ visitor_id: string }>();
	const visitTotal = await db
		.prepare("SELECT COUNT(*) AS n FROM visitor_links vl JOIN web_events w ON w.visitor_id = vl.visitor_id WHERE vl.profile_id = ?")
		.bind(profileId)
		.first<{ n: number }>();
	const visits = await db
		.prepare(
			"SELECT w.visitor_id, w.page, w.ts, w.source FROM visitor_links vl JOIN web_events w ON w.visitor_id = vl.visitor_id " +
				"WHERE vl.profile_id = ? ORDER BY w.ts DESC, w.id DESC LIMIT 100",
		)
		.bind(profileId)
		.all();
	const eventTotal = await db
		.prepare("SELECT COUNT(*) AS n FROM user_links ul JOIN app_event_owner o ON o.owner_user_id = ul.user_id WHERE ul.profile_id = ?")
		.bind(profileId)
		.first<{ n: number }>();
	const events = await db
		.prepare(
			"SELECT o.event_id, o.event, o.ts, o.device_id, o.owner_user_id AS user_id, o.properties, o.attributed_from_device " +
				"FROM user_links ul JOIN app_event_owner o ON o.owner_user_id = ul.user_id " +
				"WHERE ul.profile_id = ? ORDER BY o.ts DESC, o.event_id DESC LIMIT 100",
		)
		.bind(profileId)
		.all<{ event_id: string; event: string; ts: string; device_id: string; user_id: string; properties: string; attributed_from_device: number }>();
	const engagement = await engagementFor(db, profileId, subscriber?.last_open_date ?? null);

	return json({
		profile_id: profile.profile_id,
		kind: profile.kind,
		email: profile.email_norm,
		newsletter: subscriber && {
			signup_date: subscriber.signup_date,
			status: subscriber.status,
			source: subscriber.source,
			last_open_date: subscriber.last_open_date,
			cold: isCold(subscriber),
			days_since_open: daysSinceOpen(subscriber.last_open_date),
		},
		app_accounts: accounts.results,
		site_visits: {
			visitor_ids: visitors.results.map((v) => v.visitor_id),
			total: visitTotal?.n ?? 0,
			recent: visits.results,
		},
		app_activity: {
			total: eventTotal?.n ?? 0,
			// The newest event time, MAX(ts): the list is sorted by event time, so it is the first entry.
			last_seen: events.results[0]?.ts ?? null,
			recent: events.results.map((e) => ({
				event_id: e.event_id,
				event: e.event,
				ts: e.ts,
				device_id: e.device_id,
				user_id: e.user_id,
				properties: parseProperties(e.properties),
				// True only for an anonymous event that was attached to this profile through device_links.
				attributed_from_device: e.attributed_from_device === 1,
			})),
		},
		engagement,
	});
}

/** GET /api/lookup?q=. Nothing is cached, so new events show up on the next request. */
export async function handleLookup(env: Env, url: URL): Promise<Response> {
	const q = url.searchParams.get("q") ?? "";
	if (q === "" || q.length > MAX_QUERY_LENGTH) return json({ error: "not_found" }, 404);
	const found = await resolve(env.tpo_cdp, q);
	if (found === null) return json({ error: "not_found" }, 404);
	return found.type === "profile" ? profileView(env.tpo_cdp, found.profileId) : anonymousVisitor(env.tpo_cdp, found.visitorId);
}
