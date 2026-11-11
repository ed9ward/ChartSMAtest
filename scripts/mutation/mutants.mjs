// Deliberate faults ("mutants"). Each one changes a single place of the code; the tests must notice every one of them.
// A mutant that survives is a place where the tests would not notice a real bug.
//
//   id, file, from (must occur exactly once), to
//   ui: which browser tests to run when the unit tests do not notice (default: none, unit tests only)
//   equivalent: a mutant that cannot change the behaviour (say why); reported, but not a failure
const U = (grep, files = ['tests/ui/indicators.spec.js']) => ({ files, grep });
const EXCHANGES = ['tests/ui/binance.spec.js', 'tests/ui/coinbase.spec.js'];

export const MUTANTS = [
  // --- SMA -----------------------------------------------------------------
  { id: 'sma-window-off-by-one', file: 'src/sma.js', from: 'if (i >= period) {', to: 'if (i > period) {' },
  { id: 'sma-first-point-late', file: 'src/sma.js', from: 'if (i < period - 1 || invalid > 0) continue;', to: 'if (i < period || invalid > 0) continue;' },
  { id: 'sma-hl2-wrong', file: 'src/sma.js', from: 'return candle.high / 2 + candle.low / 2;', to: 'return candle.high / 3 + candle.low / 2;' },
  { id: 'sma-ohlc4-without-open', file: 'src/sma.js', from: 'return candle.open / 4 + candle.high / 4 + candle.low / 4 + candle.close / 4;', to: 'return candle.high / 4 + candle.low / 4 + candle.close / 4;' },
  { id: 'sma-volume-as-close', file: 'src/sma.js', from: "    case 'volume':\n      return candle[source];", to: "      return candle[source];\n    case 'volume':\n      return candle.close;" },
  { id: 'sma-nan-accepted', file: 'src/sma.js', from: "typeof value === 'number' && Number.isFinite(value) ? value : null", to: "typeof value === 'number' ? value : 0" },
  { id: 'sma-overflow-accepted', file: 'src/sma.js', from: 'if (Number.isFinite(average)) out.push', to: 'out.push' },
  { id: 'sma-period-not-validated', file: 'src/sma.js', from: 'if (!Number.isSafeInteger(period) || period < 1) {', to: 'if (false) {' },

  // --- EMA, Bollinger, RSI ---------------------------------------------------
  { id: 'ema-alpha-wrong', file: 'src/indicators.js', from: '  const alpha = 2 / (period + 1);\n  const out = [];', to: '  const alpha = 2 / period;\n  const out = [];' },
  { id: 'ema-first-start-skipped', file: 'src/indicators.js', from: "    } else if (start === 'first') {\n      ema = v[i];", to: "    } else if (false) {\n      ema = v[i];" },
  { id: 'ema-sma-seed-wrong', file: 'src/indicators.js', from: 'ema = seedMean;', to: 'ema = seedMean + 1;' },
  { id: 'ema-chain-not-reset', file: 'src/indicators.js', from: 'if (v[i] === null) { reset(); continue; }\n    if (ema !== null) {', to: 'if (v[i] === null) { continue; }\n    if (ema !== null) {' },
  { id: 'ema-start-not-validated', file: 'src/indicators.js', from: "export function computeEMA(candles, period, source = 'close', start = 'first') {\n  assertPeriod(period);\n  assertSource(source);\n  assertEmaStart(start);", to: "export function computeEMA(candles, period, source = 'close', start = 'first') {\n  assertPeriod(period);\n  assertSource(source);" },
  { id: 'bb-sample-deviation', file: 'src/statistics.js', from: 'return scale * Math.sqrt(squared / values.length);', to: 'return scale * Math.sqrt(squared / (values.length - 1));' },
  { id: 'bb-lower-above-basis', file: 'src/indicators.js', from: 'const lower = basis - mult * sd;', to: 'const lower = basis + mult * sd;' },
  { id: 'bb-bad-values-not-skipped', file: 'src/indicators.js', from: 'if (window.includes(null)) continue;', to: '' },
  { id: 'bb-multiplier-ignored', file: 'src/indicators.js', from: 'const upper = basis + mult * sd;', to: 'const upper = basis + 2 * sd;' },
  { id: 'bb-multiplier-not-validated', file: 'src/indicators.js', from: "if (kind === 'bb') assertMultiplier(params.mult);", to: '' },
  { id: 'rsi-first-value-late', file: 'src/indicators.js', from: 'if (++changes < period) continue;', to: 'if (++changes <= period) continue;' },
  { id: 'rsi-wrong-smoothing', file: 'src/indicators.js', from: 'avgGain = avgGain * ((period - 1) / period) + gain / period;', to: 'avgGain = avgGain * (period / (period + 1)) + gain / (period + 1);' },
  { id: 'rsi-flat-gives-50', file: 'src/indicators.js', from: 'const rsi = avgLoss === 0 ? 100 : avgGain === 0 ? 0 :', to: 'const rsi = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : avgGain === 0 ? 0 :' },
  { id: 'rsi-gain-and-loss-swapped', file: 'src/indicators.js', from: 'const gain = Math.max(change, 0);\n    const loss = Math.max(-change, 0);', to: 'const gain = Math.max(-change, 0);\n    const loss = Math.max(change, 0);' },
  { id: 'settle-without-the-extra-bar', file: 'src/indicators.js', from: 'return warmup + fade + 1;', to: 'return warmup + fade;' },
  { id: 'settle-rsi-with-the-ema-alpha', file: 'src/indicators.js', from: "const alpha = kind === 'ema' ? 2 / (period + 1) : 1 / period;", to: 'const alpha = 2 / (period + 1);' },

  // --- the rule for a candle, formats, limits ---------------------------------
  { id: 'candle-high-not-checked', file: 'src/sanitize.js', from: 'c.high < Math.max(c.open, c.close) || ', to: '' },
  { id: 'candle-low-not-checked', file: 'src/sanitize.js', from: ' || c.low > Math.min(c.open, c.close)', to: '' },
  { id: 'candle-negative-volume-allowed', file: 'src/sanitize.js', from: " || c.volume < 0) return 'inconsistent'", to: ") return 'inconsistent'" },
  { id: 'candle-duplicates-not-merged', file: 'src/sanitize.js', from: 'byTime.set(c.time, c); // last one wins', to: 'byTime.set(byTime.size, c);' },
  { id: 'candle-order-not-sorted', file: 'src/sanitize.js', from: '.sort((a, b) => a.time - b.time)', to: '' },
  { id: 'candle-range-not-checked', file: 'src/sanitize.js', from: 'Math.abs(p) > MAX_ABS_PRICE', to: 'false' },
  { id: 'coinbase-sparse-gaps-overreported', file: 'src/sanitize.js', from: 'if (allowSparse) {', to: 'if (false) {' },
  { id: 'limit-accepts-negatives', file: 'src/limit.js', from: 'if (!Number.isSafeInteger(limit) || limit < 0)', to: 'if (!Number.isSafeInteger(limit))' },
  { id: 'decimals-of-ordinary-prices', file: 'src/format.js', from: 'if (median >= 1) return 2;', to: 'if (median >= 1) return 4;' },
  { id: 'decimals-not-capped', file: 'src/format.js', from: 'Math.min(12, Math.max(2, Math.ceil(-Math.log10(median)) + 3))', to: 'Math.max(2, Math.ceil(-Math.log10(median)) + 3)' },
  { id: 'decimals-zeros-count', file: 'src/format.js', from: '.filter((v) => Number.isFinite(v) && v !== 0)', to: '.filter((v) => Number.isFinite(v))' },

  // --- demo feed ----------------------------------------------------------------
  { id: 'feed-wrong-first-tick', file: 'src/feed.js', from: 'const isNew = k === 1;', to: 'const isNew = k === 2;' },
  { id: 'feed-candle-ends-early', file: 'src/feed.js', from: 'if (k === ticksPerCandle) { index++; k = 0; }', to: 'if (k === ticksPerCandle - 1) { index++; k = 0; }' },
  { id: 'feed-partial-high-wrong', file: 'src/generator.js', from: 'high: f === 1 ? final.high : round2(top + (final.high - finalTop) * f),', to: 'high: f === 1 ? final.high : round2(top - 5),' },

  // --- Binance ------------------------------------------------------------------
  { id: 'binance-time-not-in-seconds', file: 'src/live.js', from: 'parseBucketTimestamp(row[0], 1000, intervalSeconds)', to: 'parseBucketTimestamp(row[0], 1, intervalSeconds)' },
  { id: 'binance-limit-not-capped', file: 'src/live.js', from: '&limit=${Math.min(limit, MAX_KLINES)}', to: '&limit=${limit}' },
  { id: 'binance-http-errors-ignored', file: 'src/live.js', from: 'if (!res.ok) throw new Error(`HTTP ${res.status}`);', to: '' },
  { id: 'binance-foreign-symbol-accepted', file: 'src/live.js', from: 'if (symbol && String(k.s).toUpperCase() !== symbol.toUpperCase()) return null;', to: '' },
  { id: 'day-change-divides-by-price', file: 'src/live.js', from: 'return ((price - prevClose) / prevClose) * 100;', to: 'return ((price - prevClose) / price) * 100;' },
  { id: 'day-change-loses-its-sign', file: 'src/live.js', from: "return `${percent > 0 ? '+' : ''}${percent.toFixed(2)}%`;", to: 'return `${percent.toFixed(2)}%`;' },

  // --- Coinbase -----------------------------------------------------------------
  { id: 'coinbase-one-heartbeat-is-enough', file: 'src/coinbase.js', from: 'if (++behind >= 2) {', to: 'if (++behind >= 1) {' },
  { id: 'coinbase-duplicates-not-found', file: 'src/coinbase.js', from: 'if (trade.tradeId <= lastId || ahead.has(trade.tradeId))', to: 'if (false)' },
  { id: 'coinbase-last-lost-trade-not-fetched', file: 'src/coinbase.js', from: 'for (let id = lastId + 1; id <= target; id++) {', to: 'for (let id = lastId + 1; id < target; id++) {' },
  { id: 'coinbase-last-match-counted', file: 'src/coinbase.js', from: 'if (!trade.last || (current && bucket > current.time) || (!current && applyLastMatchWhenUnseeded)) apply(trade);', to: 'if (true) apply(trade);' },
  { id: 'coinbase-held-back-trades-never-applied', file: 'src/coinbase.js', from: '      const trade = ahead.get(lastId + 1);\n      ahead.delete(lastId + 1);\n      if (!apply(trade)) return;\n      lastId = trade.tradeId;', to: '      const trade = ahead.get(lastId + 1);\n      ahead.delete(lastId + 1);\n      if (true) return;\n      lastId = trade.tradeId;' },
  { id: 'coinbase-goes-on-after-giving-up', file: 'src/coinbase.js', from: '    gaveUp = true;\n', to: '' },
  { id: 'coinbase-closed-candles-not-checked', file: 'src/coinbase.js', from: 'if (current && reconcileDelayMs !== null) reconcile({ ...current });', to: '' },
  { id: 'coinbase-every-closed-candle-corrected', file: 'src/coinbase.js', from: 'if (!sameCandle(exact, closed)) onKline({ candle: exact, correction: true });', to: 'if (true) onKline({ candle: exact, correction: true });' },
  { id: 'coinbase-trades-of-closed-candles-applied', file: 'src/coinbase.js', from: '    if (current && bucket < current.time) return true; // ignore closed-bucket data but advance the trade-ID watermark\n', to: '' },
  { id: 'coinbase-wrong-channel', file: 'src/coinbase.js', from: "{ name: 'matches', product_ids: [symbol] }", to: "{ name: 'ticker', product_ids: [symbol] }" },
  { id: 'coinbase-null-is-a-number', file: 'src/coinbase.js', from: 'const toNumber = (x) => parseFiniteNumber(x) ?? NaN;', to: 'const toNumber = (x) => Number(x);' },
  { id: 'coinbase-startup-bucket-not-rebuilt', file: 'src/coinbase.js', from: 'current = candleFromTrades(trades, bucket);', to: 'current = current ?? candleFromTrades(trades, bucket);' },
  { id: 'coinbase-startup-buffer-dropped', file: 'src/coinbase.js', from: 'bootstrapBuffer.set(trade.tradeId, trade);', to: 'void trade;' },
  { id: 'coinbase-zero-size-trade-accepted', file: 'src/coinbase.js', from: 'if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(time)) return null;', to: 'if (!Number.isFinite(size) || size < 0 || !Number.isFinite(time)) return null;' },
  { id: 'coinbase-limit-ignored', file: 'src/coinbase.js', from: 'const result = candles.slice(candles.length - Math.min(limit, MAX_CANDLES, candles.length));', to: 'const result = candles;' },
  { id: 'coinbase-history-not-sorted', file: 'src/coinbase.js', from: 'candles.sort((a, b) => a.time - b.time);', to: 'candles.sort(() => 0);' },

  // --- the page: what the user sees and the connection ---------------------------
  { id: 'page-stale-answers-accepted', file: 'src/app.js', from: 'limit: provider.historyBars, signal: requestController.signal });\n    if (gen !== live.gen) return;', to: 'limit: provider.historyBars, signal: requestController.signal });', ui: U('superseded', EXCHANGES) },
  { id: 'page-minute-gaps-reload-coinbase', file: 'src/app.js', from: '&& live.provider.reloadOnBarGap) {', to: ') {', ui: U('minutes without trades', EXCHANGES) },
  { id: 'page-live-candles-not-validated', file: 'src/app.js', from: '  if (validateCandle(candle)) { // the same rule as for the history', to: '  if (false) {', ui: U('impossible', EXCHANGES) },
  { id: 'page-no-automatic-reconnect', file: 'src/app.js', from: 'onClose: () => { if (gen === live.gen) scheduleRetry(null); },', to: 'onClose: () => { if (gen === live.gen) { live.conn = null; live.offline = true; showStatus(); } },', ui: U('reconnects by itself|automatic reconnect', EXCHANGES) },
  { id: 'page-constant-retry-pause', file: 'src/app.js', from: 'const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));', to: 'const delay = RETRY_BASE_MS;', ui: U('growing pauses', EXCHANGES) },
  { id: 'page-watchdog-off', file: 'src/app.js', from: 'if (silent > live.provider.staleMs) return scheduleRetry(', to: 'if (false) return scheduleRetry(', ui: U('silent|heartbeats keep', EXCHANGES) },
  {
    id: 'page-disconnect-button-not-final', file: 'src/app.js', from: '  if (live.manualOff || live.retry) return;', to: '  if (live.retry) return;', ui: U('Disconnect button is final', EXCHANGES),
    equivalent: 'a guard that nothing can reach: after Disconnect the connection is closed by us (no close event) and every answer still on its way is stale by the generation check',
  },
  { id: 'page-disconnect-ignored-while-loading', file: 'src/app.js', from: 'if (!live.conn && !live.retry && !live.loading) return;', to: 'if (!live.conn && !live.retry) return;', ui: U('on its way|still running', EXCHANGES) },
  { id: 'page-loading-never-ends', file: 'src/app.js', from: '    if (gen !== live.gen) return;\n    live.loading = false;\n    if (auto)', to: '    if (gen !== live.gen) return;\n    if (auto)', ui: U('Disconnect', EXCHANGES) },
  { id: 'page-healthy-connection-not-forgiven', file: 'src/app.js', from: 'if (live.attempt > 0 && age > STABLE_MS) live.attempt = 0;', to: '', ui: U('stayed healthy', EXCHANGES) },
  { id: 'page-binance-connection-not-rotated', file: 'src/app.js', from: 'if (live.provider.maxConnectionMs && age >= live.provider.maxConnectionMs) {', to: 'if (false) {', ui: U('scheduled connection refresh', ['tests/ui/binance.spec.js']) },
  { id: 'page-binance-startup-boundary-not-reconciled', file: 'src/app.js', from: 'void reconcileInitialBinanceBoundary(gen, last.time, interval);', to: 'void Promise.resolve();', ui: U('subscribes after its close', ['tests/ui/binance.spec.js']) },
  { id: 'page-day-by-the-computers-clock', file: 'src/app.js', from: 'utcDay(candle.time * 1000) > live.dayIndex', to: 'utcDay(Date.now()) !== live.dayIndex', ui: U('exchange\'s own bars', EXCHANGES) },
  { id: 'page-corrections-not-applied', file: 'src/app.js', from: '    state.candles[index] = candle;\n    live.corrected++;', to: '    live.corrected++;', ui: U('closed candles are checked|corrected', EXCHANGES) },
  { id: 'page-note-ignores-the-ema-start', file: 'src/app.js', from: 'const needed = settleBars(state.indicator, period, { start: state.start });', to: 'const needed = settleBars(state.indicator, period);', ui: U('settled') },
  { id: 'page-zoom-reset-on-every-change', file: 'src/app.js', from: '  if (fit) chart.timeScale().fitContent();', to: '  chart.timeScale().fitContent();', ui: U('zoom') },
  { id: 'page-two-decimals-for-everything', file: 'src/app.js', from: 'const price = priceDecimals(state.candles.map((c) => c.close));', to: 'const price = 2;', ui: U('what a trader reads|cheap coin', ['tests/ui/indicators.spec.js', 'tests/ui/binance.spec.js']) },
  { id: 'page-clock-shows-24-oclock', file: 'src/app.js', from: "{ hourCycle: 'h23' }", to: "{ hourCycle: 'h24' }", ui: U('00:05'),
    equivalent: 'current Chromium and Node print 00:05 for every hour-cycle option; the explicit h23 guards against older engines that print 24:05' },

  { id: 'min-bars-rsi-off-by-one', file: 'src/indicators.js', from: "if (kind === 'rsi') return period + 1;", to: "if (kind === 'rsi') return period;" },
  { id: 'min-bars-ema-sma-start-ignored', file: 'src/indicators.js', from: "return start === 'sma' ? period : 1;", to: 'return 1;' },
  { id: 'page-empty-line-not-explained', file: 'src/app.js', from: 'const noValues = have > 0 && have < first;', to: 'const noValues = false;', ui: U('no values') },
  { id: 'page-note-shown-without-data', file: 'src/app.js', from: 'const noValues = have > 0 && have < first;', to: 'const noValues = have < first;', ui: U('no data, no note') },
  { id: 'page-old-connection-left-open', file: 'src/app.js', from: '  live.requestController = null;\n  live.conn?.close();', to: '  live.requestController = null;', ui: U('seed', ['tests/ui/fuzz.spec.js']) },
  { id: 'page-waiting-reconnect-not-cancelled', file: 'src/app.js', from: '  live.gen++; // any answer still in flight is now stale\n  cancelRetry();', to: '  live.gen++; // any answer still in flight is now stale', ui: U('cancels it|seed', [...EXCHANGES, 'tests/ui/fuzz.spec.js']) },

  // --- the checks themselves ----------------------------------------------------------
  { id: 'checks-duplicates-not-counted', file: 'checks/compare.js', from: '    if (byTime.has(p.time)) { stats.duplicates++; continue; }', to: '    if (byTime.has(p.time)) { continue; }' },
  { id: 'checks-outside-points-not-counted', file: 'checks/compare.js', from: '    if (!inRange.has(p.time)) stats.outside++;', to: '' },
  { id: 'checks-disorder-not-counted', file: 'checks/compare.js', from: '    if (p.time < newest) stats.unordered++;', to: '' },
  { id: 'checks-tolerance-judged-against-1', file: 'checks/compare.js', from: 'diff <= IDENTICAL * Math.max(Math.abs(want), NEAR_ZERO * scale)', to: 'diff <= IDENTICAL * Math.max(1, Math.abs(want))' },
  { id: 'checks-missing-series-not-reported', file: 'checks/compare.js', from: 'for (const key of wanted) if (!have.has(key)) problems.push(', to: 'for (const key of []) if (!have.has(key)) problems.push(' },
  { id: 'checks-reference-spec-not-compared', file: 'checks/reference-spec.js', from: 'if (!same(ref?.spec, spec)) add(', to: 'if (false) add(' },
  { id: 'checks-empty-error-message-accepted', file: 'checks/assert.js', from: "throw new Error(message || 'assertion failed');", to: 'throw new Error(message);' },
  { id: 'checks-completeness-never-fails', file: 'checks/definitions.js', from: 'if (problems.length) throw new Error(`${problems.length} problem(s), e.g. ${problems[0]}`);', to: '' },
  {
    id: 'checks-runner-verdict-from-error-text', file: 'checks/runner.js',
    from: 'if (threw) summary.failed++; else summary.passed++;\n      const result = { group: group.id, name: check.name, ui: !!check.ui, ok: !threw, error, ms, detail };',
    to: 'if (error) summary.failed++; else summary.passed++;\n      const result = { group: group.id, name: check.name, ui: !!check.ui, ok: !error, error, ms, detail };',
    equivalent: 'defence in depth: describeError() never returns an empty text, so the verdict by text and by flag always agree',
  },
];
