/**
 * Клиент WebSocket Pocket Option.
 *
 * Работает: авторизация сессионным токеном и живой список активов с payout
 * (событие `updateAssets`, бинарный socket.io-пакет).
 *
 * Свечи: PO отдаёт `loadHistoryPeriod`/`changeSymbol` только сессии, открытой
 * с cookie `ssid` (формат `42["auth",{"session":"...","isDemo":1,...}]`).
 * Если в .env лежит такой SSID — запросы свечей уйдут и результат вернётся;
 * с чат-токеном (`sessionToken`) брокер молчит, и котировки берутся из
 * публичного фида в `candles.ts`.
 */

import { envFlag, envStr, WS } from "../env";
import { feedHost, rotateHost, wsHosts, wsUrl } from "./po-hosts";
import { pocketUserAgent } from "./po-session";

export interface PoAsset {
  id: number;
  symbol: string;
  name: string;
  kind: string;
  payout: number;
  isOtc: boolean;
  isActive: boolean;
}

export interface PoSnapshot {
  assets: PoAsset[];
  fetchedAt: number;
  authOk: boolean;
  candleFeed: boolean;
}

function authMessage(): string {
  const raw = envStr("POCKET_OPTION_SSID");
  if (!raw) throw new Error("POCKET_OPTION_SSID не задан");
  const match = raw.match(/42\[\s*"auth".*?\}\s*\]/s);
  if (match) return match[0];
  // Прислали только токен — собираем классический формат.
  const token = raw.replace(/["'\s]/g, "");
  const uid = envStr("POCKET_OPTION_UID", "0");
  const isDemo = envFlag("POCKET_OPTION_DEMO", true) ? 1 : 0;
  return `42["auth",{"session":"${token}","isDemo":${isDemo},"uid":${uid},"platform":2}]`;
}

/** Разбор бинарного пакета updateAssets. */
function parseAssets(payload: string): PoAsset[] {
  const raw = JSON.parse(payload) as unknown[];
  const out: PoAsset[] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry)) continue;
    const [id, symbol, name, kind, , payout, , , , , , , , , isActiveFlag] = entry as [
      number,
      string,
      string,
      string,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      unknown[],
      number,
      boolean,
    ];
    if (typeof symbol !== "string" || typeof kind !== "string") continue;
    out.push({
      id: Number(id) || 0,
      symbol,
      name: typeof name === "string" ? name : symbol,
      kind,
      payout: Number(payout) || 0,
      isOtc: symbol.endsWith("_otc"),
      isActive: Boolean(isActiveFlag),
    });
  }
  return out;
}

/** Одноразовое подключение: забрать активы с payout. */
export function fetchSnapshot(timeoutMs = 20_000, host = feedHost()): Promise<PoSnapshot> {
  return new Promise((resolve, reject) => {
    let auth: string;
    try {
      auth = authMessage();
    } catch (error) {
      reject(error);
      return;
    }

    const ws = new WS(wsUrl(host), {
      headers: { Origin: "https://pocketoption.com", "User-Agent": pocketUserAgent() },
    });

    let pendingEvent: string | null = null;
    let authOk = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {}
      reject(new Error("Pocket Option: таймаут получения активов"));
    }, timeoutMs);

    const finish = (snapshot: PoSnapshot) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(snapshot);
    };

    const handleFrame = (text: string) => {
      // Payload бинарного вложения socket.io: Bun отдаёт его то как ArrayBuffer, то как строку.
      if (pendingEvent === "updateAssets" && text.startsWith("[")) {
        pendingEvent = null;
        try {
          finish({
            assets: parseAssets(text),
            fetchedAt: Date.now(),
            authOk,
            candleFeed: false,
          });
        } catch (error) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(error);
          }
        }
        return;
      }

      if (text.startsWith("0{")) {
        ws.send("40");
        return;
      }
      if (text === "2") {
        ws.send("3");
        return;
      }
      if (text.startsWith("40")) {
        ws.send(auth);
        return;
      }
      if (/^\d+-\[/.test(text)) {
        try {
          pendingEvent = JSON.parse(text.replace(/^\d+-/, ""))[0] as string;
        } catch {
          pendingEvent = null;
        }
        return;
      }
      if (text.includes("successauth") || text.includes("auth/success")) authOk = true;
    };

    ws.addEventListener("message", (event: MessageEvent) => {
      const data = event.data;
      if (data instanceof ArrayBuffer) {
        handleFrame(new TextDecoder().decode(new Uint8Array(data)));
        return;
      }
      if (data instanceof Blob) {
        void data.text().then(handleFrame);
        return;
      }
      handleFrame(String(data));
    });

    ws.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("Pocket Option: ошибка WebSocket"));
    });

    ws.addEventListener("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("Pocket Option: соединение закрыто до получения активов"));
    });
  });
}

let snapshotCache: PoSnapshot | null = null;
let inflight: Promise<PoSnapshot> | null = null;
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;

/** Кэшированный снимок активов (обновляется раз в 10 минут). */
export async function getAssets(force = false): Promise<PoSnapshot> {
  if (!force && snapshotCache && Date.now() - snapshotCache.fetchedAt < SNAPSHOT_TTL_MS) {
    return snapshotCache;
  }
  if (inflight) return inflight;
  inflight = fetchSnapshotAnyHost()
    .then((snap) => {
      snapshotCache = snap;
      return snap;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Список активов с перебором серверов PO: недоступный сервер пропускаем. */
async function fetchSnapshotAnyHost(): Promise<PoSnapshot> {
  let lastError: unknown;
  for (let i = 0; i < wsHosts().length; i++) {
    const host = feedHost();
    try {
      return await fetchSnapshot(12_000, host);
    } catch (error) {
      lastError = error;
      rotateHost(`активы: ${(error as Error).message}`, host);
    }
  }
  throw lastError;
}

export function cachedSnapshot(): PoSnapshot | null {
  return snapshotCache;
}
