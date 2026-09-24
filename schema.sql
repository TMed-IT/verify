CREATE TABLE IF NOT EXISTS flows (
  id TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  client_id TEXT,
  state TEXT,
  code_challenge TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS flows_expiry ON flows(expires_at);
CREATE INDEX IF NOT EXISTS flows_browser ON flows(browser_hash);

CREATE TABLE IF NOT EXISTS magic_links (
  token_hash TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  email_key TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS magic_links_flow ON magic_links(flow_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  email_key TEXT NOT NULL,
  browser_hash TEXT NOT NULL,
  session_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  UNIQUE(email_key, browser_hash)
);
CREATE INDEX IF NOT EXISTS sessions_browser ON sessions(browser_hash);

CREATE TABLE IF NOT EXISTS auth_codes (
  code_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_codes_expiry ON auth_codes(expires_at);
CREATE INDEX IF NOT EXISTS auth_codes_session ON auth_codes(session_id);

CREATE TABLE IF NOT EXISTS client_tokens (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS client_tokens_session ON client_tokens(session_id);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY(bucket_key, window_start)
);
CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(window_start);
