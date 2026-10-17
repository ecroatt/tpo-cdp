-- Read indexes for app events owned through the app_event_owner view (see SPEC "D1 read budget").

-- Lookup: devices a profile's users have logged in on, without scanning device_links.
CREATE INDEX idx_device_links_user ON device_links (user_id, device_id);

-- Segments: the events in a time window are read from this index alone (it covers ts, user_id, event and device_id),
-- so scoring and app_active_days cost one index entry per event in the window. It replaces app_events(ts).
DROP INDEX idx_app_events_ts;
CREATE INDEX idx_app_events_ts ON app_events (ts, user_id, event, device_id);
