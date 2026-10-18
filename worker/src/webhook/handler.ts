import { json } from "../http/security";
import { readCapped } from "../lib/body";
import { clientKey, type Limiter } from "../lib/limiter";
import { nowIso } from "../lib/timestamps";
import { storeEvent } from "./store";
import { validateEvent } from "./validate";
import { verifySignature } from "./verify";

/** Largest accepted request body: 16 KB. */
export const MAX_BODY_BYTES = 16 * 1024;

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
