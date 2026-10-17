-- Resolves who owns each app event at read time (SPEC section 4, "Out of order and login stitching").
--   1. An event with a user_id belongs to that user.
--   2. An anonymous event on device D belongs to the user of the latest device_links row on D with seen_at <= event.ts.
--   3. Otherwise it belongs to the user of the earliest row on D after the event.
--   4. If D has no rows at all, owner_user_id is NULL: the event is stored but belongs to no profile.
-- Ties on seen_at are broken by user_id so the result is deterministic.
CREATE VIEW app_event_owner AS
SELECT
  e.event_id,
  e.event,
  e.ts,
  e.device_id,
  e.properties,
  CASE WHEN e.user_id IS NULL THEN 1 ELSE 0 END AS attributed_from_device,
  COALESCE(
    e.user_id,
    (SELECT d.user_id FROM device_links d
       WHERE d.device_id = e.device_id AND d.seen_at <= e.ts
       ORDER BY d.seen_at DESC, d.user_id DESC LIMIT 1),
    (SELECT d.user_id FROM device_links d
       WHERE d.device_id = e.device_id AND d.seen_at > e.ts
       ORDER BY d.seen_at ASC, d.user_id ASC LIMIT 1)
  ) AS owner_user_id
FROM app_events e;
