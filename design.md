# Pocket Signal Bot — Design

Мультитаймфреймовый сканер валютных пар Pocket Option: Smart Money структура + свечные паттерны + MACD + RSI + уровни поддержки/сопротивления. Сигналы уходят в Telegram и в мобильное приложение. Визуальное направление — тёмный трейдинг-терминал: графит, неоновый зелёный/красный, моноширинные цифры, плотная информативная сетка без декора.

Платформы: Telegram-бот (ядро), мобильное приложение (Expo), веб-дашборд (тот же API).

## Brand & Colors

| Token | Dark (основной) | Use |
|-------|------|-----|
| background | #08090C | Фон экрана |
| card | #10131A | Карточки сигналов |
| cardElevated | #161A24 | Вложенные блоки, чипы |
| border | #222735 | Хайрлайны |
| foreground | #F2F4F8 | Основной текст |
| mutedForeground | #8A93A6 | Подписи, метки |
| call (up) | #00E58A | CALL / бычий сигнал |
| put (down) | #FF3B5C | PUT / медвежий сигнал |
| accent | #F5C451 | Уверенность, payout, акценты |
| info | #4D8DFF | Таймфреймы, нейтральные чипы |

Mobile: `Colors.light`/`Colors.dark` в `packages/mobile/constants/theme.ts` (обе схемы = тёмная палитра, приложение всегда тёмное). Web: CSS-переменные в `packages/web/src/web/styles.css`.

## Typography

- Заголовки/цифры: `Space Mono`-подобный системный моно (`ui-monospace`, mobile: `monospace`) — цены, проценты, время.
- Текст: Poppins на web, системный на mobile.
- Иерархия: 28/20/15/13/11, плотный line-height для таблиц.

## Screens

- **Mobile — Сигналы** (`packages/mobile/app/(tabs)/index.tsx`) — лента активных сигналов: пара, CALL/PUT, время входа, экспирация, payout, уверенность, список подтверждений.
- **Mobile — Пары** (`packages/mobile/app/(tabs)/pairs.tsx`) — watchlist с payout 82–92%, статус фида, bias по 30m/15m/5m.
- **Mobile — История** (`packages/mobile/app/(tabs)/history.tsx`) — прошлые сигналы, винрейт, разбивка по парам.
- **Mobile — Настройки** (`packages/mobile/app/(tabs)/settings.tsx`) — порог уверенности, интервал сканирования, вкл/выкл рассылки, Telegram-статус.
- **Mobile — Детали сигнала** (`packages/mobile/app/signal/[id].tsx`) — полный разбор сетапа по таймфреймам.
- **Web — Дашборд** (`packages/web/src/web/pages/index.tsx`) — тот же контент в виде терминала.
- **Web — Новости** — read-only теневой журнал: реальные инструменты, события до/после публикаций, пробелы покрытия, доступность источников. Визуально те же Panel/Stat/Chip; жёлтая метка «Теневой режим», live-множитель всегда 1.00.

## Flows

1. Сканер раз в минуту берёт watchlist (payout 82–92%) → тянет свечи 5m/15m/30m → считает конфлюэнс → при достижении порога пишет сигнал в БД и шлёт в Telegram.
2. Пользователь в Telegram: `/start` подписка, `/signals` последние, `/pairs` watchlist, `/status` состояние движка, `/threshold 70` порог.
3. Мобильное приложение читает те же сигналы через oRPC и обновляется каждые 15 секунд.

## Architecture

- API + движок: Hono + oRPC + Drizzle (Turso). Сканер и Telegram long-polling стартуют из `api/engine/boot.ts` (singleton-guard).
- Данные: `market/pocket-option.ts` — список активов и payout по WS Pocket Option; `market/candles.ts` — свечи (публичный фид сейчас, PO-фид при валидном `ssid`).
- Стратегия: `strategy/` — indicators, structure (Smart Money/SR/паттерны), analyze (мультитаймфрейм-скоринг).
