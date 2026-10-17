import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
/** Source without comments, so a comment cannot satisfy or trip a scan. */
const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("webhook source scans", () => {
	it("verify.ts compares signatures with crypto.subtle.timingSafeEqual and never with === on strings", () => {
		const verify = code("src/webhook/verify.ts");
		expect(verify).toContain("crypto.subtle.timingSafeEqual(");
		expect(verify).toContain("X-TPO-Timestamp");
		expect(verify).toContain("X-TPO-Signature");
		expect(verify).not.toMatch(/\bsignature\s*[!=]==?\s/i);
		expect(verify).not.toMatch(/[!=]==?\s*(expected|computed|provided)\w*signature/i);
	});

	it("the simulator signs with the same sign() as the tests and never prints the secret", () => {
		const script = code("scripts/send-events.ts");
		expect(script).toContain('from "../src/webhook/sign"');
		expect(read("test/fixtures/webhook.ts")).toContain('from "../../src/webhook/sign"');
		expect(script).toContain("WEBHOOK_URL");
		expect(script).toContain("WEBHOOK_SECRET");
		for (const line of script.split("\n")) {
			if (/console\.(log|error|warn|info)/.test(line)) expect(line, line).not.toMatch(/\$\{\s*secret\b|[(,+]\s*secret\b/);
		}
		expect(JSON.parse(read("package.json")).scripts["send-events"]).toBe("tsx scripts/send-events.ts");
	});

	it("the handler runs its checks in the SPEC order: 405, rate limit, size, auth, content type, validation, store", () => {
		const handler = code("src/webhook/handler.ts");
		const order = ["405", "limit(", "413", "verifySignature(", "415", "validateEvent(", "storeEvent("].map((marker) => handler.indexOf(marker));
		expect(order.every((i) => i >= 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	it("the webhook route is public and wired", () => {
		const index = code("src/index.ts");
		expect(index).toContain('"/webhooks/app"');
		expect(index).toContain("handleWebhook");
	});

	it("WEBHOOK_LIMITER is 120 per 60 seconds in wrangler.jsonc", () => {
		const config = read("wrangler.jsonc");
		expect(config).toMatch(/"name":\s*"WEBHOOK_LIMITER"[\s\S]*?"limit":\s*120,\s*"period":\s*60/);
	});
});
