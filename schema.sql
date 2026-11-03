-- Listing Alpha / D1 schema. Idempotent: safe to run on every deploy.

CREATE TABLE IF NOT EXISTS events (
  id             TEXT PRIMARY KEY,
  source         TEXT NOT NULL,
  kind           TEXT NOT NULL,
  symbol         TEXT,
  base           TEXT,
  quote          TEXT,
  title          TEXT NOT NULL,
  url            TEXT,
  announced_at   TEXT NOT NULL,
  first_seen_at  TEXT NOT NULL,
  latency_sec    INTEGER,
  score          INTEGER NOT NULL DEFAULT 0,
  reasons        TEXT,
  meta           TEXT,
  notified_paid  INTEGER NOT NULL DEFAULT 0,
  notified_free  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_events_announced ON events (announced_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind      ON events (kind, announced_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_source    ON events (source, announced_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_symbol    ON events (symbol);
CREATE INDEX IF NOT EXISTS idx_events_freeq     ON events (notified_free, announced_at);

-- One row per symbol ever seen. Drives the "novelty" part of the score.
CREATE TABLE IF NOT EXISTS seen_symbols (
  symbol        TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  hits          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS invoices (
  id            TEXT PRIMARY KEY,
  plan          TEXT NOT NULL,
  amount        TEXT NOT NULL,
  amount_units  INTEGER NOT NULL,
  address       TEXT NOT NULL,
  network       TEXT NOT NULL DEFAULT 'trc20',
  status        TEXT NOT NULL DEFAULT 'pending',
  txid          TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  paid_at       TEXT,
  license_key   TEXT,
  telegram_chat TEXT,
  contact       TEXT
);

-- Unique-amount invoicing: two open invoices may never share an amount,
-- otherwise a single transfer could be credited twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_open_amount
  ON invoices (amount_units) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status, created_at DESC);

CREATE TABLE IF NOT EXISTS entitlements (
  key           TEXT PRIMARY KEY,
  plan          TEXT NOT NULL,
  invoice_id    TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT,
  telegram_chat TEXT,
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_entitlements_expiry ON entitlements (active, expires_at);

-- Ledger of every USDT transfer we have already credited, so a replay of the
-- same txid can never unlock a second licence.
CREATE TABLE IF NOT EXISTS credited_txids (
  txid        TEXT PRIMARY KEY,
  invoice_id  TEXT NOT NULL,
  units       INTEGER NOT NULL,
  credited_at TEXT NOT NULL
);
