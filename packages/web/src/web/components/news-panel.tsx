import { useState } from "react";
import { ExternalLink, Newspaper, RefreshCw } from "lucide-react";
import { useNewsOverview } from "../queries/news";
import { Chip, Panel, Stat } from "./primitives";

const stamp = (s: number | null) => s == null ? "нет данных" : new Date(s * 1000).toLocaleString("ru-RU", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const riskName = (n: number | null) => n == null ? "нет покрытия" : ["нет событий в окне", "низкий", "повышенный", "высокий"][n];
export function NewsPanel() {
  const query = useNewsOverview(), data = query.data;
  const [filter, setFilter] = useState("");
  if (query.isLoading) return <Panel title="Новостной блок">Загружаю теневой журнал…</Panel>;
  if (query.isError || !data) return <Panel title="Новостной блок"><p className="text-sm text-put">Журнал пока недоступен. Это не означает отсутствие новостей.</p><button className="mt-3 text-sm text-info" onClick={() => void query.refetch()}>Повторить загрузку</button></Panel>;
  const fresh = data.status && Date.now() / 1000 - data.status.checkedAt < 300;
  const assets = data.assessments.filter((a) => a.symbol.toLowerCase().includes(filter.toLowerCase()));
  return <div className="min-w-0 space-y-4 [&_header]:flex-wrap">
    <Panel title={<span className="inline-flex items-center gap-2"><Newspaper className="size-4" />Новости · реальные инструменты</span>} right={<Chip tone="gold">Теневой режим</Chip>}>
      <p className="text-sm">Новости оцениваются отдельно. <b>Сигналы, направление и реальные веса входа не меняются.</b> OTC исключены.</p>
      <p className="mt-2 text-xs text-muted-foreground">Обновление: {stamp(data.status?.checkedAt ?? null)} по Киеву · {fresh ? "коллектор отвечает" : "данные устарели / коллектор не подтверждён"}. Оценка направления цены пока отсутствует, риск — экспериментальная гипотеза.</p>
      <button onClick={() => void query.refetch()} className="mt-3 inline-flex items-center gap-1.5 text-xs text-info"><RefreshCw className="size-3" />Обновить журнал</button>
    </Panel>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label="Реальные инструменты" value={data.status?.assets ?? data.assessments.length} hint={`активных у брокера: ${data.status?.activeAssets ?? "—"}`} tone="info" />
      <Stat label="События в журнале" value={data.counts.events} hint="наблюдения и версии релизов" />
      <Stat label="Теневые входы" value={data.counts.signals} hint="только знания на момент входа" tone="gold" />
      <Stat label="Реакции цены" value={data.counts.measured_reactions} hint={`нет полной M1-ленты: ${data.counts.missing_reactions}`} />
    </div>
    <Panel title="Границы бесплатного покрытия">
      <ul className="space-y-1 text-xs text-muted-foreground">
        <li>Не все мировые агентства: только перечисленные публичные RSS и календарь.</li>
        <li>Календарь обновляется раз в час. Факт против прогноза {data.status?.calendarActualAvailable ? "иногда доступен; полнота не гарантирована" : "не доступен: сюрприз релиза не рассчитывается"}.</li>
        <li>Корпоративные события — агрегатор заголовков; календарь отчётности и SEC filings не подключены.</li>
        <li>Для сырья нет специализированной ленты ОПЕК/запасов. Отсутствие новости не равно отсутствию риска.</li>
        <li>Множители ниже не откалиброваны; измеренная реакция цены — совпадение во времени, не доказательство причинности.</li>
      </ul>
    </Panel>
    <Panel title="Теневые оценки по инструментам" right={<input aria-label="Поиск инструмента" placeholder="EURUSD, BTC, AAPL…" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-40 rounded border border-border bg-background px-2 py-1 text-xs" />} bodyClassName="p-0">
      <div className="max-h-[560px] overflow-auto"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-card text-muted-foreground"><tr><th className="p-3">Инструмент</th><th className="p-3">Новостной риск</th><th className="p-3">Множитель: тень / live</th><th className="p-3">События и пробелы</th></tr></thead><tbody>
        {assets.map((a) => <tr key={a.symbol} className="border-t border-border align-top"><td className="p-3 font-mono">{a.symbol}<div className="mt-1 text-[10px] text-muted-foreground">{stamp(a.asOf)}</div></td><td className="p-3"><Chip tone={a.risk === 3 ? "put" : a.risk === 2 ? "gold" : "muted"}>{riskName(a.risk)}</Chip></td><td className="p-3 font-mono">{a.proposedConfidenceMultiplier ?? "—"} / <span className="text-call">1.00</span></td><td className="max-w-md space-y-1 p-3">
          {a.events.length ? a.events.map((e) => <a key={e.id} href={e.url} target="_blank" rel="noreferrer" className="block text-info">{e.phase === "before" ? "До" : "После"} · {Math.abs(Math.round(e.secondsToEvent / 60))} мин · {e.title} <ExternalLink className="inline size-3" /></a>) : <span className="text-muted-foreground">Релевантных событий в окне не найдено</span>}
          <details className="text-[10px] text-muted-foreground"><summary className="cursor-pointer">Пробелы покрытия: {a.gaps.length}</summary><div className="mt-1 break-words">{a.gaps.join(" · ")}</div></details>
        </td></tr>)}
        {!assets.length && <tr><td className="p-4 text-muted-foreground" colSpan={4}>Оценки ещё не собраны или инструмент не найден.</td></tr>}
      </tbody></table></div>
    </Panel>
    <Panel title="Источники и доступность" bodyClassName="p-0"><div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-muted-foreground"><tr><th className="p-3">Источник</th><th className="p-3">Последний успех</th><th className="p-3">Следующий запрос</th><th className="p-3">Статус</th></tr></thead><tbody>{data.sources.map((s) => { const config = data.status?.sources.find((x) => x.id === s.source); return <tr className="border-t border-border" key={s.source}><td className="p-3"><a href={config?.url} className="text-info" target="_blank" rel="noreferrer">{config?.label ?? s.source}</a></td><td className="p-3">{stamp(s.lastOkAt)}</td><td className="p-3">{stamp(s.nextFetchAt)}</td><td className="p-3"><Chip tone={s.error ? "put" : "call"}>{s.error ?? `${s.items} записей`}</Chip></td></tr>; })}</tbody></table></div></Panel>
  </div>;
}