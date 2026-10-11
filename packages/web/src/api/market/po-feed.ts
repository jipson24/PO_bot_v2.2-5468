/**
 * Постоянное WS-соединение с Pocket Option для свечей.
 *
 * Требует рабочий cookie `ssid` (формат `42["auth",{"session":"...","isDemo":1,...}]`).
 * Чат-токен (`sessionToken`) брокер к котировкам не пускает: авторизация проходит
 * молча, а на `changeSymbol`/`loadHistoryPeriod` ответа нет. Поэтому модуль сам
 * определяет, живой ли фид (`feedState`), и при отказе сканер уходит на публичный
 * фид из `candles.ts`.
 */

import type { Candle } from "../strategy/indicators";
import { envFlag, envStr, WS } from "../env";
import { feedHost, rotateHost, wsUrl } from "./po-hosts";
import { pocketUserAgent } from "./po-session";

export { feedHost };

/** События с живыми тиками — по ним замеряем сдвиг часов брокера. */
const STREAM_EVENTS = new Set(["updateStream"]);

/** События, в которых PO присылает историю свечей. */
const CANDLE_EVENTS = new Set([
  "candles",
  "history",
  "loadHistoryPeriod",
  "loadHistoryPeriodFast",
  "updateHistoryNew",
  "updateHistoryNewFast",
]);

/** PO отдаёт не больше 150 свечей за запрос — глубину набираем страницами. */
const PAGE_BARS = 150;
const MAX_PAGES = 6;
/** Как долго набранная история считается свежей. */
const HISTORY_TTL_MS = 50_000;
/** Меньше этого числа свечей стратегии не хватает на m15/m30. */
const MIN_BARS = 180;
/** Период по умолчанию, если событие пришло без привязки к запросу. */
const DEFAULT_PERIOD = 300;
const PAGE_TIMEOUT_MS = 6_000;
const CONNECT_TIMEOUT_MS = 9_000;
/**
 * PO отдаёт котировки в своём серверном времени: метки опережают реальный UTC
 * на фиксированный сдвиг (замерено +7200 с, то есть UTC+2). Живой поток
 * `updateStream` приходит в реальном времени, но с такими же метками, поэтому
 * сдвиг измеряем по данным и округляем до получаса — так переход на летнее
 * время брокера подхватится сам.
 */
const SKEW_GRID_SEC = 1800;
/** Пауза перед переподключением: растёт вдвое, пока брокер не пустит обратно. */
const RECONNECT_MIN_MS = 1_500;
const RECONNECT_MAX_MS = 30_000;

export type FeedState = "idle" | "connecting" | "live" | "unauthorized" | "error";

function authMessage(): string | null {
  const raw = envStr("POCKET_OPTION_SSID");
  if (!raw) return null;
  const match = raw.match(/42\[\s*"auth".*?\}\s*\]/s);
  if (match) return match[0];
  const token = raw.replace(/["'\s]/g, "");
  if (!token) return null;
  const uid = envStr("POCKET_OPTION_UID", "0");
  const isDemo = envFlag("POCKET_OPTION_DEMO", true) ? 1 : 0;
  return `42["auth",{"session":"${token}","isDemo":${isDemo},"uid":${uid},"platform":2}]`;
}

/** Есть ли в SSID классический `session` — только он открывает котировки. */
export function ssidLooksLikeCookie(): boolean {
  const raw = envStr("POCKET_OPTION_SSID");
  if (!raw) return false;
  if (/"session"\s*:/.test(raw)) return true;
  return !raw.startsWith("42[");
}

/** [time, open, close, high, low] или [time, open, high, low, close] — определяем по крайним значениям. */
function fromTuple(row: number[]): Candle | null {
  const [t, a, b, c, d] = row;
  if (t == null || a == null || b == null || c == null || d == null) return null;
  const hi = Math.max(a, b, c, d);
  const lo = Math.min(a, b, c, d);
  if (c === hi && d === lo) return { time: Math.floor(t), open: a, high: c, low: d, close: b };
  if (b === hi && c === lo) return { time: Math.floor(t), open: a, high: b, low: c, close: d };
  return { time: Math.floor(t), open: a, high: hi, low: lo, close: d };
}

function normalize(rows: unknown[]): Candle[] {
  const out: Candle[] = [];
  for (const row of rows) {
    if (Array.isArray(row)) {
      if (row.length >= 5) {
        const candle = fromTuple(row as number[]);
        if (candle) out.push(candle);
      }
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, number>;
    const time = r.time ?? r.t ?? r.timestamp;
    const open = r.open ?? r.o;
    const close = r.close ?? r.c;
    const high = r.high ?? r.h ?? Math.max(open ?? 0, close ?? 0);
    const low = r.low ?? r.l ?? Math.min(open ?? 0, close ?? 0);
    if (time == null || open == null || close == null) continue;
    out.push({ time: Math.floor(time), open, high, low, close });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Тики `[[ts, price], ...]` → свечи нужного периода. */
function fromTicks(rows: unknown[], period: number): Candle[] {
  const buckets = new Map<number, Candle>();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const t = Number(row[0]);
    const p = Number(row[1]);
    if (!Number.isFinite(t) || !Number.isFinite(p)) continue;
    const key = Math.floor(t / period) * period;
    const existing = buckets.get(key);
    if (!existing) buckets.set(key, { time: key, open: p, high: p, low: p, close: p });
    else {
      existing.high = Math.max(existing.high, p);
      existing.low = Math.min(existing.low, p);
      existing.close = p;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

function extract(payload: unknown, period: number): { asset: string | null; candles: Candle[] } {
  if (Array.isArray(payload)) return { asset: null, candles: normalize(payload) };
  if (!payload || typeof payload !== "object") return { asset: null, candles: [] };

  const obj = payload as Record<string, unknown>;
  const asset = typeof obj.asset === "string" ? obj.asset : null;

  for (const key of ["candles", "data", "history_candles"]) {
    const value = obj[key];
    if (Array.isArray(value) && value.length) {
      const candles = normalize(value);
      if (candles.length) return { asset, candles };
    }
  }
  if (Array.isArray(obj.history) && obj.history.length) {
    return { asset, candles: fromTicks(obj.history, period) };
  }
  return { asset, candles: [] };
}

/**
 * Числовые readyState вместо статики глобального WebSocket: в Node 20 глобального
 * WebSocket нет вовсе (появился в 22), а сокет там — из пакета `ws`. Значения
 * фиксированы стандартом, так что константы безопаснее ссылки на глобал.
 */
const WS_CONNECTING = 0;
const WS_OPEN = 1;

let socket: WebSocket | null = null;
let lastAuthedHost = "";
let state: FeedState = "idle";
let stateNote = "";
let lastPayloadAt = 0;
let authedAt = 0;
let clockSkewSec = 0;
let skewKnown = false;
/** Самая свежая метка, которую видел фид: старые страницы истории её не двигают. */
let maxSeenTs = 0;

/**
 * PO сам закрывает простаивающий сокет через пару минут. Раз фид уже
 * понадобился, держим его поднятым: иначе каждый проход сканера начинался бы с
 * переподключения, а состояние в дашборде мигало бы «ошибка».
 */
let keepAlive = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = RECONNECT_MIN_MS;

/** Подписчики страниц истории: ключ — символ пары. */
const listeners = new Map<string, (candles: Candle[]) => void>();
/** Кэш набранной истории, чтобы не гонять страницы на каждый проход сканера. */
const historyCache = new Map<string, { at: number; candles: Candle[] }>();

export function feedState(): {
  state: FeedState;
  note: string;
  lastPayloadAt: number;
  authedAt: number;
  clockSkewSec: number;
} {
  return { state, note: stateNote, lastPayloadAt, authedAt, clockSkewSec };
}

export type FeedStateChange = { state: FeedState; prev: FeedState; note: string };
type FeedWatcher = (change: FeedStateChange) => void;

/**
 * Наблюдатели живут в globalThis: при HMR Vite подменяет модуль, и подписка,
 * сделанная при старте движка, иначе потерялась бы.
 */
const watchScope = globalThis as unknown as { __poFeedWatchers?: Set<FeedWatcher> };
watchScope.__poFeedWatchers ??= new Set<FeedWatcher>();
const watchers = watchScope.__poFeedWatchers;

/** Подписка на смену состояния фида. Возвращает функцию отписки. */
export function watchFeedState(cb: FeedWatcher): () => void {
  watchers.add(cb);
  return () => {
    watchers.delete(cb);
  };
}

/** Единственная точка смены состояния — отсюда уходят события наблюдателям. */
function setState(next: FeedState, note = "") {
  const prev = state;
  state = next;
  stateNote = note;
  if (prev === next) return;
  for (const cb of watchers) {
    try {
      cb({ state: next, prev, note });
    } catch (error) {
      console.error("[po-feed] наблюдатель состояния упал:", (error as Error).message);
    }
  }
}

/** Сдвиг часов брокера относительно реального UTC, в секундах. */
export function poClockSkew(): number {
  return clockSkewSec;
}

/**
 * Замер сдвига по самой свежей метке в пришедших данных. Округление до
 * получаса убирает шум от того, что последняя свеча может быть чуть в прошлом.
 */
function observeSkew(maxTs: number, live: boolean) {
  if (!Number.isFinite(maxTs) || maxTs <= 0) return;
  // Страницы истории уходят в прошлое — по ним сдвиг мерить нельзя.
  if (!live && maxTs <= maxSeenTs) return;
  if (maxTs > maxSeenTs) maxSeenTs = maxTs;
  const snapped = Math.round((maxTs - Date.now() / 1000) / SKEW_GRID_SEC) * SKEW_GRID_SEC;
  if (!skewKnown || snapped !== clockSkewSec) {
    if (skewKnown && snapped !== clockSkewSec) {
      console.log(`[po-feed] сдвиг часов брокера: ${clockSkewSec} → ${snapped} с`);
    }
    clockSkewSec = snapped;
    skewKnown = true;
  }
}

/** Ждём первого замера сдвига: без него первая страница уходит не туда. */
async function waitForSkew(timeoutMs = 2_500): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!skewKnown && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Метки брокера → реальный UTC. Сетка кратна 1800 с, выравнивание не рвётся. */
function toRealClock(candles: Candle[]): Candle[] {
  if (!clockSkewSec) return candles;
  return candles.map((c) => ({ ...c, time: c.time - clockSkewSec }));
}

function settleAll(error: Error) {
  void error;
  listeners.clear();
}

/** Поднять соединение заново после разрыва — с нарастающей паузой. */
function scheduleReconnect() {
  if (!keepAlive || state === "unauthorized" || reconnectTimer) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect().catch(() => {
      /* следующая попытка придёт из обработчика close */
    });
  }, delay);
}

function deliver(asset: string | null, candles: Candle[]) {
  lastPayloadAt = Date.now();
  setState("live");
  if (asset) {
    const exact = listeners.get(asset);
    if (exact) {
      exact(candles);
      return;
    }
    return;
  }
  const first = listeners.values().next();
  if (!first.done) first.value(candles);
}

/** Период последнего запроса истории по паре — нужен для свёртки тиков. */
const askedPeriod = new Map<string, number>();

function cacheKey(asset: string, period: number): string {
  return `${asset}:${period}`;
}

/** Есть ли в наборе последняя закрытая свеча сетки. */
function hasLatestClosed(candles: Candle[], period: number): boolean {
  const last = candles.at(-1);
  if (!last) return false;
  const gridOpen = Math.floor(Date.now() / 1000 / period) * period - period;
  return last.time >= gridOpen;
}

function connect(): Promise<void> {
  if (socket && socket.readyState === WS_OPEN && state === "live") return Promise.resolve();
  if (socket && (socket.readyState === WS_CONNECTING || state === "connecting")) {
    return Promise.resolve();
  }

  const auth = authMessage();
  if (!auth) {
    setState("unauthorized", "POCKET_OPTION_SSID не задан");
    return Promise.reject(new Error(stateNote));
  }

  // Если подъём уже назначен таймером — отменяем: сокет поднимаем здесь.
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  setState("connecting");
  const host = feedHost();
  const url = wsUrl(host);
  /** Дошла ли эта попытка до `successauth`; если нет — сервер меняем. */
  let authed = false;
  let rotated = false;
  const failHost = (reason: string) => {
    if (authed || rotated) return;
    rotated = true;
    rotateHost(reason, host);
  };
  const ws = new WS(url, { headers: { Origin: "https://pocketoption.com", "User-Agent": pocketUserAgent() } });
  ws.binaryType = "arraybuffer";
  socket = ws;

  /**
   * PO присылает события двумя кадрами: текстовый `451-["имя",{placeholder}]`,
   * а сразу за ним — отдельный бинарный кадр с самим JSON. Имя события живёт
   * здесь между этими двумя кадрами.
   */
  let pendingEvent: string | null = null;

  const handlePayload = (event: string, text: string) => {
    if (event === "successauth") {
      authed = true;
      authedAt = Date.now();
      if (lastAuthedHost !== host) {
        console.log(`[po-feed] сессия принята: ${host}`);
        lastAuthedHost = host;
      }
      setState("live");
      reconnectDelayMs = RECONNECT_MIN_MS;
      return;
    }
    const isStream = STREAM_EVENTS.has(event);
    if (!isStream && !CANDLE_EVENTS.has(event)) return;
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }
    if (isStream) {
      // `[["EURCHF_otc", 1789833593.865, 0.92029]]`
      if (Array.isArray(payload)) {
        for (const row of payload) {
          if (Array.isArray(row) && row.length >= 2) observeSkew(Number(row[1]), true);
        }
      }
      return;
    }
    const hint =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).asset
        : null;
    const symbol = typeof hint === "string" ? hint : null;
    const period = (symbol ? askedPeriod.get(symbol) : null) ?? DEFAULT_PERIOD;
    const { asset, candles } = extract(payload, period);
    if (!candles.length) return;
    observeSkew(candles.at(-1)!.time, false);
    deliver(asset ?? symbol, toRealClock(candles));
  };

  const handleText = (text: string) => {
    if (text.startsWith("0{")) {
      ws.send("40");
      return;
    }
    if (text === "2") {
      ws.send("3");
      return;
    }
    if (text.startsWith("40")) {
      ws.send(auth);
      return;
    }
    // `451-["loadHistoryPeriodFast",{"_placeholder":true,"num":0}]`
    const placeholder = text.match(/^\d+-\[\s*"([^"]+)"/);
    if (placeholder) {
      pendingEvent = placeholder[1] ?? null;
      return;
    }
    if (text.startsWith("42[")) {
      try {
        const [event, payload] = JSON.parse(text.slice(2)) as [string, unknown];
        handlePayload(event, JSON.stringify(payload ?? null));
      } catch {
        /* ignore */
      }
      return;
    }
    if (pendingEvent && (text.startsWith("[") || text.startsWith("{"))) {
      const event = pendingEvent;
      pendingEvent = null;
      handlePayload(event, text);
    }
  };

  const handleBinary = (text: string) => {
    const event = pendingEvent;
    pendingEvent = null;
    if (event) handlePayload(event, text);
  };

  ws.addEventListener("message", (event: MessageEvent) => {
    if (socket !== ws) return;
    const data = event.data;
    if (typeof data === "string") {
      handleText(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      handleBinary(new TextDecoder().decode(new Uint8Array(data)));
      return;
    }
    if (data instanceof Uint8Array) {
      handleBinary(new TextDecoder().decode(data));
      return;
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      void data.text().then(handleBinary);
      return;
    }
    handleText(String(data));
  });

  ws.addEventListener("close", () => {
    if (socket !== ws) return;
    if (socket === ws) socket = null;
    if (state !== "unauthorized") {
      setState(
        keepAlive ? "connecting" : "idle",
        keepAlive ? "переподключение" : "соединение закрыто",
      );
    }
    failHost("соединение закрыто до авторизации");
    settleAll(new Error("Pocket Option: соединение закрыто"));
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    if (socket !== ws) return;
    if (socket === ws) socket = null;
    if (state !== "unauthorized") {
      setState(keepAlive ? "connecting" : "error", keepAlive ? "переподключение" : "ошибка WebSocket");
    }
    failHost("ошибка соединения");
    settleAll(new Error("Pocket Option: ошибка WebSocket"));
    scheduleReconnect();
  });

  return new Promise((resolve) => {
    const started = Date.now();
    const check = setInterval(() => {
      const open = ws.readyState === WS_OPEN;
      if (socket !== ws) {
        clearInterval(check);
        resolve();
        return;
      }
      // Ждём именно `successauth`: до него котировки не отдаются.
      if ((open && state === "live") || Date.now() - started > CONNECT_TIMEOUT_MS) {
        clearInterval(check);
        if (!authed) {
          // Висящий TCP-коннект сам не отвалится ещё минуту — рвём и идём дальше.
          failHost(`нет авторизации за ${CONNECT_TIMEOUT_MS / 1000} с`);
          try {
            const raw = ws as unknown as { terminate?: () => void };
            if (raw.terminate) raw.terminate();
            else ws.close();
          } catch {
            /* сокет мог уже закрыться */
          }
        }
        resolve();
      }
    }, 100);
  });
}

/**
 * Свечи по паре с фида PO.
 *
 * PO отдаёт максимум 150 свечей за запрос, поэтому глубину набираем страницами
 * назад: каждая следующая просьба идёт от самой старой уже полученной свечи.
 * Бросает, если фид недоступен или не отдал ничего.
 */
export async function poCandles(asset: string, period = 300, bars = 300): Promise<Candle[]> {
  const want = Math.min(Math.max(bars, MIN_BARS), PAGE_BARS * MAX_PAGES);
  const key = cacheKey(asset, period);

  const cached = historyCache.get(key);
  if (
    cached &&
    Date.now() - cached.at < HISTORY_TTL_MS &&
    cached.candles.length >= MIN_BARS &&
    hasLatestClosed(cached.candles, period)
  ) {
    return cached.candles;
  }

  keepAlive = true;
  await connect();
  const ws = socket;
  if (!ws || ws.readyState !== WS_OPEN) {
    throw new Error(`PO-фид недоступен (${stateNote || state})`);
  }
  await waitForSkew();
  if (listeners.has(asset)) {
    throw new Error(`${asset}: запрос истории уже выполняется`);
  }

  const debug = envFlag("PO_FEED_DEBUG", false);
  askedPeriod.set(asset, period);
  const merged = new Map<number, Candle>();
  let onPage: (() => void) | null = null;

  listeners.set(asset, (candles) => {
    for (const candle of candles) merged.set(candle.time, candle);
    onPage?.();
  });

  const requestPage = (time: number, page: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        onPage = null;
        resolve();
      }, PAGE_TIMEOUT_MS);
      onPage = () => {
        clearTimeout(timer);
        onPage = null;
        resolve();
      };
      ws.send(
        `42["loadHistoryPeriod",{"asset":"${asset}","time":${time},"index":${Date.now() + page},"offset":${period * PAGE_BARS},"period":${period}}]`,
      );
    });

  try {
    ws.send(`42["changeSymbol",{"asset":"${asset}","period":${period}}]`);
    // `time` в запросе PO ждёт в своих серверных часах, а в merged метки уже
    // переведены в реальный UTC — поэтому сдвиг возвращаем обратно.
    let cursor = Math.floor(Date.now() / 1000) + clockSkewSec;
    let empty = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const before = merged.size;
      await requestPage(cursor, page);
      const added = merged.size - before;
      if (debug) {
        console.log(`[po-feed] ${asset} страница ${page}: +${added} → ${merged.size}`);
      }
      if (merged.size >= want) break;
      // Одну пустую страницу прощаем: PO иногда молча теряет запрос.
      // Две подряд — истории глубже нет либо фид отвалился.
      if (added === 0 && ++empty >= 2) break;
      if (added > 0) empty = 0;
      cursor = Math.min(...merged.keys()) + clockSkewSec - period;
    }
  } finally {
    listeners.delete(asset);
  }

  const candles = [...merged.values()].sort((a, b) => a.time - b.time);
  if (!candles.length) {
    if (state !== "live") {
      setState("unauthorized", "PO не отвечает на запрос свечей — нужен рабочий cookie ssid");
    }
    throw new Error(`${asset}: PO не отдал свечи (нужен рабочий cookie ssid)`);
  }
  historyCache.set(key, { at: Date.now(), candles });
  return candles;
}

/** Смена сессии: закрыть старый сокет/кэш и дождаться successauth нового. */
export function reconnectFeed(timeoutMs = 35_000): Promise<boolean> {
  const old = socket;
  socket = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  keepAlive = true;
  reconnectDelayMs = RECONNECT_MIN_MS;
  historyCache.clear();
  listeners.clear();
  askedPeriod.clear();
  authedAt = 0;
  lastPayloadAt = 0;
  lastAuthedHost = "";
  setState("idle");
  try {
    const raw = old as (WebSocket & { terminate?: () => void }) | null;
    if (raw?.terminate) raw.terminate();
    else raw?.close();
  } catch { /* старый сокет уже закрыт */ }
  return new Promise((resolve) => {
    const unsubscribe = watchFeedState((change) => {
      if (change.state !== "live") return;
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
    const timer = setTimeout(() => { unsubscribe(); resolve(false); }, timeoutMs);
    void connect().catch(() => scheduleReconnect());
  });
}

/** Мягкая проверка фида: один запрос, без исключения. */
export async function probeFeed(asset = "EURUSD_otc"): Promise<boolean> {
  try {
    const candles = await poCandles(asset, 300, 120);
    return candles.length > 0;
  } catch {
    return false;
  }
}
