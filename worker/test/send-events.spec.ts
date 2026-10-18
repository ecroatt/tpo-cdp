// The simulator's scenario (scripts/lib/scenario.ts) run through the real webhook with real signatures.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildScenario, formatResult, PRIMARY_USER, SECOND_USER, NEWCOMER_USER } from "../scripts/lib/scenario";
import { addAppUser, addSubscriber, call, loginCookie, postJson, resetAll } from "./fixtures/cdp";
import { countRows, postWebhook } from "./fixtures/webhook";

let cookie = "";

beforeAll(async () => {
	cookie = await loginCookie("203.0.113.24");
});

beforeEach(async () => {
	await resetAll();
	await addSubscriber({ id: "p_sim_a", email: "sim.a@x.com", source: "instagram", signup: "2026-06-01", open: "2026-08-01" });
	await addSubscriber({ id: "p_sim_b", email: "sim.b@x.com", source: "google", signup: "2026-06-02", open: "2026-08-02" });
	await addAppUser(PRIMARY_USER, "p_sim_a");
	await addAppUser(SECOND_USER, "p_sim_b");
});

async function lookup(q: string): Promise<any> {
	const response = await postJson("/api/lookup", { q }, cookie);
	expect(response.status).toBe(200);
	return response.json();
}

async function runScenario(runId: string) {
	const outcomes: { label: string; status: number; word: string }[] = [];
	for (const step of buildScenario(runId, Date.now())) {
		const response = await postWebhook(step.body);
		const text = await response.text();
		outcomes.push({ label: step.label, status: response.status, word: response.status === 200 ? (JSON.parse(text) as { status: string }).status : "" });
		expect(response.status, step.label).toBe(200);
		expect(JSON.parse(text).status, step.label).toBe(step.expect);
	}
	return outcomes;
}

describe("send-events scenario", () => {
	it("every step gets 200, the resend is a duplicate and everything else is stored", async () => {
		const outcomes = await runScenario("t1");
		expect(outcomes.filter((o) => o.word === "duplicate")).toHaveLength(1);
		expect(outcomes.filter((o) => o.word === "stored").length).toBe(outcomes.length - 1);
		// 11 requests, one of them a duplicate.
		expect(outcomes).toHaveLength(11);
		expect(await countRows("app_events")).toBe(10);
	});

	it("the anonymous-then-login device shows its events in lookup, flagged", async () => {
		await runScenario("t2");
		const a = await lookup(PRIMARY_USER);
		// Two anonymous events before the login, the login, two later events, and the out-of-order anonymous one.
		expect(a.app_activity.total).toBe(6);
		expect(a.app_activity.recent.filter((e: any) => e.attributed_from_device)).toHaveLength(3);
		expect(a.app_activity.recent.filter((e: any) => e.event === "login")).toHaveLength(1);
		// read_story 2 + 2, app_open 1 + 1, login 1, link_click 1.
		expect(a.engagement.breakdown.app).toBe(8);
		// The second user logs in on the same device later: one login, plus the anonymous event after it.
		const b = await lookup(SECOND_USER);
		expect(b.app_activity.total).toBe(2);
		expect(b.app_activity.recent.filter((e: any) => e.attributed_from_device)).toHaveLength(1);
	});

	it("the unknown user gets one unknown_app_user profile", async () => {
		await runScenario("t3");
		const body = await lookup(NEWCOMER_USER);
		expect(body.kind).toBe("unknown_app_user");
		expect(body.app_activity.total).toBe(2);
		expect(await countRows("profiles")).toBe(3);
	});

	it("can be run again with a new run id: only the resend is a duplicate", async () => {
		await runScenario("first");
		const again = await runScenario("second");
		expect(again.filter((o) => o.word === "duplicate")).toHaveLength(1);
		expect(await countRows("app_events")).toBe(20);
		expect(await countRows("profiles")).toBe(3);
	});

	it("keeps every event time at or before now, so no step is a future timestamp", () => {
		const now = Date.parse("2026-10-17T12:00:00Z");
		for (const step of buildScenario("t5", now)) {
			expect(Date.parse(step.body.timestamp as string), step.label).toBeLessThanOrEqual(now);
		}
	});

	it("prints a label and a status code only, with no email", () => {
		const steps = buildScenario("t6", Date.now());
		expect(formatResult(steps[0].label, 200, '{"status":"stored"}')).toBe(`${steps[0].label}: 200 stored`);
		expect(formatResult("bad", 401, "")).toBe("bad: 401");
		expect(formatResult("weird", 200, "not json")).toBe("weird: 200");
		for (const step of steps) expect(step.label).not.toContain("@");
		expect(new Set(steps.map((s) => s.label)).size).toBe(steps.length);
	});
});
