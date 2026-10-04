/**
 * Служебный канал `/api/ops/*` — доступ к боту на хостинге без SSH.
 *
 * Зачем: на панели Bot Manager нет консоли, а разбирать архив слепков,
 * смотреть логи и менять истёкший SSID надо снаружи. Это те же данные, что
 * во вкладке «Статистика», только plain HTTP + токен — удобно тянуть curl-ом.
 *
 * Доступ: заголовок `x-ops-token` или `?token=`, сверяется с `OPS_TOKEN`.
 * Без `OPS_TOKEN` канал выключен целиком (503) — открытым он не бывает.
 *
 * Эндпоинты:
 *   GET  /api/ops/health              состояние движка, фида, сканера
 *   GET  /api/ops/archive?day=&limit= слепки сигналов с итогами (JSON)
 *   GET  /api/ops/report?day=         сохранённый дневной разбор
 *   GET  /api/ops/logs?limit=         последние строки логов процесса
 *   POST /api/ops/ssid                { ssid } — новый SSID Pocket Option
 */

import type { Hono } from "hono";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { db } from "./database";
import * as schema from "./database/schema";
import { envStr, setEnvOverride } from "./env";
import { deliveryHealth, getSettings, updateSettings } from "./engine/store";
import { feedHost, feedState, ssidLooksLikeCookie } from "./market/po-feed";
import { kyivDay, kyivDayBounds, TZ } from "./lib/day";

const STARTED_AT = Date.now();

/* ------------------------------------------------------------------ логи */

/** Сколько строк логов держим в памяти — хватает на несколько часов работы. */
const LOG_LIMIT = 800;

interface LogLine {
  at: string;
  level: "log" | "warn" | "error";
  text: string;
}

const logs: LogLine[] = [];
let logsHooked = false;

function push(level: LogLine["level"], args: unknown[]) {
  const text = args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
  logs.push({ at: new Date().toISOString(), level, text });
  if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT);
}

/** Дублируем console в кольцевой буфер, не ломая вывод в stdout панели. */
function hookLogs() {
  if (logsHooked) return;
  logsHooked = true;
  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  console.log = (...args: unknown[]) => {
    push("log", args);
    original.log(...args);
  };
  console.warn = (...args: unknown[]) => {
    push("warn", args);
    original.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    push("error", args);
    original.error(...args);
  };
}

/* ------------------------------------------------------------------ доступ */

function tokenOf(request: Request): string | null {
  const header = request.headers.get("x-ops-token");
  if (header) return header.trim();
  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return new URL(request.url).searchParams.get("token");
}

/** Сравнение без утечки времени — токен короткий, но пусть. */
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type Guard = { ok: true } | { ok: false; status: 401 | 503; message: string };

function guard(request: Request): Guard {
  const expected = envStr("OPS_TOKEN");
  if (!expected) {
    return { ok: false, status: 503, message: "OPS_TOKEN не задан — служебный канал выключен" };
  }
  if (expected.length < 24) {
    return { ok: false, status: 503, message: "OPS_TOKEN короче 24 символов — задайте длиннее" };
  }
  const got = tokenOf(request);
  if (!got || !sameToken(got, expected)) {
    return { ok: false, status: 401, message: "неверный токен" };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ данные */

async function health() {
  const settings = await getSettings();
  const [lastRun] = await db
    .select()
    .from(schema.scanRuns)
    .orderBy(desc(schema.scanRuns.startedAt))
    .limit(1);
  const { start, end } = kyivDayBounds(kyivDay());
  const today = await db
    .select({
      id: schema.signals.id,
      outcome: schema.signals.outcome,
      confidence: schema.signals.confidence,
    })
    .from(schema.signals)
    .where(and(gte(schema.signals.createdAt, start), lt(schema.signals.createdAt, end)));
  const wins = today.filter((s) => s.outcome === "win").length;
  const losses = today.filter((s) => s.outcome === "loss").length;
  const pending = today.filter((s) => s.outcome == null || s.outcome === "pending").length;
  const assets = await db.select({ symbol: schema.assets.symbol }).from(schema.assets);

  return {
    status: "ok" as const,
    runtime: {
      node: process.version,
      bun: typeof (globalThis as { Bun?: unknown }).Bun !== "undefined",
      pid: process.pid,
      uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      tz: TZ,
      now: new Date().toISOString(),
    },
    feed: { ...feedState(), host: feedHost(), ssidLooksLikeCookie: ssidLooksLikeCookie() },
    scanner: {
      enabled: settings.scannerEnabled,
      intervalSec: settings.scanIntervalSec,
      lastRun: lastRun
        ? {
            startedAt: lastRun.startedAt,
            scanned: lastRun.scanned,
            signals: lastRun.signalsFound,
            errors: lastRun.errors,
            note: lastRun.note,
          }
        : null,
    },
    settings: {
      minConfidence: settings.minConfidence,
      minPayout: settings.minPayout,
      maxPayout: settings.maxPayout,
      cooldownMinutes: settings.cooldownMinutes,
      telegramEnabled: settings.telegramEnabled,
      fallbackPairs: settings.fallbackPairs,
      ssidFromDb: Boolean(settings.poSsid),
    },
    assets: assets.length,
    // Доставка отдельно от сканера: сигнал может родиться и не уехать в чат.
    delivery: await deliveryHealth(),
    today: { day: kyivDay(), signals: today.length, wins, losses, pending },
  };
}

async function archive(day: string | null, limit: number) {
  const rows = day
    ? await (async () => {
        const { start, end } = kyivDayBounds(day);
        return db
          .select()
          .from(schema.signals)
          .where(and(gte(schema.signals.createdAt, start), lt(schema.signals.createdAt, end)))
          .orderBy(desc(schema.signals.createdAt))
          .limit(limit);
      })()
    : await db
        .select()
        .from(schema.signals)
        .orderBy(desc(schema.signals.createdAt))
        .limit(limit);

  return {
    day,
    count: rows.length,
    signals: rows.map((s) => ({
      ...s,
      dayKey: kyivDay(s.createdAt),
      snapshot: parseSnapshot(s.snapshot),
    })),
  };
}

/** Слепок хранится строкой — для анализа удобнее отдать разобранным. */
function parseSnapshot(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/* ------------------------------------------------------------------ mount */

export function registerOps(app: Hono) {
  hookLogs();

  app.use("/api/ops/*", async (c, next) => {
    const check = guard(c.req.raw);
    if (!check.ok) return c.json({ error: check.message }, check.status);
    await next();
  });

  app.get("/api/ops/health", async (c) => c.json(await health()));

  app.get("/api/ops/archive", async (c) => {
    const day = c.req.query("day") ?? null;
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 200), 1), 2000);
    return c.json(await archive(day, limit));
  });

  app.get("/api/ops/report", async (c) => {
    const day = c.req.query("day") ?? kyivDay();
    const [row] = await db
      .select()
      .from(schema.dailyReports)
      .where(eq(schema.dailyReports.day, day))
      .limit(1);
    if (!row) return c.json({ day, report: null, note: "разбора за этот день нет" }, 404);
    return c.json({ day, report: row });
  });

  app.get("/api/ops/logs", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 200), 1), LOG_LIMIT);
    const level = c.req.query("level");
    const filtered = level ? logs.filter((l) => l.level === level) : logs;
    return c.json({ count: filtered.length, lines: filtered.slice(-limit) });
  });

  app.post("/api/ops/ssid", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "ожидается JSON { ssid }" }, 400);
    }
    const ssid = (body as { ssid?: unknown }).ssid;
    if (typeof ssid !== "string" || ssid.trim().length < 16) {
      return c.json({ error: "ssid слишком короткий или не строка" }, 400);
    }
    const value = ssid.trim();
    setEnvOverride("POCKET_OPTION_SSID", value);
    await updateSettings({ poSsid: value });
    return c.json({
      ok: true,
      ssidLooksLikeCookie: ssidLooksLikeCookie(),
      feed: feedState(),
      note: "SSID применён и сохранён в БД; фид переподключится на следующем цикле",
    });
  });
}
