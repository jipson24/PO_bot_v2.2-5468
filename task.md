# News shadow implementation — updated 2026-10-29

## User-approved scope
- All monitored real (non-OTC) instruments.
- Shadow only, no changes to settings, analyze(), trading weights or signal delivery.
- Free economic calendar, central-bank/world news, crypto, corporate events.
- Explicit source/latency/missing-actual coverage gaps.

## Architecture decisions
- Independent collector, separate news_* tables; deployed as appended module to current live bundle to preserve live-only strategy/tape modules.
- Immutable event revisions: first observed time is authoritative; no retrospective knowledge in assessments.
- Provisional risk-only confidence multiplier; no fabricated directional prediction.
- Capture all real assets (active and inactive) each assessment cycle and correlate new real signals with as-of-entry knowledge; later correlations explicitly lagged.
- Measure available broker price reaction around observed events, with missing/stale candle flags; no causal claims.
- Ops/news and /news status for inspection; UI read-only panel if practical.

## Research verified
- FF weekly JSON HTTP200; no actual values, hourly refresh limit.
- Federal Reserve monetary RSS, ECB RSS, BBC business/world, CoinDesk RSS HTTP200.
- SEC RSS HTTP403, Yahoo RSS HTTP404: do not claim corporate filing coverage.
- Project attachment instruction file not present on filesystem; repository older than live, preserve live code.

## Progress
- [x] Scope approval
- [x] Research/endpoints
- [x] Collector, mapping, scoring, additive SQL tables
- [x] Tests: 8 pass / 34 assertions; typecheck and production web build passed
- [x] Source availability / real instrument inventory: 55 real assets, 22 channels
- [x] Deploy live shadow module, verify rows/logs: PID 1316662 / Node v20.20.2
- [x] Continued operation 29 Oct 01:11 UTC: heartbeat 12 sec old, all sources healthy
- [x] 3516 observations / 26345 assessments / 27 real shadow signals
- [x] Reactions: 562 complete / 1756 missing-bars; association only, no performance claim
- [x] Browser check: news tab, 77 table rows, no JavaScript errors
- [x] Final mobile check: 390px viewport, no page horizontal overflow; dev preview restarted in tmux
- [ ] Git commit and push
- [ ] Deliver technical status and visibility

## Remaining caveats
- No reliable actual-vs-forecast values, no structured earnings/SEC coverage.
- Hosted static UI intentionally not overwritten; new tab in Runable preview.
- Live logs include market-channel TypeError / HTTP 502 and one scanner error; cause not investigated, no claim of fault-free delivery.
- Live weights unchanged; future live integration requires explicit approval and out-of-time validation.