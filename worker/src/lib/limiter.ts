/** The slice of the Workers Rate Limiting binding that handlers use, so tests can pass a fake. */
export interface Limiter {
	limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Rate-limit key: the caller's IP, or "unknown" when the header is missing. */
export function clientKey(request: Request): string {
	return request.headers.get("CF-Connecting-IP") ?? "unknown";
}
