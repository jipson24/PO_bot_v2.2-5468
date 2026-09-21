import { useEffect, useState } from "react";
import { Check, Info, Send, TriangleAlert } from "lucide-react";
import { Button } from "./ui/button";
import { Chip, Panel, Skeleton } from "./primitives";
import { dateShort } from "../lib/format";
import { useConfig, useUpdateConfig } from "../queries/config";

interface Draft {
  minConfidence: number;
  scanIntervalSec: number;
  minPayout: number;
  maxPayout: number;
  cooldownMinutes: number;
  excludedSymbols: string;
  blockedHours: string;
  assetClasses: string;
}

/** Классы активов Pocket Option в порядке показа. */
const ASSET_CLASS_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: "currency", label: "Валюты", hint: "80 активов" },
  { value: "cryptocurrency", label: "Криптовалюты", hint: "23 активa" },
  { value: "commodity", label: "Сырьё", hint: "золото, серебро, нефть" },
  { value: "stock", label: "Акции", hint: "40 активов" },
  { value: "index", label: "Индексы", hint: "payout ~45%" },
];

export function SettingsPanel() {
  const config = useConfig();
  const update = useUpdateConfig();
  const [draft, setDraft] = useState<Draft | null>(null);

  const settings = config.data?.settings;
  useEffect(() => {
    if (!settings || draft) return;
    setDraft({
      minConfidence: settings.minConfidence,
      scanIntervalSec: settings.scanIntervalSec,
      minPayout: settings.minPayout,
      maxPayout: settings.maxPayout,
      cooldownMinutes: settings.cooldownMinutes,
      excludedSymbols: settings.excludedSymbols ?? "",
      blockedHours: settings.blockedHours ?? "",
      assetClasses: settings.assetClasses ?? "currency",
    });
  }, [settings, draft]);

  if (config.isLoading || !draft || !settings) {
    return (
      <Panel title="Настройки движка">
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </Panel>
    );
  }

  const dirty =
    draft.minConfidence !== settings.minConfidence ||
    draft.scanIntervalSec !== settings.scanIntervalSec ||
    draft.minPayout !== settings.minPayout ||
    draft.maxPayout !== settings.maxPayout ||
    draft.cooldownMinutes !== settings.cooldownMinutes ||
    draft.excludedSymbols !== (settings.excludedSymbols ?? "") ||
    draft.blockedHours !== (settings.blockedHours ?? "") ||
    draft.assetClasses !== (settings.assetClasses ?? "currency");

  const excludedCount = draft.excludedSymbols
    .split(/[,\s;]+/)
    .filter(Boolean).length;

  const blockedCount = draft.blockedHours
    .split(/[,\s;]+/)
    .filter(Boolean).length;

  const activeClasses = new Set(
    draft.assetClasses.split(/[,\s;]+/).map((v) => v.trim().toLowerCase()).filter(Boolean),
  );
  const toggleClass = (value: string) => {
    const next = new Set(activeClasses);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    // Пустой список означал бы «сканировать нечего» — оставляем валюты.
    if (next.size === 0) next.add("currency");
    setDraft({
      ...draft,
      assetClasses: ASSET_CLASS_OPTIONS.filter((o) => next.has(o.value))
        .map((o) => o.value)
        .join(","),
    });
  };

  return (
    <div className="space-y-4">
      <Panel
        title="Настройки движка"
        right={
          <Button
            size="sm"
            className="h-7 px-3 text-[11px]"
            disabled={!dirty || update.isPending}
            onClick={() => update.mutate(draft)}
          >
            {update.isPending ? "Сохранение…" : dirty ? "Сохранить" : "Сохранено"}
          </Button>
        }
      >
        <div className="space-y-5">
          <Slider
            label="Порог уверенности"
            value={draft.minConfidence}
            min={60}
            max={95}
            suffix="%"
            hint="Ниже порога сигнал в Telegram не уходит. 80% — только сильные сетапы."
            onChange={(v) => setDraft({ ...draft, minConfidence: v })}
          />
          <Slider
            label="Интервал сканирования"
            value={draft.scanIntervalSec}
            min={30}
            max={900}
            step={30}
            suffix=" сек"
            onChange={(v) => setDraft({ ...draft, scanIntervalSec: v })}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Slider
              label="Payout от"
              value={draft.minPayout}
              min={50}
              max={100}
              suffix="%"
              onChange={(v) => setDraft({ ...draft, minPayout: v })}
            />
            <Slider
              label="Payout до"
              value={draft.maxPayout}
              min={50}
              max={100}
              suffix="%"
              onChange={(v) => setDraft({ ...draft, maxPayout: v })}
            />
          </div>
          <Slider
            label="Пауза по паре (cooldown)"
            value={draft.cooldownMinutes}
            min={0}
            max={240}
            step={5}
            suffix=" мин"
            hint="Сколько не повторять сигнал по одной и той же паре."
            onChange={(v) => setDraft({ ...draft, cooldownMinutes: v })}
          />

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-[12px] font-medium">Не сканировать пары</span>
              <span className="num text-[11px] text-muted-foreground">
                {excludedCount} шт.
              </span>
            </div>
            <textarea
              aria-label="Пары, которые не сканировать"
              value={draft.excludedSymbols}
              spellCheck={false}
              rows={2}
              placeholder="SYPUSD_otc, IRRUSD_otc"
              onChange={(e) => setDraft({ ...draft, excludedSymbols: e.target.value })}
              className="num w-full resize-y rounded-lg border border-border bg-elevated/50 px-3 py-2 text-[12px] outline-none focus:border-gold/60"
            />
            <p className="text-[11px] text-muted-foreground">
              Символы через запятую. Такие пары полностью выпадают из watchlist — ни в диапазоне
              payout, ни в резерве. Регистр не важен.
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-[12px] font-medium">Классы активов</span>
              <span className="num text-[11px] text-muted-foreground">
                {activeClasses.size} из {ASSET_CLASS_OPTIONS.length}
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {ASSET_CLASS_OPTIONS.map((opt) => {
                const on = activeClasses.has(opt.value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleClass(opt.value)}
                    className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left transition ${
                      on
                        ? "border-gold/60 bg-gold/10"
                        : "border-border bg-elevated/50 hover:border-border/80"
                    }`}
                  >
                    <span className="text-[12px] font-medium">{opt.label}</span>
                    <span className="num text-[10px] text-muted-foreground">{opt.hint}</span>
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Что сканер берёт из списка брокера. Свечи по крипте, сырью и акциям идут с того же
              фида Pocket Option, что и по валютам. Индексы выключены по умолчанию: payout у них
              около 45% — ниже, чем нужно диапазону.
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-[12px] font-medium">Закрытые часы (Киев)</span>
              <span className="num text-[11px] text-muted-foreground">
                {blockedCount} ч.
              </span>
            </div>
            <input
              aria-label="Закрытые часы по Киеву"
              value={draft.blockedHours}
              spellCheck={false}
              placeholder="5, 6, 7"
              onChange={(e) => setDraft({ ...draft, blockedHours: e.target.value })}
              className="num w-full rounded-lg border border-border bg-elevated/50 px-3 py-2 text-[12px] outline-none focus:border-gold/60"
            />
            <p className="text-[11px] text-muted-foreground">
              Часы 0–23 через запятую. В эти часы сигналы не публикуются — час считается по
              времени входа. По замеру 21.09 часы 05–07 давали винрейт 20–29%.
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <Toggle
              label="Сканер включён"
              value={settings.scannerEnabled}
              pending={update.isPending}
              onChange={(v) => update.mutate({ scannerEnabled: v })}
            />
            <Toggle
              label="Рассылка в Telegram"
              value={settings.telegramEnabled}
              pending={update.isPending}
              onChange={(v) => update.mutate({ telegramEnabled: v })}
            />
            <Toggle
              label="Резерв: обычные пары"
              value={settings.fallbackPairs}
              pending={update.isPending}
              onChange={(v) => update.mutate({ fallbackPairs: v })}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Диапазон 82–92% — это OTC-пары, их котировки идут с родного фида Pocket Option по
            cookie <b className="num">ssid</b>. Резерв подмешивает обычные валютные пары с публичным
            фидом, только если живых пар в диапазоне меньше восьми — чтобы сканер не молчал, если
            сессия PO отвалится.
          </p>
        </div>
      </Panel>

      <Panel title="Telegram">
        <div className="space-y-3 text-[12px]">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={config.data?.telegramConfigured ? "call" : "put"}>
              {config.data?.telegramConfigured ? (
                <>
                  <Check className="size-3" /> токен бота задан
                </>
              ) : (
                <>
                  <TriangleAlert className="size-3" /> нет TELEGRAM_BOT_TOKEN
                </>
              )}
            </Chip>
            <Chip tone="info">
              <Send className="size-3" /> подписчиков: {config.data?.subscribers.length ?? 0}
            </Chip>
          </div>

          {(config.data?.subscribers.length ?? 0) === 0 ? (
            <p className="rounded-lg border border-gold/30 bg-gold/5 p-3 text-gold">
              Подписчиков нет. Откройте бота в Telegram и отправьте <b>/start</b> в нужном чате —
              после этого сигналы начнут приходить туда.
            </p>
          ) : (
            <ul className="space-y-1">
              {config.data?.subscribers.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between rounded-lg border border-border/60 bg-elevated/50 px-3 py-2"
                >
                  <span className="num">{s.title ?? s.chatId}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {s.isActive ? "активен" : "отключён"} · {dateShort(s.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-2 rounded-lg border border-info/25 bg-info/5 p-3 text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0 text-info" />
            <span>
              Команды бота: <b>/start</b> подписка, <b>/signals</b> последние сигналы,{" "}
              <b>/pairs</b> watchlist, <b>/status</b> состояние движка, <b>/threshold 70</b> порог
              уверенности, <b>/stop</b> отписка.
            </span>
          </div>

          {config.data?.poFeed && (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 p-3 text-muted-foreground">
              <span
                className={`size-2 shrink-0 rounded-full ${
                  config.data.poFeed.state === "live"
                    ? "bg-call"
                    : config.data.poFeed.state === "connecting"
                      ? "bg-gold"
                      : "bg-put"
                }`}
              />
              <span>
                Фид Pocket Option: <b>{feedLabel(config.data.poFeed.state)}</b>
                {config.data.poFeed.lastPayloadAt
                  ? ` · данные ${Math.max(0, Math.round((Date.now() - config.data.poFeed.lastPayloadAt) / 1000))} сек назад`
                  : ""}
                {config.data.poFeed.clockSkewSec
                  ? ` · часы брокера +${config.data.poFeed.clockSkewSec / 3600} ч`
                  : ""}
                {config.data.poFeed.note ? ` · ${config.data.poFeed.note}` : ""}
              </span>
            </div>
          )}

          {!config.data?.otcUnlocked && (
            <div className="flex gap-2 rounded-lg border border-put/25 bg-put/5 p-3 text-muted-foreground">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-put" />
              <span>{config.data?.otcNote}</span>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = "",
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span className="num text-sm font-bold text-gold">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-elevated accent-[var(--call)]"
        style={{ accentColor: "var(--call)" }}
      />
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Toggle({
  label,
  value,
  pending,
  onChange,
}: {
  label: string;
  value: boolean;
  pending?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between rounded-lg border border-border/60 bg-elevated/50 px-3 py-2.5">
      <span className="text-[12px]">{label}</span>
      <input
        type="checkbox"
        aria-label={label}
        checked={value}
        disabled={pending}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-[var(--call)]"
      />
    </label>
  );
}

/** Понятная подпись состояния фида PO. */
function feedLabel(state: string): string {
  const names: Record<string, string> = {
    idle: "не подключён",
    connecting: "подключается",
    live: "работает",
    unauthorized: "нет доступа",
    error: "ошибка",
  };
  return names[state] ?? state;
}
