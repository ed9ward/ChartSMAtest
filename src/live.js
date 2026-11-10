// Binance public market data (no API key): REST history + WebSocket kline stream.

import { assertLimit } from './limit.js';
import { parseFiniteNumber, parseBucketTimestamp } from './parse.js';

export const INTERVAL_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1d': 86400 };
export const KLINES_URL = 'https://api.binance.com/api/v3/klines';
export const WS_URL = 'wss://stream.binance.com:9443/ws';

// REST row: [openTime, open, high, low, close, volume, closeTime, ...] (numbers come as strings)
export function parseKline(row, interval = null) {
  if (!Array.isArray(row) || row.length < 6) return null;
  const intervalSeconds = interval === null ? null : INTERVAL_SECONDS[interval];
  if (interval !== null && !intervalSeconds) return null;
  const time = parseBucketTimestamp(row[0], 1000, intervalSeconds);
  const [open, high, low, close, volume] = row.slice(1, 6).map(parseFiniteNumber);
  if (time === null || [open, high, low, close, volume].some((v) => v === null)) return null;
  return { time, open, high, low, close, volume };
}

// WebSocket message: {"e":"kline","s":"BTCUSDT","k":{"t":..,"i":"1m","o":..,"h":..,"l":..,"c":..,"v":..,"x":false}}
// Returns null for anything that is not a well-formed kline of the expected symbol and interval.
export function parseKlineMessage(data, { symbol, interval } = {}) {
  let msg = data;
  if (typeof data === 'string') {
    try { msg = JSON.parse(data); } catch { return null; }
  }
  const k = msg?.k;
  if (msg?.e !== 'kline' || !k) return null;
  if (symbol && String(k.s).toUpperCase() !== symbol.toUpperCase()) return null;
  if (interval && k.i !== interval) return null;
  const intervalSeconds = interval === undefined ? null : INTERVAL_SECONDS[interval];
  if (interval !== undefined && !intervalSeconds) return null;
  const time = parseBucketTimestamp(k.t, 1000, intervalSeconds);
  const [open, high, low, close, volume] = [k.o, k.h, k.l, k.c, k.v].map(parseFiniteNumber);
  if (time === null || [open, high, low, close, volume].some((v) => v === null)) return null;
  return { candle: { time, open, high, low, close, volume }, closed: k.x === true };
}

export const MAX_KLINES = 1000; // per request

/** The newest `limit` candles. `limit` must be a non-negative integer: 0 gives an empty list without a request, above 1000 is cut to 1000. */
export async function fetchHistory({ symbol, interval, limit = 500, signal, fetchFn = fetch }) {
  assertLimit(limit);
  if (limit === 0) return [];
  const url = `${KLINES_URL}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${Math.min(limit, MAX_KLINES)}`;
  const res = await fetchFn(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error(body?.msg || 'unexpected response');
  const candles = [];
  let invalidCount = 0;
  for (const row of body) {
    const candle = parseKline(row, interval);
    if (candle) candles.push(candle);
    else invalidCount++;
  }
  candles.invalidCount = invalidCount;
  candles.sort((a, b) => a.time - b.time);
  return candles;
}

/** Opens the kline stream. onClose fires only when the connection ends without close() being called. */
export function openStream({ symbol, interval, onKline, onClose, onActivity, WS = WebSocket }) {
  const ws = new WS(`${WS_URL}/${symbol.toLowerCase()}@kline_${interval}`);
  let closedByUs = false;
  ws.onmessage = (event) => {
    onActivity?.(); // any message at all shows that the connection is alive
    const parsed = parseKlineMessage(event.data, { symbol, interval });
    if (parsed) onKline(parsed);
  };
  ws.onclose = () => { if (!closedByUs) onClose?.(); };
  return { close() { closedByUs = true; ws.close(); } };
}

export const utcDay = (ms) => Math.floor(ms / 86400000);

/** Change of `price` against the previous day's close, in percent (null when it cannot be calculated). */
export function dayChangePercent(price, prevClose) {
  if (![price, prevClose].every(Number.isFinite) || prevClose === 0) return null;
  return ((price - prevClose) / prevClose) * 100;
}

export function formatPercent(percent) {
  if (percent === null || !Number.isFinite(percent)) return '—';
  if (Math.abs(percent) < 0.005) return '0.00%'; // never "-0.00%"
  return `${percent > 0 ? '+' : ''}${percent.toFixed(2)}%`;
}
