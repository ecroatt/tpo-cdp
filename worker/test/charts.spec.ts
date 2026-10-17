import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runTool, validatePlan } from "../src/assistant/tools";
import { handleAssistant } from "../src/routes/assistant";
import { askRequest, PAGE_A, PAGE_B, PAGE_C, scriptedModel, seedAssistantData } from "./fixtures/assistant";

beforeEach(seedAssistantData);

async function run(tool: string, input: unknown) {
	const checked = validatePlan(tool, input);
	if (!checked.ok) throw new Error("plan should be valid");
	return runTool(env.tpo_cdp, checked.plan);
}

describe("chart answers (SPEC section 6)", () => {
	it("a breakdown by source has chart labels and values equal to the counts in the database", async () => {
		const result = await run("breakdown", { by: "source" });
		// By hand: instagram 1,2,3,4,5,7,8,9; google 6,10; direct 12; x 11; no subscriber row: profile 13 ("none").
		expect(result.rows).toEqual([
			{ group: "instagram", count: 8 },
			{ group: "google", count: 2 },
			{ group: "direct", count: 1 },
			{ group: "none", count: 1 },
			{ group: "x", count: 1 },
		]);
		expect(result.chart).toEqual({ type: "bar", labels: ["instagram", "google", "direct", "none", "x"], values: [8, 2, 1, 1, 1], title: "Profiles by source" });

		// The same numbers straight from the database.
		const { results } = await env.tpo_cdp
			.prepare("SELECT COALESCE(s.source, 'none') AS g, COUNT(*) AS n FROM profiles p LEFT JOIN subscribers s ON s.email_norm = p.email_norm GROUP BY g")
			.all<{ g: string; n: number }>();
		const fromDb = new Map(results.map((r) => [r.g, r.n]));
		expect(result.chart!.labels.map((l) => fromDb.get(l))).toEqual(result.chart!.values);
		expect(result.chart!.values.reduce((a, b) => a + b, 0)).toBe(13);
	});

	it("breakdown by status, kind, cold and signup_month", async () => {
		expect((await run("breakdown", { by: "status" })).chart).toEqual({
			type: "bar",
			labels: ["active", "none", "unsubscribed"],
			values: [11, 1, 1],
			title: "Profiles by status",
		});
		expect((await run("breakdown", { by: "kind" })).chart).toEqual({ type: "bar", labels: ["subscriber", "app_only"], values: [12, 1], title: "Profiles by kind" });
		// Cold: 1, 4, 6, 7, 8. Not cold: 2, 3, 5, 9, 10, 11, 12. No newsletter row: 13.
		expect((await run("breakdown", { by: "cold" })).chart).toEqual({
			type: "bar",
			labels: ["not cold", "cold", "no newsletter"],
			values: [7, 5, 1],
			title: "Profiles by cold",
		});
		// Months run oldest first, with "none" last. July: 7. August: 1, 2, 3, 4, 5, 6, 8, 9. September: 10, 11, 12.
		expect((await run("breakdown", { by: "signup_month" })).chart).toEqual({
			type: "bar",
			labels: ["2026-07", "2026-08", "2026-09", "none"],
			values: [1, 8, 3, 1],
			title: "Profiles by signup month",
		});
	});

	it("a breakdown applies its filters", async () => {
		const result = await run("breakdown", { by: "source", filters: { status: "active" } });
		expect(result.chart).toEqual({ type: "bar", labels: ["instagram", "google", "direct", "x"], values: [7, 2, 1, 1], title: "Profiles by source" });
		expect(result.count).toBe(11);
	});

	it("a breakdown with no matches still has a chart, with no bars", async () => {
		const result = await run("breakdown", { by: "kind", filters: { sources: ["podcast"] } });
		expect(result.rows).toEqual([]);
		expect(result.chart).toEqual({ type: "bar", labels: [], values: [], title: "Profiles by kind" });
	});

	it("top_pages always has a chart, built from its rows", async () => {
		const first = await run("top_pages", { filters: { signup_from: "2026-08-29" }, mode: "first_visit" });
		expect(first.chart).toEqual({ type: "bar", labels: [PAGE_A, PAGE_B], values: [2, 1], title: "First pages visited (profiles)" });
		const all = await run("top_pages", { filters: { signup_from: "2026-08-29" }, mode: "all" });
		expect(all.chart).toEqual({ type: "bar", labels: [PAGE_A, PAGE_B, PAGE_C], values: [3, 3, 1], title: "Pages visited (profiles)" });
	});

	it("build_segment gets a by-source chart", async () => {
		const result = await run("build_segment", { filters: { status: "active" } });
		expect(result.count).toBe(11);
		expect(result.chart).toEqual({ type: "bar", labels: ["instagram", "google", "direct", "x"], values: [7, 2, 1, 1], title: "Profiles by source" });
		expect(result.rows).toHaveLength(11);
	});

	it("count_profiles has no chart and no rows", async () => {
		const result = await run("count_profiles", { filters: { sources: ["instagram"] } });
		expect(result.count).toBe(8);
		expect("chart" in result).toBe(false);
		expect("rows" in result).toBe(false);
	});

	it("the chart comes from data, not from the model's text", async () => {
		const model = scriptedModel({ name: "breakdown", input: { by: "kind" } });
		const response = await handleAssistant(askRequest("Make me a pie of kinds, labelled FAKE"), env, { fetch: model.fetch });
		const json = (await response.json()) as any;
		expect(json.result.chart.labels).toEqual(["subscriber", "app_only"]);
		expect(JSON.stringify(json.result.chart)).not.toContain("FAKE");
	});

	it("the Segments preview carries the data the page charts: by_source and by_status groups", async () => {
		const { previewSegment } = await import("../src/segments/query");
		const preview = await previewSegment(env.tpo_cdp, {});
		expect(preview.chart.by_source).toEqual([
			{ group: "instagram", count: 8 },
			{ group: "google", count: 2 },
			{ group: "direct", count: 1 },
			{ group: "none", count: 1 },
			{ group: "x", count: 1 },
		]);
		expect(preview.chart.by_status).toEqual([
			{ group: "active", count: 11 },
			{ group: "none", count: 1 },
			{ group: "unsubscribed", count: 1 },
		]);
	});
});
