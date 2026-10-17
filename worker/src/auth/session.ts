import { nowIso } from "../lib/timestamps";

export const COOKIE_NAME = "__Host-session";
export const SESSION_SECONDS = 12 * 60 * 60;

const COOKIE_FLAGS = "HttpOnly; Secure; SameSite=Strict; Path=/";

const toHex = (buf: ArrayBuffer): string =>
	[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(value: string): Promise<string> {
	return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/**
 * Constant-time password check: HMAC both values with a per-request random key,
 * then compare the fixed-length digests with timingSafeEqual.
 */
export async function passwordMatches(candidate: string, expected: unknown): Promise<boolean> {
	// Fail closed: a missing or empty configured password, or an empty attempt, never matches.
	if (typeof expected !== "string" || expected === "" || candidate === "") return false;
	const key = await crypto.subtle.importKey(
		"raw",
		crypto.getRandomValues(new Uint8Array(32)),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const enc = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.sign("HMAC", key, enc.encode(candidate)),
		crypto.subtle.sign("HMAC", key, enc.encode(expected)),
	]);
	return crypto.subtle.timingSafeEqual(a, b);
}

export function readToken(request: Request): string | null {
	const header = request.headers.get("Cookie");
	if (!header) return null;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() === COOKIE_NAME) return part.slice(eq + 1).trim();
	}
	return null;
}

export async function hasValidSession(db: D1Database, request: Request): Promise<boolean> {
	const token = readToken(request);
	if (!token) return false;
	const row = await db
		.prepare("SELECT 1 AS ok FROM sessions WHERE token_hash = ? AND expires_at > ?")
		.bind(await sha256Hex(token), nowIso())
		.first();
	return row !== null;
}

/** Creates a session, deletes expired ones, and returns the Set-Cookie value. */
export async function createSession(db: D1Database): Promise<string> {
	const token = toHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
	const now = new Date();
	const expires = new Date(now.getTime() + SESSION_SECONDS * 1000);
	await db.batch([
		db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(nowIso(now)),
		db
			.prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
			.bind(await sha256Hex(token), nowIso(now), nowIso(expires)),
	]);
	return `${COOKIE_NAME}=${token}; ${COOKIE_FLAGS}; Max-Age=${SESSION_SECONDS}`;
}

export async function destroySession(db: D1Database, request: Request): Promise<string> {
	const token = readToken(request);
	if (token) {
		await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
	}
	return `${COOKIE_NAME}=; ${COOKIE_FLAGS}; Max-Age=0`;
}
