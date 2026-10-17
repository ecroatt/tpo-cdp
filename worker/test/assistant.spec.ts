import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { buildModelRequest } from "../src/assistant/prompt";
import { ModelUnavailableError, PiiBlockedError, sendToModel } from "../src/assistant/model";
import { scrubQuestion } from "../src/assistant/scrub";
import { answerFor } from "../src/assistant/templates";
import { validatePlan } from "../src/assistant/tools";
import { handleAssistant } from "../src/routes/assistant";
import {
	ALL_EMAILS,
	ALL_IDS,
	ALL_NAME_LIKE,
	APP_ONLY,
	askRequest,
	BASE,
	FAKE_KEY,
	noSqlEnv,
	PAGE_A,
	PAGE_B,
	PAGE_C,
	pid,
	Q1,
	Q2,
	Q3,
	scriptedModel,
	seedAssistantData,
	SUBS,
} from "./fixtures/assistant";
import { call, loginCookie, postJson, resetAll } from "./fixtures/cdp";

const deps = (model: { fetch: typeof fetch }) => ({ fetch: model.fetch });

async function ask(question: unknown, reply: Parameters<typeof scriptedModel>[0], testEnv: Env = env) {
	const model = scriptedModel(reply);
	const response = await handleAssistant(askRequest(question), testEnv, deps(model));
	return { model, response, json: (await response.json()) as any };
}

beforeEach(seedAssistantData);
afterEach(() => vi.unstubAllGlobals());

describe("the test environment never holds a real key", () => {
	it("ANTHROPIC_API_KEY is the fake value from vitest.config.mts", () => {
		// Compared without printing the value on failure.
		expect(env.ANTHROPIC_API_KEY === FAKE_KEY).toBe(true);
	});
});

describe("scrubQuestion", () => {
	it("replaces an email and a user id", () => {
		expect(scrubQuestion("Who is Jane.Doe+x@Gmail.com and u_2b6447a3?")).toBe("Who is [email] and [id]?");
	});

	it("replaces every email and every id pattern: u_, d_, v_ and 32-hex profile ids", () => {
		expect(scrubQuestion("a@b.co c@d.org")).toBe("[email] [email]");
		expect(scrubQuestion("v_8001a480c8 d_aa11bb22 u_9f8e7d6c")).toBe("[id] [id] [id]");
		expect(scrubQuestion(`profile ${pid(11)} please`)).toBe("profile [id] please");
	});

	it("leaves an ordinary question alone", () => {
		expect(scrubQuestion(Q1.question)).toBe(Q1.question);
		expect(scrubQuestion("signup_from and not_opened_days")).toBe("signup_from and not_opened_days");
	});
});

describe("buildModelRequest", () => {
	const body = buildModelRequest("How many people signed up?");

	it("has the fixed settings and a forced tool call", () => {
		expect(body.model).toBe("claude-haiku-5-5");
		expect(body.max_tokens).toBe(512);
		expect(body.temperature).toBe(0);
		expect(body.tool_choice).toEqual({ type: "any" });
		expect(body.messages).toEqual([{ role: "user", content: "How many people signed up?" }]);
	});

	it("defines exactly the six tools", () => {
		expect(body.tools.map((t) => t.name)).toEqual(["count_profiles", "build_segment", "top_pages", "breakdown", "engagement_ranking", "unsupported"]);
		for (const tool of body.tools) expect(tool.input_schema.type).toBe("object");
	});

	it("the system prompt carries TODAY and the shared definitions, and no email or id", () => {
		expect(body.system).toContain("2026-09-28");
		expect(body.system).toContain("2026-08-29");
		expect(body.system).toContain("2026-08-01");
		expect(body.system).toMatch(/cold/i);
		for (const kind of ["subscriber", "app_only", "unknown_app_user"]) expect(body.system).toContain(kind);
		for (const event of ["app_open", "read_story", "link_click", "login"]) expect(body.system).toContain(event);
		expect(() => JSON.stringify(body)).not.toThrow();
		const text = JSON.stringify(body);
		expect(text).not.toMatch(/[^\s@"]+@[^\s@"]+\.[^\s@"]+/);
		expect(text).not.toMatch(/\b[udv]_[A-Za-z0-9]+/);
		expect(text).not.toMatch(/\b[0-9a-f]{32}\b/);
	});
});

describe("sendToModel", () => {
	const modelDeps = (model: { fetch: typeof fetch }) => ({ env, fetch: model.fetch });

	it("throws PiiBlockedError and makes no fetch call when an email is in the system prompt", async () => {
		const model = scriptedModel({ name: "unsupported", input: { reason: "x" } });
		const body = buildModelRequest("hi");
		await expect(sendToModel({ ...body, system: `${body.system} Contact jane.doe@example.com` }, modelDeps(model))).rejects.toBeInstanceOf(PiiBlockedError);
		expect(model.calls).toHaveLength(0);
	});

	it("throws PiiBlockedError and makes no fetch call when an email is in the message", async () => {
		const model = scriptedModel({ name: "unsupported", input: { reason: "x" } });
		const body = buildModelRequest("Is Jane.Doe+x@Gmail.com here?");
		await expect(sendToModel(body, modelDeps(model))).rejects.toBeInstanceOf(PiiBlockedError);
		expect(model.calls).toHaveLength(0);
	});

	it("throws PiiBlockedError for v_, u_, d_ and 32-hex ids, with no fetch call", async () => {
		for (const id of ["v_8001a480c8", "u_2b6447a3", "d_aa11bb22", pid(11)]) {
			const model = scriptedModel({ name: "unsupported", input: { reason: "x" } });
			await expect(sendToModel(buildModelRequest(`what about ${id}`), modelDeps(model))).rejects.toBeInstanceOf(PiiBlockedError);
			await expect(sendToModel({ ...buildModelRequest("ok"), system: `see ${id}` }, modelDeps(model))).rejects.toBeInstanceOf(PiiBlockedError);
			expect(model.calls).toHaveLength(0);
		}
	});

	it("posts to the Messages API with the key, version and JSON headers, and returns the first tool_use", async () => {
		const model = scriptedModel({ name: "count_profiles", input: { filters: {} } });
		const body = buildModelRequest("how many?");
		const plan = await sendToModel(body, modelDeps(model));
		expect(plan).toEqual({ name: "count_profiles", input: { filters: {} } });
		expect(model.calls).toHaveLength(1);
		const [sent] = model.calls;
		expect(sent.url).toBe("https://api.anthropic.com/v1/messages");
		expect(sent.init.method).toBe("POST");
		const headers = new Headers(sent.init.headers);
		// The fake key is compared, not printed.
		expect(headers.get("x-api-key") === FAKE_KEY).toBe(true);
		expect(headers.get("anthropic-version")).toBe("2023-06-01");
		expect(headers.get("content-type")).toBe("application/json");
		expect(sent.body).toBe(JSON.stringify(body));
		// 20 s timeout through an AbortSignal.
		expect(sent.init.signal).toBeInstanceOf(AbortSignal);
	});

	it("takes the first tool_use block and ignores text", async () => {
		const fake = (async () =>
			new Response(
				JSON.stringify({
					content: [
						{ type: "text", text: "hello" },
						{ type: "tool_use", id: "t1", name: "breakdown", input: { by: "source" } },
						{ type: "tool_use", id: "t2", name: "count_profiles", input: {} },
					],
				}),
				{ status: 200 },
			)) as typeof fetch;
		expect(await sendToModel(buildModelRequest("x"), { env, fetch: fake })).toEqual({ name: "breakdown", input: { by: "source" } });
	});

	it("returns null when the reply has no tool_use block", async () => {
		const fake = (async () => new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }] }), { status: 200 })) as typeof fetch;
		expect(await sendToModel(buildModelRequest("x"), { env, fetch: fake })).toBeNull();
	});

	it("throws ModelUnavailableError on a non-2xx reply, a network failure, a timeout and unreadable JSON", async () => {
		const failures: Parameters<typeof scriptedModel>[0][] = [
			{ response: new Response("{}", { status: 500 }) },
			{ response: new Response("{}", { status: 429 }) },
			{ error: new TypeError("network down") },
			{ error: new DOMException("timed out", "TimeoutError") },
			{ response: new Response("not json", { status: 200 }) },
		];
		for (const failure of failures) {
			await expect(sendToModel(buildModelRequest("x"), modelDeps(scriptedModel(failure)))).rejects.toBeInstanceOf(ModelUnavailableError);
		}
	});
});

describe("validatePlan", () => {
	it("fills defaults and normalizes filters", () => {
		expect(validatePlan("count_profiles", {})).toEqual({ ok: true, plan: { tool: "count_profiles", params: { filters: {} } } });
		expect(validatePlan("count_profiles", { filters: { sources: ["Instagram"] } })).toEqual({
			ok: true,
			plan: { tool: "count_profiles", params: { filters: { sources: ["instagram"] } } },
		});
		expect(validatePlan("top_pages", { mode: "all" })).toEqual({ ok: true, plan: { tool: "top_pages", params: { filters: {}, mode: "all", limit: 10 } } });
		expect(validatePlan("engagement_ranking", {})).toEqual({ ok: true, plan: { tool: "engagement_ranking", params: { limit: 50, filters: {} } } });
		expect(validatePlan("breakdown", { by: "cold", filters: { status: "active" } })).toEqual({
			ok: true,
			plan: { tool: "breakdown", params: { by: "cold", filters: { status: "active" } } },
		});
		expect(validatePlan("build_segment", { filters: { not_opened_days: 30 } })).toEqual({
			ok: true,
			plan: { tool: "build_segment", params: { filters: { not_opened_days: 30 } } },
		});
	});

	it("rejects unknown tools, unknown keys, bad filters and out-of-range limits", () => {
		const bad: [unknown, unknown][] = [
			["drop_table", {}],
			[42, {}],
			["count_profiles", { filters: { favorite_color: "red" } }],
			["count_profiles", { filters: { sources: ["myspace"] } }],
			["count_profiles", { filters: { not_opened_days: -1 } }],
			["count_profiles", { filters: {}, extra: 1 }],
			["count_profiles", "text"],
			["count_profiles", null],
			["count_profiles", [1]],
			["top_pages", { filters: {} }],
			["top_pages", { mode: "weekly" }],
			["top_pages", { mode: "all", limit: 21 }],
			["top_pages", { mode: "all", limit: 0 }],
			["top_pages", { mode: "all", limit: 1.5 }],
			["engagement_ranking", { limit: 101 }],
			["engagement_ranking", { limit: -1 }],
			["breakdown", {}],
			["breakdown", { by: "region" }],
			["unsupported", {}],
			["unsupported", { reason: 5 }],
			["unsupported", { reason: "" }],
		];
		for (const [name, input] of bad) expect(validatePlan(name, input), JSON.stringify([name, input])).toEqual({ ok: false });
	});

	it("accepts the limits at their caps and trims an unsupported reason to 300 characters", () => {
		expect(validatePlan("top_pages", { mode: "all", limit: 20 }).ok).toBe(true);
		expect(validatePlan("engagement_ranking", { limit: 100 }).ok).toBe(true);
		const long = validatePlan("unsupported", { reason: "r".repeat(400) });
		expect(long).toEqual({ ok: true, plan: { tool: "unsupported", params: { reason: "r".repeat(300) } } });
	});
});

describe("answer templates", () => {
	it("describes every filter in the order of the filter table", () => {
		const answer = answerFor({
			tool: "count_profiles",
			params: {
				filters: {
					sources: ["instagram", "google"],
					status: "active",
					signup_from: "2026-08-01",
					signup_to: "2026-08-31",
					cold: false,
					not_opened_days: 30,
					kind: ["subscriber", "app_only"],
					has_app: false,
					app_active_days: 7,
					min_site_visits: 2,
				},
			},
			count: 5,
		});
		expect(answer).toBe(
			"5 profiles match: Instagram or Google, active, signed up 2026-08-01 to 2026-08-31, not cold, not opened in 30 days, " +
				"kind subscriber or app_only, without an app account, active in the app in the last 7 days, at least 2 site visits in the last 30 days.",
		);
	});

	it("uses singular and plural, one-sided date ranges, and 'no filters'", () => {
		expect(answerFor({ tool: "count_profiles", params: { filters: { signup_to: "2026-05-01", has_app: true, cold: true } }, count: 1 })).toBe(
			"1 profile matches: signed up on or before 2026-05-01, cold, with an app account.",
		);
		expect(answerFor({ tool: "count_profiles", params: { filters: {} }, count: 0 })).toBe("0 profiles match: no filters.");
	});
});

describe("the brief's three example questions", () => {
	it("Q1 'How many Instagram signups went cold last month?' counts 3 and answers with the template", async () => {
		const { response, json, model } = await ask(Q1.question, Q1.reply);
		expect(response.status).toBe(200);
		expect(model.calls).toHaveLength(1);
		// Cold Instagram signups in August: profiles 1 (open 08-10), 4 (never opened, signup 08-20) and 8 (open 08-28, the boundary).
		expect(json.answer).toBe("3 profiles match: Instagram, signed up 2026-08-01 to 2026-08-31, cold.");
		expect(json.plan).toEqual({
			tool: "count_profiles",
			params: { filters: { sources: ["instagram"], signup_from: "2026-08-01", signup_to: "2026-08-31", cold: true } },
		});
		expect(json.result).toEqual({ tool: "count_profiles", params: json.plan.params, count: 3 });
		expect("chart" in json.result).toBe(false);
		expect("rows" in json.result).toBe(false);
	});

	it("Q2 'most engaged readers' returns the ranked table with emails", async () => {
		const { response, json } = await ask(Q2.question, Q2.reply);
		expect(response.status).toBe(200);
		expect(json.plan).toEqual({ tool: "engagement_ranking", params: { limit: 50, filters: {} } });
		expect(json.answer).toBe("Top 13 of 13 profiles by engagement score, matching no filters.");
		// Scores: 11 = 3 (open 09-22) + 3 visits; 13 = 2+2+1 app; 10 = 3 + 1 visit; 2 = 2 visits; 3 = 1 (open 09-20) + 1 app; 9 = 1 (open 08-29); the rest 0.
		const scores: Record<number, number> = { 11: 6, 13: 5, 10: 4, 2: 2, 3: 2, 9: 1 };
		const order = [11, 13, 10, 2, 3, 9, 1, 4, 5, 6, 7, 8, 12];
		const all = [...SUBS.map((s) => ({ k: s.k, email: s.norm, source: s.source, status: s.status, signup: s.signup, last_open: s.open })), { k: 13, email: APP_ONLY.norm, source: null, status: null, signup: null, last_open: null }];
		const expected = order.map((k) => {
			const s = all.find((a) => a.k === k)!;
			return { profile_id: pid(k), email: s.email, source: s.source, status: s.status, signup: s.signup, last_open: s.last_open, score: scores[k] ?? 0 };
		});
		expect(json.result.rows).toEqual(expected);
		expect(json.result.count).toBe(13);
	});

	it("Q2 with limit 2 returns only the two best", async () => {
		const { json } = await ask(Q2.question, { name: "engagement_ranking", input: { limit: 2 } });
		expect(json.result.rows.map((r: any) => r.profile_id)).toEqual([pid(11), pid(13)]);
		expect(json.result.count).toBe(13);
		expect(json.answer).toBe("Top 2 of 13 profiles by engagement score, matching no filters.");
	});

	it("Q3 'which pages do new subscribers hit first?' returns first-visit pages and a chart", async () => {
		const { response, json } = await ask(Q3.question, Q3.reply);
		expect(response.status).toBe(200);
		expect(json.plan).toEqual({ tool: "top_pages", params: { filters: { signup_from: "2026-08-29" }, mode: "first_visit", limit: 10 } });
		// New subscribers: 2, 10, 11, 12. First visits: 2 -> PAGE_A (08-20, on its second visitor, before signup),
		// 10 -> PAGE_A (08-25), 11 -> PAGE_B (09-11). 12 has no visits.
		expect(json.result.rows).toEqual([
			{ page: PAGE_A, profiles: 2 },
			{ page: PAGE_B, profiles: 1 },
		]);
		expect(json.result.chart).toEqual({ type: "bar", labels: [PAGE_A, PAGE_B], values: [2, 1], title: "First pages visited (profiles)" });
		expect(json.answer).toBe(`Top 2 first pages for profiles matching signed up from 2026-08-29: ${PAGE_A} (2), ${PAGE_B} (1).`);
	});

	it("first_visit picks the earlier visit across two linked visitor_ids, even though it is before signup", async () => {
		// Profile 2 (signup 08-31) has visitor 01 (first visit 09-05, PAGE_B) and visitor 02 (visit 08-20, PAGE_A).
		const { json } = await ask(Q3.question, { name: "top_pages", input: { filters: { signup_from: "2026-08-31", signup_to: "2026-08-31" }, mode: "first_visit" } });
		expect(json.result.rows).toEqual([{ page: PAGE_A, profiles: 1 }]);
	});

	it("top_pages 'all' counts distinct profiles per page, most first, ties by page", async () => {
		const { json } = await ask("pages", { name: "top_pages", input: { filters: { signup_from: "2026-08-29" }, mode: "all", limit: 20 } });
		// PAGE_A: profiles 2, 10, 11 (11 twice, counted once). PAGE_B: 2, 10, 11. PAGE_C: 2.
		expect(json.result.rows).toEqual([
			{ page: PAGE_A, profiles: 3 },
			{ page: PAGE_B, profiles: 3 },
			{ page: PAGE_C, profiles: 1 },
		]);
		expect(json.answer).toBe(`Top 3 pages for profiles matching signed up from 2026-08-29: ${PAGE_A} (3), ${PAGE_B} (3), ${PAGE_C} (1).`);
	});

	it("top_pages limit cuts the list", async () => {
		const { json } = await ask("pages", { name: "top_pages", input: { filters: { signup_from: "2026-08-29" }, mode: "all", limit: 1 } });
		expect(json.result.rows).toEqual([{ page: PAGE_A, profiles: 3 }]);
	});

	it("an empty top_pages result has an empty chart and a plain answer", async () => {
		const { json } = await ask("pages", { name: "top_pages", input: { filters: { sources: ["podcast"] }, mode: "first_visit" } });
		expect(json.result.rows).toEqual([]);
		expect(json.result.chart).toEqual({ type: "bar", labels: [], values: [], title: "First pages visited (profiles)" });
		expect(json.answer).toBe("No pages found for profiles matching Podcast.");
	});

	it("build_segment returns the count, the rows and the by-source chart", async () => {
		const { json } = await ask("list unsubscribed", { name: "build_segment", input: { filters: { status: "unsubscribed" } } });
		expect(json.result.count).toBe(1);
		expect(json.result.rows.map((r: any) => r.profile_id)).toEqual([pid(5)]);
		expect(json.result.chart).toEqual({ type: "bar", labels: ["instagram"], values: [1], title: "Profiles by source" });
		expect(json.answer).toBe("1 profile matches: unsubscribed. Showing the top 1 by engagement score.");
	});

	it("breakdown returns [{group, count}] and its answer", async () => {
		const { json } = await ask("by source", { name: "breakdown", input: { by: "source", filters: { status: "active" } } });
		expect(json.result.rows).toEqual([
			{ group: "instagram", count: 7 },
			{ group: "google", count: 2 },
			{ group: "direct", count: 1 },
			{ group: "x", count: 1 },
		]);
		expect(json.answer).toBe("Breakdown by source for profiles matching active: instagram (7), google (2), direct (1), x (1).");
	});
});

describe("PII never reaches the model", () => {
	const cases = [
		["Q1", Q1.question, Q1.reply],
		["Q2", Q2.question, Q2.reply],
		["Q3", Q3.question, Q3.reply],
		["an email in the question", "Who are the most engaged readers? Not Jane.Doe+x@Gmail.com or u_9f8e7d6c though.", Q2.reply],
	] as const;

	for (const [label, question, reply] of cases) {
		it(`${label}: one call, a body with no email, id, name or result data, and model_request equals it exactly`, async () => {
			const { response, json, model } = await ask(question, reply);
			expect(response.status).toBe(200);
			// Exactly one call: the model never gets a second turn carrying results.
			expect(model.calls).toHaveLength(1);
			const sent = model.calls[0];
			const lower = sent.body.toLowerCase();

			for (const email of ALL_EMAILS) expect(lower.includes(email.trim().toLowerCase()), "an email reached the model").toBe(false);
			for (const id of ALL_IDS) expect(lower.includes(id.toLowerCase()), "an id reached the model").toBe(false);
			for (const name of ALL_NAME_LIKE) expect(lower.includes(name), "a name-like string reached the model").toBe(false);
			expect(sent.body).not.toMatch(/[^\s@"]+@[^\s@"]+\.[^\s@"]+/);
			expect(sent.body).not.toMatch(/\b[0-9a-f]{32}\b/);

			// No result data: not the answer, the rows, the pages, or the count.
			expect(sent.body.includes(json.answer)).toBe(false);
			for (const page of [PAGE_A, PAGE_B, PAGE_C]) expect(sent.body.includes(page)).toBe(false);
			if (json.result.rows) expect(sent.body.includes(JSON.stringify(json.result.rows))).toBe(false);
			expect(sent.body).not.toMatch(/\bcount["']?\s*:\s*\d/);
			expect(sent.body.includes(String(json.result.count) + " profiles")).toBe(false);

			// "What the AI saw" is the exact body that was sent.
			expect(json.model_request).toEqual(JSON.parse(sent.body));
			expect(JSON.stringify(json.model_request)).toBe(sent.body);

			// The key is the fake one.
			expect(new Headers(sent.init.headers).get("x-api-key") === FAKE_KEY).toBe(true);
		});

		it(`${label}: the body is identical on an empty database, so no result data can be in it`, async () => {
			const withData = await ask(question, reply);
			await resetAll();
			const empty = await ask(question, reply);
			expect(empty.response.status).toBe(200);
			expect(empty.model.calls[0].body).toBe(withData.model.calls[0].body);
		});
	}

	it("a question with an email is scrubbed to [email] and [id], and the browser still gets rows with emails", async () => {
		const { json, model } = await ask(cases[3][1], Q2.reply);
		expect(JSON.parse(model.calls[0].body).messages).toEqual([{ role: "user", content: "Who are the most engaged readers? Not [email] or [id] though." }]);
		expect(model.calls).toHaveLength(1);
		expect(json.result.rows[0].email).toBe("jon.kim@example.com");
		expect(json.result.rows.map((r: any) => r.email)).toContain("lena.fox@example.org");
	});

	it("PiiBlockedError gives 422 blocked_pii, makes no fetch call and runs no SQL", async () => {
		const model = scriptedModel(Q1.reply);
		const { env: guarded, touched } = noSqlEnv();
		// A scrubber that misses the email, as a stand-in for a future gap in scrub.ts: the guard in sendToModel is the last line.
		const response = await handleAssistant(askRequest("Is jane.doe@example.com one of them?"), guarded, { fetch: model.fetch, scrub: (q: string) => q });
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({ error: "blocked_pii" });
		expect(model.calls).toHaveLength(0);
		expect(touched).toEqual([]);
	});
});

describe("invalid and unsupported plans run no SQL", () => {
	it("an unknown filter gets 422 unsupported_question", async () => {
		const { env: guarded, touched } = noSqlEnv();
		const { response, json } = await ask("x", { name: "count_profiles", input: { filters: { favorite_color: "red" } } }, guarded);
		expect(response.status).toBe(422);
		expect(json).toEqual({ error: "unsupported_question" });
		expect(touched).toEqual([]);
	});

	it("an unknown tool, an out-of-range limit and a reply with no tool call all get 422 and no SQL", async () => {
		const replies: Parameters<typeof scriptedModel>[0][] = [
			{ name: "drop_table", input: {} },
			{ name: "top_pages", input: { mode: "all", limit: 500 } },
			{ response: new Response(JSON.stringify({ content: [{ type: "text", text: "I think so" }] }), { status: 200 }) },
		];
		for (const reply of replies) {
			const { env: guarded, touched } = noSqlEnv();
			const { response, json } = await ask("x", reply, guarded);
			expect(response.status).toBe(422);
			expect(json).toEqual({ error: "unsupported_question" });
			expect(touched).toEqual([]);
		}
	});

	it("an unsupported plan returns its reason with no SQL", async () => {
		const { env: guarded, touched } = noSqlEnv();
		const reason = "Comparing two periods needs two steps; try the Segments page.";
		const { response, json, model } = await ask("compare cold rates", { name: "unsupported", input: { reason } }, guarded);
		expect(response.status).toBe(200);
		expect(model.calls).toHaveLength(1);
		expect(json.answer).toBe(reason);
		expect(json.plan).toEqual({ tool: "unsupported", params: { reason } });
		expect(json.result).toEqual({ tool: "unsupported", params: { reason } });
		expect(json.model_request).toEqual(JSON.parse(model.calls[0].body));
		expect(touched).toEqual([]);
	});
});

describe("model failures", () => {
	it("an HTTP error, a network failure and a timeout all give 502 assistant_unavailable with no SQL", async () => {
		const failures: Parameters<typeof scriptedModel>[0][] = [
			{ response: new Response("{}", { status: 500 }) },
			{ error: new TypeError("network down") },
			{ error: new DOMException("timed out", "TimeoutError") },
		];
		for (const failure of failures) {
			const { env: guarded, touched } = noSqlEnv();
			const { response, json } = await ask(Q1.question, failure, guarded);
			expect(response.status).toBe(502);
			expect(json).toEqual({ error: "assistant_unavailable" });
			expect(touched).toEqual([]);
		}
	});
});

describe("question validation", () => {
	it("a missing, empty, non-string or over-long question gets 400 and no model call", async () => {
		for (const question of [undefined, "", "   ", 42, null, ["a"], "q".repeat(501)]) {
			const model = scriptedModel(Q1.reply);
			const response = await handleAssistant(askRequest(question), env, deps(model));
			expect(response.status, String(question)).toBe(400);
			expect(await response.json()).toEqual({ error: "invalid_question" });
			expect(model.calls).toHaveLength(0);
		}
	});

	it("a body that is not JSON gets 400", async () => {
		const model = scriptedModel(Q1.reply);
		const request = new Request(BASE + "/api/assistant", { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: "not json" });
		const response = await handleAssistant(request, env, deps(model));
		expect(response.status).toBe(400);
		expect(model.calls).toHaveLength(0);
	});
});

describe("POST /api/assistant through the Worker", () => {
	let cookie = "";
	beforeAll(async () => {
		cookie = await loginCookie("203.0.113.61");
	});

	it("uses the global fetch by default: the whole wiring, with the stubbed model", async () => {
		const model = scriptedModel(Q1.reply);
		vi.stubGlobal("fetch", model.fetch);
		const response = await postJson("/api/assistant", { question: Q1.question }, cookie);
		expect(response.status).toBe(200);
		const json = (await response.json()) as any;
		expect(json.answer).toBe("3 profiles match: Instagram, signed up 2026-08-01 to 2026-08-31, cold.");
		expect(model.calls).toHaveLength(1);
		expect(model.calls[0].url).toBe("https://api.anthropic.com/v1/messages");
		expect(new Headers(model.calls[0].init.headers).get("x-api-key") === FAKE_KEY).toBe(true);
		expect(JSON.stringify(json.model_request)).toBe(model.calls[0].body);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	it("without a session it gets 401 and the model is not called", async () => {
		const model = scriptedModel(Q1.reply);
		vi.stubGlobal("fetch", model.fetch);
		const response = await call("/api/assistant", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: BASE },
			body: JSON.stringify({ question: Q1.question }),
		});
		expect(response.status).toBe(401);
		expect(model.calls).toHaveLength(0);
	});

	it("a foreign Origin gets 403 and a non-JSON content type gets 403, with no model call", async () => {
		const model = scriptedModel(Q1.reply);
		vi.stubGlobal("fetch", model.fetch);
		const foreign = await call(
			"/api/assistant",
			{ method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ question: "x" }) },
			cookie,
		);
		expect(foreign.status).toBe(403);
		const form = await call(
			"/api/assistant",
			{ method: "POST", headers: { "Content-Type": "text/plain", Origin: BASE }, body: JSON.stringify({ question: "x" }) },
			cookie,
		);
		expect(form.status).toBe(403);
		expect(model.calls).toHaveLength(0);
	});

	it("a GET is not found, since only POST is routed", async () => {
		const response = await call("/api/assistant", {}, cookie);
		expect(response.status).toBe(404);
	});

	it("model errors surface as 502 with the security headers", async () => {
		vi.stubGlobal("fetch", scriptedModel({ response: new Response("{}", { status: 503 }) }).fetch);
		const response = await postJson("/api/assistant", { question: Q1.question }, cookie);
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: "assistant_unavailable" });
		expect(response.headers.get("Content-Security-Policy")).not.toBeNull();
	});

	it("an unexpected failure returns the generic 500 with no stack trace and logs only the class", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal("fetch", scriptedModel(Q1.reply).fetch);
		// The session check works; every other statement fails.
		const real = env.tpo_cdp;
		const failing = {
			...env,
			tpo_cdp: new Proxy(real, {
				get(target, prop) {
					if (prop === "prepare") {
						return (sql: string) => {
							if (sql.includes("sessions")) return target.prepare(sql);
							throw new TypeError("boom with secret detail");
						};
					}
					return Reflect.get(target, prop);
				},
			}),
		} as Env;
		const ctxResponse = await worker.fetch(
			new Request(BASE + "/api/assistant", {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: BASE, Cookie: cookie },
				body: JSON.stringify({ question: Q1.question }),
			}),
			failing,
			{ waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
		);
		expect(ctxResponse.status).toBe(500);
		const text = await ctxResponse.text();
		expect(JSON.parse(text)).toEqual({ error: "internal" });
		expect(text).not.toMatch(/boom|TypeError|\.ts:\d+|node_modules/);
		expect(errors).toHaveBeenCalledTimes(1);
		expect(JSON.parse(errors.mock.calls[0][0] as string)).toEqual({ route: "/api/assistant", status: 500, error: "TypeError" });
		// Logs never carry the question.
		expect(String(errors.mock.calls[0][0])).not.toContain("Instagram");
		errors.mockRestore();
	});
});
