import { json } from "../http/security";
import { LAST_30_START } from "../lib/time";

/** The four headline counts on the home page (SPEC section 9). One parameterized statement. */
export async function handleOverview(env: Env): Promise<Response> {
	const row = await env.tpo_cdp
		.prepare(
			"SELECT " +
				"(SELECT COUNT(*) FROM profiles) AS people, " +
				"(SELECT COUNT(*) FROM subscribers WHERE status = ?) AS active_subscribers, " +
				"(SELECT COUNT(*) FROM user_links) AS app_users_linked, " +
				"(SELECT COUNT(*) FROM app_events WHERE ts >= ?) AS app_events_30d",
		)
		.bind("active", LAST_30_START)
		.first<{ people: number; active_subscribers: number; app_users_linked: number; app_events_30d: number }>();
	return json({
		people: row?.people ?? 0,
		active_subscribers: row?.active_subscribers ?? 0,
		app_users_linked: row?.app_users_linked ?? 0,
		app_events_30d: row?.app_events_30d ?? 0,
	});
}
