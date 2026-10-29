import { useState } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Cpu,
  Radar,
  RefreshCw,
  Settings2,
  Signal as SignalIcon,
  BarChart3,
  Users,
  Newspaper,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "../components/ui/button";
import { Chip, Empty, Panel, Skeleton, Stat } from "../components/primitives";
import { SignalCard } from "../components/signal-card";
import { PairsTable } from "../components/pairs-table";
import { ScanLog } from "../components/scan-log";
import { SettingsPanel } from "../components/settings-panel";
import { StatsPanel } from "../components/stats-panel";
import { NewsPanel } from "../components/news-panel";
import { agoLabel, expiryLabel } from "../lib/format";
import { useOverview, useResendSignal, useScanNow, useSignals } from "../queries/signals";

type Tab = "signals" | "pairs" | "settings" | "statistics" | "news";
type Filter = "all" | "call" | "put";

const TABS: { id: Tab; label: string; icon: typeof SignalIcon }[] = [
  { id: "signals", label: "Сигналы", icon: SignalIcon },
  { id: "pairs", label: "Пары", icon: Activity },
  { id: "settings", label: "Настройки", icon: Settings2 },
  { id: "statistics", label: "Статистика", icon: BarChart3 },
  { id: "news", label: "Новости", icon: Newspaper },
];

function Index() {
  const [tab, setTab] = useState<Tab>("signals");
  const [filter, setFilter] = useState<Filter>("all");

  const overview = useOverview();
  const scanNow = useScanNow();
  const signals = useSignals({ limit: 40, direction: filter === "all" ? undefined : filter });
  const resend = useResendSignal();

  const o = overview.data;

  return (
    <div className="relative min-h-screen">
      <header className="sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-lg border border-call/40 bg-call/10">
              <Radar className="size-4.5 text-call" />
            </div>
            <div>
              <h1 className="text-sm font-bold leading-tight">Pocket Signal Bot</h1>
              <p className="text-[11px] text-muted-foreground">
                Smart Money · 30m → 15m → 5m · валютные пары
              </p>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <Chip tone={o?.scannerRunning ? "call" : "put"}>
              <span
                className={cn(
                  "pulse-dot size-1.5 rounded-full",
                  o?.scannerRunning ? "bg-call" : "bg-put",
                )}
              />
              {o?.scannerRunning
                ? o.engineLocation === "remote"
                  ? "сканер активен · хостинг"
                  : "сканер активен"
                : "сканер остановлен"}
            </Chip>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 px-2.5 text-[11px]"
              disabled={scanNow.isPending}
              onClick={() => scanNow.mutate({})}
            >
              <RefreshCw className={cn("size-3.5", scanNow.isPending && "animate-spin")} />
              {scanNow.isPending ? "Сканирую…" : "Сканировать"}
            </Button>
          </div>
        </div>

        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[12px] font-medium transition-colors",
                tab === t.id
                  ? "border-call text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <t.icon className="size-3.5" />
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {overview.isLoading ? (
            [1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-[86px] w-full rounded-xl" />)
          ) : (
            <>
              <Stat
                label="Сигналов за 24ч"
                value={o?.signalsToday ?? 0}
                tone="gold"
                hint={`всего в базе: ${o?.totalSignals ?? 0}`}
              />
              <Stat
                label="CALL / PUT"
                value={
                  <span>
                    <span className="text-call">{o?.callsToday ?? 0}</span>
                    <span className="text-muted-foreground"> / </span>
                    <span className="text-put">{o?.putsToday ?? 0}</span>
                  </span>
                }
                hint="за последние 24 часа"
              />
              <Stat
                label="Пары в диапазоне"
                value={`${o?.pairs.inRange ?? 0}/${o?.pairs.total ?? 0}`}
                tone="info"
                hint={`${o?.settings.minPayout ?? 82}–${o?.settings.maxPayout ?? 92}% payout · готовы: ${o?.pairs.ready ?? 0}`}
              />
              <Stat
                label="Последний проход"
                value={o?.lastRun ? agoLabel(o.lastRun.startedAt) : "—"}
                hint={
                  o?.lastRun
                    ? `проверено ${o.lastRun.scanned} · найдено ${o.lastRun.signalsFound}`
                    : "сканер ещё не запускался"
                }
              />
            </>
          )}
        </div>

        {o && o.pairs.ready === 0 && o.pairs.waiting > 0 && (
          <div className="relative z-10 flex gap-2 rounded-xl border border-gold/30 bg-gold/5 p-3 text-[12px] text-gold">
            <Cpu className="mt-0.5 size-4 shrink-0" />
            <span>
              {o.pairs.waiting} пар из диапазона {o.settings.minPayout}–{o.settings.maxPayout}% —
              OTC, и публичный фид их котировки не отдаёт. Нужен рабочий cookie{" "}
              <b className="num">ssid</b> Pocket Option, чтобы сканер начал их считать.
            </span>
          </div>
        )}

        {tab === "signals" && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <Panel
              title={`Лента сигналов · ${signals.data?.length ?? 0}`}
              right={
                <div className="flex gap-1">
                  {(["all", "call", "put"] as Filter[]).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setFilter(f)}
                      className={cn(
                        "rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors",
                        filter === f
                          ? f === "call"
                            ? "border-call/50 bg-call/10 text-call"
                            : f === "put"
                              ? "border-put/50 bg-put/10 text-put"
                              : "border-border bg-elevated text-foreground"
                          : "border-border/60 text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {f === "all" ? "все" : f === "call" ? "call" : "put"}
                    </button>
                  ))}
                </div>
              }
              bodyClassName="p-3 space-y-3"
            >
              {signals.isLoading ? (
                [1, 2, 3].map((i) => <Skeleton key={i} className="h-44 w-full rounded-xl" />)
              ) : (signals.data?.length ?? 0) === 0 ? (
                <Empty
                  icon={<SignalIcon className="size-6" />}
                  text="Сигналов пока нет. Сканер проходит по watchlist каждую минуту и запишет сигнал, когда 30m/15m/5m сойдутся выше порога уверенности."
                />
              ) : (
                signals.data?.map((s) => (
                  <SignalCard
                    key={s.id}
                    signal={s}
                    resending={resend.isPending && resend.variables?.id === s.id}
                    onResend={(id) => resend.mutate({ id })}
                  />
                ))
              )}
            </Panel>

            <div className="space-y-4">
              <Panel title="Стратегия">
                <ul className="space-y-2 text-[12px] text-muted-foreground">
                  <Rule icon={<ArrowUpRight className="size-3.5 text-call" />}>
                    30m задаёт bias: структура HH/HL или LH/LL, BOS/CHoCH, premium/discount.
                  </Rule>
                  <Rule icon={<ArrowDownRight className="size-3.5 text-put" />}>
                    15m подтверждает: order block, FVG, снятие ликвидности, уровни S/R.
                  </Rule>
                  <Rule icon={<SignalIcon className="size-3.5 text-gold" />}>
                    5m даёт вход: свечной паттерн, MACD-кросс, RSI и дивергенции.
                  </Rule>
                  <Rule icon={<Activity className="size-3.5 text-info" />}>
                    Экспирация подбирается по ATR: {expiryLabel(60)} – {expiryLabel(900)}.
                  </Rule>
                </ul>
              </Panel>

              <Panel title="Движок">
                <div className="space-y-2 text-[12px]">
                  <Row label="Интервал скана" value={`${o?.settings.scanIntervalSec ?? 60} сек`} />
                  <Row label="Порог уверенности" value={`${o?.settings.minConfidence ?? 80}%`} />
                  <Row label="Cooldown пары" value={`${o?.settings.cooldownMinutes ?? 15} мин`} />
                  <Row
                    label="Telegram"
                    value={o?.settings.telegramEnabled ? "включён" : "выключен"}
                  />
                  <Row
                    label="Подписчики"
                    value={
                      <span className="inline-flex items-center gap-1">
                        <Users className="size-3" />
                        {o?.subscribers ?? 0}
                      </span>
                    }
                  />
                </div>
              </Panel>

              <ScanLog />
            </div>
          </div>
        )}

        {tab === "pairs" && <PairsTable />}

        {tab === "settings" && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <SettingsPanel />
            <ScanLog />
          </div>
        )}

        {tab === "statistics" && <StatsPanel />}
        {tab === "news" && <NewsPanel />}
      </main>
    </div>
  );
}

function Rule({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span>{children}</span>
    </li>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border/40 pb-1.5 last:border-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="num font-semibold">{value}</span>
    </div>
  );
}

export default Index;
