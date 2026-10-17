export const CSP =
	"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** Adds the hardening headers to any response. `Cache-Control: no-store` applies to /api/*. */
export function withSecurityHeaders(response: Response, pathname: string): Response {
	const out = new Response(response.body, response);
	out.headers.set("Content-Security-Policy", CSP);
	out.headers.set("X-Content-Type-Options", "nosniff");
	out.headers.set("Referrer-Policy", "no-referrer");
	out.headers.set("Strict-Transport-Security", "max-age=31536000");
	if (pathname.startsWith("/api/")) out.headers.set("Cache-Control", "no-store");
	return out;
}

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}
