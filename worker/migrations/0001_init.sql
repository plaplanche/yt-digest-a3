-- Every timestamp is ISO 8601 UTC text with milliseconds and a trailing Z.

CREATE TABLE nodes (
  node_id TEXT PRIMARY KEY,
  owner_label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'healthy',
  state_since TEXT NOT NULL,
  last_heartbeat_at TEXT,
  version TEXT,
  hourly_budget INTEGER NOT NULL DEFAULT 60,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE jobs (
  video_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'primary',
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  leased_by TEXT,
  lease_id TEXT,
  lease_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  tried_nodes TEXT NOT NULL DEFAULT '[]',
  last_outcome TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT,
  PRIMARY KEY (video_id, kind)
);

CREATE INDEX jobs_claim ON jobs (status, priority DESC, created_at, video_id);

CREATE TABLE leases (
  lease_id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  response_json TEXT
);

CREATE TABLE node_events (
  node_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  video_id TEXT
);

CREATE TABLE invites (
  email TEXT PRIMARY KEY,
  invited_at TEXT NOT NULL,
  accepted_user_sub TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE users (
  user_sub TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  google_refresh_token_enc TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE oauth_requests (
  request_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  client_state TEXT,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  google_state TEXT,
  google_nonce TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_sub TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_sub TEXT NOT NULL,
  family_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT
);
