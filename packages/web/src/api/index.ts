import type { RouterClient } from "@orpc/server";
import { createApp } from "./__core/app";
import { boot } from "./engine/boot";
import { registerOps } from "./ops";
import { config } from "./routes/config";
import { pairs } from "./routes/pairs";
import { ping } from "./routes/ping";
import { signals } from "./routes/signals";
import { stats } from "./routes/stats";
import { news } from "./routes/news";

// API features are oRPC procedures, one file per feature in ./routes/,
// composed into this router — typed end-to-end via the clients
// (web: src/web/lib/api.ts, mobile: lib/api.ts).
// Keep each routes/ file under 500 lines (`bun run lint` enforces this);
// split into more feature files as they grow.
// Patterns and examples: skills/app/references/api.md
export const router = {
  ping,
  signals,
  pairs,
  config,
  stats,
  news,
};

export type AppRouter = typeof router;
/** Typed client for the router — used by the web and mobile api clients. */
export type AppRouterClient = RouterClient<AppRouter>;

const app = createApp(router);

// Служебный канал /api/ops/* — разбор архива и логов на хостинге без SSH.
// Молчит (503), пока не задан OPS_TOKEN.
registerOps(app);

// Движок сигналов: сканер Pocket Option + Telegram-бот. Идемпотентно.
boot();
// Rare plain-HTTP endpoints (webhooks, streaming, the Better Auth handler)
// register here with full paths, e.g. app.post("/api/webhooks/example", ...)

export default app;
