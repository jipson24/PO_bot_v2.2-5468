import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import type { NewsAsset, NewsEvent, NewsSource } from "./types";

export const BASE_SOURCES: NewsSource[] = [
  { id: "ff-calendar", label: "Forex Factory / Fair Economy weekly calendar", url: "https://nfs.faireconomy.media/ff_calendar_thisweek.json", category: "calendar", intervalSec: 3600, staleSec: 10800 },
  { id: "fed", label: "Federal Reserve — Monetary Policy", url: "https://www.federalreserve.gov/feeds/press_monetary.xml", category: "central_bank", currency: "USD", intervalSec: 300, staleSec: 1800 },
  { id: "ecb", label: "ECB press releases", url: "https://www.ecb.europa.eu/rss/press.html", category: "central_bank", currency: "EUR", intervalSec: 300, staleSec: 1800 },
  { id: "bbc-world", label: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", category: "world", intervalSec: 300, staleSec: 1800 },
  { id: "bbc-business", label: "BBC Business", url: "https://feeds.bbci.co.uk/news/business/rss.xml", category: "world", intervalSec: 300, staleSec: 1800 },
  { id: "coindesk", label: "CoinDesk RSS", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", category: "crypto", intervalSec: 300, staleSec: 1800 },
];

const COMPANY: Record<string, string> = {
  AAPL: "Apple", AXP: "American Express", BA: "Boeing", CSCO: "Cisco", FB: "Meta Platforms",
  INTC: "Intel", JNJ: "Johnson & Johnson", JPM: "JPMorgan", MCD: "McDonalds", MSFT: "Microsoft",
  PFE: "Pfizer", TSLA: "Tesla", XOM: "ExxonMobil", BABA: "Alibaba", CITI: "Citigroup", NFLX: "Netflix",
};
export function sourcesForAssets(assets: NewsAsset[]): NewsSource[] {
  const stocks = assets.filter((a) => !a.isOtc && a.kind === "stock").slice(0, 50);
  return [...BASE_SOURCES, ...stocks.map((a) => {
    const name = COMPANY[a.symbol.replace(/^#/, "")] ?? a.name;
    const query = `"${name}" (earnings OR acquisition OR merger OR lawsuit OR dividend OR guidance) when:7d`;
    return { id: `corporate-${a.symbol}`, label: `Google News RSS — ${name} (aggregate, not filings)`,
      url: `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
      category: "corporate" as const, asset: a.symbol, intervalSec: 1800, staleSec: 5400 };
  })];
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function stamp(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const n = Date.parse(s); return Number.isFinite(n) ? Math.floor(n / 1000) : null;
}
function clean(v: unknown): string {
  return typeof v === "string" ? v.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200) : "";
}
export function tagsForTitle(title: string): string[] {
  const t = title.toLowerCase(), tags: string[] = [];
  if (/war|missile|invasion|sanction|ceasefire|military|geopolitic/.test(t)) tags.push("geopolitics");
  if (/interest rate|rate cut|rate hike|inflation|\bcpi\b|\bgdp\b|payroll|employment|unemployment|fomc|monetary/.test(t)) tags.push("macro");
  if (/etf|regulat|sec\b|exchange|hack|exploit|breach|bankrupt/.test(t)) tags.push("crypto-policy-security");
  if (/earnings|guidance|revenue|profit|quarter|acquisition|merger|dividend|lawsuit/.test(t)) tags.push("corporate");
  return tags;
}
export function currenciesForTitle(title: string): string[] {
  const rules: [string, RegExp][] = [
    ["USD", /\bus\b|\bu\.s\.|united states|federal reserve|\bfed\b|american|\bfomc\b|dollar/i],
    ["EUR", /euro|\becb\b|german|france|french|european central/i],
    ["GBP", /british|britain|\buk\b|bank of england|sterling/i],
    ["JPY", /japan|\bboj\b|\byen\b/i], ["CAD", /canada|canadian|bank of canada/i],
    ["AUD", /australia|\brba\b/i], ["NZD", /new zealand|\brbnz\b/i], ["CHF", /swiss|switzerland|\bsnb\b/i],
  ];
  return rules.filter(([, r]) => r.test(title)).map(([c]) => c);
}
function revision(e: Omit<NewsEvent, "id">): NewsEvent {
  // Immutable revisions: observed time is NOT part of id. Changed content creates a new observation.
  const { firstSeenAt, ...content } = e;
  return { ...e, id: hash(JSON.stringify(content)) };
}
export function parseCalendar(data: unknown, source: NewsSource, now: number): NewsEvent[] {
  if (!Array.isArray(data)) throw new Error("calendar schema: expected array");
  return data.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const title = clean(row.title), date = stamp(row.date), currency = clean(row.country);
    if (!title || date == null || !/^[A-Z]{3}$/.test(currency) || row.impact === "Holiday") return [];
    return [revision({ eventKey: hash(`calendar:${title}:${currency}:${date}`), source: source.id,
      category: "calendar", title, url: "https://www.forexfactory.com/calendar", publishedAt: null,
      scheduledAt: date, firstSeenAt: now, impact: row.impact === "High" ? "high" : row.impact === "Medium" ? "medium" : "low",
      currencies: [currency], assets: [], tags: ["macro"], forecast: clean(row.forecast) || null,
      previous: clean(row.previous) || null, actual: clean(row.actual) || null })];
  });
}

const xml = new XMLParser({ ignoreAttributes: false, processEntities: true, trimValues: true,
  isArray: (name) => name === "item" || name === "entry", htmlEntities: true });
export function parseRss(text: string, source: NewsSource, now: number): NewsEvent[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("DTD/entities are not accepted");
  const parsed = xml.parse(text), rows = parsed.rss?.channel?.item ?? parsed.feed?.entry;
  if (!Array.isArray(rows)) throw new Error("RSS schema: no entries");
  return rows.slice(0, 150).flatMap((item: any) => {
    const title = clean(item.title?.["#text"] ?? item.title);
    const link = clean(item.link?.["@_href"] ?? item.link);
    const publishedAt = stamp(item.pubDate ?? item.published ?? item.updated);
    // An undated or future-dated headline is not usable as a known historical event.
    if (!title || !/^https?:\/\//i.test(link) || publishedAt == null || publishedAt > now + 60) return [];
    const tags = tagsForTitle(title);
    return [revision({ eventKey: hash(`${source.id}:${link}`), source: source.id, category: source.category,
      title, url: link, publishedAt, scheduledAt: null, firstSeenAt: now,
      impact: source.category === "central_bank" ? (tags.includes("macro") ? "high" : "medium") :
        tags.includes("geopolitics") || tags.includes("crypto-policy-security") ? "high" : "unknown",
      currencies: source.currency ? [source.currency] : currenciesForTitle(title),
      assets: source.asset ? [source.asset] : [], tags, forecast: null, previous: null, actual: null })];
  });
}