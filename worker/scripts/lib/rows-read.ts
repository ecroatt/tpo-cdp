// Pure D1 recorder (no node imports): wraps a D1Database and totals meta.rows_read.

interface Meta {
	rows_read?: number;
}
interface Result {
	meta?: Meta;
	results?: unknown[];
}

export interface RowsReadRecorder {
	/** The wrapped database; hand this to code that expects a D1Database. */
	db: D1Database;
	/** Zeroes the statement and rows_read counters. */
	reset(): void;
	/** Statements executed since the last reset. */
	statements(): number;
	/** Total meta.rows_read since the last reset. */
	rowsRead(): number;
}

export function recordRowsRead(inner: D1Database): RowsReadRecorder {
	let statements = 0;
	let rowsRead = 0;
	const add = (r: Result): void => {
		statements++;
		rowsRead += r.meta?.rows_read ?? 0;
	};

	// batch() needs the real statements back, so each wrapper is remembered.
	const originals = new WeakMap<object, D1PreparedStatement>();
	const wrapStatement = (stmt: D1PreparedStatement): D1PreparedStatement => {
		const wrapped = {
			bind: (...values: unknown[]) => wrapStatement(stmt.bind(...values)),
			all: async (): Promise<Result> => {
				const r = (await stmt.all()) as Result;
				add(r);
				return r;
			},
			run: async (): Promise<Result> => {
				const r = (await stmt.run()) as Result;
				add(r);
				return r;
			},
			raw: async (options?: { columnNames?: boolean }): Promise<unknown> => {
				// raw() carries no meta, so measure via all() and rebuild the arrays.
				const r = (await stmt.all()) as Result;
				add(r);
				const rows = (r.results ?? []) as Record<string, unknown>[];
				const arrays: unknown[][] = rows.map((row) => Object.values(row));
				if (options?.columnNames) return [rows[0] ? Object.keys(rows[0]) : [], ...arrays];
				return arrays;
			},
			// D1's first() returns no meta, so it is implemented through all() with the same semantics.
			first: async (column?: string): Promise<unknown> => {
				const r = (await stmt.all()) as Result;
				add(r);
				const row = (r.results ?? [])[0] as Record<string, unknown> | undefined;
				if (row === undefined) return null;
				return column === undefined ? row : (row[column] ?? null);
			},
		};
		originals.set(wrapped, stmt);
		return wrapped as unknown as D1PreparedStatement;
	};

	const db = {
		// Pass-through of the caller's own arguments; this wrapper builds no SQL.
		prepare: (...args: Parameters<D1Database["prepare"]>) => wrapStatement(Reflect.apply(inner.prepare, inner, args)),
		batch: async (statements: D1PreparedStatement[]): Promise<Result[]> => {
			const results = (await inner.batch(statements.map((s) => originals.get(s) ?? s))) as Result[];
			for (const r of results) add(r);
			return results;
		},
		exec: (sql: string) => inner.exec(sql),
		withSession: (...args: unknown[]) => (inner as unknown as { withSession: (...a: unknown[]) => unknown }).withSession(...args),
	};

	return {
		db: db as unknown as D1Database,
		reset: () => {
			statements = 0;
			rowsRead = 0;
		},
		statements: () => statements,
		rowsRead: () => rowsRead,
	};
}
