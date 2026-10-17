// Usage (from worker/): npm run perf
// Measures D1 meta.rows_read per UI API call against the LOCAL database. Run `npm run import -- --local` first.
import { resolve } from "node:path";
import { getPlatformProxy } from "wrangler";
import worker from "../src/index";
import { COOKIE_NAME, sha256Hex } from "../src/auth/session";
import { recordRowsRead } from "./lib/rows-read";

const ORIGIN = "http://localhost:8787";

async function main(): Promise<void> {
	const { env, dispose } = await getPlatformProxy<Env>({
		configPath: resolve(import.meta.dirname, "../wrangler.jsonc"),
		persist: true,
	});
	const raw = env.tpo_cdp;
	const recorder = recordRowsRead(raw);
	const wrappedEnv = { ...env, tpo_cdp: recorder.db } as Env;
	const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

	let tokenHash: string | null = null;
	let failed = false;
	try {
		console.log("Rows per table (local D1):");
		const counts = await raw
			.prepare(
				"SELECT " +
					"(SELECT COUNT(*) FROM profiles) AS profiles, " +
					"(SELECT COUNT(*) FROM subscribers) AS subscribers, " +
					"(SELECT COUNT(*) FROM web_events) AS web_events, " +
					"(SELECT COUNT(*) FROM visitor_links) AS visitor_links, " +
					"(SELECT COUNT(*) FROM app_users) AS app_users, " +
					"(SELECT COUNT(*) FROM user_links) AS user_links, " +
					"(SELECT COUNT(*) FROM app_events) AS app_events, " +
					"(SELECT COUNT(*) FROM device_links) AS device_links",
			)
			.first<Record<string, number>>();
		for (const [table, n] of Object.entries(counts ?? {})) console.log("  " + table.padEnd(14) + " " + n);
		const subs = await raw.prepare("SELECT COUNT(*) AS n FROM subscribers").first<{ n: number }>();
		if (!subs || subs.n === 0) {
			console.error("The local database has no subscribers. Run `npm run import -- --local` first.");
			process.exitCode = 1;
			throw new Error("empty");
		}

		// The subscriber with the most linked web visits. The email stays in memory and is never printed.
		const top = await raw
			.prepare(
				"SELECT p.email_norm AS email, COUNT(*) AS visits FROM profiles p " +
					"JOIN visitor_links l ON l.profile_id = p.profile_id JOIN web_events w ON w.visitor_id = l.visitor_id " +
					"WHERE p.kind = ? GROUP BY p.profile_id ORDER BY visits DESC LIMIT 1",
			)
			.bind("subscriber")
			.first<{ email: string; visits: number }>();
		if (!top) {
			console.error("No subscriber has linked web visits. Run `npm run import -- --local` first.");
			process.exitCode = 1;
			throw new Error("no visits");
		}
		console.log(`Lookup subject has ${top.visits} linked web visits.\n`);
		const lookupQ = "  " + top.email.toUpperCase() + "  ";

		const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
		tokenHash = await sha256Hex(token);
		const now = new Date();
		await raw
			.prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
			.bind(tokenHash, now.toISOString(), new Date(now.getTime() + 3600_000).toISOString())
			.run();

		const call = async (label: string, path: string, body?: unknown, expect = 200): Promise<void> => {
			const headers: Record<string, string> = { Cookie: `${COOKIE_NAME}=${token}` };
			if (body !== undefined) {
				headers.Origin = ORIGIN;
				headers["Content-Type"] = "application/json";
			}
			const request = new Request(ORIGIN + path, {
				method: body === undefined ? "GET" : "POST",
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			recorder.reset();
			const response = await worker.fetch(request as never, wrappedEnv, ctx);
			await response.arrayBuffer();
			console.log(
				`${label.padEnd(34)} HTTP ${response.status}  statements ${String(recorder.statements()).padStart(3)}  rows_read ${String(recorder.rowsRead()).padStart(8)}`,
			);
			if (response.status !== expect) {
				failed = true;
				console.error(`  expected HTTP ${expect}`);
			}
		};

		await call("session gate only (404 route)", "/api/nothing-here", undefined, 404);
		await call("lookup by email", "/api/lookup?q=" + encodeURIComponent(lookupQ));
		await call("preview: instagram, not opened 30d", "/api/segments/preview", {
			filters: { sources: ["instagram"], not_opened_days: 30 },
		});
		await call("preview: no filters", "/api/segments/preview", { filters: {} });
		await call("import report", "/api/import-report");
	} catch (err) {
		if (process.exitCode !== 1) {
			failed = true;
			console.error("perf failed:", err instanceof Error ? err.name : "unknown");
		}
	} finally {
		if (tokenHash !== null) await raw.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
		await dispose();
	}
	if (failed) process.exitCode = 1;
}

main().catch((err) => {
	console.error("perf failed:", err);
	process.exit(1);
});
