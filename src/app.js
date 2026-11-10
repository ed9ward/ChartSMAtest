import { computeSMA, smaAt, assertPeriod } from './sma.js';
import { sanitizeCandles } from './sanitize.js';
import { SCENARIOS } from './scenarios.js';
import { createFeed } from './feed.js';
import { INTERVAL_SECONDS, fetchHistory, openStream } from './live.js';

const { createChart, CandlestickSeries, LineSeries } = window.LightweightCharts;

const STREAM_INTERVAL_MS = 200;
const STREAMABLE = new Set(['normal', 'long', 'empty']); // data sets that are a prefix of the feed
// Demo switch so the tests can prove they catch a broken SMA: ?bug=offbyone
const BUG = new URLSearchParams(location.search).get('bug');

const $ = (id) => document.getElementById(id);
const el = Object.fromEntries(
  ['source', 'period', 'scenario', 'symbol', 'interval', 'start', 'stop', 'disconnect', 'reconnect', 'status', 'bar-count', 'last-close', 'last-sma']
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
const smaSeries = chart.addSeries(LineSeries, { color: '#FF9800', lineWidth: 2, priceLineVisible: false });

const state = { candles: [], source: 'close', period: 20, scenario: 'normal', issues: [] };
const stream = { feed: null, timer: null, offlineSince: null, ticks: 0 };
const live = { gen: 0, conn: null, offline: false }; // gen invalidates answers of superseded requests

const fmt = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');
const smaPeriod = () => (BUG === 'offbyone' ? Math.max(1, state.period - 1) : state.period);
const lastCandle = () => state.candles[state.candles.length - 1];

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
  const sma = smaSeries.data();
  el['bar-count'].textContent = String(state.candles.length);
  el['last-close'].textContent = last ? fmt(last.close) : '—';
  el['last-sma'].textContent = sma.length ? fmt(sma[sma.length - 1].value) : '—';
}

// Full redraw: used after any settings or history change.
function render() {
  candleSeries.setData(state.candles);
  smaSeries.setData(computeSMA(state.candles, smaPeriod(), state.source));
  chart.timeScale().fitContent();
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

function applyPeriod(value) {
  try {
    assertPeriod(value);
  } catch (e) {
    setStatus(`Invalid period: ${e.message}`, true);
    return;
  }
  state.period = value;
  showStatus();
  render();
}

// --- live feed -------------------------------------------------------------
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

// Incremental redraw of the newest bar (new bar or update of the forming one).
function paintLast(candle) {
  candleSeries.update(candle);
  const value = smaAt(state.candles, state.candles.length - 1, smaPeriod(), state.source);
  if (value !== null) smaSeries.update({ time: candle.time, value });
  updateLegend();
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

el.source.addEventListener('change', () => { state.source = el.source.value; render(); });
el.period.addEventListener('input', () => applyPeriod(el.period.valueAsNumber));
el.scenario.addEventListener('change', () => loadScenario(el.scenario.value));
for (const id of ['symbol', 'interval']) el[id].addEventListener('change', () => { if (isLive()) loadLive(); });
el.start.addEventListener('click', startStream);
el.stop.addEventListener('click', stopStream);
el.disconnect.addEventListener('click', disconnect);
el.reconnect.addEventListener('click', () => reconnect());

loadScenario('normal');

// Hook for the autotests.
window.__app = {
  chart, candleSeries, smaSeries, step, stop: stopStream, disconnect, reconnect,
  candleData: () => candleSeries.data(),
  smaData: () => smaSeries.data(),
  state: () => ({
    source: state.source, period: state.period, scenario: state.scenario, bars: state.candles.length,
    streaming: stream.timer !== null, offline: isOffline(), ticks: stream.ticks,
    live: isLive() && live.conn !== null, symbol: el.symbol.value, interval: el.interval.value,
  }),
};
