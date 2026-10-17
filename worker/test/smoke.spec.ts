import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";

describe("smoke", () => {
	it("sends an unauthenticated page request to /login", async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(new Request("http://example.com/", { redirect: "manual" }), env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/login");
	});

	it("has the migrated schema", async () => {
		const row = await env.tpo_cdp
			.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('profiles', 'sessions', 'import_report')")
			.first<{ n: number }>();
		expect(row?.n).toBe(3);
	});
});
