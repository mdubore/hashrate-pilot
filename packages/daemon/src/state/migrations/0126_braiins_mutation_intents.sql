-- Reserved before the HTTP call. One slot serializes the controller and the
-- manual cancel action, including across daemon restarts.
CREATE TABLE braiins_mutation_intents (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  account_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  command TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
  retry_at INTEGER,
  -- Every transmission received a rate limit; no previous attempt was ambiguous.
  unexecuted INTEGER NOT NULL DEFAULT 0 CHECK (unexecuted IN (0, 1)),
  CHECK (unexecuted = 0 OR (accepted = 0 AND retry_at IS NOT NULL))
);
