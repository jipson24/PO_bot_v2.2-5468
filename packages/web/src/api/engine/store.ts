import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

export type Settings = typeof schema.settings.$inferSelect;

/** Настройки движка: одна строка с id = 1, создаётся при первом обращении. */
export async function getSettings(): Promise<Settings> {
  const rows = await db.select().from(schema.settings).where(eq(schema.settings.id, 1));
  const existing = rows[0];
  if (existing) return existing;
  const [created] = await db.insert(schema.settings).values({ id: 1 }).returning();
  return created!;
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  await getSettings();
  const [row] = await db
    .update(schema.settings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.settings.id, 1))
    .returning();
  return row!;
}

/**
 * Разбор списка исключённых пар из настроек: «SYPUSD_otc, IRRUSD_otc» →
 * множество символов в верхнем регистре для сравнения без учёта регистра.
 */
export function parseExcluded(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[,\s;]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
}

export function isExcluded(symbol: string, excluded: Set<string>): boolean {
  return excluded.has(symbol.trim().toUpperCase());
}

/**
 * Разбор списка закрытых часов из настроек: «5,6,7» → множество киевских
 * часов, в которые сигналы не публикуются. Мусор и значения вне 0–23
 * игнорируются, чтобы опечатка в настройках не глушила сканер целиком.
 */
export function parseBlockedHours(raw: string | null | undefined): Set<number> {
  if (!raw) return new Set();
  const out = new Set<number>();
  for (const part of raw.split(/[,\s;]+/)) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n >= 0 && n <= 23) out.add(n);
  }
  return out;
}

/** Классы активов, которые вообще существуют у Pocket Option. */
export const ASSET_CLASSES = [
  "currency",
  "cryptocurrency",
  "commodity",
  "stock",
  "index",
] as const;

export type AssetClass = (typeof ASSET_CLASSES)[number];

/** Человеческие названия классов для дашборда и Telegram. */
export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  currency: "Валюты",
  cryptocurrency: "Криптовалюты",
  commodity: "Сырьё",
  stock: "Акции",
  index: "Индексы",
};

/**
 * Разбор списка классов активов из настроек. Неизвестные значения молча
 * отбрасываются, пустой результат означает «валюты» — иначе опечатка в
 * настройках полностью остановила бы сканер.
 */
export function parseAssetClasses(raw: string | null | undefined): Set<AssetClass> {
  const out = new Set<AssetClass>();
  for (const part of String(raw ?? "").split(/[,\s;]+/)) {
    const v = part.trim().toLowerCase();
    if ((ASSET_CLASSES as readonly string[]).includes(v)) out.add(v as AssetClass);
  }
  if (out.size === 0) out.add("currency");
  return out;
}

export async function addSubscriber(chatId: string, title?: string) {
  const existing = await db
    .select()
    .from(schema.subscribers)
    .where(eq(schema.subscribers.chatId, chatId));
  if (existing[0]) {
    if (!existing[0].isActive) {
      await db
        .update(schema.subscribers)
        .set({ isActive: true })
        .where(eq(schema.subscribers.chatId, chatId));
    }
    return existing[0];
  }
  const [row] = await db
    .insert(schema.subscribers)
    .values({ chatId, title: title ?? null })
    .returning();
  return row!;
}

export async function deactivateSubscriber(chatId: string) {
  await db
    .update(schema.subscribers)
    .set({ isActive: false })
    .where(eq(schema.subscribers.chatId, chatId));
}

export async function activeSubscribers() {
  return db
    .select()
    .from(schema.subscribers)
    .where(eq(schema.subscribers.isActive, true));
}
