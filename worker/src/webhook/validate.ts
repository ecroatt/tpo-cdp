import { nowIso } from "../lib/timestamps";

export const EVENT_TYPES = ["app_open", "read_story", "link_click", "login"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** A validated webhook event, ready to store. `ts` is UTC `YYYY-MM-DDTHH:MM:SSZ` and `properties` is JSON text. */
export interface AppEvent {
	eventId: string;
	event: EventType;
	userId: string | null;
	deviceId: string;
	ts: string;
	properties: string;
}

/** An event time may be at most this far after the wall clock. */
const FUTURE_ALLOWANCE_MS = 5 * 60 * 1000;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const STORY = /^[a-z0-9-]{1,120}$/;
const HTTP_URL = /^https?:\/\//i;
const MAX_URL_LENGTH = 2048;
const TOP_LEVEL_KEYS = new Set(["event_id", "event", "user_id", "device_id", "timestamp", "properties"]);
const ISO_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

/**
 * Parses an ISO-8601 timestamp that carries a zone (`Z` or an offset) into epoch milliseconds, or null.
 * Impossible calendar values (month 13, Feb 30, hour 24) are rejected by round-tripping the date parts.
 */
function parseZoned(text: string): number | null {
	const m = ISO_WITH_ZONE.exec(text);
	if (m === null) return null;
	const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
	const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
	const sameParts =
		local.getUTCFullYear() === year &&
		local.getUTCMonth() === month - 1 &&
		local.getUTCDate() === day &&
		local.getUTCHours() === hour &&
		local.getUTCMinutes() === minute &&
		local.getUTCSeconds() === second;
	if (!sameParts) return null;
	let offsetMinutes = 0;
	if (m[8] !== undefined) {
		const offsetHours = Number(m[9]);
		const offsetRest = Number(m[10]);
		if (offsetHours > 23 || offsetRest > 59) return null;
		offsetMinutes = (m[8] === "-" ? -1 : 1) * (offsetHours * 60 + offsetRest);
	}
	return local.getTime() - offsetMinutes * 60_000;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict validation (SPEC section 4, step 6). Returns the event to store, or null for any failure.
 * `nowMs` is the wall clock, used only for the "no more than 5 minutes in the future" rule.
 */
export function validateEvent(input: unknown, nowMs: number): AppEvent | null {
	if (!isPlainObject(input)) return null;
	for (const key of Object.keys(input)) if (!TOP_LEVEL_KEYS.has(key)) return null;

	const { event_id: eventId, event, device_id: deviceId, timestamp } = input;
	if (typeof eventId !== "string" || !ID.test(eventId)) return null;
	if (typeof event !== "string" || !(EVENT_TYPES as readonly string[]).includes(event)) return null;
	if (typeof deviceId !== "string" || !ID.test(deviceId)) return null;

	// user_id is null or a string; leaving it out means null.
	const rawUser = input.user_id ?? null;
	if (rawUser !== null && (typeof rawUser !== "string" || !ID.test(rawUser))) return null;

	if (typeof timestamp !== "string") return null;
	const eventMs = parseZoned(timestamp);
	if (eventMs === null || eventMs > nowMs + FUTURE_ALLOWANCE_MS) return null;

	const properties = input.properties === undefined ? {} : input.properties;
	if (!isPlainObject(properties)) return null;

	if (event === "read_story" && (typeof properties.story !== "string" || !STORY.test(properties.story))) return null;
	if (event === "link_click") {
		const url = properties.url;
		if (typeof url !== "string" || url.length > MAX_URL_LENGTH || !HTTP_URL.test(url) || !URL.canParse(url)) return null;
	}
	if (event === "login" && rawUser === null) return null;

	return {
		eventId,
		event: event as EventType,
		userId: rawUser,
		deviceId,
		ts: nowIso(new Date(eventMs)),
		properties: JSON.stringify(properties),
	};
}
