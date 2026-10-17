import { json } from "../http/security";

/** The latest import run: every metric row that shares the newest run_at. */
export async function handleImportReport(env: Env): Promise<Response> {
	const { results } = await env.tpo_cdp
		.prepare(
			"SELECT run_at, metric, value FROM import_report " +
				"WHERE run_at = (SELECT MAX(run_at) FROM import_report) ORDER BY rowid",
		)
		.all<{ run_at: string; metric: string; value: number }>();
	return json({
		run_at: results[0]?.run_at ?? null,
		metrics: results.map((r) => ({ metric: r.metric, value: r.value })),
	});
}
