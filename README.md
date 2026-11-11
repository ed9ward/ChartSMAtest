# sma-chart

Mini trading chart (TradingView Lightweight Charts) with an SMA indicator, built to show that
indicator maths and chart rendering can be covered by fast autotests.

## Run

```powershell
cd D:\Data\sma-chart
npm install
npx playwright install chromium   # once
npm run serve                     # http://localhost:4173
```

## Tests

```powershell
npm run test:unit   # Vitest: SMA, generator, data sanitizing (~1 s)
npm run test:ui     # Playwright: settings, price, realtime, feed disconnect/reconnect, resize, 2000 bars, strange data, canvas pixels
npm test            # both
```

## Layout

- `src/sma.js` SMA for open/high/low/close/volume/hl2/hlc3/ohlc4, any period
- `src/indicators.js` pure reference calculations for SMA, EMA, Bollinger Bands and RSI
- `src/indicator-engine.js` incremental live calculations; only the newest candle is recalculated on each update
- `src/generator.js` seeded sine + noise candles, tick-by-tick forming candle
- `src/feed.js` live feed: replays candles tick by tick (5 ticks per candle)
- `src/live.js` Binance public data: REST klines + WebSocket kline stream (no API key)
- `src/sanitize.js` rejects NaN/null/out-of-range, merges duplicates, sorts
- `src/app.js` the page; exposes `window.__app` for tests
- `tests/unit/helpers.js` independent reference SMA used as the expected value
- `?bug=offbyone` injects a broken SMA to prove the tests catch it

## Real data

Pick **Binance live** in the Data list, then a symbol and a timeframe. History comes from the REST API,
updates from the WebSocket. Tests use `tests/fixtures/btcusdt-1m.json` (50 real BTCUSDT 1m bars) and replace
only the network; SMA values are checked against numbers calculated outside JavaScript.
To compare with TradingView: `BINANCE:BTCUSDT`, 1m, SMA length 20, source close, last bar 2026-11-10 16:17 UTC
(the chart here shows UTC; TradingView shows your time zone).

## Live demo

GitHub Pages serves the repo root: https://ed9ward.github.io/ChartSMAtest/

## Live data integrity

Binance and Coinbase REST/WebSocket messages are parsed strictly: numeric fields must be finite, timestamps must use the expected unit and align to the selected candle interval, and malformed rows are counted instead of being silently coerced. Historical gaps are reported for dense candle sources; Coinbase explicitly omits buckets with no trades, so clean sparse Coinbase history is not flagged as data loss. For sparse Coinbase history, a gap is reported only when a rejected row identifies the missing bucket; ordinary no-trade intervals remain unreported. Misaligned candles are rejected. Binance WebSocket connections are proactively rotated after 23 h 50 min, before the exchange's 24-hour connection lifetime, with REST history reloaded during the handover.

Coinbase live candles use the `matches` and `heartbeat` channels. Missed trades are recovered through the public REST Trades endpoint using trade-ID cursor pagination, up to 10 pages (10,000 records) per recovery; if the missing range cannot be covered, the app requests a full history resync rather than accepting a hole. Pagination uses the documented `before` / `after` query parameters and does not depend on browser access to response headers. Closed candles are checked against REST with bounded retries. At startup, the first `last_match` establishes an exact trade-ID boundary. The app rebuilds the forming bucket from older REST trades, then applies matches buffered during that request. This avoids both double-counting the candle snapshot and leaving its current bucket incomplete. Intraday reconstruction is bounded to 10,000 trades; daily candles skip this trade-by-trade bootstrap because a full day can exceed that bound by a wide margin. If an intraday bucket exceeds the limit or REST data is incomplete, the existing seed is retained and the final candle is reconciled after close.

Live chart history is capped at 1,000 candles. Trimming old bars redraws the series without resetting the user's zoom. On ordinary live updates, SMA and Bollinger Bands calculate only the newest window, while EMA and RSI advance their recursive state in constant time; changing settings or applying historical corrections rebuilds the engine from the available candles.
