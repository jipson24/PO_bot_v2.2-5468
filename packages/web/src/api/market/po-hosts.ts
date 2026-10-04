/**
 * Серверы Pocket Option по очереди — общие для фида свечей и списка активов.
 *
 * С UkrLine `api-eu.po.market` (185.104.209.21) недоступен по сети (тайм-аут
 * TCP), а `api-us-north`/`api-sc` принимают ту же сессию и отдают те же данные.
 * Если сервер не ответил, следующая попытка идёт на следующий, и выбор
 * запоминается для обоих модулей. Свой список: `POCKET_OPTION_WS_HOSTS=h1,h2`.
 */
import { envFlag, envStr } from "../env";

const HOSTS_LIVE = ["api-eu.po.market", "api-us-north.po.market", "api-sc.po.market"];
const HOSTS_DEMO = ["demo-api-eu.po.market"];

const scope = globalThis as unknown as { __poHostIdx?: number };

export function wsHosts(): string[] {
  const custom = envStr("POCKET_OPTION_WS_HOSTS")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (custom.length) return custom;
  return envFlag("POCKET_OPTION_DEMO", true) ? HOSTS_DEMO : HOSTS_LIVE;
}

/** Текущий сервер PO — виден в /api/ops/status и логах. */
export function feedHost(): string {
  const hosts = wsHosts();
  return hosts[(scope.__poHostIdx ?? 0) % hosts.length]!;
}

export function wsUrl(host = feedHost()): string {
  return `wss://${host}/socket.io/?EIO=4&transport=websocket`;
}

/** Перейти на следующий сервер, если `failed` всё ещё текущий. */
export function rotateHost(reason: string, failed = feedHost()) {
  const hosts = wsHosts();
  if (hosts.length < 2 || failed !== feedHost()) return;
  scope.__poHostIdx = ((scope.__poHostIdx ?? 0) + 1) % hosts.length;
  console.warn(`[po-feed] ${failed}: ${reason} → пробую ${feedHost()}`);
}
