import { json } from "../http/security";
import { clientKey, type Limiter } from "../lib/limiter";
import { nowIso } from "../lib/timestamps";
import { storeEvent } from "./store";
import { validateEvent } from "./validate";
import { verifySignature } from "./verify";

/** Largest accepted request body: 16 KB. */
export const MAX_BODY_BYTES = 16 * 1024;

/**
 * Reads the body, giving up as soon as more than `limit` bytes have arrived (a body with no Content-Length, or a
 * false one). Returns null when it is too large; the unread rest of the stream is cancelled.
 */
async function readCapped(request: Request, limit: number): Promise<Uint8Array | null> {
	if (request.body === null) return new Uint8Array(0);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

function isJsonContentType(request: Request): boolean {
	const mediaType = (request.headers.get("Content-Type") ?? "").split(";")[0];
	return mediaType.trim().toLowerCase() === "application/json";
}

function parseBody(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return undefined;
	}
}

/**
 * POST /webhooks/app (SPEC section 4), checks in this order: 405, rate limit (429), size (413), signature (bare 401),
 * content type (415), validation (400), then one batched write and a 200 with "stored" or "duplicate".
 */
export async function handleWebhook(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") {
		return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
	}

	const limiter = env.WEBHOOK_LIMITER as Limiter;
	if (!(await limiter.limit({ key: clientKey(request) })).success) {
		return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
	}

	const header = request.headers.get("Content-Length");
	if (header !== null && Number(header) > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
	const body = await readCapped(request, MAX_BODY_BYTES);
	if (body === null) return json({ error: "payload_too_large" }, 413);

	if (!(await verifySignature(request.headers, body, env.WEBHOOK_SECRET))) {
		return new Response(null, { status: 401 });
	}

	if (!isJsonContentType(request)) return json({ error: "unsupported_media_type" }, 415);

	const event = validateEvent(parseBody(body), Date.now());
	if (event === null) return json({ error: "invalid_event" }, 400);

	return json({ status: await storeEvent(env.tpo_cdp, event, nowIso()) });
}
