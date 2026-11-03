/**
 * D1 data access. Every function takes the D1 binding as its first argument so
 * the module stays pure of globals and is easy to fake in tests.
 */

const SEC = 1000;

/**
 * Insert events, ignoring ones we already have. Returns how many rows are new.
 * @param {D1Database} db
 * @param {object[]} events
 */
export async function insertEvents(db, events) {
  if (!events?.length) return 0;
  const statements = events.map((event) =>
    db
      .prepare(
        `INSERT INTO events (id, source, kind, symbol, base, quote, title, url,
                             announced_at, first_seen_at, latency_sec, score, reasons, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .bind(
        event.id,
        event.source,
        event.kind,
        event.symbol,
        event.base,
        event.quote,
        event.title,
        event.url || '',
        event.announced_at,
        event.first_seen_at,
        event.latency_sec ?? null,
        event.score ?? 0,
        JSON.stringify(event.reasons || []),
        JSON.stringify(event.meta || {})
      )
  );
  const results = await db.batch(statements);
  return results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
}

/**
 * @param {D1Database} db
 * @param {object[]} events
 */
export async function trackSymbols(db, events) {
  const now = new Date().toISOString();
  const symbols = [...new Set(events.map((e) => e.symbol).filter(Boolean))];
  if (!symbols.length) return;
  const statements = symbols.map((symbol) =>
    db
      .prepare(
        `INSERT INTO seen_symbols (symbol, first_seen_at, last_seen_at, hits)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(symbol) DO UPDATE SET last_seen_at = excluded.last_seen_at, hits = hits + 1`
      )
      .bind(symbol, now, now)
  );
  await db.batch(statements);
}

/**
 * Symbols seen in the recent past. Used for the novelty part of the score and
 * for "was this ticker already trading elsewhere" style signals.
 * @param {D1Database} db
 * @param {number} [days]
 * @returns {Promise<Set<string>>}
 */
export async function knownSymbols(db, days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { results } = await db
    .prepare('SELECT symbol FROM seen_symbols WHERE last_seen_at >= ?')
    .bind(since)
    .all();
  return new Set((results || []).map((row) => row.symbol));
}

/**
 * @param {D1Database} db
 * @param {{limit?: number, since?: string, kind?: string, source?: string, q?: string, cursor?: string}} [opts]
 */
export async function listEvents(db, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const where = [];
  const bindings = [];

  if (opts.since) { where.push('announced_at >= ?'); bindings.push(opts.since); }
  if (opts.kind) { where.push('kind = ?'); bindings.push(String(opts.kind).toUpperCase()); }
  if (opts.source) { where.push('source = ?'); bindings.push(String(opts.source).toLowerCase()); }
  if (opts.cursor) { where.push('announced_at < ?'); bindings.push(opts.cursor); }
  if (opts.q) {
    where.push('(title LIKE ? OR symbol LIKE ?)');
    bindings.push(`%${opts.q}%`, `%${opts.q}%`);
  }

  const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY announced_at DESC LIMIT ?`;
  bindings.push(limit);
  const { results } = await db.prepare(sql).bind(...bindings).all();
  return (results || []).map(hydrate);
}

/** @param {D1Database} db @param {string} id */
export async function getEvent(db, id) {
  const row = await db.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
  return row ? hydrate(row) : null;
}

/** @param {any} row */
function hydrate(row) {
  return {
    ...row,
    reasons: safeParse(row.reasons, []),
    meta: safeParse(row.meta, {}),
  };
}

function safeParse(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

/** Aggregate numbers used by the public /stats page and the weekly report. */
export async function getStats(db, days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const [byKind, bySource, totals, fastest] = await Promise.all([
    db.prepare('SELECT kind, COUNT(*) AS c FROM events WHERE announced_at >= ? GROUP BY kind ORDER BY c DESC').bind(since).all(),
    db.prepare('SELECT source, COUNT(*) AS c, AVG(latency_sec) AS avg_latency FROM events WHERE announced_at >= ? GROUP BY source ORDER BY c DESC').bind(since).all(),
    db.prepare('SELECT COUNT(*) AS c, AVG(latency_sec) AS avg_latency, AVG(score) AS avg_score FROM events WHERE announced_at >= ?').bind(since).first(),
    db.prepare('SELECT * FROM events WHERE announced_at >= ? AND latency_sec IS NOT NULL ORDER BY latency_sec ASC LIMIT 5').bind(since).all(),
  ]);

  return {
    windowDays: days,
    total: totals?.c ?? 0,
    avgLatencySec: Math.round(totals?.avg_latency ?? 0),
    avgScore: Math.round(totals?.avg_score ?? 0),
    byKind: byKind.results || [],
    bySource: (bySource.results || []).map((r) => ({ ...r, avg_latency: Math.round(r.avg_latency ?? 0) })),
    fastest: (fastest.results || []).map(hydrate),
  };
}

/* ------------------------------------------------------------------ */
/* Free-tier queue: events that are old enough to be given away.        */
/* ------------------------------------------------------------------ */

/**
 * @param {D1Database} db
 * @param {number} delaySec
 * @param {number} [limit]
 */
export async function dueFreeEvents(db, delaySec, limit = 25) {
  const cutoff = new Date(Date.now() - delaySec * SEC).toISOString();
  const { results } = await db
    .prepare(
      `SELECT * FROM events
       WHERE notified_free = 0 AND announced_at <= ?
       ORDER BY announced_at ASC LIMIT ?`
    )
    .bind(cutoff, limit)
    .all();
  return (results || []).map(hydrate);
}

/** @param {D1Database} db @param {string[]} ids */
export async function markFreeNotified(db, ids) {
  if (!ids.length) return;
  const statements = ids.map((id) =>
    db.prepare('UPDATE events SET notified_free = 1 WHERE id = ?').bind(id)
  );
  await db.batch(statements);
}

/** @param {D1Database} db @param {string[]} ids */
export async function markPaidNotified(db, ids) {
  if (!ids.length) return;
  const statements = ids.map((id) =>
    db.prepare('UPDATE events SET notified_paid = 1 WHERE id = ?').bind(id)
  );
  await db.batch(statements);
}

/** High-score events that have not been pushed to the paid channel yet. */
export async function pendingPaidEvents(db, minScore = 60, limit = 10) {
  const { results } = await db
    .prepare(
      `SELECT * FROM events WHERE notified_paid = 0 AND score >= ?
       ORDER BY score DESC, announced_at DESC LIMIT ?`
    )
    .bind(minScore, limit)
    .all();
  return (results || []).map(hydrate);
}

/* ------------------------------------------------------------------ */
/* Invoices / entitlements                                             */
/* ------------------------------------------------------------------ */

export async function openInvoiceAmountExists(db, amountUnits) {
  const row = await db
    .prepare("SELECT id FROM invoices WHERE amount_units = ? AND status = 'pending'")
    .bind(amountUnits)
    .first();
  return Boolean(row);
}

/** @param {D1Database} db @param {object} invoice */
export async function insertInvoice(db, invoice) {
  await db
    .prepare(
      `INSERT INTO invoices (id, plan, amount, amount_units, address, network, status,
                             created_at, expires_at, license_key, telegram_chat, contact)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
    )
    .bind(
      invoice.id,
      invoice.plan,
      invoice.amount,
      invoice.amount_units,
      invoice.address,
      invoice.network || 'trc20',
      invoice.created_at,
      invoice.expires_at,
      invoice.license_key,
      invoice.telegram_chat || null,
      invoice.contact || null
    )
    .run();
}

/** @param {D1Database} db @param {string} id */
export async function getInvoice(db, id) {
  return db.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
}

/** @param {D1Database} db */
export async function pendingInvoices(db) {
  const { results } = await db
    .prepare("SELECT * FROM invoices WHERE status = 'pending' ORDER BY created_at ASC LIMIT 100")
    .all();
  return results || [];
}

/** Mark an invoice paid exactly once; returns false if another worker got it first. */
export async function markInvoicePaid(db, id, txid, paidAt) {
  const res = await db
    .prepare("UPDATE invoices SET status = 'paid', paid_at = ?, txid = ? WHERE id = ? AND status = 'pending'")
    .bind(paidAt, txid, id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function expireInvoices(db, nowIso) {
  await db
    .prepare("UPDATE invoices SET status = 'expired' WHERE status = 'pending' AND expires_at < ?")
    .bind(nowIso)
    .run();
}

export async function recordTxid(db, txid, invoiceId, units) {
  await db
    .prepare('INSERT INTO credited_txids (txid, invoice_id, units, credited_at) VALUES (?, ?, ?, ?) ON CONFLICT(txid) DO NOTHING')
    .bind(txid, invoiceId, units, new Date().toISOString())
    .run();
}

export async function txidAlreadyCredited(db, txid) {
  const row = await db.prepare('SELECT txid FROM credited_txids WHERE txid = ?').bind(txid).first();
  return Boolean(row);
}

export async function insertEntitlement(db, { key, plan, invoiceId, expiresAt, telegramChat }) {
  await db
    .prepare(
      `INSERT INTO entitlements (key, plan, invoice_id, created_at, expires_at, telegram_chat, active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    )
    .bind(key, plan, invoiceId, new Date().toISOString(), expiresAt, telegramChat || null)
    .run();
}

/** @param {D1Database} db @param {string} key */
export async function getEntitlement(db, key) {
  const row = await db.prepare('SELECT * FROM entitlements WHERE key = ?').bind(key).first();
  if (!row) return null;
  const expired = row.expires_at ? Date.parse(row.expires_at) < Date.now() : false;
  return { ...row, expired, valid: Boolean(row.active) && !expired };
}
