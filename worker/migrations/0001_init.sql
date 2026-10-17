-- Phase 1 schema. Raw rows are stored as imported; identity lives in the link tables.

CREATE TABLE profiles (
  profile_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('subscriber', 'app_only', 'unknown_app_user')),
  email_norm TEXT UNIQUE,
  created_at TEXT
);

CREATE TABLE subscribers (
  email_norm TEXT PRIMARY KEY,
  email_raw TEXT,
  signup_date TEXT,
  status TEXT,
  source TEXT,
  source_raw TEXT,
  last_open_date TEXT
);

CREATE TABLE web_events (
  id INTEGER PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  page TEXT NOT NULL,
  ts TEXT NOT NULL,
  source TEXT,
  source_raw TEXT,
  email_raw TEXT,
  email_norm TEXT,
  UNIQUE (visitor_id, page, ts)
);

CREATE TABLE visitor_links (
  visitor_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL
);

CREATE TABLE app_users (
  user_id TEXT PRIMARY KEY,
  email_raw TEXT,
  email_norm TEXT,
  created_at TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('csv', 'webhook'))
);

CREATE TABLE user_links (
  user_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL
);

CREATE TABLE app_events (
  event_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  user_id TEXT,
  device_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  properties TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE device_links (
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (device_id, seen_at, user_id)
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE import_report (
  run_at TEXT NOT NULL,
  metric TEXT NOT NULL,
  value INTEGER NOT NULL
);

CREATE INDEX idx_web_events_visitor ON web_events (visitor_id);
CREATE INDEX idx_web_events_ts ON web_events (ts);
CREATE INDEX idx_app_events_user ON app_events (user_id);
CREATE INDEX idx_app_events_device_ts ON app_events (device_id, ts);
CREATE INDEX idx_subscribers_source ON subscribers (source);
CREATE INDEX idx_subscribers_signup ON subscribers (signup_date);
CREATE INDEX idx_import_report_run ON import_report (run_at);
