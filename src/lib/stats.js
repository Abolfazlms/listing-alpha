/**
 * In-memory aggregation over an event snapshot. Shared by the static site
 * builder and the weekly report so both artefacts always agree on the numbers.
 */

/**
 * @typedef {object} Summary
 * @property {number} total
 * @property {Record<string, number>} byKind
 * @property {{source: string, count: number, avgLatency: number, listings: number}[]} bySource
 * @property {number} avgLatency
 * @property {{symbol: string, count: number}[]} topSymbols
 * @property {Record<string, number>} byDay
 */

/** @param {object[]} events @returns {Summary} */
export function summarize(events) {
  const byKind = {};
  const sourceMap = new Map();
  const symbolMap = new Map();
  const byDay = {};
  let latencySum = 0;
  let latencyCount = 0;

  for (const event of events) {
    byKind[event.kind] = (byKind[event.kind] || 0) + 1;

    if (!sourceMap.has(event.source)) {
      sourceMap.set(event.source, { source: event.source, count: 0, latencySum: 0, latencyCount: 0, listings: 0 });
    }
    const source = sourceMap.get(event.source);
    source.count++;
    if (Number.isFinite(event.latency_sec)) {
      source.latencySum += event.latency_sec;
      source.latencyCount++;
      latencySum += event.latency_sec;
      latencyCount++;
    }
    if (event.kind === 'LISTING') source.listings++;

    if (event.symbol) symbolMap.set(event.symbol, (symbolMap.get(event.symbol) || 0) + 1);

    const day = String(event.announced_at).slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
  }

  return {
    total: events.length,
    byKind,
    bySource: [...sourceMap.values()]
      .map((s) => ({
        source: s.source,
        count: s.count,
        listings: s.listings,
        avgLatency: s.latencyCount ? Math.round(s.latencySum / s.latencyCount) : 0,
      }))
      .sort((a, b) => b.count - a.count),
    avgLatency: latencyCount ? Math.round(latencySum / latencyCount) : 0,
    topSymbols: [...symbolMap.entries()]
      .map(([symbol, count]) => ({ symbol, count }))
      .sort((a, b) => b.count - a.count || a.symbol.localeCompare(b.symbol))
      .slice(0, 15),
    byDay,
  };
}

/** Seconds -> "12m 03s"-ish, compact. */
export function formatLatency(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}
