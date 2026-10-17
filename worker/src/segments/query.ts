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

/**
 * Count, first 50 rows (best score first) and the by-source / by-status chart data for validated filters.
 * The only interpolations are `where.sql` (fixed fragments from buildWhere) and SCORE_SQL (a constant).
 */
export async function previewSegment(db: D1Database, filters: Filters): Promise<Preview> {
	const where = buildWhere(filters);
	const [count, rows, bySource, byStatus] = await db.batch([
		db
			.prepare(`SELECT COUNT(*) AS n FROM profiles p LEFT JOIN subscribers s ON s.email_norm = p.email_norm WHERE ${where.sql}`)
			.bind(...where.binds),
		db
			.prepare(
				`SELECT p.profile_id AS profile_id, p.email_norm AS email, s.source AS source, s.status AS status,
					s.signup_date AS signup, s.last_open_date AS last_open, ${SCORE_SQL} AS score
				FROM profiles p LEFT JOIN subscribers s ON s.email_norm = p.email_norm
				WHERE ${where.sql} ORDER BY score DESC, p.profile_id LIMIT 50`,
			)
			.bind(...SCORE_BINDS, ...where.binds),
		db
			.prepare(
				`SELECT COALESCE(s.source, 'none') AS grp, COUNT(*) AS n FROM profiles p
				LEFT JOIN subscribers s ON s.email_norm = p.email_norm WHERE ${where.sql} GROUP BY grp ORDER BY n DESC, grp`,
			)
			.bind(...where.binds),
		db
			.prepare(
				`SELECT COALESCE(s.status, 'none') AS grp, COUNT(*) AS n FROM profiles p
				LEFT JOIN subscribers s ON s.email_norm = p.email_norm WHERE ${where.sql} GROUP BY grp ORDER BY n DESC, grp`,
			)
			.bind(...where.binds),
	]);
	const groups = (r: D1Result<unknown>): Group[] => (r.results as { grp: string; n: number }[]).map((g) => ({ group: g.grp, count: g.n }));
	return {
		count: (count.results[0] as { n: number }).n,
		rows: rows.results as PreviewRow[],
		chart: { by_source: groups(bySource), by_status: groups(byStatus) },
	};
}
