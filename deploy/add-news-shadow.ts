/** Patch current live bundle only; do not rebuild unrelated live-only strategies.
 * bun deploy/add-news-shadow.ts /absolute/input.mjs /absolute/output.mjs
 * Deploy deploy/out/news-shadow.js alongside bot.js first.
 */
const [input, output] = Bun.argv.slice(2);
if (!input || !output) throw new Error("input and output required");
let s = await Bun.file(input).text();
if (s.includes("startNewsShadowLive")) throw new Error("Already patched");
function once(anchor: string, replacement: string) {
  if (s.split(anchor).length !== 2) throw new Error(`Ambiguous anchor: ${anchor.slice(0, 80)}`);
  s = s.replace(anchor, replacement);
}
s = 'import { startNewsShadow as startNewsShadowLive, readNewsShadowStatus as readNewsShadowStatusLive, newsTelegramStatus as newsTelegramStatusLive } from "./news-shadow.js";\n' + s;
once('      startScanner(settings.scanIntervalSec);', '      startNewsShadowLive();\n      startScanner(settings.scanIntervalSec);');
once('async function handleCommand(chatId, text, title, chatType = "private", senderId, messageId) {', `async function handleCommand(chatId, text, title, chatType = "private", senderId, messageId) {
  if (/^\\/news(?:@[a-z0-9_]+)?(?:\\s|$)/i.test(text.trim())) {
    try { await sendMessage(chatId, await newsTelegramStatusLive()); }
    catch { await sendMessage(chatId, "Новостной журнал недоступен. Реальные веса не меняются."); }
    return;
  }`);
once('    "/status — состояние сканера",', '    "/status — состояние сканера",\n    "/news — новостной риск и покрытие (теневой режим)",');
once('  app.get("/api/ops/health", async (c) => c.json(await health()));', '  app.get("/api/ops/health", async (c) => c.json(await health()));\n  app.get("/api/ops/news", async (c) => c.json(await readNewsShadowStatusLive()));');
await Bun.write(output, s);
console.log("News shadow patch written:", output);