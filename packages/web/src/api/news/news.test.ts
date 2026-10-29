import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { assessNews, priceReaction } from "./model";
import { BASE_SOURCES, parseCalendar, parseRss } from "./sources";
import { collectSource, createNewsShadow } from "./engine";
import { initNewsStore, loadEvents, loadHealth, newsStatus, saveEvents } from "./store";
import type { NewsAsset, NewsSource, SourceHealth } from "./types";

const NOW = 1800000000;
const fx: NewsAsset = { symbol: "EURUSD", name: "EUR/USD", kind: "currency", isOtc: false, isActive: true };
const source = BASE_SOURCES[0]!;
const calendar = (at: number, forecast = "2.5%") => parseCalendar([{ title: "CPI", country: "USD", date: new Date(at * 1000).toISOString(), impact: "High", forecast, previous: "2.4%" }], source, NOW);
const healthy: SourceHealth[] = BASE_SOURCES.map((s) => ({ source: s.id, checkedAt: NOW, lastOkAt: NOW, nextFetchAt: NOW + s.intervalSec, failures: 0, items: 1, error: null }));
const cleanups: { client: Client; dir: string }[] = [];
afterEach(async () => { for (const x of cleanups.splice(0)) { x.client.close(); await rm(x.dir, { recursive: true, force: true }); } });
async function database() {
  const dir = await mkdtemp(join(tmpdir(), "po-news-test-"));
  const client = createClient({ url: `file:${join(dir, "test.db")}` }); cleanups.push({ client, dir });
  await client.batch([
    `CREATE TABLE assets(symbol TEXT PRIMARY KEY,name TEXT,kind TEXT,is_otc INTEGER,is_active INTEGER)`,
    `CREATE TABLE signals(id INTEGER PRIMARY KEY,symbol TEXT,direction TEXT,confidence INTEGER,entry_at INTEGER,price REAL)`,
    `CREATE TABLE settings(id INTEGER PRIMARY KEY,scanner_enabled INTEGER,min_confidence INTEGER)`,
    `CREATE TABLE m1_tape(symbol TEXT,hour INTEGER,bars TEXT)`,
    `INSERT INTO assets VALUES ('EURUSD','EUR/USD','currency',0,1),('EURUSD_otc','EUR/USD OTC','currency',1,1)`,
    `INSERT INTO settings VALUES (1,1,80)`,
  ], "write");
  return client;
}

test("OTC excluded, known calendar risk before/after, no inferred direction or live change", () => {
  const events = calendar(NOW + 600);
  const before = assessNews(fx, events, BASE_SOURCES, healthy, NOW);
  expect(before.risk).toBe(3); expect(before.events[0]?.phase).toBe("before");
  expect(before.liveConfidenceMultiplier).toBe(1); expect(before.direction).toBeNull();
  expect(before.gaps.some((g) => g.startsWith("actual-missing"))).toBe(true);
  const after = assessNews(fx, events, BASE_SOURCES, healthy, NOW + 720);
  expect(after.events[0]?.phase).toBe("after");
  const otc = assessNews({ ...fx, symbol: "EURUSD_otc", isOtc: true }, events, BASE_SOURCES, healthy, NOW);
  expect(otc.events).toEqual([]); expect(otc.risk).toBeNull();
});
test("no lookahead: late first observation and later revisions cannot influence earlier entry", () => {
  const early = calendar(NOW + 1200);
  const late = calendar(NOW + 1200, "3.0%").map((e) => ({ ...e, firstSeenAt: NOW + 300 }));
  const result = assessNews(fx, [...early, ...late], BASE_SOURCES, healthy, NOW + 100);
  expect(result.events[0]?.id).toBe(early[0]?.id);
  expect(assessNews(fx, late, BASE_SOURCES, healthy, NOW + 100).events).toEqual([]);
});
test("failed sources are unknown, not safe/neutral; duplicate stories never amplify", () => {
  const a = assessNews(fx, [], BASE_SOURCES, [], NOW);
  expect(a.risk).toBeNull(); expect(a.proposedConfidenceMultiplier).toBeNull();
  expect(a.gaps.some((g) => g.startsWith("source-unavailable"))).toBe(true);
  const events = calendar(NOW + 100);
  expect(assessNews(fx, [...events, ...events], BASE_SOURCES, healthy, NOW).risk).toBe(3);
});
test("RSS publication time is not knowledge time, future headlines and DTD rejected", () => {
  const s = BASE_SOURCES.find((s) => s.id === "bbc-world")!;
  const rss = `<rss><channel><item><title>New sanctions announced</title><link>https://example.com/1</link><pubDate>${new Date((NOW - 3600) * 1000).toUTCString()}</pubDate></item></channel></rss>`;
  const e = parseRss(rss, s, NOW)[0]!;
  expect(e.publishedAt).toBe(NOW - 3600); expect(e.firstSeenAt).toBe(NOW);
  expect(assessNews(fx, [e], BASE_SOURCES, healthy, NOW - 1).events).toEqual([]);
  expect(parseRss(rss.replace(new Date((NOW - 3600) * 1000).toUTCString(), new Date((NOW + 1000) * 1000).toUTCString()), s, NOW)).toEqual([]);
  expect(() => parseRss('<!DOCTYPE rss><rss/>', s, NOW)).toThrow();
});
test("price reaction uses completed exact bars, missing prices stay null", () => {
  const ref = NOW - NOW % 60;
  const r = priceReaction([{ time: ref - 60, close: 100 }, { time: ref, close: 102 }], ref, ref + 60);
  expect(r.returnsPct["1"]).toBeCloseTo(2); expect(r.returnsPct["5"]).toBeNull();
  expect(priceReaction([{ time: ref, close: 102 }], ref, ref + 60).basePrice).toBeNull();
});
test("immutable observations preserve original seen time, source failure has backoff", async () => {
  const c = await database(); await initNewsStore(c, NOW);
  const e = calendar(NOW + 600); await saveEvents(c, e);
  await saveEvents(c, e.map((x) => ({ ...x, firstSeenAt: NOW + 500 })));
  expect((await loadEvents(c, NOW + 1000))[0]?.firstSeenAt).toBe(NOW);
  const h = await collectSource(source, undefined, { client: c, now: () => NOW,
    fetcher: (async () => new Response("blocked", { status: 403 })) as typeof fetch });
  expect(h.error).toBe("HTTP 403"); expect(h.lastOkAt).toBeNull(); expect(h.nextFetchAt).toBeGreaterThan(NOW + 3600);
});
test("collector assessment is additive, no changes to settings/signals, all real assets only", async () => {
  const c = await database(); let now = NOW;
  const fetcher = (async (url: string | URL | Request) => {
    if (String(url).endsWith('.json')) return new Response(JSON.stringify([{ title: "CPI", country: "USD", date: new Date((NOW + 600) * 1000).toISOString(), impact: "High" }]));
    return new Response(`<rss><channel><item><title>Interest rate announcement</title><link>https://example.com/press</link><pubDate>${new Date(NOW * 1000).toUTCString()}</pubDate></item></channel></rss>`);
  }) as typeof fetch;
  const worker = createNewsShadow({ client: c, fetcher, now: () => now });
  await worker.tick();
  await c.execute(`INSERT INTO signals VALUES (1,'EURUSD','call',80,${NOW + 5},1.1),(2,'EURUSD_otc','call',80,${NOW + 5},1.1)`);
  const original = JSON.stringify((await c.execute('SELECT * FROM signals')).rows);
  const settings = JSON.stringify((await c.execute('SELECT * FROM settings')).rows);
  now += 60; await worker.tick();
  expect(JSON.stringify((await c.execute('SELECT * FROM signals')).rows)).toBe(original);
  expect(JSON.stringify((await c.execute('SELECT * FROM settings')).rows)).toBe(settings);
  const status = await newsStatus(c);
  expect(status.assessments.map((a) => a.symbol)).toEqual(['EURUSD']);
  expect(status.counts.signals).toBe(1);
  const context = JSON.parse(String((await c.execute('SELECT data_json FROM news_shadow_signals')).rows[0]!.data_json));
  expect(context.appliedToLive).toBe(false); expect(context.knowledgeCutoff).toBe(NOW + 5);
  expect((await loadHealth(c)).every((h) => h.error == null)).toBe(true);
});
test("fetch completion is observation time, not start of request", async () => {
  const c = await database(); await initNewsStore(c, NOW); let t = NOW;
  await collectSource(source, undefined, { client: c, now: () => t,
    fetcher: (async () => { t += 10; return new Response(JSON.stringify([{title:'CPI',country:'USD',date:new Date((NOW+600)*1000).toISOString(),impact:'High'}])); }) as typeof fetch });
  expect((await loadEvents(c, NOW + 10))[0]?.firstSeenAt).toBe(NOW + 10);
});