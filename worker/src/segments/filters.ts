import { normalizeSource } from "../lib/source";
import { LAST_30_START, TODAY, daysBefore } from "../lib/time";

/** Source names as they appear in the real CSVs (subscriber acquisition_source and web utm_source). */
const KNOWN_RAW_SOURCES = ["Direct", "Facebook", "Google", "Instagram", "Podcast", "Referral", "X", "twitter"];

/** The allowed `sources` values: every known raw source passed through the one source map. */
export const SOURCES: readonly string[] = [
	...new Set(KNOWN_RAW_SOURCES.map((s) => normalizeSource(s)).filter((s): s is string => s !== null)),
].sort();

export const KINDS = ["subscriber", "app_only", "unknown_app_user"] as const;
export const STATUSES = ["active", "unsubscribed"] as const;

export interface Filters {
	sources?: string[];
	status?: (typeof STATUSES)[number];
	signup_from?: string;
	signup_to?: string;
	cold?: boolean;
	not_opened_days?: number;
	kind?: (typeof KINDS)[number][];
	has_app?: boolean;
	app_active_days?: number;
	min_site_visits?: number;
}

export type FilterResult = { ok: true; filters: Filters } | { ok: false; error: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KNOWN_KEYS = new Set([
	"sources",
	"status",
	"signup_from",
	"signup_to",
	"cold",
	"not_opened_days",
	"kind",
	"has_app",
	"app_active_days",
	"min_site_visits",
]);

function isRealDate(value: string): boolean {
	if (!DATE.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function intInRange(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Strict validator for the shared filter object. Unknown keys, wrong types, out-of-range values and
 * values outside the source map or profile kinds are rejected. The error names a known field only and
 * never echoes the rejected value.
 */
export function validateFilters(input: unknown): FilterResult {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "filters must be an object" };
	const raw = input as Record<string, unknown>;
	const out: Filters = {};
	for (const key of Object.keys(raw)) if (!KNOWN_KEYS.has(key)) return { ok: false, error: "unknown filter key" };

	if (raw.sources !== undefined) {
		const list = raw.sources;
		if (!Array.isArray(list) || list.length < 1 || list.length > 20) return { ok: false, error: "sources must be a non-empty array" };
		const seen = new Set<string>();
		for (const item of list) {
			// Only values that the source map turns into a known source get through.
			const normalized = typeof item === "string" ? normalizeSource(item) : null;
			if (normalized === null || !SOURCES.includes(normalized)) return { ok: false, error: "sources has a value outside the source map" };
			seen.add(normalized);
		}
		out.sources = [...seen];
	}
	if (raw.status !== undefined) {
		if (raw.status !== "active" && raw.status !== "unsubscribed") return { ok: false, error: "status must be active or unsubscribed" };
		out.status = raw.status;
	}
	for (const key of ["signup_from", "signup_to"] as const) {
		const value = raw[key];
		if (value === undefined) continue;
		if (typeof value !== "string" || !isRealDate(value)) return { ok: false, error: `${key} must be a YYYY-MM-DD date` };
		out[key] = value;
	}
	if (out.signup_from !== undefined && out.signup_to !== undefined && out.signup_from > out.signup_to) {
		return { ok: false, error: "signup_from is after signup_to" };
	}
	for (const key of ["cold", "has_app"] as const) {
		const value = raw[key];
		if (value === undefined) continue;
		if (typeof value !== "boolean") return { ok: false, error: `${key} must be a boolean` };
		out[key] = value;
	}
	if (raw.not_opened_days !== undefined) {
		if (!intInRange(raw.not_opened_days, 1, 365)) return { ok: false, error: "not_opened_days must be an integer from 1 to 365" };
		out.not_opened_days = raw.not_opened_days;
	}
	if (raw.app_active_days !== undefined) {
		if (!intInRange(raw.app_active_days, 1, 365)) return { ok: false, error: "app_active_days must be an integer from 1 to 365" };
		out.app_active_days = raw.app_active_days;
	}
	if (raw.min_site_visits !== undefined) {
		if (!intInRange(raw.min_site_visits, 0, 10000)) return { ok: false, error: "min_site_visits must be an integer from 0 to 10000" };
		out.min_site_visits = raw.min_site_visits;
	}
	if (raw.kind !== undefined) {
		const list = raw.kind;
		if (!Array.isArray(list) || list.length < 1 || list.length > KINDS.length * 4) return { ok: false, error: "kind must be a non-empty array" };
		const seen = new Set<(typeof KINDS)[number]>();
		for (const item of list) {
			const match = KINDS.find((k) => k === item);
			if (match === undefined) return { ok: false, error: "kind has an unknown value" };
			seen.add(match);
		}
		out.kind = [...seen];
	}
	return { ok: true, filters: out };
}

export type Bind = string | number;

/** `?, ?, ?` for a validated, bounded list length. The only dynamic part of any fragment. */
function marks(count: number): string {
	return Array.from({ length: count }, () => "?").join(", ");
}

/**
 * Cold, written against the aliases used by every segment query: `s` = subscribers, `p` = profiles.
 * Binds: the 30-day start, twice. Evaluates to NULL for a profile with no subscriber row.
 */
export const COLD_SQL =
	"(s.status = 'active' AND (s.last_open_date < ? OR (s.last_open_date IS NULL AND s.signup_date < ?)))";

/** Literal "haven't opened in N days". Binds: the cutoff date, twice. NULL for a profile with no subscriber row. */
const NOT_OPENED_SQL = "(s.last_open_date < ? OR (s.last_open_date IS NULL AND s.signup_date < ?))";

const HAS_APP_SQL = "EXISTS (SELECT 1 FROM user_links ul WHERE ul.profile_id = p.profile_id)";

/**
 * Profiles with an owned app event dated on or after the bound date. Not correlated, so it runs once for the whole query
 * (one pass over the events in the window) and not once per profile. Bind: the cutoff date.
 */
const APP_ACTIVE_SQL =
	"p.profile_id IN (SELECT ul.profile_id FROM user_links ul WHERE ul.user_id IN " +
	"(SELECT o.owner_user_id FROM app_event_owner o WHERE o.ts >= ?))";

const SITE_VISITS_SQL =
	"(SELECT COUNT(*) FROM visitor_links vl JOIN web_events w ON w.visitor_id = vl.visitor_id " +
	"WHERE vl.profile_id = p.profile_id AND w.ts >= ?) >= ?";

/**
 * Turns validated filters into a WHERE body (no `WHERE` keyword) and its binds. SQL comes only from the
 * fixed fragments above plus `?` lists whose length the validator bounds; every value is a bind.
 * Subscriber-based filters (sources, status, signup range, cold, not_opened_days) never match a profile
 * without a subscriber row, and `cold: false` means "has a subscriber row and is not cold".
 * An empty filter object gives `1 = 1`.
 */
export function buildWhere(filters: Filters): { sql: string; binds: Bind[] } {
	const parts: string[] = [];
	const binds: Bind[] = [];
	if (filters.sources !== undefined) {
		parts.push(`s.source IN (${marks(filters.sources.length)})`);
		binds.push(...filters.sources);
	}
	if (filters.status !== undefined) {
		parts.push("s.status = ?");
		binds.push(filters.status);
	}
	if (filters.signup_from !== undefined) {
		parts.push("s.signup_date >= ?");
		binds.push(filters.signup_from);
	}
	if (filters.signup_to !== undefined) {
		parts.push("s.signup_date <= ?");
		binds.push(filters.signup_to);
	}
	if (filters.cold === true) {
		parts.push(COLD_SQL);
		binds.push(LAST_30_START, LAST_30_START);
	} else if (filters.cold === false) {
		parts.push("(s.email_norm IS NOT NULL AND NOT COALESCE(" + COLD_SQL + ", 0))");
		binds.push(LAST_30_START, LAST_30_START);
	}
	if (filters.not_opened_days !== undefined) {
		const cutoff = daysBefore(TODAY, filters.not_opened_days);
		parts.push(NOT_OPENED_SQL);
		binds.push(cutoff, cutoff);
	}
	if (filters.kind !== undefined) {
		parts.push(`p.kind IN (${marks(filters.kind.length)})`);
		binds.push(...filters.kind);
	}
	if (filters.has_app === true) parts.push(HAS_APP_SQL);
	else if (filters.has_app === false) parts.push("NOT " + HAS_APP_SQL);
	if (filters.app_active_days !== undefined) {
		parts.push(APP_ACTIVE_SQL);
		binds.push(daysBefore(TODAY, filters.app_active_days));
	}
	if (filters.min_site_visits !== undefined) {
		parts.push(SITE_VISITS_SQL);
		binds.push(LAST_30_START, filters.min_site_visits);
	}
	const sql = parts.length === 0 ? "1 = 1" : parts.join(" AND ");
	return { sql, binds };
}
