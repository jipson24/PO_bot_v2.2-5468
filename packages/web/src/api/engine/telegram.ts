import { count, desc, eq, gte } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { envStr } from "../env";
import { feedState } from "../market/po-feed";

import {
  activeSubscribers,
  addSubscriber,
  ASSET_CLASS_LABELS,
  deactivateSubscriber,
  deliveryHealth,
  getSettings,
  parseAssetClasses,
  updateSettings,
} from "./store";

const API = (method: string) =>
  `https://api.telegram.org/bot${envStr("TELEGRAM_BOT_TOKEN")}/${method}`;

/** Подпись класса активов; неизвестный класс показываем как есть. */
function assetClassLabel(kind: string): string {
  return ASSET_CLASS_LABELS[kind as keyof typeof ASSET_CLASS_LABELS] ?? kind;
}

export function botConfigured(): boolean {
  return Boolean(envStr("TELEGRAM_BOT_TOKEN"));
}

/** Чтобы не спамить в логи одним и тем же Conflict от второй копии бота. */
let conflictLogged = false;

/** Ответ Telegram API: либо результат, либо разобранная ошибка. */
type ApiResult<T> =
  | { ok: true; result: T | null }
  | { ok: false; error: string; retryAfter?: number; fatal: boolean };

/**
 * Ошибки, после которых повторять бессмысленно: чата нет, бота выгнали или
 * заблокировали, писать запрещено. Такой чат снимаем с рассылки.
 */
const FATAL_ERRORS = [
  "chat not found",
  "bot was blocked",
  "bot was kicked",
  "user is deactivated",
  "not enough rights",
  "CHAT_WRITE_FORBIDDEN",
  "need administrator rights",
  "have no rights to send",
];

function isFatal(description: string): boolean {
  const low = description.toLowerCase();
  return FATAL_ERRORS.some((s) => low.includes(s.toLowerCase()));
}

async function request<T>(
  method: string,
  body: Record<string, unknown>,
): Promise<ApiResult<T>> {
  // Не задан токен — проблема конфигурации процесса, а не конкретного чата.
  // Раньше это помечалось fatal:true и delivery.ts на первом же сигнале снимал
  // с рассылки вообще всех подписчиков (см. FATAL_ERRORS там же) — токен
  // появится после настройки, чат тут ни при чём.
  if (!botConfigured())
    return { ok: false, error: "TELEGRAM_BOT_TOKEN не задан", fatal: false };
  try {
    const res = await fetch(API(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(method === "getUpdates" ? 70_000 : 15_000),
    });
    const json = (await res.json()) as {
      ok: boolean;
      result?: T;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!json.ok) {
      const description = json.description ?? `HTTP ${res.status}`;
      // Conflict = тот же бот опрашивается второй копией (обычно dev-сервер в
      // песочнице против продакшена). Пишем один раз на серию, иначе логи
      // продакшена забиваются одинаковой строкой каждые пару секунд.
      if (description.includes("Conflict")) {
        if (!conflictLogged) {
          conflictLogged = true;
          console.warn(
            "[telegram] тот же токен опрашивает другая копия бота — оставь запущенным только один экземпляр",
          );
        }
        return { ok: false, error: description, fatal: false };
      }
      console.error(`[telegram] ${method}: ${description}`);
      return {
        ok: false,
        error: description,
        retryAfter: json.parameters?.retry_after,
        fatal: isFatal(description),
      };
    }
    conflictLogged = false;
    return { ok: true, result: json.result ?? null };
  } catch (error) {
    const err = error as Error;
    const timeout = err.name === "TimeoutError";
    // Таймаут долгого getUpdates — норма, остальное пишем в лог обязательно:
    // раньше таймауты глотались молча, и потерянный сигнал не оставлял следа.
    if (!(timeout && method === "getUpdates")) {
      console.error(`[telegram] ${method} не прошёл: ${timeout ? "таймаут" : err.message}`);
    }
    return { ok: false, error: timeout ? "таймаут запроса" : err.message, fatal: false };
  }
}

async function call<T>(method: string, body: Record<string, unknown>): Promise<T | null> {
  const res = await request<T>(method, body);
  return res.ok ? res.result : null;
}

type Keyboard = { inline_keyboard: { text: string; url: string }[][] };

/** Отправка с разбором ошибки — для доставки сигналов с повторами. */
export async function sendMessageResult(chatId: string, text: string, keyboard?: Keyboard) {
  return request<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
}

export async function sendMessage(chatId: string, text: string, keyboard?: Keyboard) {
  const res = await sendMessageResult(chatId, text, keyboard);
  return res.ok ? res.result : null;
}

export async function broadcast(text: string, keyboard?: Keyboard) {
  const subs = await activeSubscribers();
  let sent = 0;
  for (const sub of subs) {
    const res = await sendMessage(sub.chatId, text, keyboard);
    if (res) sent += 1;
  }
  return sent;
}

type Signal = typeof schema.signals.$inferSelect;

/**
 * Кнопки «открыть пару» под сигналом.
 *
 * Терминал живёт по /cabinet/quick-high-low (демо — /cabinet/demo-quick-high-low),
 * символ передаём как ?asset=. Параметр переживает редирект на логин, так что
 * ссылка рабочая и для незалогиненного: сначала вход, потом терминал.
 *
 * Домен один на все устройства и это осознанно: у pocketoption.com есть
 * assetlinks.json и apple-app-site-association, поэтому на телефоне с
 * установленным приложением ссылка открывается в нём, а без него — в браузере.
 * Отдельная мобильная ссылка (m.pocketoption.com) такой переход бы сломала.
 */
export function pairKeyboard(symbol: string): Keyboard {
  const asset = encodeURIComponent(symbol);
  const base = "https://pocketoption.com/en/cabinet";
  return {
    inline_keyboard: [
      [
        { text: `📈 Открыть ${symbol}`, url: `${base}/quick-high-low/?asset=${asset}` },
        { text: "🧪 Демо", url: `${base}/demo-quick-high-low/?asset=${asset}` },
      ],
    ],
  };
}

/** Всё время в сообщениях — киевское (UTC+3 летом, UTC+2 зимой, DST учитывает IANA-зона). */
export const TZ = "Europe/Kyiv";

const fmtTime = (d: Date) =>
  d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: TZ });

/** Строка состояния родного фида PO — для /status. */
function feedLine(): string {
  const feed = feedState();
  const names: Record<string, string> = {
    idle: "не подключён",
    connecting: "подключается",
    live: "работает",
    unauthorized: "нет доступа",
    error: "ошибка",
  };
  const parts = [`Фид Pocket Option: ${names[feed.state] ?? feed.state}`];
  if (feed.lastPayloadAt) {
    parts.push(`данные ${Math.round((Date.now() - feed.lastPayloadAt) / 1000)} сек назад`);
  }
  if (feed.clockSkewSec) parts.push(`часы брокера +${feed.clockSkewSec / 3600} ч`);
  if (feed.note) parts.push(feed.note);
  return parts.join(" · ");
}

/**
 * Строка о доставке сигналов — для /status.
 *
 * Держим её на виду: молчащий бот при живом сканере — это почти всегда
 * недоставка, и раньше это было видно только запросом в базу.
 */
async function deliveryLine(): Promise<string> {
  const health = await deliveryHealth();
  if (health.pending === 0 && health.failed === 0) return "Доставка в чаты: всё отправлено";
  const parts: string[] = [];
  if (health.pending) parts.push(`в очереди ${health.pending}`);
  if (health.failed) parts.push(`не доставлено ${health.failed}`);
  if (health.lastError) parts.push(`последняя ошибка: ${health.lastError}`);
  return `Доставка в чаты: ${parts.join(" · ")}`;
}

function expiryLabel(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} мин` : `${seconds} сек`;
}

export function formatSignal(signal: Signal): string {
  const arrow = signal.direction === "call" ? "🟢 CALL ▲" : "🔴 PUT ▼";
  const reasons = (signal.reasons as string[]).slice(0, 6);
  const bar = "▰".repeat(Math.round(signal.confidence / 10)).padEnd(10, "▱");

  return [
    `<b>${arrow}  ${signal.assetName}</b>`,
    `<code>${signal.symbol}</code>  ·  payout ${signal.payout}%`,
    ...(signal.lowPayout ? ["⚠️ Низкий пейаут — вне целевого диапазона"] : []),
    "",
    `Цена входа: <b>${signal.price.toFixed(5)}</b>`,
    `Экспирация: <b>${expiryLabel(signal.expirySeconds)}</b> (до ${fmtTime(signal.expiresAt)} Киев)`,
    `Уверенность: <b>${signal.confidence}%</b> ${bar}`,
    "",
    "<b>Мультитаймфрейм</b>",
    `30m: ${signal.biasH30}`,
    `15m: ${signal.biasM15}`,
    `5m: ${signal.triggerM5}`,
    "",
    "<b>Подтверждения</b>",
    ...reasons.map((r) => `• ${r}`),
    "",
    `<i>Вход по закрытию 5m свечи. Риск — не более 1–2% депозита на сделку.</i>`,
  ].join("\n");
}

const HELP = [
  "<b>Pocket Signal Bot</b>",
  "Сканирую валютные пары Pocket Option по Smart Money структуре, свечным паттернам, MACD, RSI и уровням — с подтверждением 30m → 15m → 5m.",
  "",
  "<b>Команды</b>",
  "/signals — последние сигналы",
  "/last — полный разбор последнего сигнала",
  "/scan — прогнать сканер сейчас",
  "/pairs — пары в работе и payout",
  "/status — состояние сканера",
  "/threshold 70 — порог уверенности (50–90)",
  "/stop — отключить рассылку",
  "/start — включить рассылку",
].join("\n");

/**
 * Русские и «бесслэшевые» синонимы команд: люди пишут боту «старт», «сигналы»,
 * «статус» обычным текстом, и молчать в ответ — худшее поведение.
 */
const ALIASES: Record<string, string> = {
  start: "/start",
  старт: "/start",
  начать: "/start",
  подписаться: "/start",
  stop: "/stop",
  стоп: "/stop",
  отписаться: "/stop",
  help: "/help",
  помощь: "/help",
  справка: "/help",
  signals: "/signals",
  сигналы: "/signals",
  last: "/last",
  последний: "/last",
  scan: "/scan",
  скан: "/scan",
  сканировать: "/scan",
  pairs: "/pairs",
  пары: "/pairs",
  status: "/status",
  статус: "/status",
  состояние: "/status",
  threshold: "/threshold",
  порог: "/threshold",
};

function normalizeCommand(raw: string): string {
  const word = raw.split("@")[0]!.toLowerCase().replaceAll(/[!.,?]+$/g, "");
  if (word.startsWith("/")) return ALIASES[word.slice(1)] ?? word;
  return ALIASES[word] ?? word;
}

async function handleCommand(
  chatId: string,
  text: string,
  title?: string,
  chatType = "private",
) {
  const [rawCmd, ...args] = text.trim().split(/\s+/);
  const cmd = normalizeCommand(rawCmd ?? "");

  switch (cmd) {
    case "/start": {
      await addSubscriber(chatId, title);
      await sendMessage(chatId, `${HELP}\n\n✅ Рассылка сигналов включена.`);
      return;
    }
    case "/help": {
      await sendMessage(chatId, HELP);
      return;
    }
    case "/stop": {
      await deactivateSubscriber(chatId);
      await sendMessage(chatId, "⏸ Рассылка отключена. Включить снова — /start");
      return;
    }
    case "/signals": {
      const rows = await db
        .select()
        .from(schema.signals)
        .orderBy(desc(schema.signals.createdAt))
        .limit(5);
      if (!rows.length) {
        await sendMessage(chatId, "Пока сигналов нет — сканер ждёт подходящий сетап.");
        return;
      }
      const text = rows
        .map((s) => {
          const arrow = s.direction === "call" ? "🟢 CALL" : "🔴 PUT";
          return `${arrow} <b>${s.assetName}</b> · ${s.confidence}% · ${expiryLabel(s.expirySeconds)} · ${fmtTime(s.createdAt)}`;
        })
        .join("\n");
      await sendMessage(chatId, `<b>Последние сигналы</b>\n${text}`);
      return;
    }
    case "/last": {
      const [row] = await db
        .select()
        .from(schema.signals)
        .orderBy(desc(schema.signals.createdAt))
        .limit(1);
      if (!row) {
        await sendMessage(chatId, "Сигналов ещё не было — сканер ждёт подходящий сетап.");
        return;
      }
      await sendMessage(chatId, formatSignal(row), pairKeyboard(row.symbol));
      return;
    }
    case "/scan": {
      await sendMessage(chatId, "🔎 Прогоняю сканер…");
      const { runScan } = await import("./scanner");
      const out = await runScan();
      const top = out.candidates
        .slice()
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 5)
        .map(
          (x) =>
            `• ${x.name} ${x.direction ?? "—"} ${x.confidence}%${x.blockers.length ? ` — ${x.blockers[0]}` : " ✅"}`,
        );
      await sendMessage(
        chatId,
        [
          "<b>Проход сканера</b>",
          `Пар проверено: ${out.scanned} · сигналов: ${out.signals} · ошибок: ${out.errors} · ${out.durationMs} мс`,
          out.note ? `<i>${out.note}</i>` : "",
          top.length ? "\n<b>Лучшие кандидаты</b>" : "",
          ...top,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return;
    }
    case "/pairs": {
      const settings = await getSettings();
      const rows = await db
        .select()
        .from(schema.assets)
        .where(gte(schema.assets.payout, settings.minPayout))
        .orderBy(desc(schema.assets.payout))
        .limit(40);
      const classes = parseAssetClasses(settings.assetClasses);
      const filtered = rows.filter(
        (a) => a.payout <= settings.maxPayout && classes.has(a.kind as never),
      );
      if (!filtered.length) {
        await sendMessage(chatId, "Список активов ещё не загружен, попробуй через минуту.");
        return;
      }
      const ready = filtered.filter((a) => a.feedStatus === "ok");
      const waiting = filtered.filter((a) => a.feedStatus !== "ok");
      const lines = [
        `<b>Пары с payout ${settings.minPayout}–${settings.maxPayout}%</b>`,
        "",
        `<b>В работе (${ready.length})</b>`,
        ...ready.slice(0, 20).map((a) => `• ${a.name} — ${a.payout}% · ${assetClassLabel(a.kind)}`),
      ];
      if (waiting.length) {
        lines.push(
          "",
          `<b>Ждут фид PO (${waiting.length})</b>`,
          ...waiting.slice(0, 12).map((a) => `• ${a.name} — ${a.payout}%`),
          "<i>Эти пары ещё не отдали свечи — проверь состояние фида через /status.</i>",
        );
      }
      await sendMessage(chatId, lines.join("\n"));
      return;
    }
    case "/status": {
      const settings = await getSettings();
      const [run] = await db
        .select()
        .from(schema.scanRuns)
        .orderBy(desc(schema.scanRuns.startedAt))
        .limit(1);
      const [totals] = await db.select({ value: count() }).from(schema.signals);
      const totalSignals = totals?.value ?? 0;
      await sendMessage(
        chatId,
        [
          "<b>Состояние</b>",
          `Сканер: ${settings.scannerEnabled ? "работает" : "остановлен"} (раз в ${settings.scanIntervalSec} сек)`,
          `Порог уверенности: ${settings.minConfidence}%`,
          `Payout-фильтр: ${settings.minPayout}–${settings.maxPayout}%`,
          `Кулдаун по паре: ${settings.cooldownMinutes} мин`,
          run
            ? `Последний проход: ${fmtTime(run.startedAt)} · ${run.scanned} пар · ${run.signalsFound} сигналов · ${run.durationMs} мс${run.note ? ` · ${run.note}` : ""}`
            : "Последний проход: ещё не было",
          `Всего сигналов в базе: ${totalSignals}`,
          await deliveryLine(),
          feedLine(),
        ].join("\n"),
      );
      return;
    }
    case "/threshold": {
      const value = Number(args[0]);
      if (!Number.isFinite(value) || value < 60 || value > 95) {
        await sendMessage(chatId, "Укажи порог от 60 до 95, например: /threshold 80");
        return;
      }
      await updateSettings({ minConfidence: Math.round(value) });
      await sendMessage(chatId, `✅ Порог уверенности: ${Math.round(value)}%`);
      return;
    }
    default: {
      // В личке отвечаем на любое сообщение: человек уже пишет боту — подписываем
      // и показываем команды. В группах реагируем только на явные команды.
      if (chatType === "private") {
        await addSubscriber(chatId, title);
        await sendMessage(
          chatId,
          `${HELP}\n\n✅ Рассылка сигналов включена для этого чата.`,
        );
        return;
      }
      if (cmd.startsWith("/")) await sendMessage(chatId, HELP);
    }
  }
}

interface TgUpdate {
  update_id: number;
  message?: {
    chat: {
      id: number;
      type?: string;
      title?: string;
      username?: string;
      first_name?: string;
    };
    text?: string;
  };
}

/**
 * Состояние long-polling живёт в globalThis: при HMR Vite подменяет модуль, а
 * старый цикл продолжал бы опрашивать Telegram и ловить `Conflict`. Поколение
 * (`generation`) гасит устаревшие циклы — активен только последний.
 */
interface PollState {
  generation: number;
  running: boolean;
  offset: number;
}

const pollScope = globalThis as unknown as { __poTelegramPoll?: PollState };
const poll: PollState = (pollScope.__poTelegramPoll ??= {
  generation: 0,
  running: false,
  offset: 0,
});

async function pollLoop(generation: number) {
  let backoff = 0;
  while (poll.running && generation === poll.generation) {
    const updates = await call<TgUpdate[]>("getUpdates", {
      offset: poll.offset,
      timeout: 50,
      allowed_updates: ["message"],
    });
    if (!updates) {
      // Чаще всего это Conflict от прежней копии процесса: ждём и пробуем снова.
      backoff = Math.min(backoff === 0 ? 2000 : backoff * 2, 15_000);
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }
    backoff = 0;
    for (const u of updates) {
      poll.offset = u.update_id + 1;
      const msg = u.message;
      if (!msg?.text) continue;
      const chatId = String(msg.chat.id);
      const title = msg.chat.title ?? msg.chat.username ?? msg.chat.first_name ?? undefined;
      console.log(`[telegram] ← ${chatId} (${msg.chat.type ?? "?"}): ${msg.text}`);
      try {
        await handleCommand(chatId, msg.text, title, msg.chat.type ?? "private");
      } catch (error) {
        console.error("[telegram] handler:", (error as Error).message);
      }
    }
  }
}

/** Long-polling обновлений Telegram. Идемпотентно и переживает HMR. */
export function startPolling() {
  if (!botConfigured()) return;
  if (poll.running && poll.generation > 0) return;
  poll.generation += 1;
  poll.running = true;
  void pollLoop(poll.generation);
  console.log("[telegram] polling запущен");
}

export function pollingActive(): boolean {
  return poll.running;
}

// HMR: старый цикл принадлежит прежней копии модуля — поднимаем свежий.
if (poll.running) {
  poll.generation += 1;
  void pollLoop(poll.generation);
}

// Рассылка сигналов живёт в ./delivery: там на каждый чат своя строка в
// `deliveries`, повторы и снятие мёртвых чатов с подписки. Здесь — только
// транспорт (sendMessage/broadcast) и разбор команд.
