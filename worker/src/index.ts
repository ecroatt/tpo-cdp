import { handleLogin, handleLogout } from "./auth/login";
import { hasValidSession } from "./auth/session";
import { csrfCheck } from "./http/csrf";
import { declaredTooLarge, readCapped } from "./lib/body";
import { json, withSecurityHeaders } from "./http/security";
import { handleAssistant } from "./routes/assistant";
import { handleImportReport } from "./routes/import-report";
import { handleLookup } from "./routes/lookup";
import { handlePreview } from "./routes/segments";
import { handleWebhook } from "./webhook/handler";

/** Largest accepted body of a JSON /api POST: 8 KB. */
const MAX_API_BODY_BYTES = 8 * 1024;

/** Reachable without a session. Everything else goes through the gate. */
const PUBLIC_PATHS = new Set(["/login", "/login.css", "/webhooks/app"]);

async function route(request: Request, env: Env, url: URL): Promise<Response> {
	const path = url.pathname;

	if (path === "/login") return handleLogin(request, env);

	if (!PUBLIC_PATHS.has(path)) {
		if (!(await hasValidSession(env.tpo_cdp, request))) {
			if (path.startsWith("/api/")) return json({ error: "unauthorized" }, 401);
			return new Response(null, { status: 302, headers: { Location: "/login" } });
		}
		if (path.startsWith("/api/")) {
			const blocked = csrfCheck(request);
			if (blocked) return blocked;
			if (request.method !== "GET" && request.method !== "HEAD") {
				// Size first, from Content-Length and while reading, before any handler parses the body.
				const tooLarge = json({ error: "payload_too_large" }, 413);
				if (declaredTooLarge(request, MAX_API_BODY_BYTES)) return tooLarge;
				const bytes = await readCapped(request, MAX_API_BODY_BYTES);
				if (bytes === null) return tooLarge;
				request = new Request(request.url, { method: request.method, headers: request.headers, body: bytes });
			}
		}
	}

	if (path === "/webhooks/app") return handleWebhook(request, env);
	if (path === "/logout") return handleLogout(request, env);
	if (path === "/api/import-report" && request.method === "GET") return handleImportReport(env);
	if (path === "/api/lookup" && request.method === "POST") return handleLookup(request, env);
	if (path === "/api/segments/preview" && request.method === "POST") return handlePreview(request, env);
	if (path === "/api/assistant" && request.method === "POST") return handleAssistant(request, env);
	if (path.startsWith("/api/")) return json({ error: "not_found" }, 404);

	return env.ASSETS.fetch(request);
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		let response: Response;
		try {
			response = await route(request, env, url);
		} catch (err) {
			// Route, status and error class only: never messages, bodies, emails or stack traces.
			console.error(JSON.stringify({ route: url.pathname, status: 500, error: err instanceof Error ? err.name : "unknown" }));
			response = json({ error: "internal" }, 500);
		}
		return withSecurityHeaders(response, url.pathname);
	},
} satisfies ExportedHandler<Env>;
