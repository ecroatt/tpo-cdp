import type { AppEvent } from "./validate";

export type StoreResult = "stored" | "duplicate";

/**
 * A copy of this event is in app_events with the same user, device and time. After the first insert in the batch this
 * holds for a new event and for a re-send of the same event, and fails for a duplicate whose payload differs (first write
 * wins), so such a duplicate cannot add device links, accounts or profiles. Binds: event_id, user_id, device_id, ts.
 */
const STORED_AS_SENT = "EXISTS (SELECT 1 FROM app_events WHERE event_id = ? AND user_id IS ? AND device_id = ? AND ts = ?)";
/** No profile owns this user_id yet. Bind: user_id. */
const NO_LINK_YET = "NOT EXISTS (SELECT 1 FROM user_links WHERE user_id = ?)";

/**
 * Stores one event in a single D1 batch (a transaction): the event, the device link when a user is named, and, for a
 * user_id that no profile knows yet, an app_users row, an `unknown_app_user` profile and the user_links row.
 * Returns "duplicate" when the event_id was already stored; its payload is then ignored.
 */
export async function storeEvent(db: D1Database, e: AppEvent, receivedAt: string): Promise<StoreResult> {
	const asSent = [e.eventId, e.userId, e.deviceId, e.ts];
	const statements: D1PreparedStatement[] = [
		db
			.prepare("INSERT OR IGNORE INTO app_events (event_id, event, user_id, device_id, ts, properties, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.bind(e.eventId, e.event, e.userId, e.deviceId, e.ts, e.properties, receivedAt),
	];
	if (e.userId !== null) {
		statements.push(
			db
				.prepare(`INSERT OR IGNORE INTO device_links (device_id, user_id, seen_at) SELECT ?, ?, ? WHERE ${STORED_AS_SENT}`)
				.bind(e.deviceId, e.userId, e.ts, ...asSent),
			db
				.prepare(
					`INSERT OR IGNORE INTO app_users (user_id, email_raw, email_norm, created_at, origin) SELECT ?, NULL, NULL, ?, 'webhook' WHERE ${STORED_AS_SENT} AND ${NO_LINK_YET}`,
				)
				.bind(e.userId, e.ts.slice(0, 10), ...asSent, e.userId),
			db
				.prepare(
					`INSERT INTO profiles (profile_id, kind, email_norm, created_at) SELECT lower(hex(randomblob(16))), 'unknown_app_user', NULL, ? WHERE ${STORED_AS_SENT} AND ${NO_LINK_YET}`,
				)
				.bind(receivedAt, ...asSent, e.userId),
			// Same conditions as the profile insert above and nothing in between changes them, so when this runs the profile
			// that was just inserted is last_insert_rowid().
			db
				.prepare(
					`INSERT OR IGNORE INTO user_links (user_id, profile_id) SELECT ?, profile_id FROM profiles WHERE rowid = last_insert_rowid() AND ${STORED_AS_SENT} AND ${NO_LINK_YET}`,
				)
				.bind(e.userId, ...asSent, e.userId),
		);
	}
	const results = await db.batch(statements);
	return results[0].meta.changes === 1 ? "stored" : "duplicate";
}
