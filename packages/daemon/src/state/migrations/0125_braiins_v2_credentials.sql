-- Preserve the original field names and ciphertext: encryption authenticates the field name.
CREATE TABLE secrets_v2 (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  braiins_api_version TEXT NOT NULL DEFAULT 'v1' CHECK (braiins_api_version IN ('v1', 'v2')),
  braiins_owner_token TEXT,
  braiins_read_only_token TEXT,
  braiins_api_key TEXT,
  braiins_account_id TEXT,
  dashboard_password TEXT NOT NULL,
  bitcoind_rpc_url TEXT,
  bitcoind_rpc_user TEXT,
  bitcoind_rpc_password TEXT,
  telegram_bot_token TEXT,
  updated_at INTEGER NOT NULL,
  CHECK ((braiins_api_version = 'v1' AND braiins_owner_token IS NOT NULL)
      OR (braiins_api_version = 'v2' AND braiins_api_key IS NOT NULL))
);
INSERT INTO secrets_v2 (
  id, braiins_owner_token, braiins_read_only_token, dashboard_password, bitcoind_rpc_url,
  bitcoind_rpc_user, bitcoind_rpc_password, telegram_bot_token, updated_at
) SELECT id, braiins_owner_token, braiins_read_only_token, dashboard_password, bitcoind_rpc_url,
         bitcoind_rpc_user, bitcoind_rpc_password, telegram_bot_token, updated_at FROM secrets;
DROP TABLE secrets;
ALTER TABLE secrets_v2 RENAME TO secrets;

-- Account ownership belongs to the state DB, including when credentials come from env or SOPS.
CREATE TABLE braiins_account_binding (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  account_id TEXT NOT NULL,
  needs_live_confirmation INTEGER NOT NULL DEFAULT 1 CHECK (needs_live_confirmation IN (0, 1))
);
