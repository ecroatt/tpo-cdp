/** Webhook signing (SPEC section 4): hex HMAC-SHA256 over `timestamp + "." + rawBody`. Shared by the Worker, the tests and the simulator. */

const encoder = new TextEncoder();

export function toHex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The signed message as raw bytes: the ASCII `timestamp.` prefix followed by the body bytes untouched. */
function signedMessage(timestamp: string, body: Uint8Array): Uint8Array {
	const prefix = encoder.encode(`${timestamp}.`);
	const message = new Uint8Array(prefix.length + body.length);
	message.set(prefix, 0);
	message.set(body, prefix.length);
	return message;
}

/** HMAC-SHA256 of `timestamp + "." + body` as raw bytes. The verifier compares these bytes, not hex strings. */
export async function signBytes(secret: string, timestamp: string, body: Uint8Array): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, signedMessage(timestamp, body)));
}

/** The `X-TPO-Signature` value for a request: lowercase hex. */
export async function sign(secret: string, timestamp: string, body: string): Promise<string> {
	return toHex(await signBytes(secret, timestamp, encoder.encode(body)));
}
