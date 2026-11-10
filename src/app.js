import { computeSMA, smaAt, assertPeriod } from './sma.js';
import { sanitizeCandles } from './sanitize.js';
import { SCENARIOS } from './scenarios.js';
import { createFeed } from './feed.js';

const { createChart, CandlestickSeries, LineSeries } = window.LightweightCharts;

const STREAM_INTERVAL_MS = 200;
const STREAMABLE = new Set(['normal', 'long', 'empty']); // data sets that are a prefix of the feed
// Demo switch so the tests can prove they catch a broken SMA: ?bug=offbyone
const BUG = new URLSearchParams(location.search).get('bug');

const $ = (id) => document.getElementById(id);
const el = Object.fromEntries(
  ['source', 'period', 'scenario', 'start', 'stop', 'disconnect', 'reconnect', 'status', 'bar-count', 'last-close', 'last-sma']
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

const fmt = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');
const smaPeriod = () => (BUG === 'offbyone' ? Math.max(1, state.period - 1) : state.period);
const lastCandle = () => state.candles[state.candles.length - 1];

function setStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.classList.toggle('error', isError);
}
const showIssues = () => setStatus(state.issues.length ? state.issues.join('; ') : 'OK');

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
  state.scenario = name;
  const { candles, issues } = sanitizeCandles(SCENARIOS[name]());
  state.candles = candles;
  state.issues = issues;
  showIssues();
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
  showIssues();
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
  candleSeries.update(candle);
  const value = smaAt(state.candles, state.candles.length - 1, smaPeriod(), state.source);
  if (value !== null) smaSeries.update({ time: candle.time, value });
  updateLegend();
}

function startStream() {
  if (!ensureFeed()) {
    setStatus('Streaming is available for the "normal", "long" and "empty" data sets only', true);
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
  if (!stream.timer) return;
  clearInterval(stream.timer);
  stream.timer = null;
  stream.offlineSince = Date.now();
  setStatus('Feed disconnected', true);
}

// The connection is back: the ticks that were missed arrive as history, then live ticks resume.
function reconnect(missedTicks) {
  if (stream.offlineSince === null) return;
  const missed = missedTicks ?? Math.floor((Date.now() - stream.offlineSince) / STREAM_INTERVAL_MS);
  for (let i = 0; i < missed && applyTick(); i++);
  render();
  showIssues();
  startStream();
}

el.source.addEventListener('change', () => { state.source = el.source.value; render(); });
el.period.addEventListener('input', () => applyPeriod(el.period.valueAsNumber));
el.scenario.addEventListener('change', () => loadScenario(el.scenario.value));
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
    streaming: stream.timer !== null, offline: stream.offlineSince !== null, ticks: stream.ticks,
  }),
};
