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
	" + (SELECT COALESCE(SUM(CASE WHEN o.event = 'read_story' THEN 2 ELSE 1 END), 0)" +
	" FROM user_links ul JOIN app_event_owner o ON o.owner_user_id = ul.user_id" +
	" WHERE ul.profile_id = p.profile_id AND o.ts >= ?))";

export const SCORE_BINDS: string[] = [LAST_7_START, LAST_30_START, LAST_30_START, LAST_30_START];

/** Engagement for one profile, with its breakdown. Counts only events the profile owns (app_event_owner). */
export async function engagementFor(db: D1Database, profileId: string, lastOpen: string | null): Promise<Engagement> {
	const site = await db
		.prepare(
			"SELECT COUNT(*) AS n FROM visitor_links vl JOIN web_events w ON w.visitor_id = vl.visitor_id " +
				"WHERE vl.profile_id = ? AND w.ts >= ?",
		)
		.bind(profileId, LAST_30_START)
		.first<{ n: number }>();
	const app = await db
		.prepare(
			"SELECT COALESCE(SUM(CASE WHEN o.event = 'read_story' THEN 2 ELSE 1 END), 0) AS points " +
				"FROM user_links ul JOIN app_event_owner o ON o.owner_user_id = ul.user_id " +
				"WHERE ul.profile_id = ? AND o.ts >= ?",
		)
		.bind(profileId, LAST_30_START)
		.first<{ points: number }>();
	const breakdown = {
		newsletter: newsletterPoints(lastOpen),
		site: (site?.n ?? 0) * WEIGHTS.sitePerVisit,
		app: app?.points ?? 0,
	};
	return { score: breakdown.newsletter + breakdown.site + breakdown.app, breakdown, window_start: LAST_30_START };
}
