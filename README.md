# sma-chart

**English** · [Русский](#русский)

## English

A small trading chart (TradingView [Lightweight Charts](https://github.com/tradingview/lightweight-charts)) with four indicators, built to show that indicator maths, data handling and chart rendering can be covered by fast, reliable autotests. Live demo: https://ed9ward.github.io/TradingChartTest/ (self-checks: `/checks.html`).

### What it does

- **Indicators:** SMA, EMA (two starts: first value as TradingView, or SMA of the first N as TA-Lib), Bollinger Bands, RSI (Wilder). Sources: open, high, low, close, volume, hl2, hlc3, ohlc4. Any period.
- **Data:** a seeded demo feed (13 scenarios: normal, 2000 bars, negative, huge, tiny, overflow, NaN, impossible candles, duplicates, unordered, flat, stalled, empty), **Binance** (BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT) and **Coinbase** (BTC-USD, ETH-USD, SOL-USD) live data, timeframes 1m, 5m, 15m, 1h, 1d. No API keys.
- **Data checks:** strict number parsing (null, empty strings, hex, NaN, off-grid timestamps are rejected), the candle rule (high/low must contain open/close, volume not negative), duplicates merged, order fixed, missing intervals reported. Rejected data is counted in the status bar, never drawn.
- **Live reliability:** automatic reconnect (1, 2, 4, 8, 16, 30 s), silence watchdog (30 s Binance, 10 s Coinbase), Coinbase trade numbering kept and lost trades recovered over REST, closed candles checked against the exchange, history capped at 1000 bars, day change by the exchange's own clock.
- **Reading aids:** price decimals adapt to the size of the price (0.00001234 is not shown as 0.00), a note says when EMA/RSI have too little history to settle or when a period is longer than the history, the zoom survives a change of settings, the time axis is UTC.

### Run

```powershell
cd D:\Data\sma-chart
npm install
npx playwright install chromium   # once
npm run serve                     # http://localhost:4173
```

### Tests

```powershell
cd D:\Data\sma-chart
npm run test:unit    # Vitest, ~15 s
npm run test:ui      # Playwright (Chromium), 3-5 min locally
npm test             # both
npm run mutate       # the tests test themselves, see below (~8 min)
```

| Layer | What it holds | Count |
|---|---|---|
| Unit (Vitest) | every indicator against independent formulas and golden values, parsers, candle rule, Coinbase recovery, the incremental engine against TA-Lib/pandas | ~1320 |
| Browser (Playwright) | settings and recalculation of every indicator/source/period, legend and price formats, live feeds against pretend exchanges (drops, gaps, garbage, reconnects), a seeded fuzz test of random user actions and network failures | ~458 |
| What is drawn | candle colours, wicks, tops and bottoms checked by pixel; RSI panel; Bollinger lines; axes; other window sizes; the indicator line at the right height | 24 + more in the layers above |
| Self-checks page | 345 checks run in the browser, including a comparison with TA-Lib and pandas (7 data sets, ~86 000 values) | 345 |

CI (GitHub Actions) runs syntax check, unit and browser tests in about 2.5 minutes. Mutation testing runs weekly.

### Self-checks page (`checks.html`)

- **Run all checks:** every indicator against an independent reference, then the real page is driven the way a user would. A table shows how many values match TA-Lib/pandas.
- **Check the real exchanges (needs internet):** asks Binance and Coinbase themselves and reports whether this page can still read what they send (candle format, timeframes, trade numbering, the live stream, the two exchanges' prices against each other). Not part of "Run all checks" and not run in CI. If your network is blocked you will see the reason (for example `HTTP 451`).

### Mutation testing

`npm run mutate` breaks the code in 108 places, one at a time, and checks that the tests notice each break. A mutant that survives is a place where a real bug would go unnoticed. `npm run mutate:check` only checks that the list still applies to the code. Details are in `scripts/mutation/`.

### Reference data

`tests/fixtures/talib-reference.json` holds indicator values calculated by TA-Lib and pandas for 7 data sets (550 real BTCUSDT 1m bars, random walks at other price scales, negative prices, 2000 bars). Regenerate it (Python with `TA-Lib`, `pandas`, `numpy`):

```powershell
cd D:\Data\sma-chart
python scripts/make-reference.py
```

### Compare with TradingView

`BINANCE:BTCUSDT`, 1m, last bar 2026-11-10 16:17 UTC (this chart shows UTC, TradingView your time zone). Two conventions differ between libraries and are both offered or documented: the EMA start (selector in the page) and RSI on a flat price (100 here as in TradingView; TA-Lib gives 50).

### Layout

- `src/indicators.js` pure reference calculations; `src/indicator-engine.js` incremental calculations that draw the chart (only the newest candle is recalculated on a tick)
- `src/sma.js` sources, `src/statistics.js` scaled mean and deviation
- `src/live.js` Binance, `src/coinbase.js` Coinbase, `src/providers.js` what differs between them
- `src/parse.js`, `src/sanitize.js`, `src/limit.js`, `src/format.js` data rules and number formats
- `src/generator.js`, `src/feed.js`, `src/scenarios.js` demo data
- `src/app.js` the page; `window.__app` is the hook for the tests
- `checks/` the self-checks (including `live-exchanges.js`); `tests/unit`, `tests/ui`, `tests/fixtures`
- `?bug=offbyone` injects a broken SMA to prove the tests catch it

### Known limits

- Real exchanges are only reached by the "Check the real exchanges" button; the automatic tests use pretend exchanges.
- Real data in the reference is 550 BTCUSDT 1m bars from one day; there is no comparison with TradingView itself.
- Browser tests run in Chromium only. There are no golden screenshots (they differ between machines); the axis text is checked through its formatter and dark pixels, not read.
- Coinbase trade recovery covers up to 10 pages (10 000 trades); beyond that the stream resynchronises instead of accepting a hole.
- A message lost on Binance's kline stream repairs itself (each message is the whole candle so far), but reordered messages cannot be detected (no sequence number).

---

## Русский

[English](#english) · **Русский**

Небольшой торговый график (TradingView [Lightweight Charts](https://github.com/tradingview/lightweight-charts)) с четырьмя индикаторами. Сделан, чтобы показать, что расчёты индикаторов, обработку данных и отрисовку графика можно надёжно покрыть быстрыми автотестами. Демо: https://ed9ward.github.io/TradingChartTest/ (самопроверки: `/checks.html`).

### Что умеет

- **Индикаторы:** SMA, EMA (два старта: первое значение как в TradingView или SMA первых N как в TA-Lib), полосы Боллинджера, RSI (по Уайлдеру). Источники: open, high, low, close, volume, hl2, hlc3, ohlc4. Любой период.
- **Данные:** демо-поток с фиксированным зерном (13 сценариев: обычный, 2000 баров, отрицательные, огромные, мелкие цены, переполнение, NaN, невозможные свечи, дубли, неупорядоченные, плоский, застывший, пустой), живые данные **Binance** (BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT) и **Coinbase** (BTC-USD, ETH-USD, SOL-USD), таймфреймы 1m, 5m, 15m, 1h, 1d. Ключи API не нужны.
- **Проверка данных:** строгий разбор чисел (null, пустые строки, hex, NaN и время не по сетке отклоняются), правило свечи (high и low охватывают open и close, объём не отрицательный), дубли склеиваются, порядок исправляется, пропуски интервалов отмечаются. Отклонённые данные считаются в строке статуса и не рисуются.
- **Надёжность живого потока:** автопереподключение (1, 2, 4, 8, 16, 30 с), контроль «тишины» (30 с у Binance, 10 с у Coinbase), у Coinbase отслеживается нумерация сделок и потерянные докачиваются через REST, закрытые свечи сверяются с биржей, история ограничена 1000 баров, смена суток по часам биржи.
- **Помощь при чтении:** число знаков после запятой подстраивается под цену (0,00001234 не показывается как 0.00), заметка говорит, что у EMA или RSI мало истории для «схождения» или что период длиннее истории, масштаб сохраняется при смене настроек, ось времени в UTC.

### Запуск

```powershell
cd D:\Data\sma-chart
npm install
npx playwright install chromium   # один раз
npm run serve                     # http://localhost:4173
```

### Тесты

```powershell
cd D:\Data\sma-chart
npm run test:unit    # Vitest, около 15 с
npm run test:ui      # Playwright (Chromium), 3-5 мин локально
npm test             # оба
npm run mutate       # тесты проверяют сами себя, см. ниже (около 8 мин)
```

| Слой | Что в нём | Число |
|---|---|---|
| Юнит (Vitest) | каждый индикатор против независимых формул и золотых значений, разбор данных, правило свечи, восстановление Coinbase, инкрементальное ядро против TA-Lib и pandas | около 1320 |
| Браузер (Playwright) | настройки и пересчёт каждого индикатора, источника и периода, формат легенды и цен, живые потоки против «подставных» бирж (обрывы, пропуски, мусор, переподключения), случайные сценарии действий пользователя и сбоев сети | около 458 |
| Что нарисовано | цвет свечей, фитили, верх и низ по пикселям; панель RSI; линии Боллинджера; оси; другие размеры окна; линия индикатора на нужной высоте | 24 + часть в слоях выше |
| Страница самопроверок | 345 проверок в браузере, в том числе сравнение с TA-Lib и pandas (7 наборов, около 86 000 значений) | 345 |

CI (GitHub Actions) гоняет проверку синтаксиса, юнит и браузерные тесты примерно за 2,5 минуты. Мутации идут раз в неделю.

### Страница самопроверок (`checks.html`)

- **Run all checks:** каждый индикатор против независимого эталона, затем настоящая страница управляется как пользователем. Таблица показывает, сколько значений совпало с TA-Lib и pandas.
- **Check the real exchanges (нужен интернет):** обращается к самим Binance и Coinbase и сообщает, может ли страница по-прежнему читать то, что они присылают (формат свечей, таймфреймы, нумерация сделок, живой поток, цены двух бирж друг против друга). Не входит в «Run all checks» и не запускается в CI. Если сеть закрыта, вы увидите причину (например, `HTTP 451`).

### Мутационное тестирование

`npm run mutate` ломает код в 108 местах по одному и проверяет, что тесты замечают каждую поломку. Выжившая поломка означает место, где настоящая ошибка осталась бы незамеченной. `npm run mutate:check` только проверяет, что список всё ещё применим к коду. Подробности в `scripts/mutation/`.

### Эталонные данные

`tests/fixtures/talib-reference.json` содержит значения индикаторов, посчитанные TA-Lib и pandas для 7 наборов (550 настоящих минутных свечей BTCUSDT, случайные ряды в других масштабах цен, отрицательные цены, 2000 баров). Пересоздать (Python с `TA-Lib`, `pandas`, `numpy`):

```powershell
cd D:\Data\sma-chart
python scripts/make-reference.py
```

### Сравнение с TradingView

`BINANCE:BTCUSDT`, 1m, последний бар 2026-11-10 16:17 UTC (здесь график в UTC, в TradingView в вашем часовом поясе). Два соглашения различаются между библиотеками и оба предложены или описаны: старт EMA (переключатель на странице) и RSI на плоской цене (здесь 100, как в TradingView; TA-Lib даёт 50).

### Структура

- `src/indicators.js` чистые эталонные расчёты; `src/indicator-engine.js` инкрементальные расчёты, которые рисуют график (на каждом тике пересчитывается только новая свеча)
- `src/sma.js` источники, `src/statistics.js` среднее и отклонение с масштабированием
- `src/live.js` Binance, `src/coinbase.js` Coinbase, `src/providers.js` чем они различаются
- `src/parse.js`, `src/sanitize.js`, `src/limit.js`, `src/format.js` правила данных и форматы чисел
- `src/generator.js`, `src/feed.js`, `src/scenarios.js` демо-данные
- `src/app.js` страница; `window.__app` это точка входа для тестов
- `checks/` самопроверки (в том числе `live-exchanges.js`); `tests/unit`, `tests/ui`, `tests/fixtures`
- `?bug=offbyone` подставляет сломанный SMA, чтобы показать, что тесты это ловят

### Известные ограничения

- До настоящих бирж достаёт только кнопка «Check the real exchanges»; автоматические тесты используют «подставные» биржи.
- Настоящие данные в эталоне: 550 минутных свечей BTCUSDT за один день; сравнения с самим TradingView нет.
- Браузерные тесты идут только в Chromium. Золотых скриншотов нет (они различаются между машинами); текст осей проверяется через его формат и тёмные пиксели, не распознаётся.
- Восстановление сделок Coinbase охватывает до 10 страниц (10 000 сделок); дальше поток пересинхронизируется, а не принимает дыру.
- Потерянное сообщение в потоке свечей Binance исправляется само (каждое сообщение это вся свеча на данный момент), но переставленные сообщения обнаружить нельзя (нет номера).
