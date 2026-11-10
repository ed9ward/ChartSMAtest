import { SOURCES } from './sma.js';
import { INDICATORS, computeIndicator, validateParams, settleBars } from './indicators.js';
import { sanitizeCandles, validateCandle } from './sanitize.js';
import { SCENARIOS } from './scenarios.js';
import { createFeed } from './feed.js';
import { INTERVAL_SECONDS, utcDay, dayChangePercent, formatPercent } from './live.js';
import { PROVIDERS } from './providers.js';

const { createChart, CandlestickSeries, LineSeries } = window.LightweightCharts;

const STREAM_INTERVAL_MS = 200;
const STREAMABLE = new Set(['normal', 'long', 'empty']); // data sets that are a prefix of the feed
// Demo switch so the tests can prove they catch a broken indicator: ?bug=offbyone
const BUG = new URLSearchParams(location.search).get('bug');

const $ = (id) => document.getElementById(id);
const el = Object.fromEntries(
  ['indicator', 'source', 'period', 'mult', 'mult-label', 'ema-start', 'start-label', 'scenario', 'symbol', 'interval', 'start', 'stop', 'disconnect', 'reconnect',
    'status', 'settle-note', 'bar-count', 'last-close', 'last-update', 'legend-day', 'day-change', 'legend-label', 'last-sma', 'legend-bands', 'last-bb-upper', 'last-bb-lower']
    .map((id) => [id, $(id)]),
);

const chart = createChart($('chart'), {
  autoSize: true,
  layout: { background: { color: '#ffffff' }, textColor: '#222' },
  grid: { vertLines: { color: '#eee' }, horzLines: { color: '#eee' } },
  timeScale: { timeVisible: true },
});
const candleSeries = chart.addSeries(CandlestickSeries, {
  upColor: '#26a69a', downColor: '#ef5350', borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350',
});

const state = { candles: [], indicator: 'sma', source: 'close', period: 20, mult: 2, start: 'first', scenario: 'normal', issues: [], updatedAt: null };
const stream = { feed: null, timer: null, offlineSince: null, ticks: 0 };
const live = { gen: 0, conn: null, offline: false, error: null, rejected: 0, recovered: 0, duplicates: 0, corrected: 0, resyncs: 0, symbol: null, provider: null, prevClose: null, dayIndex: null }; // gen invalidates answers of superseded requests
let lines = []; // [{ key, def, series }] of the selected indicator

const fmt = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');
const lastCandle = () => state.candles[state.candles.length - 1];
const primaryLine = () => lines.find((l) => l.def.primary);
const lineLast = (key) => lines.find((l) => l.key === key)?.series.data().at(-1);

function params() {
  const period = BUG === 'offbyone' ? Math.max(1, state.period - 1) : state.period;
  return { period, mult: state.mult, start: state.start };
}
const points = () => computeIndicator(state.indicator, state.candles, params(), state.source);

function setStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.classList.toggle('error', isError);
}
const isLive = () => state.scenario in PROVIDERS;
const isOffline = () => stream.offlineSince !== null || live.offline;

function showStatus() {
  if (isOffline()) return setStatus(live.error ? `Feed disconnected: ${live.error}` : 'Feed disconnected', true);
  const base = isLive() ? `Live ${el.symbol.value} ${el.interval.value}` : '';
  // Nothing the live feed does to the data happens silently.
  const notes = [
    live.rejected && `ignored ${live.rejected} invalid update(s)`,
    live.duplicates && `ignored ${live.duplicates} duplicate message(s)`,
    live.recovered && `recovered ${live.recovered} missed trade(s)`,
    live.corrected && `corrected ${live.corrected} candle(s) from the exchange`,
    live.resyncs && `resynced ${live.resyncs} time(s)`,
  ];
  const text = [base, ...state.issues, ...notes].filter(Boolean).join('; ');
  setStatus(text || 'OK');
}

// Previous day's close: for the 1d timeframe it is the bar before the last one, otherwise it comes from a 1d request.
const prevClose = () => (el.interval.value === '1d' ? state.candles.at(-2)?.close : live.prevClose);

function renderUpdated() {
  if (state.updatedAt === null) return void (el['last-update'].textContent = '—');
  const time = new Date(state.updatedAt).toLocaleTimeString('en-GB', { hour12: false });
  const age = Math.max(0, Math.floor((Date.now() - state.updatedAt) / 1000));
  el['last-update'].textContent = `${time} (${age} s ago)`;
}
const touch = () => { state.updatedAt = Date.now(); renderUpdated(); };
setInterval(renderUpdated, 1000);

// EMA and RSI forget the value they started from slowly: with a short history the last values depend on where it begins.
function updateSettleNote() {
  const { label } = INDICATORS[state.indicator];
  const period = params().period;
  const needed = settleBars(state.indicator, period, { start: state.start });
  const have = state.candles.length;
  const unsettled = needed > 0 && have > 0 && have < needed;
  el['settle-note'].hidden = !unsettled;
  el['settle-note'].textContent = unsettled
    ? `${label}(${period}) has not settled: ${have} bars loaded, about ${needed} needed for it to forget its starting value. `
      + 'The last values depend on where this history begins, so another platform with a longer history can show slightly different numbers.'
    : '';
}

function updateLegend() {
  updateSettleNote();
  const last = lastCandle();
  el['bar-count'].textContent = String(state.candles.length);
  el['last-close'].textContent = last ? fmt(last.close) : '—';
  const change = isLive() && last ? dayChangePercent(last.close, prevClose()) : null;
  el['legend-day'].hidden = !isLive();
  el['day-change'].textContent = formatPercent(change);
  el['day-change'].className = change === null || Math.abs(change) < 0.005 ? '' : change < 0 ? 'down' : 'up';
  el['legend-label'].textContent = INDICATORS[state.indicator].label;
  el['last-sma'].textContent = fmt(primaryLine()?.series.data().at(-1)?.value);
  el['legend-bands'].hidden = state.indicator !== 'bb';
  el['last-bb-upper'].textContent = fmt(lineLast('upper')?.value);
  el['last-bb-lower'].textContent = fmt(lineLast('lower')?.value);
}

// --- indicator lines -------------------------------------------------------
function buildLines() {
  for (const l of lines) chart.removeSeries(l.series);
  const def = INDICATORS[state.indicator];
  lines = def.lines.map((lineDef) => {
    const options = { color: lineDef.color, lineWidth: 2, priceLineVisible: false, lastValueVisible: !!lineDef.primary };
    if (def.pane) {
      options.autoscaleInfoProvider = () => ({ priceRange: { minValue: 0, maxValue: 100 } });
    }
    const series = chart.addSeries(LineSeries, options, def.pane ?? 0);
    if (def.pane) {
      for (const price of [30, 70]) series.createPriceLine({ price, color: '#999', lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
      chart.panes()[def.pane]?.setStretchFactor?.(1);
    }
    return { key: lineDef.key, def: lineDef, series };
  });
}

// Full redraw: used after any settings or history change.
function render() {
  candleSeries.setData(state.candles);
  const pts = points();
  for (const l of lines) l.series.setData(pts[l.key]);
  chart.timeScale().fitContent();
  updateLegend();
}

// Incremental redraw of the newest bar (new bar or update of the forming one).
function paintLast(candle) {
  touch();
  candleSeries.update(candle);
  const pts = points();
  for (const l of lines) {
    const last = pts[l.key].at(-1);
    if (last?.time === candle.time) l.series.update(last);
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

function applyParam(key, value, label) {
  try {
    validateParams(state.indicator, { period: state.period, mult: state.mult, start: state.start, [key]: value });
  } catch (e) {
    setStatus(`Invalid ${label}: ${e.message}`, true);
    return;
  }
  state[key] = value;
  showStatus();
  render();
}

function selectIndicator(kind) {
  state.indicator = kind;
  const { defaults } = INDICATORS[kind];
  state.period = defaults.period;
  state.mult = defaults.mult ?? state.mult;
  state.start = defaults.start ?? state.start;
  el.period.value = String(state.period);
  el.mult.value = String(state.mult);
  el['ema-start'].value = state.start;
  el['start-label'].hidden = kind !== 'ema';
  el['mult-label'].hidden = kind !== 'bb';
  buildLines();
  showStatus();
  render();
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
    if (!live.conn) return;
    closeLive();
    live.offline = true;
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
  if (isLive()) return live.offline ? loadLive() : undefined;
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
function closeLive() {
  live.gen++; // any answer still in flight is now stale
  live.conn?.close();
  Object.assign(live, { conn: null, offline: false, error: null, rejected: 0, recovered: 0, duplicates: 0, corrected: 0, resyncs: 0, prevClose: null, dayIndex: null });
}

// Previous day's close for the change-per-day figure. A failure only hides that figure, the chart keeps working.
async function loadDay(gen, provider, symbol, interval) {
  let close = null;
  try {
    const days = interval === '1d' ? [] : await provider.fetchHistory({ symbol, interval: '1d', limit: 2 });
    close = days.length === 2 ? days[0].close : null;
  } catch { /* the figure stays empty */ }
  if (gen !== live.gen) return;
  Object.assign(live, { prevClose: close, dayIndex: utcDay(Date.now()) });
  updateLegend();
}

async function loadLive() {
  closeLive();
  const gen = live.gen;
  const provider = PROVIDERS[state.scenario];
  const symbol = el.symbol.value;
  const interval = el.interval.value;
  setStatus(`Loading ${symbol} ${interval}…`);
  try {
    const history = await provider.fetchHistory({ symbol, interval, limit: 500 });
    if (gen !== live.gen) return;
    ({ candles: state.candles, issues: state.issues } = sanitizeCandles(history));
    render();
    touch();
    Object.assign(live, { symbol, provider });
    loadDay(gen, provider, symbol, interval);
    live.conn = provider.openStream({
      symbol, interval, seed: lastCandle(),
      onKline: ({ candle, correction }) => onLiveKline(gen, candle, interval, correction),
      onEvent: ({ type, count }) => {
        if (gen !== live.gen) return;
        if (type === 'recovered') live.recovered += count;
        if (type === 'duplicate') live.duplicates++;
        showStatus();
      },
      // missed trades could not be fetched: take everything again, and say so
      onResync: () => {
        if (gen !== live.gen) return;
        const resyncs = live.resyncs + 1;
        loadLive();
        live.resyncs = resyncs;
      },
      onClose: () => { if (gen === live.gen) { live.conn = null; live.offline = true; showStatus(); } },
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
    Object.assign(state, { candles: [], issues: [] });
    render();
    setStatus(`Failed to load ${symbol} ${interval}: ${e.message}`, true);
  }
}

function onLiveKline(gen, candle, interval, correction = false) {
  if (gen !== live.gen) return;
  if (validateCandle(candle)) { // the same rule as for the history
    live.rejected++;
    showStatus();
    return;
  }
  if (correction) { // the exchange's final version of a candle that has already closed
    const index = state.candles.findLastIndex((c) => c.time === candle.time);
    if (index < 0) return;
    state.candles[index] = candle;
    live.corrected++;
    render();
    showStatus();
    return;
  }
  if (interval !== '1d' && live.dayIndex !== null && utcDay(Date.now()) !== live.dayIndex) {
    live.dayIndex = utcDay(Date.now()); // a new UTC day has begun: "previous close" moved
    loadDay(gen, live.provider, live.symbol, interval);
  }
  const last = lastCandle();
  if (!last || candle.time === last.time) {
    if (last) state.candles[state.candles.length - 1] = candle;
    else state.candles.push(candle);
  } else if (candle.time > last.time + INTERVAL_SECONDS[interval]) {
    loadLive(); // bars were missed (sleep, network): take the history again
    return;
  } else if (candle.time > last.time) {
    state.candles.push(candle);
  } else {
    return; // older than what we already have
  }
  paintLast(candle);
}

// --- wiring ----------------------------------------------------------------
el.indicator.addEventListener('change', () => selectIndicator(el.indicator.value));
el.source.addEventListener('change', () => { state.source = el.source.value; render(); });
el.period.addEventListener('input', () => applyParam('period', el.period.valueAsNumber, 'period'));
el.mult.addEventListener('input', () => applyParam('mult', el.mult.valueAsNumber, 'multiplier'));
el['ema-start'].addEventListener('change', () => { state.start = el['ema-start'].value; render(); });
el.scenario.addEventListener('change', () => loadScenario(el.scenario.value));
for (const id of ['symbol', 'interval']) el[id].addEventListener('change', () => { if (isLive()) loadLive(); });
el.start.addEventListener('click', startStream);
el.stop.addEventListener('click', stopStream);
el.disconnect.addEventListener('click', disconnect);
el.reconnect.addEventListener('click', () => reconnect());

buildLines();
loadScenario('normal');

// Reads the real chart canvas: where is the line of `key` drawn in the column of its last point, and where should it be?
function probeLine(key = primaryLine().key) {
  const line = lines.find((l) => l.key === key);
  const last = line?.series.data().at(-1);
  if (!last) return null;
  const pane = INDICATORS[state.indicator].pane ?? 0;
  const offset = chart.panes().slice(0, pane).reduce((sum, p) => sum + p.getHeight() + 1, 0);
  const x = Math.round(chart.timeScale().timeToCoordinate(last.time)) - 1; // the line ends at the bar centre
  const canvas = chart.takeScreenshot();
  const px = canvas.getContext('2d').getImageData(x, 0, 1, canvas.height).data;
  const rgb = [1, 3, 5].map((i) => parseInt(line.def.color.slice(i, i + 2), 16));
  const ys = [];
  for (let y = 0; y < canvas.height; y++) if (isLineColor(px.subarray(y * 4, y * 4 + 3), rgb)) ys.push(y);
  return { expectedY: line.series.priceToCoordinate(last.value) + offset, ys, height: canvas.height };
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
  get smaSeries() { return primaryLine().series; }, // the main line of the selected indicator
  lineSeries: () => Object.fromEntries(lines.map((l) => [l.key, l.series])),
  candleData: () => candleSeries.data(),
  smaData: () => primaryLine().series.data(),
  lineData: (key) => lines.find((l) => l.key === key)?.series.data() ?? [],
  probeLine,
  state: () => ({
    indicator: state.indicator, source: state.source, period: state.period, mult: state.mult, start: state.start, scenario: state.scenario,
    bars: state.candles.length, streaming: stream.timer !== null, offline: isOffline(), ticks: stream.ticks,
    live: isLive() && live.conn !== null, rejected: live.rejected, recovered: live.recovered, corrected: live.corrected, resyncs: live.resyncs, symbol: el.symbol.value, interval: el.interval.value,
  }),
};
