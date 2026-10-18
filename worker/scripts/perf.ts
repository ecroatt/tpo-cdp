// Usage (from worker/): npm run perf
// Measures D1 meta.rows_read per UI API call against the LOCAL database. Run `npm run import -- --local` first.
import { resolve } from "node:path";
import { getPlatformProxy } from "wrangler";
import worker from "../src/index";
import { questionNamesSomeone } from "../src/assistant/names";
import { runTool, validatePlan } from "../src/assistant/tools";
import { COOKIE_NAME, sha256Hex } from "../src/auth/session";
import { applyPerfSeed, buildPerfSeed } from "./lib/perf-seed";
import { recordRowsRead } from "./lib/rows-read";

const ORIGIN = "http://localhost:8787";
/** A call that reads this many rows or more is over budget and makes the script exit 1. */
const ROWS_READ_BUDGET = 25_000;

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
		const subs = await raw.prepare("SELECT COUNT(*) AS n FROM subscribers").first<{ n: number }>();
		if (!subs || subs.n === 0) {
			console.error("The local database has no subscribers. Run `npm run import -- --local` first.");
			process.exitCode = 1;
			throw new Error("empty");
		}

		// App events for the app-side calls: ~5,000 events on ~300 devices, loaded with INSERT OR IGNORE through the raw
		// binding (not counted), so a re-run changes nothing.
		const pool = await raw
			.prepare("SELECT u.user_id AS user_id FROM app_users u JOIN user_links l ON l.user_id = u.user_id WHERE u.origin = ? ORDER BY u.user_id LIMIT 220")
			.bind("csv")
			.all<{ user_id: string }>();
		const seed = buildPerfSeed(pool.results.map((r) => r.user_id));
		await applyPerfSeed(raw, seed);
		console.log("Seeded (idempotent): " + seed.events.length + " perf app events, " + seed.devices + " devices, " + pool.results.length + " app users in the pool.");

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

		// The profile that owns the most perf events, counting the anonymous ones attributed through device_links.
		// Looked up by profile_id, which is not PII. The view scan here is unmetered and runs once.
		const busiest = await raw
			.prepare(
				"SELECT l.profile_id AS profile_id, COUNT(*) AS owned, SUM(o.attributed_from_device) AS from_device " +
					"FROM app_event_owner o JOIN user_links l ON l.user_id = o.owner_user_id WHERE o.event_id LIKE ? " +
					"GROUP BY l.profile_id ORDER BY owned DESC, l.profile_id LIMIT 1",
			)
			.bind("perf_e_%")
			.first<{ profile_id: string; owned: number; from_device: number }>();
		if (!busiest) {
			console.error("No profile owns a perf event.");
			process.exitCode = 1;
			throw new Error("no perf owner");
		}
		console.log("Busiest app profile owns " + busiest.owned + " events, " + busiest.from_device + " of them attributed through a device login.");
		console.log("");

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
			const rows = recorder.rowsRead();
			const over = rows >= ROWS_READ_BUDGET;
			console.log(
				`${label.padEnd(34)} HTTP ${response.status}  statements ${String(recorder.statements()).padStart(3)}  rows_read ${String(rows).padStart(8)}` +
					(over ? "  <== OVER BUDGET (" + ROWS_READ_BUDGET + " or more)" : ""),
			);
			if (over) failed = true;
			if (response.status !== expect) {
				failed = true;
				console.error(`  expected HTTP ${expect}`);
			}
		};

		await call("session gate only (404 route)", "/api/nothing-here", undefined, 404);
		await call("lookup by email", "/api/lookup", { q: lookupQ });
		await call("preview: instagram, not opened 30d", "/api/segments/preview", {
			filters: { sources: ["instagram"], not_opened_days: 30 },
		});
		await call("preview: no filters", "/api/segments/preview", { filters: {} });
		await call("lookup: profile with app activity", "/api/lookup", { q: busiest.profile_id });
		await call("preview: app_active_days 30", "/api/segments/preview", { filters: { app_active_days: 30 } });
		await call("preview: app_active_days 90", "/api/segments/preview", { filters: { app_active_days: 90 } });
		await call("preview: app_active_days 30 + instagram", "/api/segments/preview", {
			filters: { app_active_days: 30, sources: ["instagram"] },
		});
		await call("import report", "/api/import-report");

		// The assistant's name check runs on every question: indexed ranges on profiles.email_norm, no model call.
		console.log("Assistant name check (no model call):");
		for (const question of [
			"How many Instagram signups went cold last month?",
			"Which pages did the people who signed up in the last week read first, and how many of them came back?",
		]) {
			recorder.reset();
			const found = await questionNamesSomeone(recorder.db, question);
			const rows = recorder.rowsRead();
			const over = rows >= ROWS_READ_BUDGET;
			console.log(
				`name check, ${String(question.split(" ").length).padStart(2)} words`.padEnd(58) +
					` statements ${String(recorder.statements()).padStart(3)}  rows_read ${String(rows).padStart(8)}  blocked ${found}` +
					(over ? "  <== OVER BUDGET (" + ROWS_READ_BUDGET + " or more)" : ""),
			);
			if (over) failed = true;
		}
		console.log("");

		// Every query type the assistant can run, straight through the tools (no model call), each with no filters and
		// with realistic filter sets: the brief's Q1 filters, Q3's new-subscriber filter and an app_active_days filter.
		console.log("Assistant tools (no model call):");
		const tool = async (label: string, name: string, input: unknown): Promise<void> => {
			const checked = validatePlan(name, input);
			if (!checked.ok) {
				failed = true;
				console.error(`${label}: plan rejected by validatePlan`);
				return;
			}
			recorder.reset();
			const result = await runTool(recorder.db, checked.plan);
			const rows = recorder.rowsRead();
			const over = rows >= ROWS_READ_BUDGET;
			const shown = result.rows === undefined ? (result.count === undefined ? "" : "count " + result.count) : result.rows.length + " rows";
			console.log(
				`${label.padEnd(58)} statements ${String(recorder.statements()).padStart(3)}  rows_read ${String(rows).padStart(8)}  ${shown}` +
					(over ? "  <== OVER BUDGET (" + ROWS_READ_BUDGET + " or more)" : ""),
			);
			if (over) failed = true;
		};
		const q1 = { sources: ["instagram"], signup_from: "2026-08-01", signup_to: "2026-08-31", cold: true };
		const filterSets: [string, Record<string, unknown>][] = [
			["no filters", {}],
			["brief Q1 filters", q1],
			["new subscribers (Q3)", { signup_from: "2026-08-29" }],
			["instagram, not opened 30d", { sources: ["instagram"], not_opened_days: 30 }],
			["app_active_days 30", { app_active_days: 30 }],
		];
		for (const [name, filters] of filterSets) {
			await tool(`count_profiles: ${name}`, "count_profiles", { filters });
			await tool(`build_segment: ${name}`, "build_segment", { filters });
			for (const include_site_pages of [false, true]) {
				const suffix = include_site_pages ? " +site pages" : "";
				await tool(`top_pages all${suffix}: ${name}`, "top_pages", { filters, mode: "all", limit: 20, include_site_pages });
				await tool(`top_pages first_visit${suffix}: ${name}`, "top_pages", { filters, mode: "first_visit", limit: 20, include_site_pages });
			}
			for (const by of ["source", "status", "signup_month", "kind", "cold"]) await tool(`breakdown by ${by}: ${name}`, "breakdown", { by, filters });
			await tool(`engagement_ranking 50: ${name}`, "engagement_ranking", { limit: 50, filters });
		}
		await tool("engagement_ranking 100: no filters", "engagement_ranking", { limit: 100 });
	} catch (err) {
		if (process.exitCode !== 1) {
			failed = true;
			console.error("perf failed:", err instanceof Error ? err.name + ": " + err.message : "unknown");
		}
	} finally {
		if (tokenHash !== null) await raw.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
		await dispose();
	}
	if (failed) process.exitCode = 1;
}

main().catch((err) => {
	console.error("perf failed:", err instanceof Error ? err.name : "unknown");
	process.exit(1);
});
