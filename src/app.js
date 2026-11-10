import { SOURCES } from './sma.js';
import { INDICATORS, computeIndicator, validateParams } from './indicators.js';
import { sanitizeCandles } from './sanitize.js';
import { SCENARIOS } from './scenarios.js';
import { createFeed } from './feed.js';
import { INTERVAL_SECONDS, fetchHistory, openStream } from './live.js';

const { createChart, CandlestickSeries, LineSeries } = window.LightweightCharts;

const STREAM_INTERVAL_MS = 200;
const STREAMABLE = new Set(['normal', 'long', 'empty']); // data sets that are a prefix of the feed
// Demo switch so the tests can prove they catch a broken indicator: ?bug=offbyone
const BUG = new URLSearchParams(location.search).get('bug');

const $ = (id) => document.getElementById(id);
const el = Object.fromEntries(
  ['indicator', 'source', 'period', 'mult', 'mult-label', 'scenario', 'symbol', 'interval', 'start', 'stop', 'disconnect', 'reconnect',
    'status', 'bar-count', 'last-close', 'legend-label', 'last-sma', 'legend-bands', 'last-bb-upper', 'last-bb-lower']
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

const state = { candles: [], indicator: 'sma', source: 'close', period: 20, mult: 2, scenario: 'normal', issues: [] };
const stream = { feed: null, timer: null, offlineSince: null, ticks: 0 };
const live = { gen: 0, conn: null, offline: false }; // gen invalidates answers of superseded requests
let lines = []; // [{ key, def, series }] of the selected indicator

const fmt = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');
const lastCandle = () => state.candles[state.candles.length - 1];
const primaryLine = () => lines.find((l) => l.def.primary);
const lineLast = (key) => lines.find((l) => l.key === key)?.series.data().at(-1);

function params() {
  const period = BUG === 'offbyone' ? Math.max(1, state.period - 1) : state.period;
  return { period, mult: state.mult };
}
const points = () => computeIndicator(state.indicator, state.candles, params(), state.source);

function setStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.classList.toggle('error', isError);
}
const isLive = () => state.scenario === 'binance';
const isOffline = () => stream.offlineSince !== null || live.offline;

function showStatus() {
  if (isOffline()) return setStatus('Feed disconnected', true);
  const base = isLive() ? `Live ${el.symbol.value} ${el.interval.value}` : '';
  const text = [base, ...state.issues].filter(Boolean).join('; ');
  setStatus(text || 'OK');
}

function updateLegend() {
  const last = lastCandle();
  el['bar-count'].textContent = String(state.candles.length);
  el['last-close'].textContent = last ? fmt(last.close) : '—';
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
  candleSeries.update(candle);
  const pts = points();
  for (const l of lines) {
    const last = pts[l.key].at(-1);
    if (last?.time === candle.time) l.series.update(last);
  }
  updateLegend();
}

function loadScenario(name) {
  resetStream();
  closeLive();
  state.scenario = name;
  if (isLive()) return loadLive();
  const { candles, issues } = sanitizeCandles(SCENARIOS[name]());
  state.candles = candles;
  state.issues = issues;
  showStatus();
  render();
}

function applyParam(key, value, label) {
  try {
    validateParams(state.indicator, { period: state.period, mult: state.mult, [key]: value });
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
  el.period.value = String(state.period);
  el.mult.value = String(state.mult);
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
  showStatus();
  startStream();
}

// --- Binance live data -----------------------------------------------------
function closeLive() {
  live.gen++; // any answer still in flight is now stale
  live.conn?.close();
  Object.assign(live, { conn: null, offline: false });
}

async function loadLive() {
  closeLive();
  const gen = live.gen;
  const symbol = el.symbol.value;
  const interval = el.interval.value;
  setStatus(`Loading ${symbol} ${interval}…`);
  try {
    const history = await fetchHistory({ symbol, interval });
    if (gen !== live.gen) return;
    ({ candles: state.candles, issues: state.issues } = sanitizeCandles(history));
    render();
    live.conn = openStream({
      symbol, interval,
      onKline: ({ candle }) => onLiveKline(gen, candle, interval),
      onClose: () => { if (gen === live.gen) { live.conn = null; live.offline = true; showStatus(); } },
    });
    showStatus();
  } catch (e) {
    if (gen !== live.gen) return;
    Object.assign(state, { candles: [], issues: [] });
    render();
    setStatus(`Failed to load ${symbol} ${interval}: ${e.message}`, true);
  }
}

function onLiveKline(gen, candle, interval) {
  if (gen !== live.gen) return;
  if (![candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)) return;
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
    indicator: state.indicator, source: state.source, period: state.period, mult: state.mult, scenario: state.scenario,
    bars: state.candles.length, streaming: stream.timer !== null, offline: isOffline(), ticks: stream.ticks,
    live: isLive() && live.conn !== null, symbol: el.symbol.value, interval: el.interval.value,
  }),
};
