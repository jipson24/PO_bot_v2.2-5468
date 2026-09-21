import type { Candle } from "../strategy/indicators";
import { poCandles, ssidLooksLikeCookie } from "./po-feed";

/**
 * Источник свечей. Сейчас работает публичный фид (реальные валютные пары).
 * Pocket Option отдаёт свечи только по валидному cookie `ssid` — как только он
 * появится в .env, `pocket-option.ts` начнёт отдавать свечи и для OTC-пар,
 * а этот модуль останется резервом.
 */

export interface CandleSet {
  m5: Candle[];
  m15: Candle[];
  m30: Candle[];
  lastCandleAt: number;
  source: string;
}

interface CacheEntry {
  at: number;
  data: Candle[];
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 55_000;
/** Минимальная пауза между запросами, когда новой свечи в кеше ещё нет. */
const MIN_REFETCH_MS = 20_000;

/**
 * Символ Pocket Option → символ публичного фида (Yahoo). OTC не покрывается
 * вообще: такие котировки существуют только у брокера.
 *
 * Крипта, сырьё и акции у PO живут почти целиком в OTC, поэтому публичный
 * маппинг для них — узкий резерв на не-OTC символы. Составляем его явными
 * таблицами: угадывание по форме символа давало бы битые тикеры вида
 * `BTCUSD=X` или `UKBrent=X`, по которым фид молча вернул бы пустоту.
 */
const CRYPTO_FEED: Record<string, string> = {
  BTCUSD: "BTC-USD",
  ETHUSD: "ETH-USD",
  LTCUSD: "LTC-USD",
  LNKUSD: "LINK-USD",
  DASH_USD: "DASH-USD",
  BTCGBP: "BTC-GBP",
  BTCJPY: "BTC-JPY",
  BCHEUR: "BCH-EUR",
  BCHGBP: "BCH-GBP",
  BCHJPY: "BCH-JPY",
};

const COMMODITY_FEED: Record<string, string> = {
  XAUUSD: "GC=F",
  XAGUSD: "SI=F",
  XPTUSD: "PL=F",
  XPDUSD: "PA=F",
  UKBrent: "BZ=F",
  USCrude: "CL=F",
};

const INDEX_FEED: Record<string, string> = {
  SP500: "^GSPC",
  NASUSD: "^NDX",
  DJI30: "^DJI",
  JPN225: "^N225",
  D30EUR: "^GDAXI",
  F40EUR: "^FCHI",
  E50EUR: "^STOXX50E",
  "100GBP": "^FTSE",
  H33HKD: "^HSI",
  AUS200: "^AXJO",
};

/** Тикеры PO, которые не совпадают с биржевыми. */
const STOCK_FEED: Record<string, string> = {
  VISA: "V",
  CITI: "C",
  FB: "META",
};

export function toFeedSymbol(poSymbol: string, kind?: string): string | null {
  if (poSymbol.endsWith("_otc")) return null;
  const base = poSymbol.replace(/_otc$/, "");

  switch (kind) {
    case "cryptocurrency":
      return CRYPTO_FEED[base] ?? null;
    case "commodity":
      return COMMODITY_FEED[base] ?? null;
    case "index":
      return INDEX_FEED[base] ?? null;
    case "stock": {
      // У PO тикеры акций идут с решёткой: `#MSFT`, `#AAPL`.
      const ticker = base.replace(/^#/, "").toUpperCase();
      if (STOCK_FEED[ticker]) return STOCK_FEED[ticker];
      return /^[A-Z]{1,5}$/.test(ticker) ? ticker : null;
    }
    default:
      // Валюты (и вызовы без kind — старое поведение): шестибуквенная пара.
      return /^[A-Z]{6}$/.test(base) ? `${base}=X` : null;
  }
}

export function isOtc(poSymbol: string): boolean {
  return poSymbol.endsWith("_otc");
}

async function fetchFiveMinute(feedSymbol: string): Promise<Candle[]> {
  // Открытие последней закрытой свечи по 5-минутной сетке.
  const gridOpen = Math.floor(Date.now() / 1000 / 300) * 300 - 300;
  const cached = cache.get(feedSymbol);
  if (cached) {
    const age = Date.now() - cached.at;
    const hasLatest = (cached.data.at(-1)?.time ?? 0) >= gridOpen;
    // Кеш с актуальной свечой живёт полный TTL. Если только что закрылась новая
    // свеча, а в кеше её нет — идём за данными сразу (скан выровнен по закрытию),
    // но не чаще MIN_REFETCH_MS: при закрытом рынке новых свечей всё равно не будет.
    if (hasLatest ? age < CACHE_TTL_MS : age < MIN_REFETCH_MS) return cached.data;
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    feedSymbol,
  )}?interval=5m&range=5d`;

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`feed ${feedSymbol}: HTTP ${res.status}`);

  const json = (await res.json()) as {
    chart?: {
      result?: {
        timestamp?: number[];
        indicators?: {
          quote?: {
            open?: (number | null)[];
            high?: (number | null)[];
            low?: (number | null)[];
            close?: (number | null)[];
          }[];
        };
      }[];
      error?: { description?: string } | null;
    };
  };

  const result = json.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const ts = result?.timestamp;
  if (!ts || !quote) throw new Error(`feed ${feedSymbol}: пустой ответ`);

  const candles: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = quote.open?.[i];
    const h = quote.high?.[i];
    const l = quote.low?.[i];
    const c = quote.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    // Фид иногда отдаёт «плоские» свечи (o=h=l=c) на неликвидных минутах — они не несут информации,
    // но нужны для непрерывности, поэтому оставляем.
    candles.push({ time: ts[i]!, open: o, high: h, low: l, close: c });
  }

  // Отбрасываем незакрытую свечу.
  const now = Math.floor(Date.now() / 1000);
  while (candles.length && candles.at(-1)!.time + 300 > now) candles.pop();

  cache.set(feedSymbol, { at: Date.now(), data: candles });
  return candles;
}

/** Агрегация младших свечей в старший таймфрейм по UTC-сетке. */
export function aggregate(candles: Candle[], bucketSeconds: number): Candle[] {
  const buckets = new Map<number, Candle>();
  for (const c of candles) {
    const key = Math.floor(c.time / bucketSeconds) * bucketSeconds;
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, { time: key, open: c.open, high: c.high, low: c.low, close: c.close });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close;
    }
  }
  const out = [...buckets.values()].sort((a, b) => a.time - b.time);
  // Последний бакет может быть неполным — отбрасываем.
  const now = Math.floor(Date.now() / 1000);
  while (out.length && out.at(-1)!.time + bucketSeconds > now) out.pop();
  return out;
}

/** Собрать набор таймфреймов из 5-минутных свечей. */
function buildSet(m5: Candle[], source: string): CandleSet {
  return {
    m5,
    m15: aggregate(m5, 900),
    m30: aggregate(m5, 1800),
    lastCandleAt: m5.at(-1)!.time,
    source,
  };
}

/**
 * Свечи по паре: сначала родной фид Pocket Option (единственный источник для OTC),
 * затем публичный фид для обычных валютных пар.
 */
export async function getCandleSet(poSymbol: string): Promise<CandleSet> {
  if (ssidLooksLikeCookie()) {
    try {
      // 240 свечей = 20 ч: хватает на m30 (≥30) и m15 (≥40) и это всего две
      // страницы по 150 — глубже запрашивать значит удвоить время прохода.
      const m5 = await poCandles(poSymbol, 300, 240);
      if (m5.length >= 60) return buildSet(m5, "pocket-option");
    } catch (error) {
      if (isOtc(poSymbol)) throw error;
    }
  }

  const feedSymbol = toFeedSymbol(poSymbol);
  if (!feedSymbol) {
    throw new Error(
      `${poSymbol}: OTC-пара — публичного фида нет, нужен рабочий cookie ssid Pocket Option`,
    );
  }
  const m5 = await fetchFiveMinute(feedSymbol);
  if (m5.length < 60) throw new Error(`${poSymbol}: мало свечей (${m5.length})`);
  return buildSet(m5, "public-feed");
}

/** Свежесть данных: старше 20 минут — рынок закрыт или фид отвалился. */
export function isStale(lastCandleAt: number): boolean {
  return Date.now() / 1000 - lastCandleAt > 20 * 60;
}
