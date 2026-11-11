// Coinbase Exchange public market data (no API key): REST candles and trades + WebSocket matches/heartbeat.
// Candle rows: [time (s, start of bucket), low, high, open, close, volume], newest first, at most 300 per request.
//
// Live candles are built from every trade of the `matches` channel (the `ticker` channel merges cascading matches,
// so its sizes would be incomplete). Coinbase says matches can be dropped and recommends tracking the trade id with the
// heartbeat channel and fetching the missed trades from REST. That is what openStream() does.

import { assertLimit } from './limit.js';
import { parseFiniteNumber, parseBucketTimestamp } from './parse.js';

export const COINBASE_GRANULARITY = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1d': 86400 };
export const COINBASE_REST = 'https://api.exchange.coinbase.com';
export const COINBASE_WS = 'wss://ws-feed.exchange.coinbase.com';
export const MAX_CANDLES = 300;
export const MAX_TRADES = 1000; // trades per REST request

export function parseCandleRow(row, interval = null) {
  if (!Array.isArray(row) || row.length < 6) return null;
  const intervalSeconds = interval === null ? null : COINBASE_GRANULARITY[interval];
  if (interval !== null && !intervalSeconds) return null;
  const time = parseBucketTimestamp(row[0], 1, intervalSeconds);
  const [low, high, open, close, volume] = row.slice(1, 6).map(parseFiniteNumber);
  if (time === null || [low, high, open, close, volume].some((v) => v === null)) return null;
  return { time, open, high, low, close, volume };
}

/**
 * The newest `limit` candles, oldest first. `limit` must be a non-negative integer: 0 gives an empty list without any
 * request, and anything above Coinbase's 300 per request is cut to 300.
 */
export async function fetchHistory({ symbol, interval, limit = MAX_CANDLES, signal, fetchFn = fetch }) {
  assertLimit(limit);
  if (limit === 0) return [];
  const granularity = COINBASE_GRANULARITY[interval];
  if (!granularity) throw new Error(`Coinbase has no ${interval} timeframe`);
  const url = `${COINBASE_REST}/products/${encodeURIComponent(symbol)}/candles?granularity=${granularity}`;
  const res = await fetchFn(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error(body?.message || 'unexpected response');
  const candles = [];
  let invalidCount = 0;
  for (const row of body) {
    const candle = parseCandleRow(row, interval);
    if (candle) candles.push(candle);
    else invalidCount++;
  }
  candles.sort((a, b) => a.time - b.time);
  const result = candles.slice(candles.length - Math.min(limit, MAX_CANDLES, candles.length));
  if (invalidCount) result.invalidCount = invalidCount;
  return result;
}

// --- trades ----------------------------------------------------------------
// Numbers arrive as numbers or as numeric strings; null, empty strings and objects are not numbers (Number(null) would be 0).
const toNumber = (x) => parseFiniteNumber(x) ?? NaN;

const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/i;

const parseTradeTimestamp = (value) => {
  if (typeof value !== 'string') return NaN;
  const parts = ISO_TIMESTAMP.exec(value);
  if (!parts) return NaN;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = parts;
  const y = Number(year), m = Number(month), d = Number(day);
  const daysInMonth = [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth[m - 1]
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59))) return NaN;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds / 1000 : NaN;
};

const toTrade = (tradeId, price, size, time, last = false) => {
  tradeId = toNumber(tradeId);
  price = toNumber(price);
  size = toNumber(size);
  time = parseTradeTimestamp(time);
  if (!Number.isSafeInteger(tradeId) || tradeId < 0 || !Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(time)) return null;
  return { tradeId, price, size, time, last };
};

const asObject = (data) => {
  if (typeof data !== 'string') return data;
  try { return JSON.parse(data); } catch { return null; }
};

// {"type":"match" | "last_match","trade_id":123,"product_id":"BTC-USD","price":"73068.94","size":"0.25","time":"2026-11-10T16:34:51.123456Z",...}
// "last_match" is the first message after subscribing: the newest trade that already happened.
export function parseMatch(data, { symbol } = {}) {
  const msg = asObject(data);
  if (msg?.type !== 'match' && msg?.type !== 'last_match') return null;
  if (symbol && msg.product_id !== symbol) return null;
  return toTrade(msg.trade_id, msg.price, msg.size, msg.time, msg.type === 'last_match');
}

// {"type":"heartbeat","sequence":90,"last_trade_id":20,"product_id":"BTC-USD","time":"..."} once a second.
export function parseHeartbeat(data, { symbol } = {}) {
  const msg = asObject(data);
  if (msg?.type !== 'heartbeat') return null;
  if (symbol && msg.product_id !== symbol) return null;
  const lastTradeId = toNumber(msg.last_trade_id);
  return Number.isSafeInteger(lastTradeId) && lastTradeId >= 0 ? { lastTradeId } : null;
}

/**
 * Fetch recent trades, oldest first. When afterTradeId is supplied, walk the
 * Exchange cursor pages newer than that id until the complete requested range
 * is covered. Cursor values are trade IDs, so this does not depend on browser
 * JavaScript being allowed to read Coinbase's CB-AFTER / CB-BEFORE headers.
 */
export async function fetchTrades({
  symbol, signal, fetchFn = fetch, afterTradeId = null, throughTradeId = Infinity, maxPages = 10,
}) {
  if (afterTradeId !== null && (!Number.isSafeInteger(afterTradeId) || afterTradeId < 0)) {
    throw new RangeError('afterTradeId must be a non-negative safe integer');
  }
  if (afterTradeId !== null && (!Number.isSafeInteger(throughTradeId) || throughTradeId < afterTradeId)) {
    throw new RangeError('throughTradeId must be a safe integer >= afterTradeId');
  }
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new RangeError('maxPages must be a positive integer');

  const collected = new Map();
  let cursor = null;
  let pages = 0;
  let oldestSeen = Infinity;

  while (pages < (afterTradeId === null ? 1 : maxPages)) {
    const params = new URLSearchParams({ limit: String(MAX_TRADES) });
    if (afterTradeId !== null) params.set(cursor === null ? 'before' : 'after', String(cursor ?? afterTradeId));
    const url = `${COINBASE_REST}/products/${encodeURIComponent(symbol)}/trades?${params}`;
    const res = await fetchFn(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error(body?.message || 'unexpected response');

    const page = body.map((t) => toTrade(t?.trade_id, t?.price, t?.size, t?.time)).filter(Boolean);
    pages++;
    for (const trade of page) {
      if ((afterTradeId === null || trade.tradeId > afterTradeId) && trade.tradeId <= throughTradeId) {
        collected.set(trade.tradeId, trade);
      }
      oldestSeen = Math.min(oldestSeen, trade.tradeId);
    }

    if (afterTradeId === null || page.length < MAX_TRADES || oldestSeen <= afterTradeId) break;
    const nextCursor = Math.min(...page.map((trade) => trade.tradeId));
    if (!Number.isSafeInteger(nextCursor) || nextCursor >= cursor && cursor !== null) {
      throw new Error('Coinbase trade pagination did not advance');
    }
    cursor = nextCursor;
  }

  if (afterTradeId !== null && oldestSeen > afterTradeId && pages >= maxPages) {
    throw new Error(`trade recovery exceeds ${maxPages * MAX_TRADES} REST records`);
  }
  return [...collected.values()].sort((a, b) => a.tradeId - b.tradeId);
}

/**
 * Rebuild the currently forming candle from its complete trade history.
 * Coinbase's first last_match gives us an exact upper trade-ID boundary. Walking
 * older REST pages from that ID until the bucket boundary avoids guessing which
 * trades were already present in the earlier candle snapshot.
 */
export async function fetchTradesForBucket({
  symbol, lastTrade, bucketStart, intervalSeconds, signal, fetchFn = fetch, maxPages = 10,
}) {
  if (!lastTrade || !Number.isSafeInteger(lastTrade.tradeId) || lastTrade.tradeId < 0) {
    throw new RangeError('lastTrade must have a non-negative safe trade ID');
  }
  if (!Number.isSafeInteger(bucketStart) || bucketStart < 0
    || !Number.isSafeInteger(intervalSeconds) || intervalSeconds <= 0
    || bucketStart % intervalSeconds !== 0) {
    throw new RangeError('bucketStart and intervalSeconds must describe an aligned bucket');
  }
  if (Math.floor(lastTrade.time / intervalSeconds) * intervalSeconds !== bucketStart) {
    throw new RangeError('lastTrade does not belong to the requested bucket');
  }
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new RangeError('maxPages must be a positive integer');

  const collected = new Map([[lastTrade.tradeId, lastTrade]]);
  let cursor = lastTrade.tradeId;
  let boundaryReached = false;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    const params = new URLSearchParams({ limit: String(MAX_TRADES), after: String(cursor) });
    const url = `${COINBASE_REST}/products/${encodeURIComponent(symbol)}/trades?${params}`;
    const res = await fetchFn(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error(body?.message || 'unexpected response');

    const page = body.map((t) => toTrade(t?.trade_id, t?.price, t?.size, t?.time));
    if (page.some((trade) => trade === null)) throw new Error('invalid trade row during candle bootstrap');
    if (page.length === 0) { boundaryReached = true; break; }

    const ids = page.map((trade) => trade.tradeId);
    const nextCursor = Math.min(...ids);
    if (!Number.isSafeInteger(nextCursor) || nextCursor >= cursor) {
      throw new Error('Coinbase candle bootstrap pagination did not advance');
    }
    for (const trade of page) {
      if (trade.tradeId >= cursor) throw new Error('Coinbase candle bootstrap returned a non-older trade');
      if (trade.time >= bucketStart) collected.set(trade.tradeId, trade);
      else boundaryReached = true;
    }
    if (boundaryReached || body.length < MAX_TRADES) {
      boundaryReached = true;
      break;
    }
    cursor = nextCursor;
  }

  if (!boundaryReached) throw new Error(`current candle exceeds ${maxPages * MAX_TRADES} REST records`);
  const trades = [...collected.values()].sort((a, b) => a.tradeId - b.tradeId);
  for (let i = 1; i < trades.length; i++) {
    if (trades[i].tradeId !== trades[i - 1].tradeId + 1) {
      throw new Error(`trade gap during candle bootstrap at ID ${trades[i - 1].tradeId + 1}`);
    }
  }
  if (trades.some((trade) => trade.time < bucketStart
    || Math.floor(trade.time / intervalSeconds) * intervalSeconds !== bucketStart)) {
    throw new Error('Coinbase candle bootstrap crossed a bucket boundary');
  }
  return trades;
}

const candleFromTrades = (trades, bucketStart) => ({
  time: bucketStart,
  open: trades[0].price,
  high: Math.max(...trades.map((trade) => trade.price)),
  low: Math.min(...trades.map((trade) => trade.price)),
  close: trades[trades.length - 1].price,
  volume: trades.reduce((sum, trade) => sum + trade.size, 0),
});

const sameNumber = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const sameCandle = (a, b) => ['open', 'high', 'low', 'close', 'volume'].every((k) => sameNumber(a[k], b[k]));

/**
 * Opens the feed and turns trades into candles of the chosen timeframe.
 *
 * - seed: the newest candle of the history; on startup, last_match establishes a trade-ID boundary and the forming
 *   bucket is rebuilt from REST trades before buffered live matches are applied.
 * - Every trade must have the next trade id. A trade that arrives too early is held back: if its predecessors show up
 *   within `graceMs` (reordering) they are applied in order, otherwise they are fetched from REST. Repeated or old
 *   trades are ignored.
 * - Two heartbeats in a row that report a newer last_trade_id than the one applied mean the newest trades were lost
 *   (no later trade would reveal that); they are fetched from REST too.
 * - If missed trades cannot be fetched (too old, REST error), onResync(reason) is called: the caller reloads everything.
 * - When a candle closes, the exchange's own version of it is fetched (after `reconcileDelayMs`) and, if it differs,
 *   delivered as a correction. That makes closed candles exact even where the live feed was incomplete.
 * - onKline({ candle, correction }), onEvent({ type: 'recovered' | 'duplicate', ... }), onError(text) for an error
 *   message of the server, onClose() when the connection ends without close() being called.
 */
export function openStream({
  symbol, interval, onKline, onClose, onError, onEvent, onResync, onActivity, seed,
  WS = WebSocket, fetchFn = fetch, graceMs = 300, reconcileDelayMs = 2000,
  reconcileAttempts = 3, reconcileRetryMs = 1000, applyLastMatchWhenUnseeded = true, bootstrapBucket = false,
}) {
  const granularity = COINBASE_GRANULARITY[interval];
  const ws = new WS(COINBASE_WS);
  let closedByUs = false;
  let current = seed ? { ...seed } : null;
  let lastId = null;          // newest trade applied to the candle
  let bootstrapping = false;
  const bootstrapBuffer = [];
  let behind = 0;             // heartbeats in a row that were ahead of lastId
  let heartbeatId = null;     // newest trade id a heartbeat reported
  let recovering = false;
  let gaveUp = false;         // missed trades could not be fetched: the caller reloads everything, this feed is finished
  const ahead = new Map();    // trades that arrived before their predecessors
  const timers = new Set();

  const later = (fn, ms) => {
    if (closedByUs) return;
    const timer = setTimeout(() => { timers.delete(timer); if (!closedByUs) fn(); }, ms);
    timers.add(timer);
  };
  const event = (type, extra = {}) => onEvent?.({ type, ...extra });

  // The exchange's version of a closed candle replaces ours when they differ. Transient REST
  // failures and temporarily missing candles are retried a bounded number of times.
  const reconcile = (closed) => {
    const check = async (attempt) => {
      if (closedByUs) return;
      try {
        const exact = (await fetchHistory({ symbol, interval, fetchFn })).find((c) => c.time === closed.time);
        if (closedByUs) return;
        if (exact) {
          if (!sameCandle(exact, closed)) onKline({ candle: exact, correction: true });
          return;
        }
        throw new Error('closed candle not returned by REST');
      } catch (error) {
        if (closedByUs) return;
        const reason = error instanceof Error ? error.message : String(error);
        if (attempt < reconcileAttempts) {
          event('reconcile-retry', { time: closed.time, attempt, reason });
          later(() => check(attempt + 1), reconcileRetryMs * attempt);
        } else {
          event('reconcile-failed', { time: closed.time, attempts: attempt, reason });
        }
      }
    };
    later(() => check(1), reconcileDelayMs);
  };

  const apply = (trade) => {
    const bucket = Math.floor(trade.time / granularity) * granularity;
    if (current && bucket < current.time) return; // belongs to a candle that is already closed
    if (!current || bucket > current.time) {
      if (current && reconcileDelayMs !== null) reconcile({ ...current });
      current = { time: bucket, open: trade.price, high: trade.price, low: trade.price, close: trade.price, volume: trade.size };
    } else {
      current = {
        ...current,
        high: Math.max(current.high, trade.price),
        low: Math.min(current.low, trade.price),
        close: trade.price,
        volume: current.volume + trade.size,
      };
    }
    onKline({ candle: { ...current } });
  };

  const drain = () => {
    while (ahead.has(lastId + 1)) {
      const trade = ahead.get(lastId + 1);
      ahead.delete(lastId + 1);
      apply(trade);
      lastId = trade.tradeId;
    }
  };

  const recover = async () => {
    if (recovering || gaveUp || closedByUs || lastId === null) return;
    const target = Math.max(lastId, heartbeatId ?? 0, ...ahead.keys());
    if (target <= lastId) return; // the missing trades arrived in the meantime
    recovering = true;
    try {
      const fromRest = new Map((await fetchTrades({ symbol, fetchFn, afterTradeId: lastId, throughTradeId: target })).map((t) => [t.tradeId, t]));
      if (closedByUs) return;
      let fetched = 0;
      for (let id = lastId + 1; id <= target; id++) {
        const trade = ahead.get(id) ?? fromRest.get(id);
        if (!trade) throw new Error(`trade ${id} is not available any more`);
        if (!ahead.has(id)) fetched++;
        ahead.delete(id);
        apply(trade);
        lastId = id;
      }
      // Preserve a newer heartbeat watermark received while this REST request was in flight.
      if (heartbeatId !== null && heartbeatId <= lastId) heartbeatId = null;
      behind = 0;
      if (fetched) event('recovered', { count: fetched, upTo: lastId });
      drain();
    } catch (e) {
      gaveUp = true;
      if (!closedByUs) onResync?.(e.message);
    } finally {
      recovering = false;
    }
    if (!closedByUs && !gaveUp && (ahead.size || (heartbeatId !== null && heartbeatId > lastId))) {
      later(recover, 0); // more trades or a newer heartbeat arrived while we were fetching
    }
  };

  const finishBootstrap = async (trade) => {
    const bucket = Math.floor(trade.time / granularity) * granularity;
    try {
      const trades = await fetchTradesForBucket({
        symbol, lastTrade: trade, bucketStart: bucket, intervalSeconds: granularity, fetchFn,
      });
      if (closedByUs) return;
      if (current && bucket < current.time) {
        // The REST snapshot is newer than this delayed first message; keep the newer seed.
      } else if (trades.length === 1 && current && current.time === bucket) {
        // No older trades exist in this bucket. The REST candle seed already contains the same last trade.
      } else {
        if (current && bucket > current.time && reconcileDelayMs !== null) reconcile({ ...current });
        current = candleFromTrades(trades, bucket);
        onKline({ candle: { ...current } });
      }
    } catch (error) {
      // A very busy bucket or a transient REST failure must not stop the live feed.
      // Fall back to the previous safe baseline behavior; the closed candle is later
      // reconciled against Coinbase's candle endpoint.
      event('bootstrap-failed', { reason: error instanceof Error ? error.message : String(error) });
      const bucket = Math.floor(trade.time / granularity) * granularity;
      if (!current || bucket > current.time) apply(trade);
    } finally {
      bootstrapping = false;
      const buffered = bootstrapBuffer.splice(0).sort((a, b) => a.tradeId - b.tradeId);
      if (closedByUs) return;
      for (const pending of buffered) accept(pending);
      if (!closedByUs && !gaveUp && heartbeatId !== null && heartbeatId > lastId && behind >= 2) recover();
    }
  };

  const accept = (trade) => {
    if (bootstrapping) {
      if (trade.tradeId > lastId && !bootstrapBuffer.some((item) => item.tradeId === trade.tradeId)) bootstrapBuffer.push(trade);
      return;
    }
    if (lastId === null) { // the first message fixes where we are
      lastId = trade.tradeId;
      if (trade.last && bootstrapBucket && interval !== '1d') {
        bootstrapping = true;
        finishBootstrap(trade);
        return;
      }
      // A last_match already represented by a same-bucket REST seed must not be counted twice.
      // If it starts a newer bucket, or there is no seed, it is not part of the REST snapshot.
      const bucket = Math.floor(trade.time / granularity) * granularity;
      if (!trade.last || (current && bucket > current.time) || (!current && applyLastMatchWhenUnseeded)) apply(trade);
      return;
    }
    if (trade.tradeId <= lastId || ahead.has(trade.tradeId)) return void event('duplicate', { tradeId: trade.tradeId });
    if (trade.tradeId === lastId + 1) {
      apply(trade);
      lastId = trade.tradeId;
      drain();
      return;
    }
    ahead.set(trade.tradeId, trade);
    later(recover, graceMs);
  };

  const heartbeat = ({ lastTradeId }) => {
    if (bootstrapping) {
      if (lastTradeId > (heartbeatId ?? lastId)) heartbeatId = lastTradeId;
      behind = lastTradeId > lastId ? behind + 1 : 0;
      return;
    }
    if (lastId === null || lastTradeId <= lastId) { behind = 0; return; }
    if (++behind >= 2) { // one heartbeat can simply be ahead of the match messages
      heartbeatId = lastTradeId;
      recover();
    }
  };

  ws.onopen = () => ws.send(JSON.stringify({
    type: 'subscribe',
    channels: [{ name: 'matches', product_ids: [symbol] }, { name: 'heartbeat', product_ids: [symbol] }],
  }));

  ws.onmessage = (message) => {
    onActivity?.(); // any message at all shows that the connection is alive (heartbeats come every second)
    if (closedByUs || gaveUp) return;
    const msg = asObject(message.data);
    if (msg?.type === 'error') return void onError?.(msg.message || msg.reason || 'error');
    const trade = parseMatch(msg, { symbol });
    if (trade) return accept(trade);
    const beat = parseHeartbeat(msg, { symbol });
    if (beat) heartbeat(beat);
  };

  ws.onclose = () => { if (!closedByUs) onClose?.(); };
  return {
    close() {
      closedByUs = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      ws.close();
    },
  };
}
