import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth/session";
import { csrfCheck } from "../src/http/csrf";
import worker from "../src";
import type { Limiter } from "../src/lib/limiter";

const BASE = "https://cdp.test";
const PASSWORD = "test-ui-password";

async function call(path: string, init: RequestInit = {}, testEnv: Env = env): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(new Request(BASE + path, { redirect: "manual", ...init }), testEnv, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

const loginRequest = (password: string, ip = "198.51.100.1"): RequestInit => ({
	method: "POST",
	headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": ip },
	body: new URLSearchParams({ password }),
});

/** Logs in and returns the cookie pair to send back. */
async function login(ip?: string): Promise<string> {
	const response = await call("/login", loginRequest(PASSWORD, ip));
	expect(response.status).toBe(303);
	return response.headers.get("Set-Cookie")!.split(";")[0];
}

const allowAll: Limiter = { limit: async () => ({ success: true }) };

beforeEach(async () => {
	await env.tpo_cdp.prepare("DELETE FROM sessions").run();
	await env.tpo_cdp.prepare("DELETE FROM import_report").run();
});

afterEach(() => vi.restoreAllMocks());

describe("login and session", () => {
	it("a wrong password gets 401 and no cookie", async () => {
		const response = await call("/login", loginRequest("nope"));
		expect(response.status).toBe(401);
		expect(response.headers.get("Set-Cookie")).toBeNull();
	});

	it("the right password sets a cookie with HttpOnly, Secure, SameSite=Strict and the __Host- prefix", async () => {
		const response = await call("/login", loginRequest(PASSWORD));
		const cookie = response.headers.get("Set-Cookie")!;
		expect(cookie).toMatch(/^__Host-session=[0-9a-f]{64}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=43200$/);
		// Only the SHA-256 of the token is stored.
		const token = cookie.split(";")[0].split("=")[1];
		const row = await env.tpo_cdp
			.prepare("SELECT expires_at, created_at FROM sessions WHERE token_hash = ?")
			.bind(await sha256Hex(token))
			.first<{ expires_at: string; created_at: string }>();
		expect(row).not.toBeNull();
		const hours = (Date.parse(row!.expires_at) - Date.parse(row!.created_at)) / 3_600_000;
		expect(hours).toBe(12);
	});

	it("/api/import-report works with the cookie and returns 401 without it", async () => {
		await env.tpo_cdp
			.prepare("INSERT INTO import_report (run_at, metric, value) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)")
			.bind("2026-10-16T00:00:00Z", "old_metric", 1, "2026-10-17T00:00:00Z", "subscribers_rows_read", 2987, "2026-10-17T00:00:00Z", "subscribers_duplicates_merged", 85)
			.run();
		expect((await call("/api/import-report")).status).toBe(401);
		const cookie = await login();
		const response = await call("/api/import-report", { headers: { Cookie: cookie } });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			run_at: "2026-10-17T00:00:00Z",
			metrics: [
				{ metric: "subscribers_rows_read", value: 2987 },
				{ metric: "subscribers_duplicates_merged", value: 85 },
			],
		});
	});

	it("/ without a session redirects to /login", async () => {
		const response = await call("/");
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/login");
	});

	it("/ with a session serves the home page, and /login and /login.css are public", async () => {
		const cookie = await login();
		const home = await call("/", { headers: { Cookie: cookie } });
		expect(home.status).toBe(200);
		expect(await home.text()).toContain("Last import");
		expect((await call("/login")).status).toBe(200);
		expect((await call("/login.css")).status).toBe(200);
		expect((await call("/home.js")).status).toBe(302);
	});

	it("an expired session gets 401", async () => {
		const token = "e".repeat(64);
		await env.tpo_cdp
			.prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
			.bind(await sha256Hex(token), "2026-10-16T00:00:00Z", "2026-10-16T12:00:00Z")
			.run();
		const response = await call("/api/import-report", { headers: { Cookie: `__Host-session=${token}` } });
		expect(response.status).toBe(401);
	});

	it("expired rows are deleted on each login", async () => {
		await env.tpo_cdp
			.prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
			.bind("stale", "2026-10-16T00:00:00Z", "2026-10-16T12:00:00Z")
			.run();
		await login();
		const rows = await env.tpo_cdp.prepare("SELECT token_hash FROM sessions").all<{ token_hash: string }>();
		expect(rows.results.map((r) => r.token_hash)).not.toContain("stale");
		expect(rows.results).toHaveLength(1);
	});

	it("after logout the old token gets 401", async () => {
		const cookie = await login();
		expect((await call("/api/import-report", { headers: { Cookie: cookie } })).status).toBe(200);
		const out = await call("/logout", { method: "POST", headers: { Cookie: cookie } });
		expect(out.status).toBe(303);
		expect(out.headers.get("Set-Cookie")).toContain("Max-Age=0");
		expect((await call("/api/import-report", { headers: { Cookie: cookie } })).status).toBe(401);
	});

	it("too many logins get 429, using a fake Limiter for LOGIN_LIMITER", async () => {
		const seen: string[] = [];
		const deny: Limiter = {
			limit: async ({ key }) => {
				seen.push(key);
				return { success: false };
			},
		};
		const response = await call("/login", loginRequest(PASSWORD, "203.0.113.9"), { ...env, LOGIN_LIMITER: deny } as Env);
		expect(response.status).toBe(429);
		expect(response.headers.get("Set-Cookie")).toBeNull();
		expect(seen).toEqual(["203.0.113.9"]);
	});

	it("keys the login limiter on 'unknown' when CF-Connecting-IP is missing", async () => {
		const seen: string[] = [];
		const spy: Limiter = {
			limit: async ({ key }) => {
				seen.push(key);
				return { success: true };
			},
		};
		await call("/login", { method: "POST", body: new URLSearchParams({ password: "nope" }) }, { ...env, LOGIN_LIMITER: spy } as Env);
		expect(seen).toEqual(["unknown"]);
	});

	it("fails closed when UI_PASSWORD is missing, even with an empty password", async () => {
		const missing = { ...env, UI_PASSWORD: undefined, LOGIN_LIMITER: allowAll } as unknown as Env;
		const response = await call("/login", loginRequest(""), missing);
		expect(response.status).toBe(401);
		expect(response.headers.get("Set-Cookie")).toBeNull();
		const other = await call("/login", loginRequest("anything"), missing);
		expect(other.headers.get("Set-Cookie")).toBeNull();
	});

	it("fails closed when UI_PASSWORD is empty", async () => {
		const empty = { ...env, UI_PASSWORD: "", LOGIN_LIMITER: allowAll } as unknown as Env;
		const response = await call("/login", loginRequest(""), empty);
		expect(response.status).toBe(401);
		expect(response.headers.get("Set-Cookie")).toBeNull();
	});

	it("an empty password gets 401 against the real configured password", async () => {
		const response = await call("/login", loginRequest(""));
		expect(response.status).toBe(401);
		expect(response.headers.get("Set-Cookie")).toBeNull();
	});

	it("uses dummy secrets for all three secret bindings in tests", () => {
		expect(env.UI_PASSWORD).toBe("test-ui-password");
		expect(env.WEBHOOK_SECRET).toBe("test-webhook-secret");
		expect(env.ANTHROPIC_API_KEY).toBe("test-anthropic-key");
	});

	it("the real LOGIN_LIMITER binding is wired up", async () => {
		const response = await call("/login", loginRequest("nope", "192.0.2.77"));
		expect(response.status).toBe(401);
	});
});

describe("requests and headers", () => {
	it("a state-changing /api request with a foreign Origin gets 403 (CSRF helper)", async () => {
		const bad = new Request(BASE + "/api/segments", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
			body: "{}",
		});
		expect(csrfCheck(bad)?.status).toBe(403);
		const wrongType = new Request(BASE + "/api/segments", {
			method: "POST",
			headers: { "Content-Type": "text/plain", Origin: BASE },
			body: "{}",
		});
		expect(csrfCheck(wrongType)?.status).toBe(403);
		const noOrigin = new Request(BASE + "/api/segments", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		expect(csrfCheck(noOrigin)?.status).toBe(403);
		const good = new Request(BASE + "/api/segments", {
			method: "POST",
			headers: { "Content-Type": "application/json; charset=utf-8", Origin: BASE },
			body: "{}",
		});
		expect(csrfCheck(good)).toBeNull();
		expect(csrfCheck(new Request(BASE + "/api/x"))).toBeNull();
	});

	it("the gate applies the CSRF check to logged-in /api writes", async () => {
		const cookie = await login();
		const response = await call("/api/import-report", {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/json", Origin: "https://evil.example" },
			body: "{}",
		});
		expect(response.status).toBe(403);
	});

	it("A POST to /api/segments with a foreign Origin gets 403", async () => {
		// With a valid session, so the 403 comes from the CSRF gate and not from a missing login.
		const cookie = await login("198.51.100.31");
		for (const path of ["/api/segments", "/api/segments/preview"]) {
			const response = await call(path, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json", Origin: "https://evil.example" },
				body: JSON.stringify({ filters: {} }),
			});
			expect(response.status, path).toBe(403);
			expect(await response.json()).toEqual({ error: "forbidden" });
		}
		// The same request from the page's own origin passes the gate.
		const ok = await call("/api/segments/preview", {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/json", Origin: BASE },
			body: JSON.stringify({ filters: {} }),
		});
		expect(ok.status).toBe(200);
	});

	it("a POST to /api/segments/preview with a missing or wrong Content-Type or Origin gets 403", async () => {
		const cookie = await login("198.51.100.32");
		const body = JSON.stringify({ filters: {} });
		const attempts: Record<string, HeadersInit> = {
			"wrong type": { Cookie: cookie, "Content-Type": "text/plain", Origin: BASE },
			"form type": { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: BASE },
			"no type": { Cookie: cookie, Origin: BASE },
			"no origin": { Cookie: cookie, "Content-Type": "application/json" },
		};
		for (const [name, headers] of Object.entries(attempts)) {
			const response = await call("/api/segments/preview", { method: "POST", headers, body });
			expect(response.status, name).toBe(403);
		}
		// Without a session the answer is 401 before CSRF matters.
		const anonymous = await call("/api/segments/preview", { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body });
		expect(anonymous.status).toBe(401);
	});

	it("the Lookup and Segments pages sit behind the gate and the home page links to them", async () => {
		const cookie = await login("198.51.100.33");
		for (const path of ["/lookup", "/segments"]) {
			const anonymous = await call(path);
			expect(anonymous.status, path).toBe(302);
			expect(anonymous.headers.get("Location"), path).toBe("/login");
			const page = await call(path, { headers: { Cookie: cookie }, redirect: "follow" });
			expect(page.status, path).toBe(200);
		}
		const home = await (await call("/", { headers: { Cookie: cookie } })).text();
		expect(home).toContain('href="/lookup"');
		expect(home).toContain('href="/segments"');
	});

	it("the CSP and nosniff headers are present on HTML and API responses", async () => {
		const cookie = await login();
		const csp =
			"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
		const responses = [
			await call("/login"),
			await call("/"),
			await call("/", { headers: { Cookie: cookie } }),
			await call("/api/import-report"),
			await call("/api/import-report", { headers: { Cookie: cookie } }),
		];
		for (const response of responses) {
			expect(response.headers.get("Content-Security-Policy")).toBe(csp);
			expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
			expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
			expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
		}
		expect(responses[3].headers.get("Cache-Control")).toBe("no-store");
		expect(responses[4].headers.get("Cache-Control")).toBe("no-store");
	});

	it("a 500 response body contains no stack trace", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		// A real failure: with no database binding, creating the session throws inside the handler.
		const broken = { ...env, tpo_cdp: undefined, LOGIN_LIMITER: allowAll } as unknown as Env;
		const response = await call("/login", loginRequest(PASSWORD), broken);
		expect(response.status).toBe(500);
		const text = await response.text();
		expect(JSON.parse(text)).toEqual({ error: "internal" });
		expect(text).not.toMatch(/TypeError|Error:|\bat\b.*\(|\.ts:\d+|node_modules/);
		expect(response.headers.get("Content-Security-Policy")).not.toBeNull();
		// Logs carry route, status and error class only.
		expect(errors).toHaveBeenCalledTimes(1);
		expect(JSON.parse(errors.mock.calls[0][0] as string)).toEqual({ route: "/login", status: 500, error: "TypeError" });
	});
});
