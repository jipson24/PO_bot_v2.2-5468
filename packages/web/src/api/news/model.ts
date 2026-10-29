import type { NewsAsset, NewsAssessment, NewsEvent, NewsSource, SourceHealth } from "./types";

export const NEWS_VERSION = "news-shadow-v1-risk-only";
export const HORIZONS = [-15, -5, 1, 5, 15, 30] as const;
const FX = new Set(["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"]);
export function assetCurrencies(asset: NewsAsset): string[] {
  const symbol = asset.symbol.replace(/^#/, "").replace(/_/g, "").toUpperCase();
  if (asset.kind === "currency") return [symbol.slice(0, 3), symbol.slice(3, 6)].filter((c) => FX.has(c));
  return [...FX].filter((c) => symbol.endsWith(c));
}
export function relevantTo(event: NewsEvent, asset: NewsAsset): boolean {
  if (asset.isOtc || /_otc$/i.test(asset.symbol)) return false;
  if (event.assets.includes(asset.symbol)) return true;
  if (event.category === "corporate") return false;
  if (event.category === "crypto") return asset.kind === "cryptocurrency";
  if (event.tags.includes("geopolitics")) return true; // broad risk, NOT a directional vote
  const currencies = assetCurrencies(asset);
  if (event.currencies.some((c) => currencies.includes(c))) return true;
  // USD macro spillover into non-FX is only a risk flag, never a predicted sign.
  return event.currencies.includes("USD") && event.tags.includes("macro") && asset.kind !== "currency";
}

export function asOfEvents(events: NewsEvent[], asOf: number): NewsEvent[] {
  const revisions = new Map<string, NewsEvent>();
  for (const e of events) {
    if (e.firstSeenAt > asOf || (e.publishedAt != null && e.publishedAt > asOf)) continue;
    const old = revisions.get(e.eventKey);
    if (!old || old.firstSeenAt < e.firstSeenAt) revisions.set(e.eventKey, e);
  }
  return [...revisions.values()];
}

export function assessNews(asset: NewsAsset, events: NewsEvent[], sources: NewsSource[], health: SourceHealth[], asOf: number): NewsAssessment {
  const gaps: string[] = ["unlicensed-global-coverage-incomplete", "weights-uncalibrated", "headline-direction-not-inferred"];
  if (asset.isOtc || /_otc$/i.test(asset.symbol)) return {
    version: NEWS_VERSION, mode: "shadow", symbol: asset.symbol, asOf, risk: null,
    proposedConfidenceMultiplier: null, liveConfidenceMultiplier: 1, direction: null,
    events: [], gaps: ["otc-excluded"],
  };
  const needed = sources.filter((s) => s.category === "calendar" || s.category === "world" || s.category === "central_bank" ||
    (s.category === "crypto" && asset.kind === "cryptocurrency") || (s.asset === asset.symbol));
  for (const s of needed) {
    const h = health.filter((h) => h.source === s.id && h.checkedAt <= asOf).sort((a, b) => b.checkedAt - a.checkedAt)[0];
    if (!h || h.lastOkAt == null || asOf - h.lastOkAt > s.staleSec) gaps.push(`source-unavailable:${s.id}`);
    else if (h.error) gaps.push(`source-degraded:${s.id}`);
  }
  if (asset.kind === "stock") gaps.push("no-structured-earnings-calendar", "no-sec-filings-feed");
  if (asset.kind === "commodity") gaps.push("no-opec-inventory-feed");
  const mapped = asOfEvents(events, asOf).filter((e) => relevantTo(e, asset)).flatMap((e) => {
    const at = e.scheduledAt ?? e.publishedAt ?? e.firstSeenAt;
    const dt = at - asOf;
    let risk = 0;
    if (e.category === "calendar") {
      if (e.impact === "high" && Math.abs(dt) <= 1800) risk = dt >= 0 || dt >= -300 ? 3 : 2;
      else if (e.impact === "medium" && Math.abs(dt) <= 900) risk = 2;
      if (risk && !e.actual) gaps.push(`actual-missing:${e.id.slice(0, 12)}`);
    } else if (dt <= 0 && dt >= -7200) {
      if (e.tags.length > 0 || e.category === "central_bank") risk = e.impact === "high" && dt >= -900 ? 3 : 2;
    }
    if (!risk) return [];
    const lag = e.publishedAt == null ? 0 : e.firstSeenAt - e.publishedAt;
    if (lag > 300) gaps.push(`headline-lag:${e.source}:${lag}s`);
    return [{ id: e.id, title: e.title, source: e.source, phase: dt > 0 ? "before" as const : "after" as const,
      secondsToEvent: dt, risk, url: e.url }];
  });
  // Duplicate stories cannot amplify weight: max risk, not sum or source count.
  const dedup = new Map<string, typeof mapped[number]>();
  for (const e of mapped) dedup.set(e.title.toLowerCase().replace(/\W+/g, " "), e);
  const relevant = [...dedup.values()].sort((a, b) => b.risk - a.risk || Math.abs(a.secondsToEvent) - Math.abs(b.secondsToEvent)).slice(0, 12);
  const available = needed.some((s) => health.some((h) => h.source === s.id && h.checkedAt <= asOf &&
    h.lastOkAt != null && asOf - h.lastOkAt <= s.staleSec));
  const risk = available ? Math.max(0, ...relevant.map((e) => e.risk)) : null;
  return { version: NEWS_VERSION, mode: "shadow", symbol: asset.symbol, asOf, risk,
    proposedConfidenceMultiplier: risk == null ? null : [1, 0.95, 0.85, 0.7][risk]!,
    liveConfidenceMultiplier: 1, direction: null, events: relevant, gaps: [...new Set(gaps)] };
}

export interface TapeBar { time: number; close: number }
/** Price association, not causality. Only completed exact M1 bars; no interpolation. */
export function priceReaction(bars: TapeBar[], referenceAt: number, now: number) {
  const referenceClose = Math.floor(referenceAt / 60) * 60;
  const closeAt = (t: number) => bars.find((b) => b.time + 60 === t && b.time + 60 <= now)?.close ?? null;
  const base = closeAt(referenceClose);
  const returns = Object.fromEntries(HORIZONS.map((m) => {
    const p = closeAt(referenceClose + m * 60);
    return [String(m), base != null && base > 0 && p != null ? (p / base - 1) * 100 : null];
  }));
  return { referenceAt, referenceClose, basePrice: base, returnsPct: returns,
    missingHorizons: HORIZONS.filter((m) => returns[String(m)] == null),
    basis: "broker-m1-tape; rounded down to minute; close-to-close; association-not-causation" };
}