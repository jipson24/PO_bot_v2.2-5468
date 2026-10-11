/** Точечный перенос команды в скачанный live-бандл, без потери live-only модулей.
 * bun deploy/add-ssid-command.ts <input.mjs> <output.mjs>
 */
const [input, output] = Bun.argv.slice(2);
if (!input || !output) throw new Error("Нужны input.mjs output.mjs");
let bundle = await Bun.file(input).text();
const transpiler = new Bun.Transpiler({ loader: "ts", target: "node" });
const base = new URL("../packages/web/src/api/", import.meta.url);
const source = async (path: string) => Bun.file(new URL(path, base)).text();
function once(from: string, to: string) {
  if (bundle.split(from).length !== 2) throw new Error(`Неоднозначный anchor: ${from.slice(0, 90)}`);
  bundle = bundle.replace(from, to);
}
function plain(source: string) {
  return transpiler.transformSync(source).replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, "").replace(/^\{ feedHost \};\n/gm, "");
}
const command = plain(await source("engine/ssid-command.ts"));
const hosts = plain(await source("market/po-hosts.ts")).replace(/\bscope\b/g, "ssidHostScope");
const session = plain(await source("market/po-session.ts"));
const feed = await source("market/po-feed.ts");
const connect = plain(feed.slice(feed.indexOf("function connect():"), feed.indexOf("/**\n * Свечи по паре")));
const reconnect = plain(feed.slice(feed.indexOf("export function reconnectFeed("), feed.indexOf("/** Мягкая проверка фида")));
once("function connect() {", hosts + session + '\nvar lastAuthedHost = "";\nfunction connect() {');
const start = bundle.indexOf("function connect() {");
const end = bundle.indexOf("async function poCandles(", start);
if (start < 0 || end < 0) throw new Error("Не найден connect/poCandles");
bundle = bundle.slice(0, start) + connect + "\n" + reconnect + "\n" + bundle.slice(end);
once('async function handleCommand(chatId, text, title, chatType = "private") {', command + `
async function handleCommand(chatId, text, title, chatType = "private", senderId, messageId) {
  if (isSsidCommand(text)) {
    await handleSsidCommand(chatId, chatType, senderId, text, {
      expectedUid: envStr("POCKET_OPTION_UID"),
      isDemo: envFlag("POCKET_OPTION_DEMO", true),
      reply: (reply) => sendMessage(chatId, reply),
      removeMessage: () => messageId == null ? Promise.resolve() : call("deleteMessage", { chat_id: chatId, message_id: messageId }),
      save: (ssid) => updateSettings({ poSsid: ssid }),
      apply: (ssid) => setEnvOverride("POCKET_OPTION_SSID", ssid),
      reconnect: () => reconnectFeed(),
    });
    return;
  }
`);
once('${msg.text}`);', '${safeTelegramText(msg.text)}`);');
once('await handleCommand(chatId, msg.text, title, msg.chat.type ?? "private");',
  'await handleCommand(chatId, msg.text, title, msg.chat.type ?? "private", msg.from ? String(msg.from.id) : undefined, msg.message_id);');
once('console.error("[telegram] handler:", error.message);',
  'console.error("[telegram] handler:", isSsidCommand(msg.text) ? "ошибка команды /ssid (детали скрыты)" : error.message);');
once('    "/status — состояние сканера",', '    "/status — состояние сканера",\n    "/ssid &lt;строка&gt; — обновить сессию PO (только владелец, личный чат)",');
once('feed: { ...feedState(), ssidLooksLikeCookie: ssidLooksLikeCookie() },',
  'feed: { ...feedState(), host: feedHost(), ssidLooksLikeCookie: ssidLooksLikeCookie() },');
// Перебор серверов и для отдельного соединения со списком активов.
once('function fetchSnapshot(timeoutMs = 20000) {', 'function fetchSnapshot(timeoutMs = 20000, host = feedHost()) {');
once('const url = envFlag("POCKET_OPTION_DEMO", true) ? WS_URL : LIVE_WS_URL;', 'const url = wsUrl(host);');
once('"User-Agent": UA2', '"User-Agent": pocketUserAgent()');
once('inflight = fetchSnapshot().then(', 'inflight = fetchSnapshotAnyHost().then(');
const assets = await source("market/pocket-option.ts");
const helper = plain(assets.slice(assets.indexOf("async function fetchSnapshotAnyHost"), assets.indexOf("export function cachedSnapshot")));
once("function cachedSnapshot() {", helper + "\nfunction cachedSnapshot() {");
await Bun.write(output, bundle);
console.log("Патч создан:", output, "байт:", Buffer.byteLength(bundle));