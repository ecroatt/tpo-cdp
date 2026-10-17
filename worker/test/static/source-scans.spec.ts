import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const full = join(dir, name);
		return statSync(full).isDirectory() ? walk(full) : [full];
	});
}

const rel = (f: string) => relative(root, f).replaceAll("\\", "/");
const sourceFiles = () => [...walk(join(root, "src")), ...walk(join(root, "scripts"))].filter((f) => /\.(ts|js|mjs)$/.test(f));

/** Returns the text of each `.prepare(` argument list, balanced through nested parens and strings. */
export function prepareArguments(text: string, marker = ".prepare("): { args: string; index: number }[] {
	const found: { args: string; index: number }[] = [];
	let from = 0;
	for (;;) {
		const at = text.indexOf(marker, from);
		if (at === -1) return found;
		let depth = 1;
		let i = at + marker.length;
		let quote: string | null = null;
		for (; i < text.length && depth > 0; i++) {
			const ch = text[i];
			if (quote) {
				if (ch === "\\") i++;
				else if (ch === quote) quote = null;
			} else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
			else if (ch === "(") depth++;
			else if (ch === ")") depth--;
		}
		found.push({ args: text.slice(at + marker.length, i - 1), index: at });
		from = i;
	}
}

/**
 * Interpolations allowed inside SQL template literals, per file. Each is a constant identifier or a
 * placeholder list built from "?", never user input. The importer's `verb`, `table`, `columns`, `group`
 * and `select` come from fixed lists in the same file.
 */
const ALLOWED_SQL_INTERPOLATIONS: Record<string, string[]> = {
	"src/import/build.ts": [
		'columns.map(() => "?").join(", ")',
		'columns.join(", ")',
		"verb",
		"table",
		"group",
		'part.map(() => group).join(", ")',
		'part.map(() => "(?, ?)").join(", ")',
		"select",
	],
	// buildWhere: `?` lists whose length the validator bounds. Every value is a bind.
	"src/segments/filters.ts": ["marks(filters.sources.length)", "marks(filters.kind.length)"],
	// previewSegment: the WHERE body from buildWhere and the constant SCORE_SQL. Nothing else.
	"src/segments/query.ts": ["where.sql", "SCORE_SQL", "APP_POINTS_CTE"],
	// ownedActivity / ownedWindowPoints: two constants defined in the same file (string literals joined by +).
	"src/lib/owned-events.ts": ["OWNED_EVENTS_CTE", "POINTS_IF_IN_WINDOW"],
	// storeEvent: two constant guard fragments (string literals in the same file) spliced into its INSERT ... SELECT statements.
	"src/webhook/store.ts": ["STORED_AS_SENT", "NO_LINK_YET"],
};

const SQL_WORDS = /\b(SELECT|INSERT|UPDATE|DELETE|VALUES|WITH|WHERE|FROM|AND|OR|JOIN|ORDER|SET|IN)\b/i;

/** Interpolated expressions of SQL-looking template literals that are not in `allowed`. */
export function disallowedSqlInterpolations(text: string, allowed: string[], forceSql = false): string[] {
	const bad: string[] = [];
	for (const m of text.matchAll(/`(?:[^`\\]|\\.)*`/g)) {
		const literal = m[0];
		// A template assigned to `sql:` or passed to `.prepare(` is SQL whatever words it contains.
		const before = text.slice(Math.max(0, m.index! - 40), m.index!);
		const sqlPosition = forceSql || /(\bsql\s*:|\.prepare\s*\()\s*$/.test(before);
		// HTML page templates start with a tag; their prose ("Sign in") would otherwise look like SQL words.
		if (!sqlPosition && (literal.startsWith("`<") || (!SQL_WORDS.test(literal) && !literal.includes("?")))) continue;
		for (const part of literal.matchAll(/\$\{([^}]*)\}/g)) {
			if (!allowed.includes(part[1].trim())) bad.push(part[1].trim());
		}
	}
	return bad;
}

/** Splits call arguments on top-level commas, ignoring commas inside strings, brackets and parens. */
function splitArgs(args: string, separator = ","): string[] {
	const out: string[] = [];
	let depth = 0;
	let quote: string | null = null;
	let start = 0;
	for (let i = 0; i < args.length; i++) {
		const ch = args[i];
		if (quote) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = null;
		} else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
		else if ("([{".includes(ch)) depth++;
		else if (")]}".includes(ch)) depth--;
		else if (ch === separator && depth === 0) {
			out.push(args.slice(start, i).trim());
			start = i + 1;
		}
	}
	out.push(args.slice(start).trim());
	return out;
}

const STRING_LITERAL = /^("([^"\\]|\\.)*"|'([^'\\]|\\.)*')$/;
const LITERAL_ARRAY = /^\[\s*(("([^"\\]|\\.)*"|'([^'\\]|\\.)*')\s*,?\s*)*\]$/;

const TEMPLATE = /^`(?:[^`\\]|\\.)*`$/;

/**
 * The ONE rule for every SQL position (each `sql:` value and each `.prepare(` argument): string literals
 * joined by `+`, and/or templates whose interpolations are all on the allow-list. Anything else
 * (identifiers, calls, member access, other operators) fails.
 */
export function isConstantSql(expression: string, allowed: string[] = []): boolean {
	const expr = expression.trim().replace(/,$/, "").trim();
	if (expr === "") return false;
	return splitArgs(expr, "+").every((term) => {
		if (STRING_LITERAL.test(term)) return true;
		return TEMPLATE.test(term) && disallowedSqlInterpolations(term, allowed, true).length === 0;
	});
}

/** Expressions assigned to `sql:` properties (the `sql: string` type declaration is not a value). */
export function sqlFieldExpressions(text: string): { expr: string; index: number }[] {
	const found: { expr: string; index: number }[] = [];
	for (const m of text.matchAll(/\bsql\s*:\s*/g)) {
		let i = m.index! + m[0].length;
		const start = i;
		let depth = 0;
		let quote: string | null = null;
		for (; i < text.length; i++) {
			const ch = text[i];
			if (quote) {
				if (ch === "\\") i++;
				else if (ch === quote) quote = null;
			} else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
			else if ("([{".includes(ch)) depth++;
			else if (")]}".includes(ch)) {
				if (depth === 0) break;
				depth--;
			} else if ((ch === "," || ch === ";") && depth === 0) break;
		}
		const expr = text.slice(start, i).trim();
		if (expr === "string") continue;
		found.push({ expr, index: m.index! });
	}
	return found;
}

/** SQL positions in `text` that break the shared rule, as line numbers. */
export function badSqlPositions(text: string, allowed: string[]): number[] {
	const line = (index: number) => text.slice(0, index).split("\n").length;
	const bad: number[] = [];
	for (const { expr, index } of sqlFieldExpressions(text)) if (!isConstantSql(expr, allowed)) bad.push(line(index));
	for (const { args, index } of prepareArguments(text)) {
		if (!isConstantSql(splitArgs(args)[0] ?? "", allowed)) bad.push(line(index));
	}
	return bad;
}


/**
 * `verb`, `table` and `columns` may be interpolated only because every `bulkInsert(` call passes
 * string literals (and a literal array of strings) for them. Returns the calls that do not.
 */
export function nonLiteralBulkInserts(text: string): string[] {
	const bad: string[] = [];
	for (const { args, index } of prepareArguments(text, "bulkInsert(")) {
		if (text.slice(Math.max(0, index - 9), index) === "function ") continue;
		const [verb, table, columns] = splitArgs(args);
		if (!STRING_LITERAL.test(verb ?? "") || !STRING_LITERAL.test(table ?? "") || !LITERAL_ARRAY.test(columns ?? "")) {
			bad.push(args.slice(0, 60));
		}
	}
	return bad;
}

/**
 * The `select` interpolation is allowed because it is only ever one of the fixed SELECT strings in the
 * `dbMetrics` list. Returns true when that list holds nothing but string literals, `+`, brackets and commas.
 */
export function dbMetricsIsConstant(text: string): boolean {
	const m = /const dbMetrics[^=]*=\s*\[([\s\S]*?)\n\t\];/.exec(text);
	if (!m) return false;
	const stripped = m[1].replace(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g, "").replace(/[\s,+[\]]/g, "");
	return stripped === "";
}

describe("source scans", () => {
	it("every sql: value and .prepare( argument is string literals joined by + or an allow-listed template", () => {
		const offenders: string[] = [];
		for (const file of sourceFiles()) {
			const allowed = ALLOWED_SQL_INTERPOLATIONS[rel(file)] ?? [];
			for (const line of badSqlPositions(readFileSync(file, "utf8"), allowed)) offenders.push(`${rel(file)}:${line}`);
		}
		expect(offenders).toEqual([]);
		// The scan really sees the importer's SQL positions.
		const build = readFileSync(join(root, "src/import/build.ts"), "utf8");
		expect(sqlFieldExpressions(build).length).toBeGreaterThanOrEqual(6);
	});

	it("the shared SQL rule flags concatenation, identifiers and calls in sql: and .prepare(", () => {
		expect(badSqlPositions('const a = { sql: "a" + x };', [])).toEqual([1]);
		expect(badSqlPositions('const a = { sql: "a" + "b", params: [] };', [])).toEqual([]);
		expect(badSqlPositions('db.prepare("a" + x)', [])).toEqual([1]);
		expect(badSqlPositions('db.prepare("a" + "b")', [])).toEqual([]);
		expect(badSqlPositions("const a = { sql: someVar };", [])).toEqual([1]);
		expect(badSqlPositions("const a = { sql: build(1), params: [] };", [])).toEqual([1]);
		expect(badSqlPositions("const a = { sql: \"INSERT INTO t VALUES ('\" + value + \"')\" };", [])).toEqual([1]);
		expect(badSqlPositions("const a = { sql: `x ${y}` };", [])).toEqual([1]);
		expect(badSqlPositions("const a = { sql: `x ${table}` };", ["table"])).toEqual([]);
		expect(badSqlPositions("interface S { sql: string; }", [])).toEqual([]);
	});

	it("the .prepare( scan flags dynamic SQL and accepts constant SQL", () => {
		expect(isConstantSql('"SELECT 1 " +\n "FROM t"')).toBe(true);
		expect(isConstantSql("`SELECT 1`")).toBe(true);
		expect(isConstantSql("`SELECT ${x}`")).toBe(false);
		expect(isConstantSql('"SELECT " + table')).toBe(false);
		expect(prepareArguments('db.prepare("a (b)").bind(x)').map((p) => p.args)).toEqual(['"a (b)"']);
	});

	it("no SQL template literal in src/ or scripts/ interpolates a non-constant value", () => {
		const offenders: string[] = [];
		for (const file of sourceFiles()) {
			const bad = disallowedSqlInterpolations(readFileSync(file, "utf8"), ALLOWED_SQL_INTERPOLATIONS[rel(file)] ?? []);
			for (const expr of bad) offenders.push(`${rel(file)}: \${${expr}}`);
		}
		expect(offenders).toEqual([]);
	});

	it("the SQL template scan flags a non-constant interpolation and accepts allow-listed ones", () => {
		expect(disallowedSqlInterpolations("db.prepare(`SELECT * FROM t WHERE id = ${id}`)", [])).toEqual(["id"]);
		expect(disallowedSqlInterpolations("const q = `INSERT INTO t VALUES (${userInput})`;", ["table"])).toEqual(["userInput"]);
		expect(disallowedSqlInterpolations("const q = `INSERT INTO ${table} VALUES (?)`;", ["table"])).toEqual([]);
		expect(disallowedSqlInterpolations("const g = `(${cols.map(() => \"?\").join(\", \")})`;", [])).toHaveLength(1);
		expect(disallowedSqlInterpolations("log(`finished after ${ms}ms`)", [])).toEqual([]);
	});

	it("the interpolated verb/table/columns/select in build.ts only ever come from literal call sites", () => {
		const text = readFileSync(join(root, "src/import/build.ts"), "utf8");
		expect(nonLiteralBulkInserts(text)).toEqual([]);
		expect(dbMetricsIsConstant(text)).toBe(true);
		expect(text).toContain("bulkInsert(");
	});

	it("the tightened SQL scan flags keyword-less fragments and non-literal bulkInsert arguments", () => {
		expect(disallowedSqlInterpolations("const f = `AND source = '${s}'`;", [])).toEqual(["s"]);
		expect(disallowedSqlInterpolations("const f = `WHERE ${col} = 1`;", [])).toEqual(["col"]);
		expect(disallowedSqlInterpolations("const o = { sql: `${frag}` };", [])).toEqual(["frag"]);
		expect(disallowedSqlInterpolations("db.prepare(`${frag}`)", [])).toEqual(["frag"]);
		expect(disallowedSqlInterpolations("const m = `hello ${name}`;", [])).toEqual([]);

		const good = 'bulkInsert("INSERT", "t", ["a", "b"], rows);';
		expect(nonLiteralBulkInserts(good)).toEqual([]);
		expect(nonLiteralBulkInserts("function bulkInsert(verb: string, table: string, columns: string[]) {}")).toEqual([]);
		expect(nonLiteralBulkInserts('bulkInsert(x, "t", ["a"], rows);')).toHaveLength(1);
		expect(nonLiteralBulkInserts('bulkInsert("INSERT", userValue, ["a"], rows);')).toHaveLength(1);
		expect(nonLiteralBulkInserts('bulkInsert("INSERT", "t", cols, rows);')).toHaveLength(1);

		expect(dbMetricsIsConstant('const dbMetrics: [string, string][] = [\n\t["a", "SELECT 1 " + "FROM t"],\n\t];')).toBe(true);
		expect(dbMetricsIsConstant('const dbMetrics: [string, string][] = [\n\t["a", userSql],\n\t];')).toBe(false);
	});

	it("the buildWhere fragment builder is the only dynamic SQL, and it is built from fixed fragments", () => {
		const filters = readFileSync(join(root, "src/segments/filters.ts"), "utf8");
		const query = readFileSync(join(root, "src/segments/query.ts"), "utf8");
		const engagement = readFileSync(join(root, "src/segments/engagement.ts"), "utf8");
		expect(disallowedSqlInterpolations(filters, ALLOWED_SQL_INTERPOLATIONS["src/segments/filters.ts"]).sort()).toEqual([]);
		expect(disallowedSqlInterpolations(query, ALLOWED_SQL_INTERPOLATIONS["src/segments/query.ts"])).toEqual([]);
		expect(query).toContain("buildWhere(");
		expect(query).toContain("${where.sql}");
		// marks() emits only "?" and the fixed fragments are plain string literals.
		expect(filters).toMatch(/Array\.from\(\{ length: count \}, \(\) => "\?"\)\.join\(", "\)/);
		for (const name of ["COLD_SQL", "NOT_OPENED_SQL", "HAS_APP_SQL", "APP_ACTIVE_SQL", "SITE_VISITS_SQL"]) {
			const m = new RegExp(`const ${name} =\\s*([^;]*);`).exec(filters);
			expect(m, name).not.toBeNull();
			expect(isConstantSql(m![1]), name).toBe(true);
		}
		const score = /export const SCORE_SQL =\s*([^;]*);/.exec(engagement);
		expect(score).not.toBeNull();
		expect(isConstantSql(score![1])).toBe(true);
		const appCte = /export const APP_POINTS_CTE =s*([^;]*);/.exec(engagement);
		expect(appCte).not.toBeNull();
		expect(isConstantSql(appCte![1])).toBe(true);
		const owned = readFileSync(join(root, "src/lib/owned-events.ts"), "utf8");
		for (const name of ["OWNED_EVENTS_CTE", "POINTS_IF_IN_WINDOW"]) {
			const m = new RegExp(`const ${name} =\\s*([^;]*);`).exec(owned);
			expect(m, name).not.toBeNull();
			expect(isConstantSql(m![1]), name).toBe(true);
		}
		expect(disallowedSqlInterpolations(owned, ALLOWED_SQL_INTERPOLATIONS["src/lib/owned-events.ts"])).toEqual([]);
		// A value interpolated next to the allowed ones is still caught.
		expect(disallowedSqlInterpolations("db.prepare(`SELECT 1 WHERE ${where.sql} AND x = '${value}'`)", ["where.sql", "SCORE_SQL"])).toEqual(["value"]);
	});

	it("the webhook store guards are string literals, so the store.ts templates only splice constants", () => {
		const store = readFileSync(join(root, "src/webhook/store.ts"), "utf8");
		for (const name of ["STORED_AS_SENT", "NO_LINK_YET"]) {
			const m = new RegExp(`const ${name} =\\s*([^;]*);`).exec(store);
			expect(m, name).not.toBeNull();
			expect(isConstantSql(m![1]), name).toBe(true);
		}
		expect(disallowedSqlInterpolations(store, ALLOWED_SQL_INTERPOLATIONS["src/webhook/store.ts"])).toEqual([]);
	});

	it("no TODO or FIXME in src/ or scripts/", () => {
		const offenders = sourceFiles().filter((f) => /\b(TODO|FIXME)\b/.test(readFileSync(f, "utf8"))).map(rel);
		expect(offenders).toEqual([]);
	});

	it("no innerHTML, outerHTML, insertAdjacentHTML or document.write in public/ outside public/vendor/", () => {
		const files = walk(join(root, "public")).filter((f) => !rel(f).startsWith("public/vendor/") && /\.(js|mjs|html)$/.test(f));
		expect(files.length).toBeGreaterThan(0);
		const offenders = files.filter((f) => /innerHTML|outerHTML|insertAdjacentHTML|document\s*\.\s*write/.test(readFileSync(f, "utf8"))).map(rel);
		expect(offenders).toEqual([]);
	});
});
