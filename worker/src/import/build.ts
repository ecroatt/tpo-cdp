import { emailRawOrNull, normalizeEmail } from "../lib/email";
import { normalizeSource } from "../lib/source";
import { parseCsv } from "./csv";

export type SqlValue = string | number | null;
export interface Statement {
	sql: string;
	params: SqlValue[];
}

export interface ImportInput {
	subscribersCsv: string;
	webEventsCsv: string;
	appUsersCsv: string;
}

type Row = Record<string, string>;

// The email column goes through email.ts, the only place emails are trimmed.
const isBlank = (row: Row) =>
	Object.entries(row).every(([column, v]) => (column === "email" ? emailRawOrNull(v) === null : v.trim() === ""));
const orNull = (v: string | undefined): string | null => {
	const t = (v ?? "").trim();
	return t === "" ? null : t;
};

/** Web CSV timestamps have no zone and are read as UTC. */
function toUtcIso(raw: string): string | null {
	const t = raw.trim();
	if (t === "") return null;
	const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(?:\.\d+)?Z?$/.exec(t);
	return m ? `${m[1]}T${m[2]}Z` : null;
}

const chunk = <T>(items: T[], size: number): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
};

/** Multi-row INSERT with at most 100 bound values per statement (the D1 limit). */
function bulkInsert(verb: string, table: string, columns: string[], rows: SqlValue[][]): Statement[] {
	const perStatement = Math.max(1, Math.floor(100 / columns.length));
	const group = `(${columns.map(() => "?").join(", ")})`;
	return chunk(rows, perStatement).map((part) => ({
		sql: `${verb} INTO ${table} (${columns.join(", ")}) VALUES ${part.map(() => group).join(", ")}`,
		params: part.flat(),
	}));
}

interface Counts {
	[metric: string]: number;
}

export interface ImportPlan {
	statements: Statement[];
	/** Metrics known from the CSV text alone. Metrics derived from the database are written by SQL. */
	counts: Counts;
}

interface Sub {
	emailNorm: string;
	emailRaw: string;
	signup: string | null;
	status: string | null;
	sourceRaw: string;
	lastOpen: string | null;
}

/**
 * All import rules live here. Pure: CSV text in, parameterized statements out.
 * `runAt` is the report timestamp and is also used as profiles.created_at.
 */
export function buildImportStatements(input: ImportInput, runAt: string): ImportPlan {
	const counts: Counts = {};
	const statements: Statement[] = [];

	// ---- Subscribers
	const subRows = parseCsv(input.subscribersCsv);
	const subLive = subRows.filter((r) => !isBlank(r));
	counts.subscribers_rows_read = subLive.length;
	counts.subscribers_blank_rows = subRows.length - subLive.length;

	const groups = new Map<string, Sub[]>();
	let invalidSubs = 0;
	for (const r of subLive) {
		const emailNorm = normalizeEmail(r.email);
		if (emailNorm === null) {
			invalidSubs++;
			continue;
		}
		const sub: Sub = {
			emailNorm,
			emailRaw: r.email,
			signup: orNull(r.signup_date),
			status: orNull(r.status)?.toLowerCase() ?? null,
			sourceRaw: r.acquisition_source ?? "",
			lastOpen: orNull(r.last_open_date),
		};
		const g = groups.get(emailNorm);
		if (g) g.push(sub);
		else groups.set(emailNorm, [sub]);
	}
	counts.subscribers_invalid_email = invalidSubs;
	let merged = 0;
	const subRowsOut: SqlValue[][] = [];
	for (const g of groups.values()) {
		merged += g.length - 1;
		// Earliest signup wins; a missing signup date sorts last; ties keep file order.
		const kept = g.reduce((best, cur) => {
			if (cur.signup === null) return best;
			if (best.signup === null || cur.signup < best.signup) return cur;
			return best;
		});
		const lastOpens = g.map((s) => s.lastOpen).filter((d): d is string => d !== null);
		const lastOpen = lastOpens.length ? lastOpens.reduce((a, b) => (b > a ? b : a)) : null;
		subRowsOut.push([
			kept.emailNorm,
			kept.emailRaw,
			kept.signup,
			kept.status,
			normalizeSource(kept.sourceRaw),
			orNull(kept.sourceRaw) === null ? null : kept.sourceRaw,
			lastOpen,
		]);
	}
	counts.subscribers_duplicates_merged = merged;
	statements.push(
		...bulkInsert(
			"INSERT OR IGNORE",
			"subscribers",
			["email_norm", "email_raw", "signup_date", "status", "source", "source_raw", "last_open_date"],
			subRowsOut,
		),
	);

	// ---- App users
	const appRows = parseCsv(input.appUsersCsv);
	const appLive = appRows.filter((r) => !isBlank(r));
	counts.app_users_rows_read = appLive.length;
	counts.app_users_blank_rows = appRows.length - appLive.length;
	let invalidApp = 0;
	const appOut: SqlValue[][] = [];
	const seenUsers = new Set<string>();
	for (const r of appLive) {
		const userId = orNull(r.user_id);
		if (userId === null || seenUsers.has(userId)) continue;
		seenUsers.add(userId);
		const emailNorm = normalizeEmail(r.email);
		if (emailNorm === null) invalidApp++;
		appOut.push([userId, emailRawOrNull(r.email), emailNorm, orNull(r.created_at), "csv"]);
	}
	counts.app_users_invalid_email = invalidApp;
	statements.push(
		...bulkInsert("INSERT OR IGNORE", "app_users", ["user_id", "email_raw", "email_norm", "created_at", "origin"], appOut),
	);

	// ---- Profiles (set-based; NOT EXISTS keeps re-runs from minting new IDs)
	statements.push({
		sql:
			"INSERT INTO profiles (profile_id, kind, email_norm, created_at) " +
			"SELECT lower(hex(randomblob(16))), 'subscriber', s.email_norm, ? FROM subscribers s " +
			"WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.email_norm = s.email_norm)",
		params: [runAt],
	});
	statements.push({
		sql:
			"INSERT INTO profiles (profile_id, kind, email_norm, created_at) " +
			"SELECT lower(hex(randomblob(16))), 'app_only', e.email_norm, ? " +
			"FROM (SELECT DISTINCT email_norm FROM app_users WHERE email_norm IS NOT NULL AND origin = 'csv') e " +
			"WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.email_norm = e.email_norm)",
		params: [runAt],
	});
	statements.push({
		sql:
			"INSERT OR IGNORE INTO user_links (user_id, profile_id) " +
			"SELECT a.user_id, p.profile_id FROM app_users a JOIN profiles p ON p.email_norm = a.email_norm " +
			"WHERE a.origin = 'csv'",
		params: [],
	});

	// ---- Web events
	const webRows = parseCsv(input.webEventsCsv);
	const webLive = webRows.filter((r) => !isBlank(r));
	counts.web_events_rows_read = webLive.length;
	counts.web_events_blank_rows = webRows.length - webLive.length;
	let invalidWebRows = 0;
	let invalidWebEmails = 0;
	const webOut: SqlValue[][] = [];
	// The earliest visit carrying a valid email decides the visitor's email.
	const visitorEmail = new Map<string, { ts: string; emailNorm: string }>();
	const visitorEmails = new Map<string, Set<string>>();
	for (const r of webLive) {
		const visitorId = orNull(r.visitor_id);
		const page = orNull(r.page);
		const ts = toUtcIso(r.timestamp ?? "");
		if (visitorId === null || page === null || ts === null) {
			invalidWebRows++;
			continue;
		}
		const emailNorm = normalizeEmail(r.email);
		if (emailRawOrNull(r.email) !== null && emailNorm === null) invalidWebEmails++;
		webOut.push([
			visitorId,
			page,
			ts,
			normalizeSource(r.utm_source),
			orNull(r.utm_source) === null ? null : r.utm_source,
			emailRawOrNull(r.email),
			emailNorm,
		]);
		if (emailNorm !== null) {
			const cur = visitorEmail.get(visitorId);
			if (!cur || ts < cur.ts) visitorEmail.set(visitorId, { ts, emailNorm });
			const set = visitorEmails.get(visitorId) ?? new Set<string>();
			set.add(emailNorm);
			visitorEmails.set(visitorId, set);
		}
	}
	counts.web_events_invalid_rows = invalidWebRows;
	counts.web_events_invalid_email = invalidWebEmails;
	counts.visitors_email_conflicts = [...visitorEmails.values()].filter((s) => s.size > 1).length;
	statements.push(
		...bulkInsert(
			"INSERT OR IGNORE",
			"web_events",
			["visitor_id", "page", "ts", "source", "source_raw", "email_raw", "email_norm"],
			webOut,
		),
	);

	// ---- Visitor links: a visitor whose email matches no profile stays unlinked.
	const knownEmails = new Set<string>(groups.keys());
	for (const row of appOut) if (row[2] !== null) knownEmails.add(row[2] as string);
	const linkPairs: SqlValue[][] = [];
	let unlinked = 0;
	for (const [visitorId, { emailNorm }] of visitorEmail) {
		if (knownEmails.has(emailNorm)) linkPairs.push([visitorId, emailNorm]);
		else unlinked++;
	}
	counts.visitors_unlinked = unlinked;
	for (const part of chunk(linkPairs, 50)) {
		statements.push({
			sql:
				"INSERT OR IGNORE INTO visitor_links (visitor_id, profile_id) " +
				`WITH v(visitor_id, email_norm) AS (VALUES ${part.map(() => "(?, ?)").join(", ")}) ` +
				"SELECT v.visitor_id, p.profile_id FROM v JOIN profiles p ON p.email_norm = v.email_norm",
			params: part.flat(),
		});
	}

	// ---- Report: file-derived metrics, then database-derived metrics.
	statements.push(
		...bulkInsert(
			"INSERT",
			"import_report",
			["run_at", "metric", "value"],
			Object.entries(counts).map(([metric, value]) => [runAt, metric, value]),
		),
	);
	const dbMetrics: [string, string][] = [
		["profiles_subscriber", "SELECT COUNT(*) FROM profiles WHERE kind = 'subscriber'"],
		["profiles_app_only", "SELECT COUNT(*) FROM profiles WHERE kind = 'app_only'"],
		["profiles_unknown_app_user", "SELECT COUNT(*) FROM profiles WHERE kind = 'unknown_app_user'"],
		["visitors_linked", "SELECT COUNT(*) FROM visitor_links"],
		["visits_linked", "SELECT COUNT(*) FROM web_events w JOIN visitor_links l ON l.visitor_id = w.visitor_id"],
		[
			"app_users_matched",
			"SELECT COUNT(*) FROM app_users a JOIN user_links l ON l.user_id = a.user_id " +
				"JOIN profiles p ON p.profile_id = l.profile_id WHERE a.origin = 'csv' AND p.kind = 'subscriber'",
		],
		[
			"app_users_app_only",
			"SELECT COUNT(*) FROM app_users a JOIN user_links l ON l.user_id = a.user_id " +
				"JOIN profiles p ON p.profile_id = l.profile_id WHERE a.origin = 'csv' AND p.kind = 'app_only'",
		],
	];
	for (const [metric, select] of dbMetrics) {
		statements.push({
			sql: `INSERT INTO import_report (run_at, metric, value) SELECT ?, ?, (${select})`,
			params: [runAt, metric],
		});
	}

	return { statements, counts };
}

function literal(v: SqlValue): string {
	if (v === null) return "NULL";
	if (typeof v === "number") {
		if (!Number.isFinite(v)) throw new Error("non-finite number in SQL params");
		return String(v);
	}
	const quoted = `'${v.replace(/\0/g, "").replace(/'/g, "''")}'`;
	// Keep every statement on one line so line-based executors cannot split a value.
	return quoted.replace(/\r/g, "' || char(13) || '").replace(/\n/g, "' || char(10) || '");
}

/** Renders statements to a SQL script for `wrangler d1 execute --file`. Values are escaped literals. */
export function renderSql(statements: Statement[]): string {
	const lines = statements.map((s) => {
		const parts = s.sql.split("?");
		if (parts.length - 1 !== s.params.length) throw new Error("placeholder count mismatch");
		return parts.map((part, i) => (i < s.params.length ? part + literal(s.params[i]) : part)).join("") + ";";
	});
	return lines.join("\n") + "\n";
}
