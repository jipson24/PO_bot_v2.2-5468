import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Активы Pocket Option с payout — обновляются из WS-фида брокера. */
export const assets = sqliteTable(
  "assets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    symbol: text("symbol").notNull().unique(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    isOtc: integer("is_otc", { mode: "boolean" }).notNull().default(false),
    payout: integer("payout").notNull().default(0),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    feedSymbol: text("feed_symbol"),
    feedStatus: text("feed_status").notNull().default("unknown"),
    lastCandleAt: integer("last_candle_at", { mode: "timestamp" }),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("assets_payout_idx").on(t.payout)],
);

/** Сформированные сигналы. */
export const signals = sqliteTable(
  "signals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    symbol: text("symbol").notNull(),
    assetName: text("asset_name").notNull(),
    direction: text("direction").notNull(),
    confidence: integer("confidence").notNull(),
    score: real("score").notNull(),
    payout: integer("payout").notNull().default(0),
    /** payout вне диапазона minPayout–maxPayout: сигнал отправляем, но помечаем. */
    lowPayout: integer("low_payout", { mode: "boolean" }).notNull().default(false),
    price: real("price").notNull(),
    expirySeconds: integer("expiry_seconds").notNull(),
    entryAt: integer("entry_at", { mode: "timestamp" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    biasH30: text("bias_h30").notNull(),
    biasM15: text("bias_m15").notNull(),
    triggerM5: text("trigger_m5").notNull(),
    reasons: text("reasons", { mode: "json" }).notNull(),
    details: text("details", { mode: "json" }).notNull(),
    /** Факторы голосования с весами — как есть из analyze(). */
    factors: text("factors", { mode: "json" }),
    /** Полный слепок входа: свечи, индикаторы, настройки движка на момент сигнала. */
    snapshot: text("snapshot", { mode: "json" }),
    /** Киевский торговый день входа, «2026-09-20» — по нему группируется архив. */
    tradeDay: text("trade_day"),
    /** pending | win | loss | draw | unknown */
    outcome: text("outcome").notNull().default("pending"),
    resultPrice: real("result_price"),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
    /** Как получена цена экспирации либо почему не получена. */
    resolveNote: text("resolve_note"),
    sentToTelegram: integer("sent_to_telegram", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("signals_created_idx").on(t.createdAt),
    index("signals_symbol_idx").on(t.symbol),
    index("signals_trade_day_idx").on(t.tradeDay),
    index("signals_outcome_idx").on(t.outcome),
  ],
);

/**
 * Доставка сигнала в каждый чат по отдельности.
 *
 * Раньше факт отправки жил одним флагом `signals.sent_to_telegram`, который
 * ставился, если сообщение ушло хотя бы в один чат. Из-за этого сбой доставки
 * в один из чатов был невидим (в базе «отправлено», у человека — тишина), а
 * таймаут Telegram API вообще ничего не оставлял в логах. Теперь на каждый
 * чат — своя строка со статусом, числом попыток и текстом ошибки, и
 * дожимальщик (`retryPendingDeliveries`) добивает `pending` до конца.
 */
export const deliveries = sqliteTable(
  "deliveries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    signalId: integer("signal_id").notNull(),
    chatId: text("chat_id").notNull(),
    /** pending | sent | failed */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    sentAt: integer("sent_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("deliveries_signal_chat_idx").on(t.signalId, t.chatId),
    index("deliveries_status_idx").on(t.status),
  ],
);

/** Ежедневные отчёты: по одному на киевский день, пересоздаются при запросе. */
export const dailyReports = sqliteTable("daily_reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** «2026-09-20» — киевские сутки 00:00–23:59. */
  day: text("day").notNull().unique(),
  trades: integer("trades").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  draws: integer("draws").notNull().default(0),
  pending: integer("pending").notNull().default(0),
  /** Винрейт в процентах по решённым сделкам: win / (win + loss). */
  winrate: real("winrate").notNull().default(0),
  bestWinStreak: integer("best_win_streak").notNull().default(0),
  worstLossStreak: integer("worst_loss_streak").notNull().default(0),
  /** Разбор дня: что работало, что подводило, причины и предложения. */
  analysis: text("analysis", { mode: "json" }).notNull(),
  /** Готовый текст отчёта — уходит в Telegram и показывается в дашборде. */
  summary: text("summary").notNull(),
  sentToTelegram: integer("sent_to_telegram", { mode: "boolean" }).notNull().default(false),
  generatedAt: integer("generated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** Подписчики Telegram. */
export const subscribers = sqliteTable("subscribers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: text("chat_id").notNull().unique(),
  title: text("title"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** Настройки движка — одна строка с id = 1. */
export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  minConfidence: integer("min_confidence").notNull().default(80),
  scanIntervalSec: integer("scan_interval_sec").notNull().default(60),
  /**
   * Нижняя граница payout. 80, а не 82, чтобы в работу попало сырьё: у золота,
   * серебра, Brent и WTI payout ровно 80%. По замеру 21.09.2026 зона ниже 85%
   * дала 76.2% винрейта против 48.1% в зоне 90%+ — правда, всего на 21 сделке,
   * так что выборку по сырью надо пересмотреть на волне 2.
   */
  minPayout: integer("min_payout").notNull().default(80),
  /**
   * Верхняя граница payout. Высокий payout — метка плохо предсказуемой пары:
   * по замеру 21.09.2026 зона 90%+ дала 48% винрейта на 150 сделках при пороге
   * безубытка 52.1%, тогда как 85–89% дали 59.3%. Поэтому граница 89, не 95.
   */
  maxPayout: integer("max_payout").notNull().default(89),
  cooldownMinutes: integer("cooldown_minutes").notNull().default(15),
  telegramEnabled: integer("telegram_enabled", { mode: "boolean" }).notNull().default(true),
  /** Пока OTC заблокированы (нет cookie ssid) — сканировать обычные пары с публичным фидом. */
  fallbackPairs: integer("fallback_pairs", { mode: "boolean" }).notNull().default(true),
  scannerEnabled: integer("scanner_enabled", { mode: "boolean" }).notNull().default(true),
  /**
   * SSID Pocket Option, заданный на ходу (через дашборд или /api/ops/ssid).
   * Живёт в БД, а не в .env: сессия привязана к IP и истекает, и на хостинге
   * её надо менять без пересборки. Пусто — берётся значение из .env.
   */
  poSsid: text("po_ssid"),
  /**
   * Пары, которые сканер игнорирует, через запятую (например экзотика
   * SYPUSD_otc, IRRUSD_otc). Сравнение без учёта регистра.
   */
  excludedSymbols: text("excluded_symbols").notNull().default("SYPUSD_otc,IRRUSD_otc"),
  /**
   * Киевские часы, в которые сигналы не публикуются, через запятую.
   * По замеру 21.09.2026 часы 05–07 давали винрейт 20–29% на 28 сделках —
   * утренний переход между сессиями с рваной ликвидностью.
   */
  blockedHours: text("blocked_hours").notNull().default("5,6,7"),
  /**
   * Классы активов Pocket Option, которые берёт сканер, через запятую.
   * Возможные значения — категории брокера: currency, cryptocurrency,
   * commodity, stock, index. Свечи по всем классам отдаёт родной фид PO
   * (проверено 21.09.2026 на XAUUSD_otc, DOGE_otc, #MSFT_otc, UKBrent_otc),
   * поэтому ограничение здесь — вопрос выбора, а не доступности данных.
   */
  assetClasses: text("asset_classes")
    .notNull()
    .default("currency,cryptocurrency,commodity,stock"),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** Журнал проходов сканера — для /status и диагностики. */
export const scanRuns = sqliteTable("scan_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
  durationMs: integer("duration_ms").notNull(),
  scanned: integer("scanned").notNull(),
  signalsFound: integer("signals_found").notNull(),
  errors: integer("errors").notNull().default(0),
  note: text("note"),
});
