import { ownedWindowPoints } from "../lib/owned-events";
import { LAST_30_START, LAST_7_START } from "../lib/time";

/** Weights (SPEC section 3). Counted over the last 30 days; SCORE_SQL below repeats these numbers. */
export const WEIGHTS = {
	newsletterLast7: 3,
	newsletterLast30: 1,
	sitePerVisit: 1,
	appReadStory: 2,
	appOtherEvent: 1,
} as const;

export interface Engagement {
	score: number;
	breakdown: { newsletter: number; site: number; app: number };
	window_start: string;
}

/** 3 points for an open in the last 7 days, otherwise 1 for the last 30 days. */
export function newsletterPoints(lastOpen: string | null): number {
	if (lastOpen === null) return 0;
	if (lastOpen >= LAST_7_START) return WEIGHTS.newsletterLast7;
	if (lastOpen >= LAST_30_START) return WEIGHTS.newsletterLast30;
	return 0;
}

/**
 * The score as a SQL expression for queries that alias profiles as `p` and subscribers as `s`.
 * Binds, in order: SCORE_BINDS. Same rules as `engagementFor`; a test keeps them in agreement.
 */
export const SCORE_SQL =
	"(CASE WHEN s.last_open_date >= ? THEN 3 WHEN s.last_open_date >= ? THEN 1 ELSE 0 END" +
	" + (SELECT COUNT(*) FROM visitor_links vl JOIN web_events w ON w.visitor_id = vl.visitor_id" +
	" WHERE vl.profile_id = p.profile_id AND w.ts >= ?)" +
	" + COALESCE(a.points, 0))";

/** Binds for SCORE_SQL, in order. */
export const SCORE_BINDS: string[] = [LAST_7_START, LAST_30_START, LAST_30_START];

/**
 * The `a` that SCORE_SQL reads: app points per profile for the events dated in the last 30 days, in one pass over
 * those events (the covering index on app_events(ts, ...)) instead of one scan of the app_event_owner view per profile.
 * Events are grouped by their owner first, so user_links is read once per owner and not once per event.
 * Prefix this to the query and LEFT JOIN `a ON a.profile_id = p.profile_id`. Binds, in order: APP_POINTS_BINDS.
 */
export const APP_POINTS_CTE =
	"WITH a AS (SELECT ul.profile_id AS profile_id, SUM(x.points) AS points" +
	" FROM (SELECT o.owner_user_id AS user_id, SUM(CASE WHEN o.event = 'read_story' THEN 2 ELSE 1 END) AS points" +
	" FROM app_event_owner o WHERE o.ts >= ? GROUP BY o.owner_user_id) x" +
	" JOIN user_links ul ON ul.user_id = x.user_id GROUP BY ul.profile_id)";

export const APP_POINTS_BINDS: string[] = [LAST_30_START];

/**
 * Engagement for one profile, with its breakdown. Counts only events the profile owns (app_event_owner).
 * Pass `appPoints` when the caller already has them (lookup gets them in the same statement as the event list).
 */
export async function engagementFor(db: D1Database, profileId: string, lastOpen: string | null, appPoints?: number): Promise<Engagement> {
	const site = await db
		.prepare(
			"SELECT COUNT(*) AS n FROM visitor_links vl JOIN web_events w ON w.visitor_id = vl.visitor_id " +
				"WHERE vl.profile_id = ? AND w.ts >= ?",
		)
		.bind(profileId, LAST_30_START)
		.first<{ n: number }>();
	const app = appPoints ?? (await ownedWindowPoints(db, profileId, LAST_30_START));
	const breakdown = {
		newsletter: newsletterPoints(lastOpen),
		site: (site?.n ?? 0) * WEIGHTS.sitePerVisit,
		app,
	};
	return { score: breakdown.newsletter + breakdown.site + breakdown.app, breakdown, window_start: LAST_30_START };
}
