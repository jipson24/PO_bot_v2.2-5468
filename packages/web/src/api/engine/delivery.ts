/**
 * Доставка сигналов в Telegram — с гарантией и следом в базе.
 *
 * Почему не хватило простой рассылки: раньше `publishSignal` звал broadcast и
 * ставил один флаг `signals.sent_to_telegram`, если сообщение ушло хотя бы в
 * один чат. Отсюда две дыры, из-за которых сигналы терялись молча:
 *   1. сбой доставки в один из двух чатов был невидим — в базе «отправлено», а
 *      у человека в чате тишина;
 *   2. любая разовая ошибка Telegram API (таймаут, 429, пятисотка на их
 *      стороне) теряла сигнал навсегда — повторов не было.
 *
 * Теперь на каждую пару «сигнал × чат» пишется строка в `deliveries`, и пока
 * она `pending` — дожимальщик повторяет отправку. Флаг `sent_to_telegram`
 * означает «ушло во все активные чаты», а не «хоть куда-то».
 *
 * Сигналы не догоняем вечно: вход привязан к закрытию 5m свечи, и сообщение,
 * пришедшее после экспирации, только путает. Просроченные закрываем как
 * `failed` с понятной причиной.
 */

import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { activeSubscribers, deactivateSubscriber, getSettings } from "./store";
import { formatSignal, pairKeyboard, sendMessageResult } from "./telegram";

type Signal = typeof schema.signals.$inferSelect;

/** Сколько раз пробуем один чат, прежде чем признать доставку провалившейся. */
const MAX_ATTEMPTS = 8;
/** Частота прохода дожимальщика. */
const RETRY_INTERVAL_MS = 30_000;
/**
 * Запас после экспирации, в течение которого сигнал ещё имеет смысл дослать:
 * человек хотя бы увидит, что бот жив и что вход был. Позже — только мусор.
 */
const DELIVER_GRACE_MS = 120_000;

/** Постановка задач на доставку: по строке на каждый активный чат. */
async function enqueue(signalId: number, chatIds: string[]) {
  if (chatIds.length === 0) return;
  await db
    .insert(schema.deliveries)
    .values(chatIds.map((chatId) => ({ signalId, chatId })))
    .onConflictDoNothing();
}

/**
 * Одна попытка в один чат.
 *
 * Фатальную ошибку (чат удалён, бота выгнали или заблокировали) не повторяем и
 * снимаем чат с рассылки: иначе каждый следующий сигнал будет биться в ту же
 * стену и тормозить доставку живым подписчикам.
 */
async function attempt(
  row: typeof schema.deliveries.$inferSelect,
  signal: Signal,
): Promise<boolean> {
  const res = await sendMessageResult(
    row.chatId,
    formatSignal(signal),
    pairKeyboard(signal.symbol),
  );
  const attempts = row.attempts + 1;

  if (res.ok) {
    await db
      .update(schema.deliveries)
      .set({ status: "sent", attempts, lastError: null, sentAt: new Date() })
      .where(eq(schema.deliveries.id, row.id));
    return true;
  }

  const giveUp = res.fatal || attempts >= MAX_ATTEMPTS;
  await db
    .update(schema.deliveries)
    .set({ status: giveUp ? "failed" : "pending", attempts, lastError: res.error })
    .where(eq(schema.deliveries.id, row.id));

  if (res.fatal) {
    await deactivateSubscriber(row.chatId);
    console.warn(
      `[доставка] чат ${row.chatId} снят с рассылки: ${res.error}`,
    );
  } else {
    console.warn(
      `[доставка] сигнал ${signal.symbol} → ${row.chatId}: ${res.error} (попытка ${attempts}/${MAX_ATTEMPTS}${giveUp ? ", сдаёмся" : ", повторим"})`,
    );
  }
  return false;
}

/** Флаг на сигнале — «ушло во все чаты, которым причиталось». */
async function syncSignalFlag(signalId: number) {
  const rows = await db
    .select()
    .from(schema.deliveries)
    .where(eq(schema.deliveries.signalId, signalId));
  const done = rows.length > 0 && rows.every((r) => r.status === "sent");
  await db
    .update(schema.signals)
    .set({ sentToTelegram: done })
    .where(eq(schema.signals.id, signalId));
}

/**
 * Рассылка сигнала. Возвращает, сколько чатов получили сообщение сразу;
 * недошедшие остаются в очереди и уйдут повтором.
 */
export async function publishSignal(signal: Signal) {
  const settings = await getSettings();
  if (!settings.telegramEnabled) return 0;

  const subs = await activeSubscribers();
  if (subs.length === 0) {
    console.warn("[доставка] нет активных подписчиков — сигнал никуда не ушёл");
    return 0;
  }

  await enqueue(
    signal.id,
    subs.map((s) => s.chatId),
  );
  const rows = await db
    .select()
    .from(schema.deliveries)
    .where(
      and(
        eq(schema.deliveries.signalId, signal.id),
        eq(schema.deliveries.status, "pending"),
      ),
    );

  let sent = 0;
  for (const row of rows) if (await attempt(row, signal)) sent += 1;
  await syncSignalFlag(signal.id);

  if (sent < rows.length) {
    console.warn(
      `[доставка] сигнал ${signal.symbol}: ${sent} из ${rows.length} чатов, остальные в очереди повторов`,
    );
  }
  return sent;
}

/**
 * Дожимальщик: один проход по зависшим доставкам.
 * Возвращает, сколько сообщений удалось дослать.
 */
export async function retryPendingDeliveries(): Promise<number> {
  const settings = await getSettings();
  if (!settings.telegramEnabled) return 0;

  const pending = await db
    .select()
    .from(schema.deliveries)
    .where(
      and(
        eq(schema.deliveries.status, "pending"),
        lt(schema.deliveries.attempts, MAX_ATTEMPTS),
      ),
    )
    .orderBy(asc(schema.deliveries.signalId))
    .limit(50);
  if (pending.length === 0) return 0;

  const ids = [...new Set(pending.map((r) => r.signalId))];
  const signals = await db
    .select()
    .from(schema.signals)
    .where(inArray(schema.signals.id, ids));
  const byId = new Map(signals.map((s) => [s.id, s]));

  let sent = 0;
  const touched = new Set<number>();
  for (const row of pending) {
    const signal = byId.get(row.signalId);
    if (!signal) {
      await db
        .update(schema.deliveries)
        .set({ status: "failed", lastError: "сигнал удалён из базы" })
        .where(eq(schema.deliveries.id, row.id));
      continue;
    }
    // Просроченное не досылаем: вход уже нельзя открыть.
    if (Date.now() > signal.expiresAt.getTime() + DELIVER_GRACE_MS) {
      await db
        .update(schema.deliveries)
        .set({ status: "failed", lastError: "истёк до доставки" })
        .where(eq(schema.deliveries.id, row.id));
      touched.add(row.signalId);
      continue;
    }
    if (await attempt(row, signal)) sent += 1;
    touched.add(row.signalId);
  }

  for (const id of touched) await syncSignalFlag(id);
  if (sent > 0) console.log(`[доставка] повтором ушло ${sent} сообщений`);
  return sent;
}

const state = (
  globalThis as unknown as { __poDeliveryRetry?: { timer: ReturnType<typeof setInterval> | null } }
).__poDeliveryRetry ??= { timer: null };

/** Периодический дожим недоставленных сигналов. */
export function startDeliveryRetry() {
  if (state.timer) return;
  state.timer = setInterval(() => {
    void retryPendingDeliveries().catch((error) =>
      console.error("[доставка] повтор не прошёл:", (error as Error).message),
    );
  }, RETRY_INTERVAL_MS);
  console.log(`[доставка] дожим недоставленных сигналов каждые ${RETRY_INTERVAL_MS / 1000} сек`);
}
