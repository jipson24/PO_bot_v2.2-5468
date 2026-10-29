import type { Client } from "@libsql/client";
import type { NewsAssessment, NewsAsset, NewsEvent, NewsOverview, SourceHealth } from "./types";
import { priceReaction, type TapeBar } from "./model";

export async function initNewsStore(c: Client, now: number) {
  await c.batch([
    `CREATE TABLE IF NOT EXISTS news_events (id TEXT PRIMARY KEY, event_key TEXT NOT NULL, source TEXT NOT NULL, first_seen_at INTEGER NOT NULL, scheduled_at INTEGER, published_at INTEGER, data_json TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS news_events_seen ON news_events(first_seen_at)`,
    `CREATE INDEX IF NOT EXISTS news_events_key ON news_events(event_key,first_seen_at)`,
    `CREATE TABLE IF NOT EXISTS news_sources (source TEXT PRIMARY KEY, data_json TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS news_source_history (source TEXT NOT NULL, checked_at INTEGER NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(source,checked_at))`,
    `CREATE TABLE IF NOT EXISTS news_shadow_assessments (symbol TEXT NOT NULL, bucket INTEGER NOT NULL, assessed_at INTEGER NOT NULL, risk INTEGER, data_json TEXT NOT NULL, PRIMARY KEY(symbol,bucket))`,
    `CREATE TABLE IF NOT EXISTS news_shadow_signals (signal_id INTEGER PRIMARY KEY, entry_at INTEGER NOT NULL, evaluated_at INTEGER NOT NULL, data_json TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS news_reactions (event_id TEXT NOT NULL, symbol TEXT NOT NULL, reference_at INTEGER NOT NULL, evaluated_at INTEGER NOT NULL, status TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(event_id,symbol))`,
    `CREATE TABLE IF NOT EXISTS news_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)`,
    { sql: `INSERT OR IGNORE INTO news_meta VALUES ('started_at',?)`, args: [String(now)] },
  ], "write");
}
export async function readNewsAssets(c: Client): Promise<NewsAsset[]> {
  const rows = (await c.execute(`SELECT symbol,name,kind,is_otc,is_active FROM assets WHERE is_otc=0 AND lower(symbol) NOT LIKE '%otc%'`)).rows;
  return rows.map((r) => ({ symbol: String(r.symbol), name: String(r.name), kind: String(r.kind), isOtc: Boolean(r.is_otc), isActive: Boolean(r.is_active) }));
}
export async function saveEvents(c: Client, events: NewsEvent[]) {
  for (let i = 0; i < events.length; i += 100) {
    await c.batch(events.slice(i, i + 100).map((e) => ({
      sql: `INSERT OR IGNORE INTO news_events VALUES (?,?,?,?,?,?,?)`,
      args: [e.id, e.eventKey, e.source, e.firstSeenAt, e.scheduledAt, e.publishedAt, JSON.stringify(e)],
    })), "write");
  }
}
export async function saveHealth(c: Client, h: SourceHealth) {
  await c.batch([
    { sql: `INSERT INTO news_sources VALUES (?,?) ON CONFLICT(source) DO UPDATE SET data_json=excluded.data_json`, args: [h.source, JSON.stringify(h)] },
    { sql: `INSERT OR IGNORE INTO news_source_history VALUES (?,?,?)`, args: [h.source, h.checkedAt, JSON.stringify(h)] },
  ], "write");
}
export async function loadHealth(c: Client): Promise<SourceHealth[]> {
  return (await c.execute(`SELECT data_json FROM news_sources`)).rows.map((r) => JSON.parse(String(r.data_json)));
}
export async function loadHealthAsOf(c: Client, at: number): Promise<SourceHealth[]> {
  return (await c.execute({ sql: `SELECT h.data_json FROM news_source_history h JOIN (SELECT source,MAX(checked_at) t FROM news_source_history WHERE checked_at<=? GROUP BY source) m ON h.source=m.source AND h.checked_at=m.t`, args: [at] })).rows.map((r) => JSON.parse(String(r.data_json)));
}
export async function loadEvents(c: Client, now: number): Promise<NewsEvent[]> {
  return (await c.execute({ sql: `SELECT data_json FROM news_events WHERE first_seen_at<=? AND (scheduled_at>=? OR published_at>=?) ORDER BY first_seen_at DESC LIMIT 10000`, args: [now, now - 86400, now - 86400] })).rows.map((r) => JSON.parse(String(r.data_json)));
}
export async function saveAssessments(c: Client, list: NewsAssessment[]) {
  if (!list.length) return;
  await c.batch(list.map((a) => ({ sql: `INSERT OR IGNORE INTO news_shadow_assessments VALUES (?,?,?,?,?)`,
    args: [a.symbol, Math.floor(a.asOf / 300), a.asOf, a.risk, JSON.stringify(a)] })), "write");
}
export async function readUnassessedSignals(c: Client) {
  const started = Number((await c.execute(`SELECT value FROM news_meta WHERE key='started_at'`)).rows[0]?.value ?? 0);
  return (await c.execute({ sql: `SELECT s.id,s.symbol,s.direction,s.confidence,s.entry_at,s.price FROM signals s JOIN assets a ON a.symbol=s.symbol LEFT JOIN news_shadow_signals n ON n.signal_id=s.id WHERE a.is_otc=0 AND lower(s.symbol) NOT LIKE '%otc%' AND s.entry_at>=? AND n.signal_id IS NULL ORDER BY s.id LIMIT 100`, args: [started] })).rows;
}
export async function saveSignalContext(c: Client, signal: { id: number; entryAt: number; confidence: number; direction: string }, assessment: NewsAssessment, now: number) {
  const m = assessment.proposedConfidenceMultiplier;
  const context = { assessment, originalConfidence: signal.confidence,
    proposedConfidence: m == null ? null : Math.round(signal.confidence * m),
    originalDirection: signal.direction, appliedToLive: false, evaluatedAt: now,
    evaluationLagSec: now - signal.entryAt, knowledgeCutoff: signal.entryAt };
  await c.execute({ sql: `INSERT OR IGNORE INTO news_shadow_signals VALUES (?,?,?,?)`, args: [signal.id, signal.entryAt, now, JSON.stringify(context)] });
}

export async function updateReactions(c: Client, events: NewsEvent[], assets: NewsAsset[], now: number, relevant: (e: NewsEvent, a: NewsAsset) => boolean) {
  const candidates = events.filter((e) => {
    const t = e.scheduledAt ?? e.publishedAt;
    return t != null && t < now - 1800 && t > now - 86400 && (e.category !== "calendar" || e.impact !== "low");
  }).sort((a, b) => (a.category === "calendar" ? -1 : 0) - (b.category === "calendar" ? -1 : 0)).slice(0, 100);
  let count = 0;
  for (const e of candidates) {
    const t = (e.scheduledAt ?? e.publishedAt)!;
    for (const a of assets.filter((a) => relevant(e, a)).slice(0, 60)) {
      const old = (await c.execute({ sql: `SELECT status,evaluated_at FROM news_reactions WHERE event_id=? AND symbol=?`, args: [e.id, a.symbol] })).rows[0];
      if (old?.status === "complete" || (old && now - Number(old.evaluated_at) < 7200)) continue;
      if (++count > 100) return;
      let bars: TapeBar[] = [];
      try {
        const rows = (await c.execute({ sql: `SELECT bars FROM m1_tape WHERE symbol=? AND hour BETWEEN ? AND ?`, args: [a.symbol, Math.floor((t - 1200) / 3600) * 3600, Math.floor((t + 2400) / 3600) * 3600] })).rows;
        bars = rows.flatMap((r) => JSON.parse(String(r.bars)).map((b: number[]) => ({ time: b[0]!, close: b[4]! })));
      } catch { /* old databases without m1_tape: coverage gap, never invented prices */ }
      const reaction = { ...priceReaction(bars, t, now), firstSeenAt: e.firstSeenAt,
        observationLagSec: e.publishedAt == null ? null : e.firstSeenAt - e.publishedAt,
        eventTitle: e.title, source: e.source, actual: e.actual };
      await c.execute({ sql: `INSERT INTO news_reactions VALUES (?,?,?,?,?,?) ON CONFLICT(event_id,symbol) DO UPDATE SET evaluated_at=excluded.evaluated_at,status=excluded.status,data_json=excluded.data_json`,
        args: [e.id, a.symbol, t, now, reaction.missingHorizons.length ? "missing-bars" : "complete", JSON.stringify(reaction)] });
    }
  }
}
export async function saveHeartbeat(c: Client, value: unknown) {
  await c.execute({ sql: `INSERT INTO news_meta VALUES ('status',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, args: [JSON.stringify(value)] });
}
export async function pruneNews(c: Client, now: number) {
  await c.batch([
    { sql: `DELETE FROM news_shadow_assessments WHERE assessed_at<?`, args: [now - 14 * 86400] },
    { sql: `DELETE FROM news_source_history WHERE checked_at<?`, args: [now - 14 * 86400] },
    { sql: `DELETE FROM news_events WHERE first_seen_at<?`, args: [now - 90 * 86400] },
  ], "write");
}

export async function newsStatus(c: Client): Promise<NewsOverview> {
  const meta = (await c.execute(`SELECT value FROM news_meta WHERE key='status'`)).rows[0];
  const counts = (await c.execute(`SELECT (SELECT COUNT(*) FROM news_events) events,(SELECT COUNT(*) FROM news_shadow_assessments) assessments,(SELECT COUNT(*) FROM news_shadow_signals) signals,(SELECT COUNT(*) FROM news_reactions WHERE status='complete') measured_reactions,(SELECT COUNT(*) FROM news_reactions WHERE status!='complete') missing_reactions`)).rows[0];
  const rows = (await c.execute(`SELECT a.data_json FROM news_shadow_assessments a JOIN (SELECT symbol,MAX(bucket) b FROM news_shadow_assessments GROUP BY symbol) m ON a.symbol=m.symbol AND a.bucket=m.b ORDER BY a.risk DESC,a.symbol`)).rows;
  return { status: meta ? JSON.parse(String(meta.value)) : null,
    counts: { events: Number(counts?.events ?? 0), assessments: Number(counts?.assessments ?? 0),
      signals: Number(counts?.signals ?? 0), measured_reactions: Number(counts?.measured_reactions ?? 0),
      missing_reactions: Number(counts?.missing_reactions ?? 0) },
    sources: await loadHealth(c), assessments: rows.map((r) => JSON.parse(String(r.data_json))) };
}