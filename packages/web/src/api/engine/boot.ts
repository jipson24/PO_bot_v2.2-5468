import { addSubscriber, getSettings } from "./store";
import { startScanner } from "./scanner";
import { startFeedAlerts } from "./feed-alerts";
import { startDeliveryRetry } from "./delivery";
import { startOutcomeResolver } from "./outcomes";
import { startDailyReporter } from "./daily-report";
import { botConfigured, sendMessage, startPolling } from "./telegram";
import { engineEnabled, envStr, setEnvOverride } from "../env";
import { startNewsShadow } from "../news/engine";

const FLAG = "__pocketSignalBotBooted";
const globalScope = globalThis as unknown as Record<string, boolean | undefined>;

/**
 * Единовременный запуск движка: сканер + Telegram long-polling.
 * Защищён флагом в globalThis, чтобы HMR Vite не поднимал вторую копию.
 */
export function boot() {
  if (!engineEnabled()) {
    console.warn(
      "[boot] ENGINE_ENABLED=0 — движок не запущен: этот процесс только отдаёт дашборд и читает базу",
    );
    return;
  }
  if (globalScope[FLAG]) return;
  globalScope[FLAG] = true;

  void (async () => {
    try {
      const settings = await getSettings();

      // SSID из БД важнее .env: на хостинге сессию PO меняют через
      // /api/ops/ssid, и после перезапуска она должна подхватиться сама.
      if (settings.poSsid) setEnvOverride("POCKET_OPTION_SSID", settings.poSsid);

      if (botConfigured()) {
        startPolling();
        // Чат из .env подписываем только если бот реально может в него писать.
        const seed = envStr("TELEGRAM_DEFAULT_CHAT_ID");
        if (seed) {
          const ok = await sendMessage(
            seed,
            "♻️ <b>Pocket Signal Bot запущен</b>\nСканирую валютные пары Pocket Option. /help — команды.",
          );
          if (ok) await addSubscriber(seed, "Чат из .env");
          else console.warn(`[boot] чат ${seed} недоступен — нужен /start от пользователя`);
        }
      } else {
        console.warn("[boot] TELEGRAM_BOT_TOKEN не задан — рассылка выключена");
      }

      startDeliveryRetry();
      startFeedAlerts();
      startOutcomeResolver();
      startDailyReporter();
      startNewsShadow();
      startScanner(settings.scanIntervalSec);
    } catch (error) {
      globalScope[FLAG] = false;
      console.error("[boot] не удалось запустить движок:", (error as Error).message);
    }
  })();
}
