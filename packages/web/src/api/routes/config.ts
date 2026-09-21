import { desc } from "drizzle-orm";
import { z } from "zod";
import { base } from "../__core/app";
import { db } from "../database";
import * as schema from "../database/schema";
import { getSettings, updateSettings } from "../engine/store";
import { botConfigured } from "../engine/telegram";
import { feedState, ssidLooksLikeCookie } from "../market/po-feed";

const patch = z.object({
  minConfidence: z.number().min(60).max(95).optional(),
  scanIntervalSec: z.number().min(30).max(900).optional(),
  minPayout: z.number().min(50).max(100).optional(),
  maxPayout: z.number().min(50).max(100).optional(),
  cooldownMinutes: z.number().min(0).max(240).optional(),
  telegramEnabled: z.boolean().optional(),
  scannerEnabled: z.boolean().optional(),
  fallbackPairs: z.boolean().optional(),
  excludedSymbols: z.string().max(2000).optional(),
  blockedHours: z.string().max(200).optional(),
  assetClasses: z.string().max(200).optional(),
});

export const config = {
  get: base.handler(async () => {
    const settings = await getSettings();
    const subscribers = await db
      .select()
      .from(schema.subscribers)
      .orderBy(desc(schema.subscribers.createdAt));
    return {
      settings,
      subscribers,
      telegramConfigured: botConfigured(),
      otcUnlocked: ssidLooksLikeCookie(),
      poFeed: feedState(),
      otcNote:
        "OTC-пары включатся, когда будет добавлен рабочий cookie ssid Pocket Option — у публичного фида OTC-котировок нет.",
    };
  }),

  update: base.input(patch).handler(({ input }) => updateSettings(input)),
};
