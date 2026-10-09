/** SSID принимается только от владельца в личном чате, без записи секрета в лог. */
export const SSID_OWNER_ID = "381686253";

export function isSsidCommand(text: string): boolean {
  return /^\/ssid(?:@[a-z0-9_]+)?(?:\s|$)/i.test(text.trim());
}

export function safeTelegramText(text: string): string {
  if (isSsidCommand(text) || /42\s*\[\s*"auth"|"session"\s*:/i.test(text)) {
    return "/ssid [скрыто]";
  }
  return text;
}

export function parseSsidCommand(text: string, expectedUid: string) {
  const ssid = text.trim().replace(/^\/ssid(?:@[a-z0-9_]+)?\s*/i, "");
  if (!ssid || ssid === text.trim()) throw new Error("Используй /ssid — затем полная строка 42[\"auth\",…].");
  let data: unknown;
  try {
    if (!ssid.startsWith("42[")) throw new Error();
    data = JSON.parse(ssid.slice(2));
  } catch {
    throw new Error("Неверный формат SSID. Скопируй полный кадр 42[\"auth\",…] без изменений.");
  }
  if (!Array.isArray(data) || data.length !== 2 || data[0] !== "auth") {
    throw new Error("Нужен кадр авторизации 42[\"auth\",…].");
  }
  const payload = data[1];
  if (!payload || typeof payload.session !== "string" || payload.session.length < 16 ||
      ![0, 1].includes(payload.isDemo) || !Number.isSafeInteger(payload.uid)) {
    throw new Error("В SSID должны быть session, uid и isDemo (0 или 1).");
  }
  if (expectedUid && String(payload.uid) !== expectedUid) {
    throw new Error("SSID принадлежит другому аккаунту Pocket Option — не применён.");
  }
  return { ssid, isDemo: payload.isDemo as number };
}

export interface SsidActions {
  expectedUid: string;
  isDemo: boolean;
  reply: (text: string) => Promise<unknown>;
  removeMessage: () => Promise<unknown>;
  save: (ssid: string) => Promise<unknown>;
  apply: (ssid: string) => void;
  reconnect: () => Promise<boolean>;
}

export async function handleSsidCommand(
  chatId: string, chatType: string, senderId: string | undefined,
  text: string, actions: SsidActions,
) {
  if (chatType !== "private" || chatId !== SSID_OWNER_ID || senderId !== SSID_OWNER_ID) {
    await actions.reply("Команда /ssid доступна только владельцу в личном чате с ботом.");
    return;
  }
  // Удаление best-effort: Telegram может отказать, но секрет не возвращаем в ответе.
  await actions.removeMessage().catch(() => undefined);
  let parsed: ReturnType<typeof parseSsidCommand>;
  try {
    parsed = parseSsidCommand(text, actions.expectedUid);
    if (Boolean(parsed.isDemo) !== actions.isDemo) {
      throw new Error("Режим аккаунта не совпадает с движком. Скопируй SSID из " +
        (actions.isDemo ? "демо-счёта." : "реального счёта."));
    }
  } catch (error) {
    await actions.reply((error as Error).message);
    return;
  }
  try {
    await actions.save(parsed.ssid);
  } catch {
    await actions.reply("Не удалось сохранить SSID в БД. Старый токен остаётся активным; попробуй ещё раз.");
    return;
  }
  actions.apply(parsed.ssid);
  await actions.reply("SSID сохранён. Проверяю авторизацию Pocket Option…");
  let accepted = false;
  try { accepted = await actions.reconnect(); } catch { /* ответ без текста ошибки/секрета */ }
  await actions.reply(accepted
    ? "Pocket Option принял новый SSID. Фид переподключён, бот не перезапускался. Проверить котировки — /status."
    : "SSID сохранён, но авторизация пока не подтверждена. Возможна проблема с сессией или сетью; проверь /status и при необходимости отправь свежий /ssid.");
}