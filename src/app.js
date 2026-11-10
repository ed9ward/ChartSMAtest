import { generateCandles, partialCandle } from './generator.js';
import { computeSMA, smaAt, assertPeriod } from './sma.js';
import { sanitizeCandles } from './sanitize.js';
import { SCENARIOS } from './scenarios.js';

const { createChart, CandlestickSeries, LineSeries } = window.LightweightCharts;

const TICKS_PER_CANDLE = 5;
const STREAM_INTERVAL_MS = 200;
// Demo switch so the tests can prove they catch a broken SMA: ?bug=offbyone
const BUG = new URLSearchParams(location.search).get('bug');

const $ = (id) => document.getElementById(id);
const el = { source: $('source'), period: $('period'), scenario: $('scenario'), start: $('start'),
  stop: $('stop'), status: $('status'), barCount: $('bar-count'), lastClose: $('last-close'), lastSma: $('last-sma') };

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

const state = { candles: [], source: 'close', period: 20, scenario: 'normal', issues: [], stream: null };

const fmt = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');
const effectivePeriod = () => (BUG === 'offbyone' ? Math.max(1, state.period - 1) : state.period);

function setStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.classList.toggle('error', isError);
}

function updateLegend() {
  const last = state.candles[state.candles.length - 1];
  const sma = smaSeries.data();
  el.barCount.textContent = String(state.candles.length);
  el.lastClose.textContent = last ? fmt(last.close) : '—';
  el.lastSma.textContent = sma.length ? fmt(sma[sma.length - 1].value) : '—';
}

function render() {
  candleSeries.setData(state.candles);
  smaSeries.setData(computeSMA(state.candles, effectivePeriod(), state.source));
  chart.timeScale().fitContent();
  updateLegend();
}

function loadScenario(name) {
  stopStream();
  state.scenario = name;
  const { candles, issues } = sanitizeCandles(SCENARIOS[name]());
  state.candles = candles;
  state.issues = issues;
  setStatus(issues.length ? issues.join('; ') : 'OK');
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
  setStatus(state.issues.length ? state.issues.join('; ') : 'OK');
  render();
}

// --- streaming: replays a pre-generated sequence tick by tick ---
function startStream() {
  if (!ensureStream()) {
    setStatus('Streaming is available for the "normal" data set only', true);
    return;
  }
  if (!state.stream.timer) state.stream.timer = setInterval(step, STREAM_INTERVAL_MS);
}

function stopStream() {
  if (state.stream?.timer) clearInterval(state.stream.timer);
  state.stream = null;
}

function ensureStream() {
  if (!state.stream) {
    if (state.scenario !== 'normal') return false;
    const full = generateCandles({ seed: 42, count: 1000 });
    state.stream = { full, index: state.candles.length, k: 0, timer: null };
  }
  return true;
}

function step() {
  if (!ensureStream()) return;
  const s = state.stream;
  const final = s.full[s.index];
  s.k++;
  const candle = partialCandle(final, s.k, TICKS_PER_CANDLE);
  if (s.k === 1) state.candles.push(candle);
  else state.candles[state.candles.length - 1] = candle;
  candleSeries.update(candle);
  const lastIndex = state.candles.length - 1;
  const value = smaAt(state.candles, lastIndex, effectivePeriod(), state.source);
  if (value !== null) smaSeries.update({ time: candle.time, value });
  if (s.k === TICKS_PER_CANDLE) { s.index++; s.k = 0; }
  updateLegend();
}

el.source.addEventListener('change', () => { state.source = el.source.value; render(); });
el.period.addEventListener('input', () => applyPeriod(el.period.valueAsNumber));
el.scenario.addEventListener('change', () => loadScenario(el.scenario.value));
el.start.addEventListener('click', startStream);
el.stop.addEventListener('click', stopStream);

loadScenario('normal');

// Hook for the autotests.
window.__app = {
  chart, candleSeries, smaSeries, step,
  candleData: () => candleSeries.data(),
  smaData: () => smaSeries.data(),
  state: () => ({ source: state.source, period: state.period, scenario: state.scenario, bars: state.candles.length, streaming: !!state.stream?.timer }),
};
