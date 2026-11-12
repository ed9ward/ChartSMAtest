import { SOURCES } from './sma.js';
import { INDICATORS, validateParams, settleBars, minBars } from './indicators.js';
import { createIndicatorEngine } from './indicator-engine.js';
import { sanitizeCandles, validateCandle, appendBoundedCandle } from './sanitize.js';
import { SCENARIOS } from './scenarios.js';
import { createFeed } from './feed.js';
import { INTERVAL_SECONDS, utcDay, dayChangePercent, formatPercent } from './live.js';
import { PROVIDERS } from './providers.js';
import { priceDecimals, formatFixed } from './format.js';

const { createChart, CandlestickSeries, LineSeries } = window.LightweightCharts;

const STREAM_INTERVAL_MS = 200;
const MAX_LIVE_CANDLES = 1000;
const STREAMABLE = new Set(['normal', 'long', 'empty']); // data sets that are a prefix of the feed
// Demo switch so the tests can prove they catch a broken indicator: ?bug=offbyone
const BUG = new URLSearchParams(location.search).get('bug');

const $ = (id) => document.getElementById(id);
const el = Object.fromEntries(
  ['mult', 'ema-start', 'scenario', 'symbol', 'interval', 'start', 'stop', 'disconnect', 'reconnect',
    'status', 'settle-note', 'bar-count', 'last-close', 'last-update', 'legend-day', 'day-change',
    'legend-sma', 'legend-ema', 'legend-bb', 'legend-rsi', 'last-sma', 'last-ema', 'last-bb-basis', 'last-bb-upper', 'last-bb-lower', 'last-rsi']
    .map((id) => [id, $(id)]),
);

const KINDS = ['sma', 'ema', 'bb', 'rsi']; // the order they are listed in, drawn in and reported in
// Every indicator has its own switch, period and source (and the EMA its start, Bollinger its multiplier).
const ctl = Object.fromEntries(KINDS.map((k) => [k, { on: $(`ind-${k}`), period: $(`period-${k}`), source: $(`source-${k}`) }]));

const chart = createChart($('chart'), {
  autoSize: true,
  layout: { background: { color: '#ffffff' }, textColor: '#222' },
  grid: { vertLines: { color: '#eee' }, horzLines: { color: '#eee' } },
  timeScale: { timeVisible: true },
});
const candleSeries = chart.addSeries(CandlestickSeries, {
  upColor: '#26a69a', downColor: '#ef5350', borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350',
});

const newIndicators = () => Object.fromEntries(KINDS.map((k) => [k, {
  on: k === 'sma', source: 'close', period: INDICATORS[k].defaults.period, mult: INDICATORS[k].defaults.mult ?? 2, start: INDICATORS[k].defaults.start ?? 'first',
}]));
const state = { decimals: { price: 2, lines: {} }, candles: [], engines: {}, indicators: newIndicators(), scenario: 'normal', issues: [], updatedAt: null };
const stream = { feed: null, timer: null, offlineSince: null, ticks: 0 };
const RETRY_BASE_MS = 1000;   // first attempt after a second, then 2, 4, 8, 16, 30, 30, ...
const RETRY_MAX_MS = 30_000;
const STABLE_MS = 10_000;     // a connection that lived this long counts as healthy: the next loss starts again at one second
const live = { loading: false, attempt: 0, retry: null, manualOff: false, lastActivity: 0, connectedAt: 0, gen: 0, conn: null, offline: false, error: null, rejected: 0, recovered: 0, duplicates: 0, corrected: 0, reconcileFailures: 0, bootstrapFailures: 0, closedThrough: null, boundaryReconcilePending: false, resyncs: 0, symbol: null, provider: null, prevClose: null, dayIndex: null, requestController: null }; // gen invalidates answers of superseded requests
let lines = []; // [{ kind, key, def, series }] of every indicator that is switched on


const lastCandle = () => state.candles[state.candles.length - 1];
const enabled = () => KINDS.filter((k) => state.indicators[k].on);
const primaryLine = () => lines.find((l) => l.def.primary); // the main line of the first indicator that is on
const lineLast = (key) => lines.find((l) => l.key === key)?.series.data().at(-1);

function paramsOf(kind) {
  const { period, mult, start } = state.indicators[kind];
  return { period: BUG === 'offbyone' ? Math.max(1, period - 1) : period, mult, start };
}

function setStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.classList.toggle('error', isError);
}
const isLive = () => state.scenario in PROVIDERS;
const isOffline = () => stream.offlineSince !== null || live.offline;

function showStatus() {
  if (isOffline()) {
    const retry = live.retry ? `; reconnecting in ${live.retry.delay / 1000} s (attempt ${live.retry.attempt})` : '';
    return setStatus(`${live.error ? `Feed disconnected: ${live.error}` : 'Feed disconnected'}${retry}`, true);
  }
  const base = isLive() ? `Live ${el.symbol.value} ${el.interval.value}` : '';
  // Nothing the live feed does to the data happens silently.
  const notes = [
    live.rejected && `ignored ${live.rejected} invalid update(s)`,
    live.duplicates && `ignored ${live.duplicates} duplicate message(s)`,
    live.recovered && `recovered ${live.recovered} missed trade(s)`,
    live.corrected && `corrected ${live.corrected} candle(s) from the exchange`,
    live.reconcileFailures && `could not verify ${live.reconcileFailures} closed candle(s)`,
    live.bootstrapFailures && `could not fully rebuild ${live.bootstrapFailures} startup candle(s)`,
    live.resyncs && `resynced ${live.resyncs} time(s)`,
  ];
  const text = [base, ...state.issues, ...notes].filter(Boolean).join('; ');
  setStatus(text || 'OK');
}

// Previous day's close: for the 1d timeframe it is the bar before the last one, otherwise it comes from a 1d request.
const prevClose = () => (el.interval.value === '1d' ? state.candles.at(-2)?.close : live.prevClose);

function renderUpdated() {
  if (state.updatedAt === null) return void (el['last-update'].textContent = '—');
  const time = new Date(state.updatedAt).toLocaleTimeString('en-GB', { hourCycle: 'h23' }); // 00:05, never 24:05
  const age = Math.max(0, Math.floor((Date.now() - state.updatedAt) / 1000));
  el['last-update'].textContent = `${time} (${age} s ago)`;
}
const touch = () => { state.updatedAt = Date.now(); renderUpdated(); };
setInterval(renderUpdated, 1000);

// EMA and RSI forget the value they started from slowly: with a short history the last values depend on where it begins.
// And an indicator with a period longer than the history has no line at all. Each indicator that is on says so for itself.
function settleNote(kind) {
  const { label } = INDICATORS[kind];
  const { period, start } = state.indicators[kind];
  const used = paramsOf(kind).period;
  const needed = settleBars(kind, used, { start });
  const first = minBars(kind, used, { start });
  const have = state.candles.length;
  if (have > 0 && have < first) return `${label}(${period}) has no values yet: it needs ${first} bars and ${have} are loaded, so its line is empty.`;
  if (needed > 0 && have > 0 && have < needed) {
    return `${label}(${period}) has not settled: ${have} bars loaded, about ${needed} needed for it to forget its starting value. `
      + 'The last values depend on where this history begins, so another platform with a longer history can show slightly different numbers.';
  }
  return null;
}

function updateSettleNote() {
  const notes = enabled().map((kind) => [kind, settleNote(kind)]).filter(([, text]) => text);
  el['settle-note'].hidden = notes.length === 0;
  el['settle-note'].replaceChildren(...notes.map(([kind, text]) => {
    const line = document.createElement('div');
    line.dataset.testid = `settle-note-${kind}`;
    line.textContent = text;
    return line;
  }));
}

function updateLegend() {
  updateSettleNote();
  const last = lastCandle();
  el['bar-count'].textContent = String(state.candles.length);
  el['last-close'].textContent = last ? formatFixed(last.close, state.decimals.price) : '—';
  const change = isLive() && last ? dayChangePercent(last.close, prevClose()) : null;
  el['legend-day'].hidden = !isLive();
  el['day-change'].textContent = formatPercent(change);
  el['day-change'].className = change === null || Math.abs(change) < 0.005 ? '' : change < 0 ? 'down' : 'up';
  const decimalsOf = (key) => state.decimals.lines[key] ?? 2;
  const show = (id, key) => { el[id].textContent = formatFixed(lineLast(key)?.value, decimalsOf(key)); };
  for (const kind of KINDS) el[`legend-${kind}`].hidden = !state.indicators[kind].on;
  show('last-sma', 'sma');
  show('last-ema', 'ema');
  show('last-bb-basis', 'basis');
  show('last-bb-upper', 'upper');
  show('last-bb-lower', 'lower');
  show('last-rsi', 'rsi');
}

// --- indicator lines -------------------------------------------------------
function buildLines() {
  for (const l of lines) chart.removeSeries(l.series);
  lines = enabled().flatMap((kind) => {
    const def = INDICATORS[kind];
    return def.lines.map((lineDef) => {
      const options = { color: lineDef.color, lineWidth: 2, priceLineVisible: false, lastValueVisible: !!lineDef.primary };
      if (def.pane) {
        options.autoscaleInfoProvider = () => ({ priceRange: { minValue: 0, maxValue: 100 } });
      }
      const series = chart.addSeries(LineSeries, options, def.pane ?? 0);
      if (def.pane) {
        for (const price of [30, 70]) series.createPriceLine({ price, color: '#999', lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
        chart.panes()[def.pane]?.setStretchFactor?.(1);
      }
      return { kind, key: lineDef.key, def: lineDef, series };
    });
  });
}

// How many decimals the prices and each indicator need, and the same for the chart's own price scale.
function applyPrecision(points) {
  const price = priceDecimals(state.candles.map((c) => c.close));
  state.decimals = { price, lines: {} };
  const setFormat = (series, decimals) => series.applyOptions({ priceFormat: { type: 'price', precision: decimals, minMove: 10 ** -decimals } });
  setFormat(candleSeries, price);
  // all lines of one indicator are read with the same number of decimals (the bands of Bollinger would otherwise differ by one);
  // each indicator has its own, because an RSI (0-100) and a price of 0.00001234 do not need the same
  for (const kind of enabled()) {
    const own = lines.filter((l) => l.kind === kind);
    const decimals = kind === 'rsi' ? 2 : priceDecimals(own.flatMap((l) => points[kind][l.key].map((p) => p.value)));
    for (const l of own) {
      state.decimals.lines[l.key] = decimals;
      setFormat(l.series, decimals);
    }
  }
}

// fit: show all bars (new data); false keeps the range the user zoomed to (a changed setting).
function render({ fit = true } = {}) {
  candleSeries.setData(state.candles);
  state.engines = {};
  const points = {};
  for (const kind of enabled()) {
    state.engines[kind] = createIndicatorEngine(kind, state.candles, paramsOf(kind), state.indicators[kind].source);
    points[kind] = state.engines[kind].data();
  }
  for (const l of lines) l.series.setData(points[l.kind][l.key]);
  applyPrecision(points);
  if (fit) chart.timeScale().fitContent();
  updateLegend();
}

// Incremental redraw of the newest bar (new bar or update of the forming one).
function paintLast(candle, fullRedraw = false) {
  touch();
  if (fullRedraw) { render({ fit: false }); return; }
  candleSeries.update(candle);
  const latest = {};
  for (const kind of enabled()) latest[kind] = state.engines[kind].upsert(candle);
  for (const l of lines) {
    const point = latest[l.kind][l.key];
    if (point) l.series.update(point);
  }
  updateLegend();
}

// Each exchange has its own symbol names (BTCUSDT on Binance, BTC-USD on Coinbase).
function fillSymbols(exchange) {
  const symbols = PROVIDERS[exchange].symbols;
  if ([...el.symbol.options].map((o) => o.value).join() === symbols.join()) return;
  el.symbol.replaceChildren(...symbols.map((name) => new Option(name, name)));
}

function loadScenario(name) {
  resetStream();
  resetRetry();
  closeLive();
  state.scenario = name;
  if (isLive()) {
    fillSymbols(name);
    return loadLive();
  }
  const { candles, issues } = sanitizeCandles(SCENARIOS[name]());
  state.candles = candles;
  state.issues = issues;
  showStatus();
  render();
  touch();
}

// A changed number of one indicator: checked for that indicator, the others are not touched.
function applyParam(kind, key, value, label) {
  try {
    validateParams(kind, { ...state.indicators[kind], [key]: value });
  } catch (e) {
    setStatus(`Invalid ${label} (${INDICATORS[kind].label}): ${e.message}`, true); // which indicator it is about stays at the end
    if (key === 'period') ctl[kind].period.value = String(state.indicators[kind].period);
    if (key === 'mult') el.mult.value = String(state.indicators[kind].mult);
    return;
  }
  state.indicators[kind][key] = value;
  showStatus();
  render({ fit: false }); // a changed setting keeps the range the user zoomed to
}

function setEnabled(kind, on) {
  state.indicators[kind].on = on;
  buildLines();
  showStatus();
  render({ fit: false });
}

// --- demo live feed --------------------------------------------------------
function ensureFeed() {
  if (!STREAMABLE.has(state.scenario)) return false;
  stream.feed ??= createFeed({ startIndex: state.candles.length });
  return true;
}

// Moves the feed one tick forward and returns the affected candle (null at the end of data).
function applyTick() {
  const result = stream.feed.tick();
  if (!result) return null;
  stream.ticks++;
  if (result.isNew) state.candles.push(result.candle);
  else state.candles[state.candles.length - 1] = result.candle;
  return result.candle;
}

function step() {
  if (!ensureFeed()) return;
  const candle = applyTick();
  if (!candle) {
    stopStream();
    setStatus('End of data', true);
    return;
  }
  paintLast(candle);
}

function startStream() {
  if (!ensureFeed()) {
    setStatus('Streaming is available for the "normal", "long" and "empty" data sets only (Binance is already live)', true);
    return;
  }
  stream.offlineSince = null;
  stream.timer ??= setInterval(step, STREAM_INTERVAL_MS);
}

// Stop = pause: Start continues from the same tick, so a half-built candle gets finished.
function stopStream() {
  clearInterval(stream.timer);
  Object.assign(stream, { timer: null, offlineSince: null });
}

function resetStream() {
  stopStream();
  Object.assign(stream, { feed: null, ticks: 0 });
}

// The connection drops: ticks stop arriving, the chart keeps what it has.
function disconnect() {
  if (isLive()) {
    if (!live.conn && !live.retry && !live.loading) return;
    closeLive();                  // also cancels a reconnect that is waiting, or a load that is on its way
    Object.assign(live, { offline: true, manualOff: true }); // the user asked for it: no automatic reconnect now
    return showStatus();
  }
  if (!stream.timer) return;
  clearInterval(stream.timer);
  stream.timer = null;
  stream.offlineSince = Date.now();
  showStatus();
}

// The connection is back: missed data arrives as history, then live updates resume.
function reconnect(missedTicks) {
  if (isLive()) {
    if (!live.offline) return;
    resetRetry();
    return loadLive();
  }
  if (stream.offlineSince === null) return;
  const missed = missedTicks ?? Math.floor((Date.now() - stream.offlineSince) / STREAM_INTERVAL_MS);
  stream.offlineSince = null;
  for (let i = 0; i < missed && applyTick(); i++);
  render();
  touch();
  showStatus();
  startStream();
}

// --- Binance live data -----------------------------------------------------
function cancelRetry() {
  clearTimeout(live.retry?.timer);
  live.retry = null;
}

// A deliberate action of the user (another data set, symbol or timeframe, the Reconnect button): start counting afresh.
function resetRetry() {
  cancelRetry();
  Object.assign(live, { attempt: 0, manualOff: false });
}

// Retry transient transport/service failures, but do not loop on permanent client errors such as an invalid symbol.
function isRetryableLoadError(error) {
  if (error?.name === 'AbortError') return false;
  if (error?.name === 'TimeoutError' || error instanceof TypeError || error instanceof SyntaxError) return true;
  const status = /^HTTP (\d{3})$/.exec(error?.message ?? '');
  if (!status) return false;
  const code = Number(status[1]);
  return code === 408 || code === 418 || code === 425 || code === 429 || code >= 500;
}

// The connection is lost (closed by the server, or silent): try again with a growing pause. The chart stays as it is meanwhile.
function scheduleRetry(reason, retryAfterMs = 0) {
  if (live.manualOff || live.retry) return;
  cancelRetry();
  const attempt = ++live.attempt;
  const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
  const delay = Math.max(backoff, Number.isFinite(retryAfterMs) ? Math.min(retryAfterMs, 24 * 60 * 60 * 1000) : 0);
  live.conn?.close();
  Object.assign(live, { conn: null, offline: true, error: reason ?? null });
  live.retry = { attempt, delay, timer: setTimeout(() => { live.retry.timer = null; loadLive({ auto: true }); }, delay) };
  showStatus();
}

// Once a second: is the connection alive, and has it been alive long enough to count as healthy?
function watchConnection() {
  if (!live.conn || !live.provider) return;
  const now = Date.now();
  const age = now - live.connectedAt;
  // Binance expires a WebSocket connection after 24 hours. Rotate proactively
  // and reload REST history so the handover cannot leave a silent data gap.
  if (live.provider.maxConnectionMs && age >= live.provider.maxConnectionMs) {
    return scheduleRetry('scheduled connection refresh');
  }
  const silent = now - live.lastActivity;
  if (silent > live.provider.staleMs) return scheduleRetry(`no data for ${Math.round(silent / 1000)} s`);
  if (live.attempt > 0 && age > STABLE_MS) live.attempt = 0;
}
setInterval(watchConnection, 1000);

function closeLive() {
  live.gen++; // any answer still in flight is now stale
  cancelRetry();
  live.requestController?.abort();
  live.requestController = null;
  live.conn?.close();
  Object.assign(live, { loading: false, conn: null, offline: false, error: null, rejected: 0, recovered: 0, duplicates: 0, corrected: 0, reconcileFailures: 0, bootstrapFailures: 0, closedThrough: null, boundaryReconcilePending: false, resyncs: 0, prevClose: null, dayIndex: null });
}

// Previous day's close for the change-per-day figure. A failure only hides that figure, the chart keeps working.
async function loadDay(gen, provider, symbol, interval, signal) {
  let close = null;
  try {
    const days = interval === '1d' ? [] : await provider.fetchHistory({ symbol, interval: '1d', limit: 2, signal });
    close = days.length === 2 ? days[0].close : null;
  } catch { /* the figure stays empty */ }
  if (gen !== live.gen) return;
  Object.assign(live, { prevClose: close, dayIndex: utcDay((lastCandle()?.time ?? Date.now() / 1000) * 1000) });
  updateLegend();
}

async function loadLive({ auto = false } = {}) {
  closeLive();
  const gen = live.gen;
  const provider = PROVIDERS[state.scenario];
  const symbol = el.symbol.value;
  const interval = el.interval.value;
  const requestController = new AbortController();
  live.requestController = requestController;
  setStatus(`Loading ${symbol} ${interval}…`);
  live.loading = true; // Disconnect must work now too, not only once the connection is open
  try {
    const history = await provider.fetchHistory({ symbol, interval, limit: provider.historyBars, signal: requestController.signal });
    if (gen !== live.gen) return;
    live.loading = false;
    ({ candles: state.candles, issues: state.issues } = sanitizeCandles(history, INTERVAL_SECONDS[interval], { allowSparse: provider.sparseHistory }));
    render();
    touch();
    Object.assign(live, { symbol, provider, lastActivity: Date.now(), connectedAt: Date.now() });
    loadDay(gen, provider, symbol, interval, requestController.signal);
    // The history request may finish just before a candle boundary. If the socket
    // subscribes after that boundary, its first message can be the next candle;
    // the previous candle's final WebSocket update was then missed.
    live.boundaryReconcilePending = provider === PROVIDERS.binance;
    live.conn = provider.openStream({
      symbol, interval, signal: requestController.signal, seed: lastCandle(), bootstrapBucket: provider.bootstrapBucket,
      onActivity: () => { if (gen === live.gen) live.lastActivity = Date.now(); },
      onKline: ({ candle, correction, closed }) => onLiveKline(gen, candle, interval, correction, closed),
      onEvent: ({ type, count }) => {
        if (gen !== live.gen) return;
        if (type === 'recovered') live.recovered += count;
        if (type === 'duplicate') live.duplicates++;
        if (type === 'reconcile-failed') live.reconcileFailures++;
        if (type === 'bootstrap-failed') live.bootstrapFailures++;
        showStatus();
      },
      // missed trades could not be fetched: take everything again, and say so
      onResync: (reason, retryAfterMs) => {
        if (gen !== live.gen) return;
        const resyncs = live.resyncs + 1;
        if (retryAfterMs > 0) {
          live.resyncs = resyncs;
          scheduleRetry('could not recover (' + reason + ')', retryAfterMs);
        } else {
          loadLive({ auto: true });
          live.resyncs = resyncs;
        }
      },
      onClose: () => { if (gen === live.gen) scheduleRetry(null); },
      onError: (message) => {
        if (gen !== live.gen) return;
        live.conn?.close();
        Object.assign(live, { conn: null, offline: true, error: message });
        showStatus();
      },
    });
    showStatus();
  } catch (e) {
    if (gen !== live.gen) return;
    live.loading = false;
    if (auto) {
      if (isRetryableLoadError(e)) return scheduleRetry('could not reload (' + e.message + ')', e.retryAfterMs);
      Object.assign(live, { offline: true, error: 'could not reload (' + e.message + ')' });
      showStatus();
      return;
    }
    Object.assign(state, { candles: [], issues: [] });
    render();
    if (isRetryableLoadError(e)) return scheduleRetry('could not load (' + e.message + ')', e.retryAfterMs);
    setStatus('Failed to load ' + symbol + ' ' + interval + ': ' + e.message, true);
  }
}

async function reconcileInitialBinanceBoundary(gen, previousTime, interval) {
  try {
    const candles = await live.provider.fetchHistory({ symbol: live.symbol, interval, limit: 2, signal: live.requestController?.signal });
    if (gen !== live.gen) return;
    const finalCandle = candles.find((item) => item.time === previousTime);
    const index = state.candles.findIndex((item) => item.time === previousTime);
    if (!finalCandle || index < 0) {
      live.reconcileFailures++;
      showStatus();
      return;
    }
    const previous = state.candles[index];
    const changed = ['open', 'high', 'low', 'close', 'volume'].some((key) => previous[key] !== finalCandle[key]);
    if (!changed) return;
    state.candles[index] = finalCandle;
    live.corrected++;
    render({ fit: false });
    showStatus();
  } catch {
    if (gen !== live.gen) return;
    live.reconcileFailures++;
    showStatus();
  }
}

function onLiveKline(gen, candle, interval, correction = false, closed = false) {
  if (gen !== live.gen) return;
  if (validateCandle(candle)) { // the same rule as for the history
    live.rejected++;
    showStatus();
    return;
  }
  if (live.provider === PROVIDERS.binance && !closed && live.closedThrough !== null && candle.time <= live.closedThrough) return;
  if (correction) { // the exchange's final version of a candle that has already closed
    const index = state.candles.findLastIndex((c) => c.time === candle.time);
    if (index < 0) return;
    state.candles[index] = candle;
    live.corrected++;
    render({ fit: false });
    showStatus();
    return;
  }
  // A bar of a new UTC day has begun, by the exchange's own clock: "previous close" moved. (Not the computer's clock.)
  if (interval !== '1d' && live.dayIndex !== null && utcDay(candle.time * 1000) > live.dayIndex) {
    live.dayIndex = utcDay(candle.time * 1000);
    loadDay(gen, live.provider, live.symbol, interval);
  }
  const last = lastCandle();
  if (live.provider === PROVIDERS.binance && live.boundaryReconcilePending) {
    if (closed && last && candle.time === last.time) {
      // We received the final version of the history's newest candle directly.
      live.boundaryReconcilePending = false;
    } else if (last && candle.time === last.time + INTERVAL_SECONDS[interval]) {
      // The first post-history message is already the next candle: reconcile the
      // previous one through REST because its final WebSocket update was missed.
      live.boundaryReconcilePending = false;
      void reconcileInitialBinanceBoundary(gen, last.time, interval);
    }
  }
  let trimmed = false;
  if (!last || candle.time === last.time) {
    if (last) state.candles[state.candles.length - 1] = candle;
    else trimmed = appendBoundedCandle(state.candles, candle, MAX_LIVE_CANDLES);
  } else if (candle.time > last.time + INTERVAL_SECONDS[interval] && live.provider.reloadOnBarGap) {
    loadLive({ auto: true }); // Binance bars may have been missed (sleep, network): reload without discarding the last good chart
    return;
  } else if (candle.time > last.time) {
    trimmed = appendBoundedCandle(state.candles, candle, MAX_LIVE_CANDLES);
  } else {
    return; // older than what we already have
  }
  if (closed && live.provider === PROVIDERS.binance) {
    live.closedThrough = Math.max(live.closedThrough ?? -Infinity, candle.time);
  }
  paintLast(candle, trimmed);
}

// --- wiring ----------------------------------------------------------------
for (const kind of KINDS) {
  ctl[kind].on.addEventListener('change', () => setEnabled(kind, ctl[kind].on.checked));
  ctl[kind].source.addEventListener('change', () => { state.indicators[kind].source = ctl[kind].source.value; render({ fit: false }); });
  ctl[kind].period.addEventListener('input', () => applyParam(kind, 'period', ctl[kind].period.valueAsNumber, 'period'));
}
el.mult.addEventListener('input', () => applyParam('bb', 'mult', el.mult.valueAsNumber, 'multiplier'));
el['ema-start'].addEventListener('change', () => { state.indicators.ema.start = el['ema-start'].value; render({ fit: false }); });
el.scenario.addEventListener('change', () => loadScenario(el.scenario.value));
for (const id of ['symbol', 'interval']) el[id].addEventListener('change', () => { if (isLive()) { resetRetry(); loadLive(); } });
el.start.addEventListener('click', startStream);
el.stop.addEventListener('click', stopStream);
el.disconnect.addEventListener('click', disconnect);
el.reconnect.addEventListener('click', () => reconnect());

buildLines();
loadScenario('normal');

// Reads the real chart canvas: where is the line of `key` drawn in the column of its last point, and where should it be?
function probeLine(key = primaryLine()?.key) {
  const line = lines.find((l) => l.key === key);
  const last = line?.series.data().at(-1);
  if (!last) return null;
  const pane = INDICATORS[line.kind].pane ?? 0;
  const offset = chart.panes().slice(0, pane).reduce((sum, p) => sum + p.getHeight() + 1, 0);
  const x = Math.round(chart.timeScale().timeToCoordinate(last.time)) - 1; // the line ends at the bar centre
  const canvas = chart.takeScreenshot();
  const px = canvas.getContext('2d').getImageData(x, 0, 1, canvas.height).data;
  const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const rgb = toRgb(line.def.color);
  const others = lines.filter((l) => l !== line && l.def.color !== line.def.color).map((l) => toRgb(l.def.color));
  const ys = [];
  for (let y = 0; y < canvas.height; y++) {
    const p = px.subarray(y * 4, y * 4 + 3);
    // a pixel of this line's colour, and not one that another line's colour explains better (blue and indigo are close)
    if (isLineColor(p, rgb) && !others.some((o) => blendError(p, o) + 2 < blendError(p, rgb))) ys.push(y);
  }
  return { expectedY: line.series.priceToCoordinate(last.value) + offset, ys, height: canvas.height };
}

// How far a pixel is from the nearest blend of a colour with the white background (0: exactly that colour or one of its blends).
function blendError(p, rgb) {
  let along = 0, norm = 0;
  for (let i = 0; i < 3; i++) { along += (p[i] - rgb[i]) * (255 - rgb[i]); norm += (255 - rgb[i]) ** 2; }
  const t = norm === 0 ? 0 : Math.min(1, Math.max(0, along / norm));
  return Math.hypot(...[0, 1, 2].map((i) => p[i] - (rgb[i] + t * (255 - rgb[i]))));
}

// True for the line colour and for its anti-aliased blends with the white background.
function isLineColor(p, rgb) {
  const blends = [];
  for (let i = 0; i < 3; i++) {
    if (255 - rgb[i] >= 30) blends.push((p[i] - rgb[i]) / (255 - rgb[i]));
    else if (Math.abs(p[i] - rgb[i]) > 40) return false;
  }
  return blends.every((t) => t > -0.1 && t < 0.7) && Math.max(...blends) - Math.min(...blends) < 0.15;
}

// Hook for the autotests.
window.__app = {
  chart, candleSeries, step, stop: stopStream, disconnect, reconnect, sources: SOURCES,
  get smaSeries() { return primaryLine().series; }, // the main line of the first indicator that is on
  lineSeries: () => Object.fromEntries(lines.map((l) => [l.key, l.series])),
  candleData: () => candleSeries.data(),
  rawCandleData: () => state.candles,
  smaData: () => primaryLine()?.series.data() ?? [],
  lineData: (key) => lines.find((l) => l.key === key)?.series.data() ?? [],
  probeLine,
  state: () => ({
    // the first indicator that is on speaks for the old single-indicator fields
    indicator: enabled()[0] ?? 'sma', source: state.indicators[enabled()[0] ?? 'sma'].source, period: state.indicators[enabled()[0] ?? 'sma'].period,
    mult: state.indicators.bb.mult, start: state.indicators.ema.start,
    enabled: enabled(), indicators: JSON.parse(JSON.stringify(state.indicators)), scenario: state.scenario,
    bars: state.candles.length, streaming: stream.timer !== null, offline: isOffline(), ticks: stream.ticks,
    live: isLive() && live.conn !== null, retry: live.retry ? { attempt: live.retry.attempt, delay: live.retry.delay } : null, attempts: live.attempt, rejected: live.rejected, recovered: live.recovered, corrected: live.corrected, resyncs: live.resyncs, symbol: el.symbol.value, interval: el.interval.value,
  }),
};
