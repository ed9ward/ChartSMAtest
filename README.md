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
- `src/generator.js` seeded sine + noise candles, tick-by-tick forming candle
- `src/feed.js` live feed: replays candles tick by tick (5 ticks per candle)
- `src/sanitize.js` rejects NaN/null/out-of-range, merges duplicates, sorts
- `src/app.js` the page; exposes `window.__app` for tests
- `tests/unit/helpers.js` independent reference SMA used as the expected value
- `?bug=offbyone` injects a broken SMA to prove the tests catch it

## Live demo

GitHub Pages serves the repo root: https://ed9ward.github.io/ChartSMAtest/
