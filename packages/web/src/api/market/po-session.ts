import { envStr } from "../env";

/** Извлекаем UA из PHP-сессии, не меняя подписанную брокером строку. */
export function sessionUserAgent(ssid: string): string | undefined {
  let payload: unknown;
  try { payload = JSON.parse(ssid.slice(2)); } catch { return undefined; }
  if (!Array.isArray(payload) || payload[0] !== "auth") return undefined;
  const session = payload[1]?.session;
  if (typeof session !== "string") return undefined;
  const match = session.match(/s:10:"user_agent";s:\d+:"([^"\r\n]+)";/);
  if (!match || match[1]!.length > 1024) return undefined;
  return match[1];
}

/** SSID из БД подхватывается boot(): он же источник UA после рестарта. */
export function pocketUserAgent(): string {
  return sessionUserAgent(envStr("POCKET_OPTION_SSID")) ?? envStr(
    "POCKET_OPTION_UA",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  );
}