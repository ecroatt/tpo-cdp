import { signBytes } from "./sign";

/** The timestamp may be this many seconds from the wall clock, in either direction. */
export const MAX_SKEW_SECONDS = 300;

const SECONDS = /^\d{1,12}$/;
const HEX_DIGEST = /^[0-9a-fA-F]{64}$/;

function fromHex(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

/**
 * Checks `X-TPO-Timestamp` and `X-TPO-Signature` against the raw request bytes (before any JSON parsing).
 * False when a header is missing, the timestamp is more than 300 s from `nowMs` either way, the signature is not a
 * 64-digit hex digest, or the HMAC differs. The comparison is crypto.subtle.timingSafeEqual on two 32-byte buffers.
 * The wall clock is used here only, for signature freshness.
 */
export async function verifySignature(headers: Headers, rawBody: Uint8Array, secret: string | undefined, nowMs: number = Date.now()): Promise<boolean> {
	const timestamp = headers.get("X-TPO-Timestamp");
	const provided = headers.get("X-TPO-Signature");
	if (timestamp === null || provided === null || !secret) return false;
	if (!SECONDS.test(timestamp) || !HEX_DIGEST.test(provided)) return false;
	if (Math.abs(nowMs / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
	const expected = await signBytes(secret, timestamp, rawBody);
	const given = fromHex(provided);
	if (expected.byteLength !== given.byteLength) return false;
	return crypto.subtle.timingSafeEqual(expected, given);
}
