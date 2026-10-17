import { SCORE_BINDS, SCORE_SQL } from "./engagement";
import { buildWhere, type Filters } from "./filters";

export interface PreviewRow {
	profile_id: string;
	email: string | null;
	source: string | null;
	status: string | null;
	signup: string | null;
	last_open: string | null;
	score: number;
}

export interface Group {
	group: string;
	count: number;
}

export interface Preview {
	count: number;
	rows: PreviewRow[];
	chart: { by_source: Group[]; by_status: Group[] };
}

/** Best score first, then profile_id: the order the SQL used to give with `ORDER BY score DESC, p.profile_id`. */
function byScoreThenId(a: PreviewRow, b: PreviewRow): number {
	return b.score - a.score || (a.profile_id < b.profile_id ? -1 : a.profile_id > b.profile_id ? 1 : 0);
}

/** Groups sorted by count (largest first), then by name. */
function toGroups(counts: Map<string, number>): Group[] {
	return [...counts]
		.map(([group, count]) => ({ group, count }))
		.sort((a, b) => b.count - a.count || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
}

/**
 * Count, first 50 rows (best score first) and the by-source / by-status chart data for validated filters.
 * One pass over the matching profiles returns each profile's source, status and score; the count, the chart
 * groups and the top 50 are derived from those rows here, so D1 reads the profiles and subscribers once
 * instead of once per figure and without a sort. The only interpolations are `where.sql` (fixed fragments
 * from buildWhere) and SCORE_SQL (a constant).
 */
export async function previewSegment(db: D1Database, filters: Filters): Promise<Preview> {
	const where = buildWhere(filters);
	const { results } = await db
		.prepare(
			`SELECT p.profile_id AS profile_id, p.email_norm AS email, s.source AS source, s.status AS status,
				s.signup_date AS signup, s.last_open_date AS last_open, ${SCORE_SQL} AS score
			FROM profiles p LEFT JOIN subscribers s ON s.email_norm = p.email_norm
			WHERE ${where.sql}`,
		)
		.bind(...SCORE_BINDS, ...where.binds)
		.all<PreviewRow>();
	const bySource = new Map<string, number>();
	const byStatus = new Map<string, number>();
	for (const r of results) {
		const source = r.source ?? "none";
		const status = r.status ?? "none";
		bySource.set(source, (bySource.get(source) ?? 0) + 1);
		byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
	}
	return {
		count: results.length,
		rows: results.sort(byScoreThenId).slice(0, 50),
		chart: { by_source: toGroups(bySource), by_status: toGroups(byStatus) },
	};
}
