/**
 * App events owned by one profile, for lookup and the single-profile engagement score.
 *
 * The app_event_owner view computes owner_user_id per event, so `owner_user_id = user_links.user_id` cannot use an
 * index and a join through the view reads every event for every profile. This goes the other way round and reads only
 * what the profile can own, with the view still deciding who owns an anonymous event (so the ownership rules live in
 * one place, migration 0002):
 *   - events whose own user_id is one of the profile's users (index app_events(user_id)), and
 *   - anonymous events on devices that have a device_links row for one of those users (index device_links(user_id, device_id)
 *     and app_events(device_id, ts)), kept only when the view says the owner is one of those users.
 * Binds: the profile_id, once.
 */
export const OWNED_EVENTS_CTE =
	"WITH me AS (SELECT user_id FROM user_links WHERE profile_id = ?), " +
	"mine AS (" +
	"SELECT e.event_id AS event_id, e.event AS event, e.ts AS ts, e.device_id AS device_id, e.user_id AS user_id, e.properties AS properties, 0 AS attributed_from_device " +
	"FROM app_events e WHERE e.user_id IN (SELECT user_id FROM me) " +
	"UNION ALL " +
	"SELECT o.event_id, o.event, o.ts, o.device_id, o.owner_user_id, o.properties, 1 " +
	"FROM app_event_owner o WHERE o.attributed_from_device = 1 " +
	"AND o.device_id IN (SELECT d.device_id FROM device_links d WHERE d.user_id IN (SELECT user_id FROM me)) " +
	"AND o.owner_user_id IN (SELECT user_id FROM me))";

/** Engagement points of one event, as SQL: 2 for read_story, 1 for anything else (see WEIGHTS in engagement.ts). */
const POINTS_IF_IN_WINDOW = "CASE WHEN ts >= ? THEN CASE WHEN event = 'read_story' THEN 2 ELSE 1 END ELSE 0 END";

export interface OwnedEvent {
	event_id: string;
	event: string;
	ts: string;
	device_id: string;
	user_id: string;
	properties: string;
	attributed_from_device: number;
}

export interface OwnedActivity {
	/** Every event the profile owns. */
	total: number;
	/** The newest `limit` events, by event time then event_id, newest first. */
	recent: OwnedEvent[];
	/** Engagement points of the owned events dated on or after `windowStart`. */
	windowPoints: number;
}

interface Row extends OwnedEvent {
	total: number;
	points: number;
}

/** One statement: the count and window points are window functions over all owned events, the rows are the newest `limit`. */
export async function ownedActivity(db: D1Database, profileId: string, windowStart: string, limit: number): Promise<OwnedActivity> {
	const { results } = await db
		.prepare(
			`${OWNED_EVENTS_CTE} SELECT event_id, event, ts, device_id, user_id, properties, attributed_from_device, ` +
				`COUNT(*) OVER () AS total, COALESCE(SUM(${POINTS_IF_IN_WINDOW}) OVER (), 0) AS points ` +
				"FROM mine ORDER BY ts DESC, event_id DESC LIMIT ?",
		)
		.bind(profileId, windowStart, limit)
		.all<Row>();
	const first = results[0];
	return {
		total: first?.total ?? 0,
		windowPoints: first?.points ?? 0,
		recent: results.map(({ total: _total, points: _points, ...event }) => event),
	};
}

/** Engagement points of the owned events dated on or after `windowStart`, for callers that do not need the list. */
export async function ownedWindowPoints(db: D1Database, profileId: string, windowStart: string): Promise<number> {
	const row = await db
		.prepare(`${OWNED_EVENTS_CTE} SELECT COALESCE(SUM(${POINTS_IF_IN_WINDOW}), 0) AS points FROM mine`)
		.bind(profileId, windowStart)
		.first<{ points: number }>();
	return row?.points ?? 0;
}
