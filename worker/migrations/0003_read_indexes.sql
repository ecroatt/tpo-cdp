-- Read indexes. Without these, every "link table WHERE profile_id = ?" and every owner lookup was a full scan,
-- which made the per-profile score and filter subqueries quadratic (see SPEC "D1 read budget").

-- Profile -> visitors / app users (lookup, engagement, score, has_app, min_site_visits).
CREATE INDEX idx_visitor_links_profile ON visitor_links (profile_id, visitor_id);
CREATE INDEX idx_user_links_profile ON user_links (profile_id, user_id);

-- Visits per visitor inside a time window; covers (visitor_id) lookups, so the old single-column index goes.
CREATE INDEX idx_web_events_visitor_ts ON web_events (visitor_id, ts);
DROP INDEX idx_web_events_visitor;

-- Events in a time window (app_active_days, score window).
CREATE INDEX idx_app_events_ts ON app_events (ts);
