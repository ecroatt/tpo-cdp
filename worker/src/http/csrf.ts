import { json } from "./security";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * State-changing /api requests need `Content-Type: application/json` and an
 * `Origin` equal to the request's own origin. Returns a 403 response, or null when the request passes.
 */
export function csrfCheck(request: Request): Response | null {
	if (SAFE_METHODS.has(request.method)) return null;
	const contentType = request.headers.get("Content-Type") ?? "";
	const isJson = /^application\/json\s*(;|$)/i.test(contentType);
	const origin = request.headers.get("Origin");
	if (!isJson || origin === null || origin !== new URL(request.url).origin) {
		return json({ error: "forbidden" }, 403);
	}
	return null;
}
