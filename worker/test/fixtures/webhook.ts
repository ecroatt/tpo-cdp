// Signed webhook requests for the Worker tests. Signing is real HMAC-SHA256 with the miniflare binding
// WEBHOOK_SECRET ("test-webhook-secret"); nothing about crypto or D1 is mocked.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../src";
import { sign } from "../../src/webhook/sign";

export const WEBHOOK_URL = "https://cdp.test/webhooks/app";
export const SECRET = "test-webhook-secret";

// A random starting point keeps every request's CF-Connecting-IP unique, so the real limiter's shared counters never matter.
let ipCounter = crypto.getRandomValues(new Uint16Array(1))[0] * 4;
export function freshIp(): string {
	ipCounter += 1;
	return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

let eventSeq = 0;
/** A valid app_open event; override any field. A key set to `undefined` is left out of the JSON. */
export function makeEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
	eventSeq += 1;
	return {
		event_id: `evt_${crypto.randomUUID().slice(0, 8)}_${eventSeq}`,
		event: "app_open",
		user_id: null,
		device_id: "d_default",
		timestamp: "2026-09-20T10:00:00Z",
		properties: {},
		...over,
	};
}

export interface PostOptions {
	/** Unix seconds used for X-TPO-Timestamp and the signature. Defaults to the wall clock. */
	timestamp?: number;
	skipTimestamp?: boolean;
	skipSignature?: boolean;
	/** Replaces the computed signature. */
	signature?: string;
	/** Signs this text instead of the body that is sent. */
	signedBody?: string;
	contentType?: string | null;
	/** `null` leaves CF-Connecting-IP off. Default: a unique IP. */
	ip?: string | null;
	method?: string;
	headers?: Record<string, string>;
	env?: Env;
	/** Sends the body as a stream, which has no Content-Length. */
	stream?: boolean;
}

/** POSTs `event` (an object, or raw text) to /webhooks/app, signed unless an option says otherwise. */
export async function postWebhook(event: unknown, options: PostOptions = {}): Promise<Response> {
	const raw = typeof event === "string" ? event : JSON.stringify(event);
	const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
	const headers = new Headers(options.headers);
	if (options.contentType !== null) headers.set("Content-Type", options.contentType ?? "application/json");
	if (options.ip !== null) headers.set("CF-Connecting-IP", options.ip ?? freshIp());
	if (!options.skipTimestamp) headers.set("X-TPO-Timestamp", timestamp);
	if (!options.skipSignature) headers.set("X-TPO-Signature", options.signature ?? (await sign(SECRET, timestamp, options.signedBody ?? raw)));
	const method = options.method ?? "POST";
	let body: BodyInit | undefined;
	if (method === "POST") {
		if (options.stream) {
			const bytes = new TextEncoder().encode(raw);
			body = new ReadableStream({
				start(controller) {
					for (let i = 0; i < bytes.length; i += 1024) controller.enqueue(bytes.slice(i, i + 1024));
					controller.close();
				},
			});
		} else body = raw;
	}
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		new Request(WEBHOOK_URL, { method, headers, body, ...(options.stream ? { duplex: "half" } : {}) } as RequestInit),
		options.env ?? env,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return response;
}

/** Row count of a table, straight from D1. */
export async function countRows(table: "app_events" | "device_links" | "app_users" | "user_links" | "profiles"): Promise<number> {
	const statements = {
		app_events: "SELECT COUNT(*) AS n FROM app_events",
		device_links: "SELECT COUNT(*) AS n FROM device_links",
		app_users: "SELECT COUNT(*) AS n FROM app_users",
		user_links: "SELECT COUNT(*) AS n FROM user_links",
		profiles: "SELECT COUNT(*) AS n FROM profiles",
	};
	return (await env.tpo_cdp.prepare(statements[table]).first<{ n: number }>())!.n;
}
