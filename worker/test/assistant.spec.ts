import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { buildModelRequest } from "../src/assistant/prompt";
import { ModelUnavailableError, PiiBlockedError, sendToModel } from "../src/assistant/model";
import { normalizeEmail } from "../src/lib/email";
import { scrubQuestion } from "../src/assistant/scrub";
import { answerFor } from "../src/assistant/templates";
import { SITE_PAGES, validatePlan } from "../src/assistant/tools";
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
	PAGE_D,
	LOOKALIKE_ABOUT,
	LOOKALIKE_SUBSCRIBE,
	PAGE_F,
	pid,
	PICKS,
	Q1,
	Q1_FILTERS,
	Q2,
	Q3,
	scriptedModel,
	seedAssistantData,
	SITE_ONLY_FILTERS,
	SUBS,
} from "./fixtures/assistant";
import { call, loginCookie, postJson, resetAll } from "./fixtures/cdp";

/** The sentence that ends a top_pages answer when site pages are left out, built from the one constant. */
const LEAVES_OUT = ` Leaves out site pages: ${SITE_PAGES.join(", ")}.`;
const Q1_DESC = "Instagram, signed up 2026-08-01 to 2026-08-31, cold";

/** Ways to write an email so a plain pattern misses it. Each must be blocked, never sent to the model. */
const DISGUISED_EMAILS: [string, string][] = [
	["spaces around @", "jane @ gmail.com"],
	["spelled out", "jane at gmail dot com"],
	["(at) and (dot)", "jane(at)gmail(dot)com"],
	["[at] and [dot]", "jane[at]gmail[dot]com"],
	["percent-encoded @", "jane%40gmail.com"],
	["html entity @", "jane&#64;gmail.com"],
	["literal backslash-u0040", "jane\u0040gmail.com"],
	["a typed email", "jane@gmail.com"],
	["zero-width characters", "ja​ne@gmail.com"],
	["fullwidth @", "jane＠gmail.com"],
];

const deps = (model: { fetch: typeof fetch }) => ({ fetch: model.fetch });

async function ask(question: unknown, reply: Parameters<typeof scriptedModel>[0], testEnv: Env = env) {
	const model = scriptedModel(reply);
	const response = await handleAssistant(askRequest(question), testEnv, deps(model));
	return { model, response, json: (await response.json()) as any };
}

beforeEach(seedAssistantData);
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

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

	it("replaces ids that carry _ or - after the prefix, and ids glued to a word with an underscore", () => {
		expect(scrubQuestion("is d_sim_abc_phone active?")).toBe("is [id] active?");
		expect(scrubQuestion("is u_ab-cd_12 active?")).toBe("is [id] active?");
		expect(scrubQuestion("see x_u_2b6447a3 now")).toBe("see x_[id] now");
	});

	it("replaces a fullwidth @ email after NFKC, and an email with zero-width characters inside", () => {
		expect(scrubQuestion("who is jane＠gmail.com?")).toBe("who is [email]?");
		for (const zw of ["​", "‌", "‍", "⁠", "﻿"]) {
			expect(scrubQuestion(`who is ja${zw}ne@gmail.com?`), JSON.stringify(zw)).toBe("who is [email]?");
		}
	});

	it("keeps scrubbing the same text the same way on every call (no regex state)", () => {
		for (let i = 0; i < 4; i++) {
			expect(scrubQuestion("a@b.co and u_2b6447a3")).toBe("[email] and [id]");
		}
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
		expect("temperature" in body).toBe(false);
		expect("top_p" in body).toBe(false);
		expect("top_k" in body).toBe(false);
		expect(body.tool_choice).toEqual({ type: "any" });
		expect(body.messages).toEqual([{ role: "user", content: "How many people signed up?" }]);
	});

	it("defines exactly the six tools", () => {
		expect(body.tools.map((t) => t.name)).toEqual(["count_profiles", "build_segment", "top_pages", "breakdown", "engagement_ranking", "unsupported"]);
		for (const tool of body.tools) expect(tool.input_schema.type).toBe("object");
	});

	it("the top_pages schema has include_site_pages as a boolean, and the system prompt names it", () => {
		const topPages = body.tools.find((t) => t.name === "top_pages")!;
		expect((topPages.input_schema.properties.include_site_pages as { type: string }).type).toBe("boolean");
		expect(topPages.input_schema.required).toEqual(["mode"]);
		expect(body.system).toContain("include_site_pages");
	});

	it("tells the model to set include_site_pages true only when the question asks about the home, subscribe or about pages", () => {
		const topPages = body.tools.find((t) => t.name === "top_pages")!;
		const prop = topPages.input_schema.properties.include_site_pages as { type: string; description: string };
		const rule = /true only when the question asks about the home, subscribe or about pages/;
		const line = body.system.split("\n").find((l) => l.includes("include_site_pages"));
		expect(line).toBeDefined();
		expect(line).toMatch(rule);
		expect(prop.type).toBe("boolean");
		expect(prop.description).toMatch(rule);
		for (const text of [line!, prop.description]) {
			expect(text).not.toMatch(/\balways\b/i);
			expect(text).toMatch(/\bonly\b/);
		}
	});

	it("never calls a content page a site page, and the include_site_pages wording names exactly SITE_PAGES", () => {
		for (const line of body.system.split("\n")) {
			if (/site pages?\b/i.test(line)) {
				for (const page of ["/beliefs", "/our-staff", "/shadrachs-picks"]) expect(line.includes(page), line).toBe(false);
			}
		}
		const named = /Site pages are exactly: (.*?) \(/.exec(body.system);
		expect(named).not.toBeNull();
		expect(named![1].split(", ")).toEqual(SITE_PAGES);
		expect(body.system).toContain("Pages on the site: ");
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

	it("throws PiiBlockedError, with no fetch call, for every disguised email form in the body", async () => {
		for (const [label, text] of DISGUISED_EMAILS) {
			const model = scriptedModel({ name: "unsupported", input: { reason: "x" } });
			await expect(sendToModel(buildModelRequest(`is ${text} one of them?`), modelDeps(model)), label).rejects.toBeInstanceOf(PiiBlockedError);
			await expect(sendToModel({ ...buildModelRequest("ok"), system: `see ${text}` }, modelDeps(model)), label).rejects.toBeInstanceOf(PiiBlockedError);
			expect(model.calls, label).toHaveLength(0);
		}
	});

	it("throws PiiBlockedError for an id glued to a word or with underscores", async () => {
		for (const id of ["d_sim_abc_phone", "x_u_2b6447a3"]) {
			const model = scriptedModel({ name: "unsupported", input: { reason: "x" } });
			await expect(sendToModel(buildModelRequest(`what about ${id}`), modelDeps(model))).rejects.toBeInstanceOf(PiiBlockedError);
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
		expect(validatePlan("top_pages", { mode: "all" })).toEqual({ ok: true, plan: { tool: "top_pages", params: { filters: {}, mode: "all", limit: 10, include_site_pages: false } } });
		expect(validatePlan("top_pages", { mode: "all", include_site_pages: true })).toEqual({
			ok: true,
			plan: { tool: "top_pages", params: { filters: {}, mode: "all", limit: 10, include_site_pages: true } },
		});
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
			["top_pages", { mode: "all", include_site_pages: "yes" }],
			["top_pages", { mode: "all", include_site_pages: 1 }],
			["top_pages", { mode: "all", include_site_pages: null }],
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
		expect(json.plan).toEqual({ tool: "top_pages", params: { filters: { signup_from: "2026-08-29" }, mode: "first_visit", limit: 10, include_site_pages: false } });
		// New subscribers: 2, 10, 11, 12. First visits: 2 -> PAGE_A (08-20, on its second visitor, before signup),
		// 10 -> PAGE_A (08-25), 11 -> PAGE_B (09-11). 12 has no visits.
		expect(json.result.rows).toEqual([
			{ page: PAGE_A, profiles: 2 },
			{ page: PAGE_B, profiles: 1 },
		]);
		expect(json.result.chart).toEqual({ type: "bar", labels: [PAGE_A, PAGE_B], values: [2, 1], title: "First pages visited (profiles)" });
		expect(json.answer).toBe(`Top 2 first pages for profiles matching signed up from 2026-08-29: ${PAGE_A} (2), ${PAGE_B} (1).${LEAVES_OUT}`);
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
		expect(json.answer).toBe(`Top 3 pages for profiles matching signed up from 2026-08-29: ${PAGE_A} (3), ${PAGE_B} (3), ${PAGE_C} (1).${LEAVES_OUT}`);
	});

	it("top_pages limit cuts the list", async () => {
		const { json } = await ask("pages", { name: "top_pages", input: { filters: { signup_from: "2026-08-29" }, mode: "all", limit: 1 } });
		expect(json.result.rows).toEqual([{ page: PAGE_A, profiles: 3 }]);
	});

	it("an empty top_pages result has an empty chart and a plain answer", async () => {
		const { json } = await ask("pages", { name: "top_pages", input: { filters: { sources: ["podcast"] }, mode: "first_visit" } });
		expect(json.result.rows).toEqual([]);
		expect(json.result.chart).toEqual({ type: "bar", labels: [], values: [], title: "First pages visited (profiles)" });
		expect(json.answer).toBe("No pages found for profiles matching Podcast." + LEAVES_OUT);
	});

	it("an empty top_pages result with include_site_pages true has no 'Leaves out' sentence", async () => {
		const { json } = await ask("pages", { name: "top_pages", input: { filters: { sources: ["podcast"] }, mode: "first_visit", include_site_pages: true } });
		expect(json.result.rows).toEqual([]);
		expect(json.answer).toBe("No pages found for profiles matching Podcast.");
	});

	it("top_pages with the Q1 filters leaves out site pages in both modes and still counts /shadrachs-picks", async () => {
		// Q1 profiles are 1, 4 and 8. Visits (site pages are /, /subscribe, /about): 1 -> / 06-15, /about 06-16, PAGE_D 07-01, PICKS 08-10;
		// 4 -> / 08-20, PICKS 08-21, / 08-23, /subscribe 08-24, /about-us 08-26, /subscribe/thanks 08-27;
		// 8 -> /subscribe 08-18, PAGE_F 08-19, PICKS 08-25, /about-us 08-26. /about-us and /subscribe/thanks are content pages
		// that merely start like a site page: they must be counted.
		const all = await ask("pages", { name: "top_pages", input: { filters: Q1_FILTERS, mode: "all" } });
		expect(all.json.plan.params).toEqual({ filters: Q1_FILTERS, mode: "all", limit: 10, include_site_pages: false });
		// All three visited PICKS; /about-us profiles 4 and 8; PAGE_D only profile 1, PAGE_F only profile 8,
		// /subscribe/thanks only profile 4. Ties by page.
		expect(all.json.result.rows).toEqual([
			{ page: PICKS, profiles: 3 },
			{ page: LOOKALIKE_ABOUT, profiles: 2 },
			{ page: PAGE_D, profiles: 1 },
			{ page: PAGE_F, profiles: 1 },
			{ page: LOOKALIKE_SUBSCRIBE, profiles: 1 },
		]);
		expect(all.json.answer).toBe(
			`Top 5 pages for profiles matching ${Q1_DESC}: ${PICKS} (3), ${LOOKALIKE_ABOUT} (2), ${PAGE_D} (1), ${PAGE_F} (1), ${LOOKALIKE_SUBSCRIBE} (1).${LEAVES_OUT}`,
		);

		// First content page: profile 1 -> PAGE_D (07-01), profile 4 -> PICKS (08-21), profile 8 -> PAGE_F (08-19).
		const first = await ask("pages", { name: "top_pages", input: { filters: Q1_FILTERS, mode: "first_visit" } });
		expect(first.json.result.rows).toEqual([
			{ page: PAGE_D, profiles: 1 },
			{ page: PAGE_F, profiles: 1 },
			{ page: PICKS, profiles: 1 },
		]);
		expect(first.json.result.chart.labels).toEqual([PAGE_D, PAGE_F, PICKS]);
		expect(first.json.answer).toBe(
			`Top 3 first pages for profiles matching ${Q1_DESC}: ${PAGE_D} (1), ${PAGE_F} (1), ${PICKS} (1).${LEAVES_OUT}`,
		);
		for (const row of [...all.json.result.rows, ...first.json.result.rows]) expect(SITE_PAGES).not.toContain(row.page);
	});

	it("top_pages with include_site_pages true brings the site pages back, with no 'Leaves out' sentence", async () => {
		const all = await ask("pages", { name: "top_pages", input: { filters: Q1_FILTERS, mode: "all", include_site_pages: true } });
		expect(all.json.plan.params.include_site_pages).toBe(true);
		// "/": profiles 1 and 4 (4 twice, counted once). /subscribe: 4 and 8. /about: 1. PICKS: 1, 4, 8. /about-us: 4, 8.
		// Ties by page, so "/" < "/about-us" < "/subscribe" at 2, and "/about" < PAGE_D < PAGE_F < "/subscribe/thanks" at 1.
		expect(all.json.result.rows).toEqual([
			{ page: PICKS, profiles: 3 },
			{ page: "/", profiles: 2 },
			{ page: LOOKALIKE_ABOUT, profiles: 2 },
			{ page: "/subscribe", profiles: 2 },
			{ page: "/about", profiles: 1 },
			{ page: PAGE_D, profiles: 1 },
			{ page: PAGE_F, profiles: 1 },
			{ page: LOOKALIKE_SUBSCRIBE, profiles: 1 },
		]);
		expect(all.json.answer).toBe(
			`Top 8 pages for profiles matching ${Q1_DESC}: ${PICKS} (3), / (2), ${LOOKALIKE_ABOUT} (2), /subscribe (2), /about (1), ${PAGE_D} (1), ${PAGE_F} (1), ${LOOKALIKE_SUBSCRIBE} (1).`,
		);
		expect(all.json.answer).not.toContain("Leaves out");

		// Earliest visit: profile 1 -> / (06-15), profile 4 -> / (08-20), profile 8 -> /subscribe (08-18).
		const first = await ask("pages", { name: "top_pages", input: { filters: Q1_FILTERS, mode: "first_visit", include_site_pages: true } });
		expect(first.json.result.rows).toEqual([
			{ page: "/", profiles: 2 },
			{ page: "/subscribe", profiles: 1 },
		]);
		expect(first.json.answer).toBe(`Top 2 first pages for profiles matching ${Q1_DESC}: / (2), /subscribe (1).`);
	});

	it("a profile with only site-page visits is left out of first_visit by default and counted with include_site_pages true", async () => {
		const desc = "Instagram, signed up on or before 2026-07-31";
		// Profile 7 is the only match: visits / (08-05) and /about (08-06), nothing else.
		const hidden = await ask("pages", { name: "top_pages", input: { filters: SITE_ONLY_FILTERS, mode: "first_visit" } });
		expect(hidden.json.result.rows).toEqual([]);
		expect(hidden.json.answer).toBe(`No pages found for profiles matching ${desc}.${LEAVES_OUT}`);
		const shown = await ask("pages", { name: "top_pages", input: { filters: SITE_ONLY_FILTERS, mode: "first_visit", include_site_pages: true } });
		expect(shown.json.result.rows).toEqual([{ page: "/", profiles: 1 }]);
		expect(shown.json.answer).toBe(`Top 1 first pages for profiles matching ${desc}: / (1).`);
		const all = await ask("pages", { name: "top_pages", input: { filters: SITE_ONLY_FILTERS, mode: "all", include_site_pages: true } });
		expect(all.json.result.rows).toEqual([
			{ page: "/", profiles: 1 },
			{ page: "/about", profiles: 1 },
		]);
	});

	it("SITE_PAGES is exactly the home, subscribe and about pages", () => {
		expect(SITE_PAGES).toEqual(["/", "/subscribe", "/about"]);
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

			for (const email of ALL_EMAILS) {
				expect(sent.body.includes(email), "a raw email reached the model").toBe(false);
				const normalized = normalizeEmail(email);
				if (normalized !== null) expect(lower.includes(normalized), "an email reached the model").toBe(false);
			}
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

describe("disguised emails are blocked, not sent", () => {
	it("each evasive form gets 422 blocked_pii through the route, with no fetch call and no SQL", async () => {
		for (const [label, text] of DISGUISED_EMAILS.filter(([l]) => !["a typed email", "zero-width characters", "fullwidth @"].includes(l))) {
			const model = scriptedModel(Q1.reply);
			const { env: guarded, touched } = noSqlEnv();
			const response = await handleAssistant(askRequest(`is ${text} one of them?`), guarded, { fetch: model.fetch });
			expect(response.status, label).toBe(422);
			expect(await response.json(), label).toEqual({ error: "blocked_pii" });
			expect(model.calls, label).toHaveLength(0);
			expect(touched, label).toEqual([]);
		}
	});

	it("with a scrubber that misses them, all of them are still blocked by the guard in sendToModel (422, no fetch)", async () => {
		for (const [label, text] of DISGUISED_EMAILS) {
			const model = scriptedModel(Q1.reply);
			const response = await handleAssistant(askRequest(`is ${text} one of them?`), env, { fetch: model.fetch, scrub: (q: string) => q });
			expect(response.status, label).toBe(422);
			expect(await response.json(), label).toEqual({ error: "blocked_pii" });
			expect(model.calls, label).toHaveLength(0);
		}
	});

	it("a zero-width or fullwidth email that scrubs cleanly is replaced, and the question goes on with one fetch call", async () => {
		for (const text of ["ja​ne@gmail.com", "jane＠gmail.com"]) {
			const { model, response } = await ask(`is ${text} one of them?`, Q1.reply);
			expect(response.status).toBe(200);
			expect(model.calls).toHaveLength(1);
			expect(model.calls[0].body).not.toMatch(/jane|gmail/i);
		}
	});

	it("ordinary questions with 'at' or a handle-free sentence are not blocked", async () => {
		for (const q of ["How many signed up at the start of the month?", "Which pages do people look at first?", Q1.question]) {
			const { model, response } = await ask(q, Q1.reply);
			expect(response.status, q).toBe(200);
			expect(model.calls, q).toHaveLength(1);
		}
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

	it("a 400 from the model gives 502 and logs only the status and error type, never the key or the question", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const apiMessage = "DISTINCTIVE-API-MESSAGE-7f3a";
		const rawText = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: apiMessage } });
		const model = scriptedModel({ response: new Response(rawText, { status: 400 }) });
		vi.stubGlobal("fetch", model.fetch);
		const response = await postJson("/api/assistant", { question: Q1.question }, cookie);
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: "assistant_unavailable" });
		const logged = errors.mock.calls.map((args) => args.map((a) => String(a)).join(" "));
		expect(logged.some((line) => line.includes("400") && line.includes("invalid_request_error"))).toBe(true);
		const everything = JSON.stringify(errors.mock.calls) + logged.join("\n");
		const sent = model.calls[0].body;
		const system = JSON.stringify((JSON.parse(sent) as { system: unknown }).system);
		for (const secret of [FAKE_KEY, Q1.question, apiMessage, rawText, sent, system]) {
			expect(everything.includes(secret)).toBe(false);
		}
	});

	it("a network failure and a timeout log only the error name, never its message, the key or the question", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const cases: [Error, string, string][] = [
			[new TypeError("network down MSG-1c9d"), "TypeError", "MSG-1c9d"],
			[new DOMException("timed out MSG-8e2b", "TimeoutError"), "TimeoutError", "MSG-8e2b"],
		];
		for (const [error, name, message] of cases) {
			errors.mockClear();
			vi.stubGlobal("fetch", scriptedModel({ error }).fetch);
			const response = await postJson("/api/assistant", { question: Q1.question }, cookie);
			expect(response.status).toBe(502);
			const everything = JSON.stringify(errors.mock.calls) + errors.mock.calls.map((a) => a.map(String).join(" ")).join("\n");
			expect(everything).toContain(name);
			for (const secret of [message, "network down", "timed out", FAKE_KEY, Q1.question]) {
				expect(everything.includes(secret)).toBe(false);
			}
		}
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
	});
});
