import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { getCandleSet, isStale, toFeedSymbol } from "../market/candles";
import { ssidLooksLikeCookie } from "../market/po-feed";
import { getAssets } from "../market/pocket-option";
import { kyivHour } from "../lib/day";
import { analyze } from "../strategy/analyze";
import { buildSnapshot } from "../strategy/snapshot";
import {
  getSettings,
  isExcluded,
  parseAssetClasses,
  parseBlockedHours,
  parseExcluded,
} from "./store";
import { publishSignal } from "./telegram";

export interface ScanOutcome {
  scanned: number;
  signals: number;
  errors: number;
  durationMs: number;
  note: string;
  skipped: { symbol: string; reason: string }[];
  candidates: {
    symbol: string;
    name: string;
    direction: string | null;
    confidence: number;
    blockers: string[];
  }[];
}

/** Синхронизация списка активов и payout из Pocket Option. */
export async function syncAssets(): Promise<{ total: number; tradable: number }> {
  const snapshot = await getAssets();
  const settings = await getSettings();
  const now = new Date();

  const poFeed = ssidLooksLikeCookie();
  // Классы активов из настроек: валюты, крипта, сырьё, акции, индексы.
  const classes = parseAssetClasses(settings.assetClasses);
  const selected = snapshot.assets.filter((a) => classes.has(a.kind as never));
  for (const asset of selected) {
    const feedSymbol = toFeedSymbol(asset.symbol, asset.kind);
    // OTC-котировки существуют только у PO: без cookie ssid пара остаётся в ожидании.
    const feedStatus = feedSymbol ? "ok" : poFeed ? "ok" : "needs_po_feed";
    await db
      .insert(schema.assets)
      .values({
        symbol: asset.symbol,
        name: asset.name,
        kind: asset.kind,
        isOtc: asset.isOtc,
        payout: asset.payout,
        isActive: asset.isActive,
        feedSymbol,
        feedStatus,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.assets.symbol,
        set: {
          name: asset.name,
          payout: asset.payout,
          isActive: asset.isActive,
          feedSymbol,
          feedStatus,
          updatedAt: now,
        },
      });
  }

  const tradable = selected.filter(
    (a) => a.payout >= settings.minPayout && a.payout <= settings.maxPayout,
  );
  return { total: selected.length, tradable: tradable.length };
}

/**
 * Пары под сканирование: payout в диапазоне + есть источник свечей.
 *
 * Если в диапазоне 82–92% нет ни одной пары с живым фидом (сейчас так: весь
 * диапазон — OTC, а их котировки отдаёт только PO с cookie ssid), то при
 * включённом `fallbackPairs` в работу берутся обычные валютные пары с
 * публичным фидом — иначе сканер молчал бы полностью.
 */
/** Ниже этого числа живых пар в диапазоне подмешиваем резервный пул. */
const MIN_READY = 8;

/**
 * Минимальный запас до экспирации на момент публикации. Если свеча закрылась
 * давно и сделку уже не открыть — сигнал не отправляем вообще.
 */
const MIN_ENTRY_WINDOW_MS = 120_000;

async function watchlist(): Promise<{ list: (typeof schema.assets.$inferSelect)[]; fallback: boolean }> {
  const settings = await getSettings();
  const all = await db.select().from(schema.assets).orderBy(desc(schema.assets.payout));

  // Ручной чёрный список пар (настройки) — убираем до всех прочих фильтров,
  // чтобы исключённые символы не попали ни в диапазон, ни в резервный пул.
  const excluded = parseExcluded(settings.excludedSymbols);
  const notExcluded = excluded.size ? all.filter((a) => !isExcluded(a.symbol, excluded)) : all;

  // Класс активов выключили — его строки остаются в БД с прошлых синхронизаций,
  // поэтому фильтруем ещё и здесь, а не только на приёме снепшота.
  const classes = parseAssetClasses(settings.assetClasses);
  const rows = notExcluded.filter((a) => classes.has(a.kind as never));

  const inRange = rows.filter(
    (a) =>
      a.isActive && a.payout >= settings.minPayout && a.payout <= settings.maxPayout,
  );
  const ready = inRange.filter((a) => a.feedStatus === "ok");
  if (!settings.fallbackPairs) return { list: inRange, fallback: false };

  // Резерв нужен не только когда в диапазоне пусто: в сессию у одной-двух
  // обычных пар payout заходит в диапазон, и без объединения охват падал бы с
  // 21 пары до одной. Поэтому добавляем резерв, пока живых пар в диапазоне
  // меньше MIN_READY.
  if (ready.length >= MIN_READY) return { list: inRange, fallback: false };

  // Обычные пары PO часто помечает неактивными вне сессии, но публичный фид
  // по ним живой — свежесть всё равно проверит isStale в основном цикле.
  // Резерв держим валютным: публичный фид надёжно покрывает только FX, а по
  // не-OTC крипте/сырью/акциям payout у брокера 15–45% и до диапазона не доходит.
  const spare = rows.filter((a) => !a.isOtc && a.kind === "currency" && a.feedStatus === "ok");
  if (spare.length === 0) return { list: inRange, fallback: false };

  const bySymbol = new Map<string, typeof schema.assets.$inferSelect>();
  for (const a of [...inRange, ...spare]) bySymbol.set(a.symbol, a);
  return { list: [...bySymbol.values()], fallback: ready.length === 0 };
}

async function recentSignal(symbol: string, cooldownMinutes: number) {
  const since = new Date(Date.now() - cooldownMinutes * 60_000);
  const rows = await db
    .select()
    .from(schema.signals)
    .where(and(eq(schema.signals.symbol, symbol), gte(schema.signals.createdAt, since)))
    .limit(1);
  return rows[0];
}

/**
 * Один проход сканера по watchlist.
 *
 * `publish: false` — проход только обновляет payout, фиды и список кандидатов,
 * не создавая сигналов: так делают промежуточные проходы между закрытиями 5m
 * свечей, потому что весь анализ строится на закрытых свечах и до следующего
 * закрытия результат не меняется.
 */
export async function runScan(opts: { publish?: boolean } = {}): Promise<ScanOutcome> {
  const publish = opts.publish ?? true;
  const startedAt = new Date();
  const started = Date.now();
  const settings = await getSettings();
  const blockedHours = parseBlockedHours(settings.blockedHours);
  const skipped: ScanOutcome["skipped"] = [];
  const candidates: ScanOutcome["candidates"] = [];
  let scanned = 0;
  let signals = 0;
  let errors = 0;
  let note = "";

  try {
    await syncAssets();
  } catch (error) {
    note = `активы PO недоступны: ${(error as Error).message}`;
  }

  const wl = await watchlist();
  if (wl.fallback) {
    const prefix = "в диапазоне payout нет пар с живым фидом (OTC ждут cookie ssid) — сканирую обычные пары";
    note = note ? `${note}; ${prefix}` : prefix;
  }

  for (const asset of wl.list) {
    if (asset.feedStatus !== "ok") {
      skipped.push({ symbol: asset.symbol, reason: "нет фида свечей (нужен ssid PO)" });
      continue;
    }

    try {
      const set = await getCandleSet(asset.symbol);
      if (isStale(set.lastCandleAt)) {
        skipped.push({ symbol: asset.symbol, reason: "данные устарели (рынок закрыт)" });
        await db
          .update(schema.assets)
          .set({ lastCandleAt: new Date(set.lastCandleAt * 1000) })
          .where(eq(schema.assets.symbol, asset.symbol));
        continue;
      }
      if (set.m30.length < 30 || set.m15.length < 40) {
        skipped.push({ symbol: asset.symbol, reason: "мало истории" });
        continue;
      }

      scanned += 1;
      const result = analyze(set);
      candidates.push({
        symbol: asset.symbol,
        name: asset.name,
        direction: result.direction,
        confidence: result.confidence,
        blockers: result.blockers,
      });

      await db
        .update(schema.assets)
        .set({ lastCandleAt: new Date(set.lastCandleAt * 1000) })
        .where(eq(schema.assets.symbol, asset.symbol));

      const passes =
        result.direction !== null &&
        result.confidence >= settings.minConfidence &&
        result.blockers.length === 0;
      if (!passes) continue;

      if (!publish) {
        skipped.push({ symbol: asset.symbol, reason: "сетап есть — ждём закрытия 5m свечи" });
        continue;
      }

      const dup = await recentSignal(asset.symbol, settings.cooldownMinutes);
      if (dup) {
        skipped.push({ symbol: asset.symbol, reason: "кулдаун после недавнего сигнала" });
        continue;
      }

      // Вход — по закрытию последней 5m свечи (её close и есть result.price),
      // поэтому и экспирацию считаем от этого момента, а не от времени вставки.
      const entryAt = new Date((set.lastCandleAt + 300) * 1000);
      const expiresAt = new Date(entryAt.getTime() + result.expirySeconds * 1000);

      // Закрытые часы считаем по времени входа, а не по «сейчас»: в статистике
      // группировка идёт по entry_at, и фильтр должен резать ровно то же.
      const hour = kyivHour(entryAt);
      if (blockedHours.has(hour)) {
        skipped.push({
          symbol: asset.symbol,
          reason: `час ${String(hour).padStart(2, "0")}:00 по Киеву закрыт настройками`,
        });
        continue;
      }

      const leftMs = expiresAt.getTime() - Date.now();
      if (leftMs < MIN_ENTRY_WINDOW_MS) {
        skipped.push({
          symbol: asset.symbol,
          reason: `до экспирации ${Math.round(leftMs / 1000)} сек — меньше минимального окна входа`,
        });
        continue;
      }

      const lowPayout = asset.payout < settings.minPayout || asset.payout > settings.maxPayout;
      // Архив входа: по нему ежедневный отчёт разбирает причины убытков.
      const snapshot = buildSnapshot({
        set,
        analysis: result,
        asset: {
          symbol: asset.symbol,
          name: asset.name,
          isOtc: asset.isOtc,
          payout: asset.payout,
        },
        lowPayout,
        settings,
        entryAt,
      });

      const [signal] = await db
        .insert(schema.signals)
        .values({
          symbol: asset.symbol,
          assetName: asset.name,
          direction: result.direction!,
          confidence: result.confidence,
          score: result.score,
          payout: asset.payout,
          lowPayout,
          price: result.price,
          expirySeconds: result.expirySeconds,
          entryAt,
          expiresAt,
          biasH30: result.biasH30,
          biasM15: result.biasM15,
          triggerM5: result.triggerM5,
          reasons: result.reasons,
          details: result.details,
          factors: result.factors,
          snapshot,
          tradeDay: snapshot.tradeDay,
        })
        .returning();

      if (signal) {
        signals += 1;
        const lagSec = Math.round((Date.now() - entryAt.getTime()) / 1000);
        console.log(
          `[scanner] сигнал ${signal.symbol} ${signal.direction} · payout ${signal.payout}%${
            signal.lowPayout ? " (вне диапазона)" : ""
          } · лаг от закрытия свечи ${lagSec} сек`,
        );
        void publishSignal(signal).catch((error) =>
          console.error("[scanner] telegram:", (error as Error).message),
        );
      }
    } catch (error) {
      errors += 1;
      skipped.push({ symbol: asset.symbol, reason: (error as Error).message });
    }
  }

  const durationMs = Date.now() - started;
  await db.insert(schema.scanRuns).values({
    startedAt,
    durationMs,
    scanned,
    signalsFound: signals,
    errors,
    note: note || null,
  });

  return { scanned, signals, errors, durationMs, note, skipped, candidates };
}

/**
 * Таймер живёт в globalThis: после HMR старый таймер держал бы прежнюю копию
 * кода (и сканировал по устаревшей логике). При загрузке модуля старый таймер
 * гасится и поднимается новый — с актуальным `tick`.
 */
interface ScanState {
  timer: ReturnType<typeof setTimeout> | null;
  intervalSec: number;
  running: boolean;
}

const scanScope = globalThis as unknown as { __poScanner?: ScanState };
const state: ScanState = (scanScope.__poScanner ??= {
  timer: null,
  intervalSec: 60,
  running: false,
});

/** Сетка 5m и задержка после закрытия свечи — фиду нужно её опубликовать. */
const GRID_SEC = 300;
const ALIGN_LAG_SEC = 5;

/** Ближайший момент «закрытие 5m свечи + задержка» после `from`. */
function nextAlignedAt(from: number): number {
  const sec = Math.ceil((from / 1000 - ALIGN_LAG_SEC) / GRID_SEC) * GRID_SEC + ALIGN_LAG_SEC;
  return sec * 1000;
}

async function tick(publish: boolean) {
  if (state.running) return;
  state.running = true;
  try {
    const settings = await getSettings();
    if (!settings.scannerEnabled) return;
    if (settings.scanIntervalSec !== state.intervalSec) {
      state.intervalSec = Math.max(30, settings.scanIntervalSec);
    }
    const out = await runScan({ publish });
    console.log(
      `[scanner] ${out.scanned} пар · ${out.signals} сигналов · ${out.errors} ошибок · ${
        out.durationMs
      } мс${publish ? " · проход по закрытию 5m" : " · промежуточный проход"}`,
    );
  } catch (error) {
    console.error("[scanner] проход упал:", (error as Error).message);
  } finally {
    state.running = false;
    schedule();
  }
}

/**
 * Сигналы публикуются только на проходе, выровненном по закрытию 5m свечи —
 * иначе сообщение приходило бы через десятки секунд после закрытия, и «вход по
 * закрытию свечи» уже не соответствовал бы цене. Между выровненными проходами
 * идут промежуточные (payout, фиды, дашборд) без публикации.
 */
function schedule() {
  if (state.timer) clearTimeout(state.timer);
  const now = Date.now();
  const aligned = nextAlignedAt(now);
  const refresh = now + state.intervalSec * 1000;
  const publish = aligned <= refresh;
  const at = publish ? aligned : refresh;
  state.timer = setTimeout(() => void tick(publish), Math.max(500, at - now));
}

/** Запуск периодического сканирования. */
export function startScanner(intervalSec = 60) {
  if (state.timer) return;
  state.intervalSec = Math.max(30, intervalSec);
  schedule();
  console.log(
    `[scanner] запущен: сигналы по закрытию 5m свечи (+${ALIGN_LAG_SEC} сек), обновление каждые ${state.intervalSec} сек`,
  );
}

export function scannerRunning(): boolean {
  return state.timer !== null;
}

// HMR: перевешиваем таймер на свежий код модуля.
if (state.timer) schedule();
