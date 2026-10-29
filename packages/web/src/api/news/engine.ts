import { createClient, type Client } from "@libsql/client";
import { BASE_SOURCES, parseCalendar, parseRss, sourcesForAssets } from "./sources";
import { assessNews, asOfEvents, NEWS_VERSION, relevantTo } from "./model";
import { initNewsStore, loadEvents, loadHealth, loadHealthAsOf, newsStatus, pruneNews, readNewsAssets,
  readUnassessedSignals, saveAssessments, saveEvents, saveHealth, saveHeartbeat, saveSignalContext, updateReactions } from "./store";
import type { NewsSource, SourceHealth } from "./types";

export interface NewsOptions { client: Client; fetcher?: typeof fetch; now?: () => number }
export async function collectSource(source: NewsSource, old: SourceHealth | undefined, opts: NewsOptions): Promise<SourceHealth> {
  const clock = opts.now ?? (() => Math.floor(Date.now() / 1000));
  let now = clock();
  try {
    const res = await (opts.fetcher ?? fetch)(source.url, { headers: {
      "User-Agent": "PocketSignal-NewsShadow/1.0 (RSS reader; no article scraping)",
      "Accept": source.category === "calendar" ? "application/json" : "application/rss+xml,application/xml,text/xml",
    }, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    now = clock(); // knowledge begins AFTER response is available, not at request start
    if (body.length > 2_000_000) throw new Error("feed larger than 2 MB");
    const events = source.category === "calendar" ? parseCalendar(JSON.parse(body), source, now) : parseRss(body, source, now);
    await saveEvents(opts.client, events);
    const h = { source: source.id, checkedAt: now, lastOkAt: now, nextFetchAt: now + source.intervalSec,
      failures: 0, items: events.length, error: null };
    await saveHealth(opts.client, h); return h;
  } catch (error) {
    // Fixed short error categories: no credentials/URLs/article payloads in logs.
    const detail = (error as Error).message;
    const safe = /^HTTP \d+$|^calendar schema:|^RSS schema:|^feed larger|^DTD/.test(detail) ? detail : (error as Error).name;
    const failures = (old?.failures ?? 0) + 1;
    const h = { source: source.id, checkedAt: now, lastOkAt: old?.lastOkAt ?? null,
      nextFetchAt: now + Math.min(86400, source.intervalSec * 2 ** Math.min(failures, 5)),
      failures, items: old?.items ?? 0, error: safe };
    await saveHealth(opts.client, h); return h;
  }
}

export function createNewsShadow(opts: NewsOptions) {
  const c = opts.client, clock = opts.now ?? (() => Math.floor(Date.now() / 1000));
  let ready = false, running = false, lastAssessment = 0, lastReaction = 0, lastPrune = 0;
  return {
    async tick() {
      if (running) return;
      running = true;
      try {
        const now = clock();
        if (!ready) { await initNewsStore(c, now); ready = true; }
        const assets = await readNewsAssets(c), sources = sourcesForAssets(assets);
        const old = await loadHealth(c), due = sources.filter((s) => {
          const h = old.find((h) => h.source === s.id); return !h || h.nextFetchAt <= now;
        });
        // At most 3 simultaneous external requests; no article fetching or paywall bypass.
        for (let i = 0; i < due.length; i += 3) await Promise.all(due.slice(i, i + 3).map((s) => collectSource(s, old.find((h) => h.source === s.id), opts)));
        const evaluatedAt = clock(), health = await loadHealth(c), events = await loadEvents(c, evaluatedAt);
        if (evaluatedAt - lastAssessment >= 300) {
          await saveAssessments(c, assets.map((a) => assessNews(a, events, sources, health, evaluatedAt)));
          lastAssessment = evaluatedAt;
        }
        // Separate records, JOIN later to outcomes. Original signals/settings are NEVER updated.
        const signals = await readUnassessedSignals(c);
        for (const s of signals) {
          const asset = assets.find((a) => a.symbol === s.symbol); if (!asset) continue;
          const entryAt = Number(s.entry_at), knownHealth = await loadHealthAsOf(c, entryAt);
          const assessment = assessNews(asset, events, sources, knownHealth, entryAt);
          await saveSignalContext(c, { id: Number(s.id), entryAt, confidence: Number(s.confidence), direction: String(s.direction) }, assessment, evaluatedAt);
        }
        if (evaluatedAt - lastReaction >= 1800) {
          await updateReactions(c, asOfEvents(events, evaluatedAt), assets, evaluatedAt, relevantTo);
          lastReaction = evaluatedAt;
        }
        if (evaluatedAt - lastPrune >= 86400) { await pruneNews(c, evaluatedAt); lastPrune = evaluatedAt; }
        const failed = health.filter((h) => h.error).map((h) => h.source);
        await saveHeartbeat(c, { version: NEWS_VERSION, mode: "shadow", appliedToLive: false,
          runtime: { pid: process.pid, node: process.version },
          checkedAt: evaluatedAt, assets: assets.length, activeAssets: assets.filter((a) => a.isActive).length,
          sources: sources.map((s) => ({ id: s.id, label: s.label, url: s.url, intervalSec: s.intervalSec })),
          failedSources: failed, calendarActualAvailable: events.some((e) => e.category === "calendar" && e.actual != null),
          gaps: ["not-all-world-agencies", "calendar-actual-and-surprise-not-guaranteed", "rss-not-tick-time-news",
            "corporate-rss-not-filings-or-earnings-calendar", "commodity-opec-inventories-not-in-v1", "risk-weights-not-calibrated",
            "reactions-sampled-max-100-per-cycle; dependent-on-existing-m1-tape"],
        });
        if (due.length || signals.length) console.log(`[news-shadow] ${assets.length} реальных инструментов · ${events.length} событий в окне · ${failed.length} источников с ошибкой · веса live НЕ меняются`);
      } catch (error) {
        console.error("[news-shadow] цикл не завершён:", (error as Error).name);
      } finally { running = false; }
    },
    status: () => newsStatus(c),
  };
}

const scope = globalThis as unknown as { poNewsShadow?: { timer: ReturnType<typeof setInterval>; client: Client } };
export function startNewsShadow() {
  if (process.env.NEWS_SHADOW_ENABLED === "0" || process.env.ENGINE_ENABLED === "0" || scope.poNewsShadow) return;
  const url = process.env.DATABASE_URL;
  if (!url) { console.warn("[news-shadow] нет DATABASE_URL"); return; }
  const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });
  const worker = createNewsShadow({ client });
  const timer = setInterval(() => void worker.tick(), 60_000);
  timer.unref?.();
  scope.poNewsShadow = { timer, client };
  console.log("[news-shadow] включён: реальные инструменты, OTC исключены, live-веса неизменны");
  void worker.tick();
}

export async function readNewsShadowStatus() {
  const client = createClient({ url: process.env.DATABASE_URL!, authToken: process.env.DATABASE_AUTH_TOKEN });
  try { return await newsStatus(client); } finally { client.close(); }
}

export async function newsTelegramStatus(): Promise<string> {
  const n = await readNewsShadowStatus();
  const age = n.status ? Math.floor(Date.now() / 1000) - n.status.checkedAt : null;
  return ["<b>Новостной блок · теневой режим</b>",
    "Сигналы и реальные веса НЕ меняются. OTC исключены.",
    `Реальных инструментов: ${n.status?.assets ?? 0} · активных: ${n.status?.activeAssets ?? 0}`,
    `Событий: ${n.counts.events} · теневых входов: ${n.counts.signals}`,
    `Реакций с полной M1-лентой: ${n.counts.measured_reactions} · неполных: ${n.counts.missing_reactions}`,
    `Источников: ${n.sources.length} · с ошибкой: ${n.sources.filter((s) => s.error).length}`,
    `Последний цикл: ${age == null ? "не подтверждён" : `${age} сек назад`}`,
    "Пробелы: нет полного покрытия агентств, факта всех релизов, SEC filings и календаря отчётности.",
    "Новостной риск не предсказывает CALL/PUT. Веса ещё не откалиброваны.",
  ].join("\n");
}

export { BASE_SOURCES };