import { isCold } from "../segments/definitions";
import { buildWhere, validateFilters, type Filters } from "../segments/filters";
import { previewSegment, type Group } from "../segments/query";

export const TOP_PAGES_DEFAULT = 10;
export const TOP_PAGES_MAX = 20;
export const RANKING_DEFAULT = 50;
export const RANKING_MAX = 100;
const REASON_MAX = 300;

/** The site's own pages. Every other page is a content page. The only place this list is written down. */
export const SITE_PAGES = ["/", "/subscribe", "/about"];

export const BREAKDOWN_FIELDS = ["source", "status", "signup_month", "kind", "cold"] as const;
export type BreakdownField = (typeof BREAKDOWN_FIELDS)[number];
export type PagesMode = "all" | "first_visit";

/** A validated plan: the tool the model chose and its checked parameters, with defaults filled in. */
export type Plan =
	| { tool: "count_profiles"; params: { filters: Filters } }
	| { tool: "build_segment"; params: { filters: Filters } }
	| { tool: "top_pages"; params: { filters: Filters; mode: PagesMode; limit: number; include_site_pages: boolean } }
	| { tool: "breakdown"; params: { by: BreakdownField; filters: Filters } }
	| { tool: "engagement_ranking"; params: { limit: number; filters: Filters } }
	| { tool: "unsupported"; params: { reason: string } };

export type PlanCheck = { ok: true; plan: Plan } | { ok: false };

export interface Chart {
	type: "bar" | "line";
	labels: string[];
	values: number[];
	title: string;
}

export interface ToolResult {
	tool: Plan["tool"];
	params: Plan["params"];
	count?: number;
	rows?: unknown[];
	chart?: Chart;
}

const FAIL: PlanCheck = { ok: false };

function limitOf(value: unknown, fallback: number, max: number): number | null {
	if (value === undefined) return fallback;
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max ? value : null;
}

/**
 * Checks a plan from the model with the section 3 validator. Unknown tools, unknown keys, bad filters and
 * out-of-range limits all fail, and a failed plan never reaches SQL. The failure carries no detail, so nothing
 * the model wrote is echoed back.
 */
export function validatePlan(name: unknown, input: unknown): PlanCheck {
	if (typeof name !== "string") return FAIL;
	if (typeof input !== "object" || input === null || Array.isArray(input)) return FAIL;
	const raw = input as Record<string, unknown>;
	const only = (...allowed: string[]): boolean => Object.keys(raw).every((key) => allowed.includes(key));
	const filtersOf = (): Filters | null => {
		if (raw.filters === undefined) return {};
		const checked = validateFilters(raw.filters);
		return checked.ok ? checked.filters : null;
	};

	switch (name) {
		case "count_profiles":
		case "build_segment": {
			if (!only("filters")) return FAIL;
			const filters = filtersOf();
			return filters === null ? FAIL : { ok: true, plan: { tool: name, params: { filters } } };
		}
		case "top_pages": {
			if (!only("filters", "mode", "limit", "include_site_pages")) return FAIL;
			const filters = filtersOf();
			const limit = limitOf(raw.limit, TOP_PAGES_DEFAULT, TOP_PAGES_MAX);
			if (filters === null || limit === null) return FAIL;
			if (raw.mode !== "all" && raw.mode !== "first_visit") return FAIL;
			const include = raw.include_site_pages === undefined ? false : raw.include_site_pages;
			if (typeof include !== "boolean") return FAIL;
			return { ok: true, plan: { tool: "top_pages", params: { filters, mode: raw.mode, limit, include_site_pages: include } } };
		}
		case "breakdown": {
			if (!only("by", "filters")) return FAIL;
			const filters = filtersOf();
			const by = BREAKDOWN_FIELDS.find((field) => field === raw.by);
			if (filters === null || by === undefined) return FAIL;
			return { ok: true, plan: { tool: "breakdown", params: { by, filters } } };
		}
		case "engagement_ranking": {
			if (!only("limit", "filters")) return FAIL;
			const filters = filtersOf();
			const limit = limitOf(raw.limit, RANKING_DEFAULT, RANKING_MAX);
			if (filters === null || limit === null) return FAIL;
			return { ok: true, plan: { tool: "engagement_ranking", params: { limit, filters } } };
		}
		case "unsupported": {
			if (!only("reason")) return FAIL;
			if (typeof raw.reason !== "string" || raw.reason.trim() === "") return FAIL;
			return { ok: true, plan: { tool: "unsupported", params: { reason: raw.reason.trim().slice(0, REASON_MAX) } } };
		}
		default:
			return FAIL;
	}
}

const DATE_LABEL = /^\d{4}-\d{2}(-\d{2})?$/;

/** A line when at least one label is a YYYY-MM-DD or YYYY-MM date and every other label is "none"; otherwise a bar. */
export function chartType(labels: string[]): "bar" | "line" {
	const dates = labels.filter((l) => DATE_LABEL.test(l)).length;
	return dates > 0 && labels.every((l) => l === "none" || DATE_LABEL.test(l)) ? "line" : "bar";
}

function groupsChart(groups: Group[], title: string): Chart {
	return { type: chartType(groups.map((g) => g.group)), labels: groups.map((g) => g.group), values: groups.map((g) => g.count), title };
}

const byGroupName = (a: Group, b: Group): number => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0);

interface BreakdownRow {
	kind: string;
	source: string | null;
	status: string | null;
	signup: string | null;
	last_open: string | null;
	has_subscriber: number;
}

function groupOf(by: BreakdownField, r: BreakdownRow): string {
	switch (by) {
		case "source":
			return r.source ?? "none";
		case "status":
			return r.status ?? "none";
		case "kind":
			return r.kind;
		case "signup_month":
			return r.signup === null ? "none" : r.signup.slice(0, 7);
		case "cold":
			if (r.has_subscriber === 0) return "no newsletter";
			return isCold({ status: r.status, signup_date: r.signup, last_open_date: r.last_open }) ? "cold" : "not cold";
	}
}

/** One pass over the matching profiles; the groups are counted and sorted here. */
async function breakdown(db: D1Database, by: BreakdownField, filters: Filters): Promise<ToolResult> {
	const where = buildWhere(filters);
	const { results } = await db
		.prepare(
			`SELECT p.kind AS kind, s.source AS source, s.status AS status, s.signup_date AS signup, s.last_open_date AS last_open,
				s.email_norm IS NOT NULL AS has_subscriber
			FROM profiles p LEFT JOIN subscribers s ON s.email_norm = p.email_norm
			WHERE ${where.sql}`,
		)
		.bind(...where.binds)
		.all<BreakdownRow>();
	const counts = new Map<string, number>();
	for (const r of results) {
		const group = groupOf(by, r);
		counts.set(group, (counts.get(group) ?? 0) + 1);
	}
	let groups: Group[] = [...counts].map(([group, count]) => ({ group, count }));
	if (by === "signup_month") {
		// Months run oldest first, with "none" last.
		groups.sort((a, b) => (a.group === "none" ? 1 : b.group === "none" ? -1 : byGroupName(a, b)));
	} else {
		groups = groups.sort((a, b) => b.count - a.count || byGroupName(a, b));
	}
	return {
		tool: "breakdown",
		params: { by, filters },
		count: results.length,
		rows: groups,
		chart: groupsChart(groups, `Profiles by ${by.replace("_", " ")}`),
	};
}

/**
 * Pages by profiles. The matching profiles are found first (the `m` CTE, with the buildWhere body), then one pass over
 * their linked visits: 'all' counts each profile once per page, 'first_visit' keeps only each profile's earliest visit
 * across all of its visitor_ids, at any time (MIN over ts + page, so a tie on time takes the page that sorts first). No per-profile subqueries.
 */
async function topPages(db: D1Database, filters: Filters, mode: PagesMode, limit: number, includeSitePages: boolean): Promise<ToolResult> {
	const where = buildWhere(filters);
	// Site-page visits are dropped before grouping or MIN, by exact match on bound values. One `w.page <> ?` per site page,
	// because `NOT IN (?, ?, ?)` read 26,094 rows in perf (top_pages all, no filters) against a 25,000 budget, where this form reads 17,653.
	const skipSitePages = includeSitePages ? "" : " WHERE " + SITE_PAGES.map(() => "w.page <> ?").join(" AND ");
	const skipBinds = includeSitePages ? [] : SITE_PAGES;
	const statement =
		mode === "all"
			? db.prepare(
					`WITH m AS (SELECT p.profile_id AS profile_id FROM profiles p LEFT JOIN subscribers s ON s.email_norm = p.email_norm WHERE ${where.sql})
					SELECT w.page AS page, COUNT(DISTINCT vl.profile_id) AS profiles
					FROM m JOIN visitor_links vl ON vl.profile_id = m.profile_id JOIN web_events w ON w.visitor_id = vl.visitor_id
					${skipSitePages}
						GROUP BY w.page ORDER BY profiles DESC, w.page ASC LIMIT ?`,
				)
			: db.prepare(
					`WITH m AS (SELECT p.profile_id AS profile_id FROM profiles p LEFT JOIN subscribers s ON s.email_norm = p.email_norm WHERE ${where.sql}),
					f AS (SELECT MIN(w.ts || '|' || w.page) AS k
						FROM m JOIN visitor_links vl ON vl.profile_id = m.profile_id JOIN web_events w ON w.visitor_id = vl.visitor_id
						${skipSitePages}
						GROUP BY vl.profile_id)
					SELECT substr(k, instr(k, '|') + 1) AS page, COUNT(*) AS profiles FROM f GROUP BY page ORDER BY profiles DESC, page ASC LIMIT ?`,
				);
	const { results } = await statement.bind(...where.binds, ...skipBinds, limit).all<{ page: string; profiles: number }>();
	const title = mode === "all" ? "Pages visited (profiles)" : "First pages visited (profiles)";
	return {
		tool: "top_pages",
		params: { filters, mode, limit, include_site_pages: includeSitePages },
		rows: results,
		chart: { type: chartType(results.map((r) => r.page)), labels: results.map((r) => r.page), values: results.map((r) => r.profiles), title },
	};
}

/** Runs a validated plan. The model never writes SQL: every query is a fixed statement plus the buildWhere body. */
export async function runTool(db: D1Database, plan: Plan): Promise<ToolResult> {
	switch (plan.tool) {
		case "count_profiles": {
			const where = buildWhere(plan.params.filters);
			const row = await db
				.prepare(`SELECT COUNT(*) AS n FROM profiles p LEFT JOIN subscribers s ON s.email_norm = p.email_norm WHERE ${where.sql}`)
				.bind(...where.binds)
				.first<{ n: number }>();
			return { tool: plan.tool, params: plan.params, count: row?.n ?? 0 };
		}
		case "build_segment": {
			const preview = await previewSegment(db, plan.params.filters);
			return { tool: plan.tool, params: plan.params, count: preview.count, rows: preview.rows, chart: groupsChart(preview.chart.by_source, "Profiles by source") };
		}
		case "top_pages":
			return topPages(db, plan.params.filters, plan.params.mode, plan.params.limit, plan.params.include_site_pages);
		case "breakdown":
			return breakdown(db, plan.params.by, plan.params.filters);
		case "engagement_ranking": {
			const preview = await previewSegment(db, plan.params.filters, plan.params.limit);
			return { tool: plan.tool, params: plan.params, count: preview.count, rows: preview.rows };
		}
		case "unsupported":
			return { tool: plan.tool, params: plan.params };
	}
}
