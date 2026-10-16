import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";

describe("smoke", () => {
	it("answers a request with 200", async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(new Request("http://example.com/"), env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("Hello, world!");
	});
});
