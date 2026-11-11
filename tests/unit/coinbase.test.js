import { describe, it, expect } from 'vitest';
import { COINBASE_GRANULARITY, MAX_CANDLES, MAX_TRADES, parseCandleRow, fetchHistory, parseMatch, parseHeartbeat, fetchTrades, openStream } from '../../src/coinbase.js';
import { INTERVAL_SECONDS } from '../../src/live.js';
import { PROVIDERS } from '../../src/providers.js';
import { validateCandle } from '../../src/sanitize.js';
import { mulberry32 } from '../../src/generator.js';

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
// [time, low, high, open, close, volume], newest first, like the real API
const ROWS = [[1200, 9, 12, 10, 11, 5], [1140, 8, 11, 9, 10, 4], [1080, 7, 10, 8, 9, 3]];

describe('timeframes', () => {
  it('match the page timeframes and the Binance lengths in seconds', () => {
    expect(COINBASE_GRANULARITY).toEqual(INTERVAL_SECONDS);
  });
  it('only granularities Coinbase accepts are used', () => {
    for (const g of Object.values(COINBASE_GRANULARITY)) expect([60, 300, 900, 3600, 21600, 86400]).toContain(g);
    expect(MAX_CANDLES).toBe(300);
  });
});

describe('parseCandleRow', () => {
  it('maps [time, low, high, open, close, volume] to a candle', () => {
    expect(parseCandleRow([1700000000, '70', '75', '71', '74', '1.5'])).toEqual({ time: 1700000000, open: 71, high: 75, low: 70, close: 74, volume: 1.5 });
  });
  it.each([[null], [undefined], [[]], [[1, 2, 3]], ['x'], [{}]])('rejects %j', (row) => {
    expect(parseCandleRow(row)).toBeNull();
  });
});

describe('fetchHistory', () => {
  it('asks for the product and granularity, and returns candles oldest first', async () => {
    let url;
    const candles = await fetchHistory({ symbol: 'BTC-USD', interval: '1m', fetchFn: async (u) => { url = u; return ok(ROWS); } });
    expect(url).toBe('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60');
    expect(candles.map((c) => c.time)).toEqual([1080, 1140, 1200]);
    expect(candles[2]).toEqual({ time: 1200, open: 10, high: 12, low: 9, close: 11, volume: 5 });
  });
  it.each([['1m', 60], ['5m', 300], ['15m', 900], ['1h', 3600], ['1d', 86400]])('timeframe %s is granularity %i', async (interval, g) => {
    let url;
    await fetchHistory({ symbol: 'ETH-USD', interval, fetchFn: async (u) => { url = u; return ok([]); } });
    expect(url).toContain(`granularity=${g}`);
    expect(url).toContain('/products/ETH-USD/');
  });
  it('keeps only the newest `limit` candles', async () => {
    const candles = await fetchHistory({ symbol: 'BTC-USD', interval: '1m', limit: 2, fetchFn: async () => ok(ROWS) });
    expect(candles.map((c) => c.time)).toEqual([1140, 1200]);
  });
  it('never returns more than Coinbase allows, whatever limit is asked', async () => {
    const many = Array.from({ length: 400 }, (_, i) => [60 * (400 - i), 1, 2, 1, 2, 1]);
    expect(await fetchHistory({ symbol: 'BTC-USD', interval: '1m', limit: 500, fetchFn: async () => ok(many) })).toHaveLength(300);
  });
  it('drops broken rows; an empty answer is fine', async () => {
    const partial = await fetchHistory({ symbol: 'X', interval: '1m', fetchFn: async () => ok([ROWS[0], null, 'x', [1]]) });
    expect(partial).toHaveLength(1);
    expect(partial.invalidCount).toBe(3);
    expect(await fetchHistory({ symbol: 'X', interval: '1m', fetchFn: async () => ok([]) })).toEqual([]);
  });
  describe('the limit contract', () => {
    const rows = Array.from({ length: 5 }, (_, i) => [60 * (5 - i), 1, 2, 1, 2, 1]); // newest first: times 300, 240, ..., 60
    const run = (limit, fetchFn = async () => ok(rows)) => fetchHistory({ symbol: 'X', interval: '1m', limit, fetchFn });
    it('zero gives an empty list and makes no request', async () => {
      let called = false;
      expect(await run(0, async () => { called = true; return ok(rows); })).toEqual([]);
      expect(called).toBe(false);
    });
    it.each([1, 2, 3, 5])('%i gives exactly the newest %i candles', async (limit) => {
      const got = await run(limit);
      expect(got).toHaveLength(limit);
      expect(got.map((c) => c.time)).toEqual([60, 120, 180, 240, 300].slice(5 - limit));
    });
    it('more than there are is everything; more than Coinbase allows is cut to 300', async () => {
      expect(await run(100)).toHaveLength(5);
      const many = Array.from({ length: 400 }, (_, i) => [60 * (400 - i), 1, 2, 1, 2, 1]);
      expect(await run(10000, async () => ok(many))).toHaveLength(300);
      expect(await run(301, async () => ok(many))).toHaveLength(300);
      expect(await run(300, async () => ok(many))).toHaveLength(300);
    });
    it.each([[-1], [-10], [NaN], [1.5], [0.5], [Infinity], [-Infinity], ['5'], [null], [{}], [[]], [true]])('rejects %j before any request', async (limit) => {
      let called = false;
      await expect(run(limit, async () => { called = true; return ok(rows); })).rejects.toThrow(RangeError);
      expect(called).toBe(false);
    });
    it('no limit means the default (300)', async () => {
      expect(await fetchHistory({ symbol: 'X', interval: '1m', fetchFn: async () => ok(rows) })).toHaveLength(5);
    });
    it('an empty answer with a positive limit is an empty list, not an error', async () => {
      expect(await run(3, async () => ok([]))).toEqual([]);
    });
  });
  it('unsupported timeframe is rejected before any request', async () => {
    let called = false;
    await expect(fetchHistory({ symbol: 'X', interval: '4h', fetchFn: async () => { called = true; } })).rejects.toThrow('no 4h timeframe');
    expect(called).toBe(false);
  });
  it('HTTP error, error object, unexpected body, network failure', async () => {
    await expect(fetchHistory({ symbol: 'X', interval: '1m', fetchFn: async () => ({ ok: false, status: 429 }) })).rejects.toThrow('HTTP 429');
    await expect(fetchHistory({ symbol: 'X', interval: '1m', fetchFn: async () => ok({ message: 'NotFound' }) })).rejects.toThrow('NotFound');
    await expect(fetchHistory({ symbol: 'X', interval: '1m', fetchFn: async () => ok(null) })).rejects.toThrow('unexpected response');
    await expect(fetchHistory({ symbol: 'X', interval: '1m', fetchFn: async () => { throw new TypeError('Failed to fetch'); } })).rejects.toThrow('Failed to fetch');
  });
});

describe('parseMatch', () => {
  const msg = (over = {}) => ({ type: 'match', product_id: 'BTC-USD', trade_id: 1001, price: '73068.94', size: '0.25', time: '2026-11-10T16:34:51.123456Z', side: 'buy', sequence: 7, ...over });
  const ctx = { symbol: 'BTC-USD' };
  it('parses id, price, size and time (seconds)', () => {
    expect(parseMatch(JSON.stringify(msg()), ctx)).toEqual({ tradeId: 1001, price: 73068.94, size: 0.25, time: Date.parse('2026-11-10T16:34:51.123Z') / 1000, last: false });
  });
  it('the first message after subscribing is a last_match', () => {
    expect(parseMatch(msg({ type: 'last_match' }), ctx).last).toBe(true);
  });
  it('ids, prices and sizes may be numbers or numeric strings', () => {
    expect(parseMatch(msg({ trade_id: '1001', price: 73068.94, size: 0.25 }), ctx)).toMatchObject({ tradeId: 1001, price: 73068.94, size: 0.25 });
  });
  it('zero and negative trade sizes are rejected', () => {
    expect(parseMatch(msg({ size: '0' }), ctx)).toBeNull();
    expect(parseMatch(msg({ size: '-1' }), ctx)).toBeNull();
  });
  it.each([
    ['invalid JSON', '{nope'], ['empty string', ''], ['null', 'null'], ['a ticker', msg({ type: 'ticker' })], ['a heartbeat', { type: 'heartbeat', product_id: 'BTC-USD' }],
    ['other product', msg({ product_id: 'ETH-USD' })], ['broken price', msg({ price: 'x' })], ['zero price', msg({ price: '0' })], ['negative price', msg({ price: '-5' })],
    ['missing price', msg({ price: undefined })], ['broken size', msg({ size: 'abc' })], ['broken time', msg({ time: 'yesterday' })], ['missing time', msg({ time: undefined })],
    ['missing trade id', msg({ trade_id: undefined })], ['fractional trade id', msg({ trade_id: 1.5 })], ['negative trade id', msg({ trade_id: -1 })],
    ['text trade id', msg({ trade_id: 'abc' })], ['null trade id', msg({ trade_id: null })], ['empty trade id', msg({ trade_id: '' })],
    ['null size', msg({ size: null })], ['empty size', msg({ size: '' })], ['null price', msg({ price: null })], ['numeric time', msg({ time: 1700000000 })],
    ['date without time', msg({ time: '2026-11-10' })], ['timestamp without timezone', msg({ time: '2026-11-10T16:34:51' })],
    ['invalid calendar date', msg({ time: '2026-02-30T16:34:51Z' })], ['invalid clock time', msg({ time: '2026-11-10T25:34:51Z' })],
  ])('ignores %s', (_, data) => {
    expect(parseMatch(data, ctx)).toBeNull();
  });
});

describe('parseHeartbeat', () => {
  const beat = (over = {}) => ({ type: 'heartbeat', sequence: 90, last_trade_id: 20, product_id: 'BTC-USD', time: '2026-11-10T16:34:51Z', ...over });
  it('gives the last trade id', () => {
    expect(parseHeartbeat(JSON.stringify(beat()), { symbol: 'BTC-USD' })).toEqual({ lastTradeId: 20 });
  });
  it.each([['other product', beat({ product_id: 'ETH-USD' })], ['not a heartbeat', beat({ type: 'match' })], ['missing id', beat({ last_trade_id: undefined })],
    ['fractional id', beat({ last_trade_id: 2.5 })], ['negative id', beat({ last_trade_id: -3 })], ['text id', beat({ last_trade_id: 'x' })], ['null id', beat({ last_trade_id: null })], ['garbage', '{nope']])('ignores %s', (_, data) => {
    expect(parseHeartbeat(data, { symbol: 'BTC-USD' })).toBeNull();
  });
});

describe('fetchTrades', () => {
  const rows = [{ time: '2026-11-10T16:34:03Z', trade_id: 12, price: '101', size: '0.5', side: 'sell' }, { time: '2026-11-10T16:34:02Z', trade_id: 11, price: '100', size: '1', side: 'buy' }];
  it('asks for the latest 1000 trades and returns them oldest first', async () => {
    let url;
    const trades = await fetchTrades({ symbol: 'BTC-USD', fetchFn: async (u) => { url = u; return ok(rows); } });
    expect(url).toBe('https://api.exchange.coinbase.com/products/BTC-USD/trades?limit=1000');
    expect(trades.map((t) => t.tradeId)).toEqual([11, 12]);
    expect(trades[0]).toMatchObject({ price: 100, size: 1 });
  });
  it('paginates a recovery range larger than one page without response headers', async () => {
    const all = Array.from({ length: 1011 }, (_, i) => ({
      trade_id: i + 1, time: '2026-11-10T16:34:03Z', price: '101', size: '0.5',
    }));
    const urls = [];
    const trades = await fetchTrades({
      symbol: 'BTC-USD', afterTradeId: 10, throughTradeId: 1011,
      fetchFn: async (url) => {
        urls.push(url);
        const parsed = new URL(url);
        const before = parsed.searchParams.get('before');
        const after = parsed.searchParams.get('after');
        const page = all.filter((t) => before !== null ? t.trade_id > Number(before)
          : after !== null ? t.trade_id < Number(after) : true)
          .sort((a, b) => b.trade_id - a.trade_id).slice(0, MAX_TRADES);
        return ok(page);
      },
    });
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('before=10');
    expect(urls[1]).toContain('after=12');
    expect(trades).toHaveLength(1001);
    expect(trades[0].tradeId).toBe(11);
    expect(trades.at(-1).tradeId).toBe(1011);
  });
  it('stops at the requested upper trade ID even if the page contains newer trades', async () => {
    const all = Array.from({ length: 20 }, (_, i) => ({
      trade_id: i + 1, time: '2026-11-10T16:34:03Z', price: '101', size: '0.5',
    }));
    const trades = await fetchTrades({
      symbol: 'BTC-USD', afterTradeId: 10, throughTradeId: 12,
      fetchFn: async () => ok(all.sort((a, b) => b.trade_id - a.trade_id)),
    });
    expect(trades.map((trade) => trade.tradeId)).toEqual([11, 12]);
  });
  it('fails closed when the configured pagination bound is exhausted', async () => {
    const all = Array.from({ length: 3000 }, (_, i) => ({
      trade_id: i + 1, time: '2026-11-10T16:34:03Z', price: '101', size: '0.5',
    }));
    await expect(fetchTrades({
      symbol: 'BTC-USD', afterTradeId: 1, throughTradeId: 3000, maxPages: 2,
      fetchFn: async (url) => {
        const parsed = new URL(url);
        const before = parsed.searchParams.get('before');
        const after = parsed.searchParams.get('after');
        const page = all.filter((t) => before !== null ? t.trade_id > Number(before)
          : after !== null ? t.trade_id < Number(after) : true)
          .sort((a, b) => b.trade_id - a.trade_id).slice(0, MAX_TRADES);
        return ok(page);
      },
    })).rejects.toThrow('trade recovery exceeds 2000 REST records');
  });
  it('drops broken rows; errors are reported', async () => {
    expect(await fetchTrades({ symbol: 'X', fetchFn: async () => ok([rows[0], null, { trade_id: 'x' }, {}, { ...rows[0], trade_id: 13, size: '0' }]) })).toHaveLength(1);
    await expect(fetchTrades({ symbol: 'X', fetchFn: async () => ({ ok: false, status: 503 }) })).rejects.toThrow('HTTP 503');
    await expect(fetchTrades({ symbol: 'X', fetchFn: async () => ok({ message: 'Rate limit' }) })).rejects.toThrow('Rate limit');
  });
});

// --- the stream ------------------------------------------------------------
class FakeWS {
  static last;
  constructor(url) { this.url = url; this.sent = []; this.closed = false; FakeWS.last = this; }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.closed = true; }
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 3)); };
const BASE = Date.UTC(2026, 10, 10, 16, 34, 0) / 1000; // start of a minute
const at = (seconds) => new Date((BASE + seconds) * 1000).toISOString();
const match = (id, seconds, price, size = 1, type = 'match') => ({ data: JSON.stringify({ type, product_id: 'BTC-USD', trade_id: id, price: String(price), size: String(size), time: at(seconds) }) });
const lastMatch = (id, seconds = 0, price = 100) => match(id, seconds, price, 1, 'last_match');
const heartbeat = (lastTradeId) => ({ data: JSON.stringify({ type: 'heartbeat', product_id: 'BTC-USD', sequence: 1, last_trade_id: lastTradeId, time: at(0) }) });

/** `trades` is what REST knows (any order); `candles` what the REST candle endpoint returns. */
function setup({ trades = [], candles = [], ...opts } = {}) {
  const out = { candles: [], events: [], corrections: [], resyncs: [], urls: [] };
  const fetchFn = async (url) => {
    out.urls.push(url);
    if (opts.failRest) throw new TypeError('Failed to fetch');
    if (url.includes('/trades')) {
      const parsed = new URL(url);
      const before = parsed.searchParams.get('before');
      const after = parsed.searchParams.get('after');
      const limit = Number(parsed.searchParams.get('limit') || MAX_TRADES);
      const page = out.trades.filter((trade) => before !== null ? trade.trade_id > Number(before)
        : after !== null ? trade.trade_id < Number(after) : true)
        .sort((a, b) => b.trade_id - a.trade_id).slice(0, limit);
      return ok(page);
    }
    return ok(out.restCandles);
  };
  out.trades = trades.map(([id, seconds, price, size = 1]) => ({ trade_id: id, time: at(seconds), price: String(price), size: String(size), side: 'buy' }));
  out.restCandles = candles;
  const conn = openStream({
    symbol: 'BTC-USD', interval: '1m', WS: FakeWS, fetchFn, graceMs: 0, reconcileDelayMs: null, applyLastMatchWhenUnseeded: false,
    onKline: ({ candle, correction }) => (correction ? out.corrections : out.candles).push(candle),
    onEvent: (e) => out.events.push(e),
    onResync: (reason) => out.resyncs.push(reason),
    ...opts,
  });
  out.ws = FakeWS.last;
  out.conn = conn;
  out.send = (m) => out.ws.onmessage(m);
  return out;
}
const bucketAt = (s) => BASE + Math.floor(s / 60) * 60;
const restUrls = (t) => t.urls.filter((u) => u.includes('/trades'));

describe('stream: subscription and baseline', () => {
  it('connects to the public feed and subscribes to matches and heartbeat only when open', () => {
    const t = setup();
    expect(t.ws.url).toBe('wss://ws-feed.exchange.coinbase.com');
    expect(t.ws.sent).toEqual([]);
    t.ws.onopen();
    expect(t.ws.sent).toEqual([{ type: 'subscribe', channels: [{ name: 'matches', product_ids: ['BTC-USD'] }, { name: 'heartbeat', product_ids: ['BTC-USD'] }] }]);
  });
  it('the last_match only sets the baseline: it creates no candle and adds no volume', () => {
    const t = setup({ seed: { time: BASE, open: 90, high: 120, low: 80, close: 100, volume: 10 } });
    t.send(lastMatch(500, 5, 100));
    expect(t.candles).toEqual([]);
    t.send(match(501, 10, 101, 2));
    expect(t.candles[0]).toEqual({ time: BASE, open: 90, high: 120, low: 80, close: 101, volume: 12 });
  });
  it('applies last_match when there is no REST seed', () => {
    const t = setup({ applyLastMatchWhenUnseeded: true });
    t.send(lastMatch(7, 5, 100));
    expect(t.candles).toEqual([{ time: BASE, open: 100, high: 100, low: 100, close: 100, volume: 1 }]);
    t.send(match(8, 10, 101, 2));
    expect(t.candles.at(-1)).toEqual({ time: BASE, open: 100, high: 101, low: 100, close: 101, volume: 3 });
  });
  it('applies last_match when it starts a bucket newer than the REST seed', () => {
    const t = setup({ seed: { time: BASE, open: 90, high: 100, low: 80, close: 95, volume: 10 } });
    t.send(lastMatch(500, 65, 110));
    expect(t.candles.at(-1)).toEqual({ time: BASE + 60, open: 110, high: 110, low: 110, close: 110, volume: 1 });
  });
  it('without a last_match the first trade fixes the baseline and is applied', () => {
    const t = setup();
    t.send(match(7, 5, 100, 2));
    expect(t.candles).toEqual([{ time: BASE, open: 100, high: 100, low: 100, close: 100, volume: 2 }]);
  });
});

describe('stream: building candles from trades', () => {
  it('trades in the same minute move high, low, close and add volume', () => {
    const t = setup();
    t.send(lastMatch(0));
    [[1, 5, 100, 1], [2, 20, 105, 2], [3, 40, 98, 0.5], [4, 59, 101, 1]].forEach(([id, s, p, z]) => t.send(match(id, s, p, z)));
    expect(t.candles.at(-1)).toEqual({ time: BASE, open: 100, high: 105, low: 98, close: 101, volume: 4.5 });
    expect(t.candles).toHaveLength(4);
  });
  it('a trade exactly at the next boundary starts a new candle', () => {
    const t = setup();
    t.send(lastMatch(0));
    t.send(match(1, 59, 100));
    t.send(match(2, 60, 110));
    expect(t.candles.at(-1)).toMatchObject({ time: BASE + 60, open: 110, close: 110 });
    expect(t.candles[0].time).toBe(BASE);
  });
  it('a seed of an older minute is not continued', () => {
    const t = setup({ seed: { time: BASE - 60, open: 90, high: 120, low: 80, close: 100, volume: 10 } });
    t.send(lastMatch(0));
    t.send(match(1, 5, 150));
    expect(t.candles.at(-1)).toEqual({ time: BASE, open: 100, high: 150, low: 100, close: 150, volume: 2 });
  });
  it('a trade older than the candle under way is ignored (it belongs to a closed candle)', () => {
    const t = setup({ seed: { time: BASE + 60, open: 90, high: 120, low: 80, close: 100, volume: 10 } });
    t.send(lastMatch(0));
    t.send(match(1, 5, 999));
    expect(t.candles).toEqual([]);
  });
  it.each([['5m', 300], ['15m', 900], ['1h', 3600], ['1d', 86400]])('candles of %s start at multiples of %i s', (interval, g) => {
    const t = setup({ interval });
    t.send(lastMatch(0));
    t.send(match(1, 51, 100));
    expect(t.candles[0].time % g).toBe(0);
    expect(BASE + 51 - t.candles[0].time).toBeLessThan(g);
  });
  it('the day candle starts at midnight UTC', () => {
    const t = setup({ interval: '1d' });
    t.send({ data: JSON.stringify({ type: 'last_match', product_id: 'BTC-USD', trade_id: 0, price: '1', size: '1', time: '2026-11-10T23:59:00Z' }) });
    t.send({ data: JSON.stringify({ type: 'match', product_id: 'BTC-USD', trade_id: 1, price: '100', size: '1', time: '2026-11-10T23:59:59Z' }) });
    expect(t.candles[0].time).toBe(Date.UTC(2026, 10, 10) / 1000);
  });
  it('ignores garbage, other products, tickers and bad trades without emitting or changing anything', () => {
    const t = setup();
    t.send(lastMatch(0));
    for (const data of ['{nope', JSON.stringify({ type: 'subscriptions', channels: [] }), JSON.stringify({ type: 'ticker', product_id: 'BTC-USD', price: '1', time: at(1) }),
      JSON.stringify({ type: 'match', product_id: 'ETH-USD', trade_id: 1, price: '1', size: '1', time: at(1) }),
      JSON.stringify({ type: 'match', product_id: 'BTC-USD', trade_id: 1, price: 'x', size: '1', time: at(1) }),
      JSON.stringify({ type: 'match', product_id: 'BTC-USD', trade_id: 'x', price: '1', size: '1', time: at(1) })]) t.send({ data });
    expect(t.candles).toEqual([]);
    t.send(match(1, 2, 100)); // the next valid id is still 1
    expect(t.candles).toHaveLength(1);
  });
  it('the emitted candle is a copy: changing it does not corrupt the next one', () => {
    const t = setup();
    t.send(lastMatch(0));
    t.send(match(1, 1, 100));
    t.candles[0].high = 1e9;
    t.send(match(2, 2, 101));
    expect(t.candles[1].high).toBe(101);
  });
});

describe('stream: duplicated and reordered messages', () => {
  it('a repeated message is ignored: no double volume, and it is reported', () => {
    const t = setup();
    t.send(lastMatch(0));
    t.send(match(1, 1, 100, 2));
    t.send(match(1, 1, 100, 2));
    t.send(match(2, 2, 101, 3));
    t.send(match(2, 2, 101, 3));
    t.send(match(1, 1, 100, 2)); // an old one again
    expect(t.candles.at(-1).volume).toBe(5);
    expect(t.candles).toHaveLength(2);
    expect(t.events.filter((e) => e.type === 'duplicate').map((e) => e.tradeId)).toEqual([1, 2, 1]);
  });
  it('a trade that was delivered early and then again is counted once', async () => {
    const t = setup({ graceMs: 20 });
    t.send(lastMatch(0));
    t.send(match(3, 3, 103, 1));
    t.send(match(3, 3, 103, 1));
    t.send(match(1, 1, 101, 1));
    t.send(match(2, 2, 102, 1));
    await new Promise((r) => setTimeout(r, 40));
    expect(t.candles.at(-1).volume).toBe(3);
    expect(t.events.filter((e) => e.type === 'duplicate')).toHaveLength(1);
  });
  it('reordered messages are put in order without asking REST', async () => {
    const t = setup({ graceMs: 30 });
    t.send(lastMatch(0));
    t.send(match(1, 1, 100, 1));
    t.send(match(3, 3, 90, 1));   // arrives before 2
    expect(t.candles).toHaveLength(1);
    t.send(match(2, 2, 110, 1));
    await new Promise((r) => setTimeout(r, 60));
    expect(t.candles.at(-1)).toEqual({ time: BASE, open: 100, high: 110, low: 90, close: 90, volume: 3 });
    expect(restUrls(t)).toEqual([]);
    expect(t.events.filter((e) => e.type === 'recovered')).toEqual([]);
  });
  it('several trades reversed in a row also come out in order', async () => {
    const t = setup({ graceMs: 30 });
    t.send(lastMatch(0));
    [5, 4, 3, 2, 1].forEach((id) => t.send(match(id, id, 100 + id, 1)));
    await new Promise((r) => setTimeout(r, 60));
    expect(t.candles.at(-1)).toEqual({ time: BASE, open: 101, high: 105, low: 101, close: 105, volume: 5 });
    expect(restUrls(t)).toEqual([]);
  });
});

describe('stream: lost trades are fetched from REST', () => {
  it('a trade lost inside the candle: its volume, its extreme and the last price are all there afterwards', async () => {
    const t = setup({ trades: [[3, 3, 150, 4], [2, 2, 101, 1], [1, 1, 100, 1]] }); // trade 3 set a new high
    t.send(lastMatch(0));
    t.send(match(1, 1, 100, 1));
    t.send(match(2, 2, 101, 1));
    t.send(match(4, 4, 102, 2)); // 3 was lost
    await flush();
    expect(t.candles.at(-1)).toEqual({ time: BASE, open: 100, high: 150, low: 100, close: 102, volume: 8 });
    expect(restUrls(t)).toEqual(['https://api.exchange.coinbase.com/products/BTC-USD/trades?limit=1000&before=2']);
    expect(t.events).toContainEqual({ type: 'recovered', count: 1, upTo: 4 });
    expect(t.resyncs).toEqual([]);
  });
  it('the lost trade was the last one of the candle: it becomes the close', async () => {
    const t = setup({ trades: [[3, 55, 95, 2]] });
    t.send(lastMatch(0));
    t.send(match(1, 1, 100, 1));
    t.send(match(2, 2, 101, 1));
    t.send(match(4, 61, 120, 1)); // the next candle starts with 4; 3 (at second 55) is missing
    await flush();
    const first = t.candles.filter((c) => c.time === BASE).at(-1);
    expect(first).toEqual({ time: BASE, open: 100, high: 101, low: 95, close: 95, volume: 4 });
    expect(t.candles.at(-1)).toMatchObject({ time: BASE + 60, open: 120 });
    expect(t.candles.map((c) => c.time)).toEqual([BASE, BASE, BASE, BASE + 60]); // 1, 2, recovered 3, then 4: in order
  });
  it('recovers a gap spanning more than one REST page', async () => {
    const trades = Array.from({ length: 1001 }, (_, i) => [i + 2, 2 + i / 1000, 100 + i / 1000, 0.01]);
    const t = setup({ trades });
    t.send(lastMatch(1));
    t.send(match(1003, 4, 105, 1));
    await flush();
    expect(t.resyncs).toEqual([]);
    expect(t.candles.at(-1).volume).toBeCloseTo(11.01, 8);
    expect(t.events).toContainEqual({ type: 'recovered', count: 1001, upTo: 1003 });
    expect(restUrls(t)).toHaveLength(2);
    expect(restUrls(t)[0]).toContain('before=1');
    expect(restUrls(t)[1]).toContain('after=3');
  });
  it('several lost trades in a row', async () => {
    const t = setup({ trades: [[2, 2, 101, 1], [3, 3, 102, 1], [4, 4, 103, 1]] });
    t.send(lastMatch(0));
    t.send(match(1, 1, 100, 1));
    t.send(match(5, 5, 104, 1));
    await flush();
    expect(t.candles.at(-1)).toEqual({ time: BASE, open: 100, high: 104, low: 100, close: 104, volume: 5 });
    expect(t.events).toContainEqual({ type: 'recovered', count: 3, upTo: 5 });
  });
  it('the tail of the feed was lost: two heartbeats with a newer last_trade_id reveal it', async () => {
    const t = setup({ trades: [[3, 30, 99, 2], [2, 20, 101, 1], [1, 1, 100, 1]] });
    t.send(lastMatch(0));
    t.send(match(1, 1, 100, 1));
    t.send(match(2, 20, 101, 1));
    t.send(heartbeat(3));
    await flush();
    expect(restUrls(t)).toEqual([]); // one heartbeat can be ahead of the match messages: wait for the second
    t.send(heartbeat(3));
    await flush();
    expect(t.candles.at(-1)).toEqual({ time: BASE, open: 100, high: 101, low: 99, close: 99, volume: 4 });
    expect(t.events).toContainEqual({ type: 'recovered', count: 1, upTo: 3 });
  });
  it('does not discard a newer heartbeat watermark received while REST recovery is in flight', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const fetchFn = async (url) => {
      if (!url.includes('/trades')) return ok([]);
      calls++;
      if (calls === 1) await gate;
      const ids = calls === 1 ? [4, 3, 2] : [5];
      return ok(ids.map((id) => ({ trade_id: id, time: at(id), price: String(100 + id), size: '1', side: 'buy' })));
    };
    const t = setup({ fetchFn, graceMs: 0 });
    t.send(lastMatch(0));
    t.send(match(1, 1, 101, 1));
    t.send(match(4, 4, 104, 1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    t.send(heartbeat(5));
    t.send(heartbeat(5));
    release();
    await flush();
    await flush();
    expect(calls).toBe(2);
    expect(t.resyncs).toEqual([]);
    expect(t.events.filter((e) => e.type === 'recovered').map((e) => e.upTo)).toEqual([4, 5]);
    expect(t.candles.at(-1).close).toBe(105);
  });
  it('a heartbeat that is not ahead resets the count; a heartbeat ahead that is then caught up with never fetches', async () => {
    const t = setup({ trades: [[3, 3, 99, 1]] });
    t.send(lastMatch(0));
    t.send(match(1, 1, 100, 1));
    t.send(match(2, 2, 101, 1));
    t.send(heartbeat(3));
    t.send(match(3, 3, 99, 1));   // the message was merely late
    t.send(heartbeat(3));
    t.send(heartbeat(3));
    await flush();
    expect(restUrls(t)).toEqual([]);
    expect(t.candles.at(-1).volume).toBe(3);
  });
  it('heartbeats of other products or without an id are ignored', async () => {
    const t = setup({ trades: [[2, 2, 99, 1]] });
    t.send(lastMatch(0));
    t.send(match(1, 1, 100, 1));
    for (const data of [JSON.stringify({ type: 'heartbeat', product_id: 'ETH-USD', last_trade_id: 9 }), JSON.stringify({ type: 'heartbeat', product_id: 'BTC-USD' })]) {
      t.send({ data });
      t.send({ data });
    }
    await flush();
    expect(restUrls(t)).toEqual([]);
  });
  it('a gap that spans a minute boundary: the recovered trades go into the right candles in order', async () => {
    const t = setup({ trades: [[2, 40, 105, 1], [3, 59, 95, 1], [4, 61, 110, 1]] });
    t.send(lastMatch(0));
    t.send(match(1, 10, 100, 1));
    t.send(match(5, 70, 111, 1)); // 2, 3 (minute 1) and 4 (minute 2) are missing
    await flush();
    const byMinute = (m) => t.candles.filter((c) => c.time === BASE + m * 60).at(-1);
    expect(byMinute(0)).toEqual({ time: BASE, open: 100, high: 105, low: 95, close: 95, volume: 3 });
    expect(byMinute(1)).toEqual({ time: BASE + 60, open: 110, high: 111, low: 110, close: 111, volume: 2 });
    expect(t.candles.map((c) => c.time)).toEqual([...Array(3).fill(BASE), BASE + 60, BASE + 60]);
  });
  it('trades that arrive while REST is being asked are held back and applied afterwards, in order', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = setup({
      fetchFn: async () => {
        await gate;
        return ok([{ trade_id: 3, time: at(3), price: '102', size: '1' }, { trade_id: 2, time: at(2), price: '101', size: '1' }]);
      },
    });
    slow.send(lastMatch(0));
    slow.send(match(1, 1, 100, 1));
    slow.send(match(4, 4, 103, 1));
    await new Promise((r) => setTimeout(r, 10)); // the fetch is now waiting
    slow.send(match(5, 5, 104, 1));              // these arrive during the fetch
    slow.send(match(6, 6, 105, 1));
    release();
    await flush();
    expect(slow.candles.at(-1)).toEqual({ time: BASE, open: 100, high: 105, low: 100, close: 105, volume: 6 });
    expect(slow.candles.map((c) => c.close)).toEqual([100, 101, 102, 103, 104, 105]);
    expect(slow.resyncs).toEqual([]);
  });
  it('a second loss after a recovery is recovered too', async () => {
    const t = setup({ trades: [[2, 2, 101, 1], [4, 4, 103, 1]] });
    t.send(lastMatch(0));
    t.send(match(1, 1, 100, 1));
    t.send(match(3, 3, 102, 1));
    await flush();
    t.send(match(5, 5, 104, 1));
    await flush();
    expect(t.candles.at(-1)).toEqual({ time: BASE, open: 100, high: 104, low: 100, close: 104, volume: 5 });
    expect(t.events.filter((e) => e.type === 'recovered').map((e) => e.count)).toEqual([1, 1]);
  });
  it('a held-back trade is used instead of fetching it again', async () => {
    const t = setup({ trades: [[2, 2, 101, 1]] });
    t.send(lastMatch(0));
    t.send(match(1, 1, 100, 1));
    t.send(match(4, 4, 103, 1)); // held back
    t.send(match(3, 3, 102, 1)); // also held back (2 is still missing)
    await flush();
    expect(t.candles.at(-1).volume).toBe(4);
    expect(t.events).toContainEqual({ type: 'recovered', count: 1, upTo: 4 });
  });
  it('nothing is fetched while the feed is in order', async () => {
    const t = setup();
    t.send(lastMatch(0));
    for (let i = 1; i <= 50; i++) t.send(match(i, i, 100 + i, 1));
    await flush();
    expect(t.urls).toEqual([]);
    expect(t.candles.at(-1).volume).toBe(50);
  });
});

describe('stream: when the missing trades cannot be fetched', () => {
  it('trades that REST does not have any more: a resync is requested and the feed stops', async () => {
    const t = setup({ trades: [[1, 1, 100, 1]] }); // 2 and 3 are not known to REST
    t.send(lastMatch(0));
    t.send(match(1, 1, 100, 1));
    t.send(match(4, 4, 103, 1));
    await flush();
    expect(t.resyncs).toEqual(['trade 2 is not available any more']);
    t.send(match(5, 5, 104, 1)); // nothing more is applied after giving up
    await flush();
    expect(t.candles.at(-1).close).toBe(100);
    expect(t.resyncs).toHaveLength(1);
  });
  it('a failing REST request also requests a resync', async () => {
    const t = setup({ failRest: true });
    t.send(lastMatch(0));
    t.send(match(1, 1, 100, 1));
    t.send(match(3, 3, 102, 1));
    await flush();
    expect(t.resyncs).toEqual(['Failed to fetch']);
  });
  it('after close() nothing more happens: no fetch result is applied, no resync, no events', async () => {
    const t = setup({ trades: [[2, 2, 101, 1]], graceMs: 20 });
    t.send(lastMatch(0));
    t.send(match(1, 1, 100, 1));
    t.send(match(3, 3, 102, 1));
    t.conn.close();
    await new Promise((r) => setTimeout(r, 60));
    expect(t.urls).toEqual([]);
    expect(t.candles).toHaveLength(1);
    expect(t.resyncs).toEqual([]);
    expect(t.ws.closed).toBe(true);
  });
});

describe('stream: the exchange corrects a closed candle', () => {
  // what the exchange says the minute BASE really was: it had one more trade than the stream delivered
  const closedByExchange = () => [[BASE + 60, 110, 110, 110, 110, 1], [BASE, 95, 130, 100, 98, 7.5]];
  it('a closed candle that differs from the exchange\'s version is corrected', async () => {
    const t = setup({ reconcileDelayMs: 5, candles: closedByExchange() });
    t.send(lastMatch(0));
    t.send(match(1, 10, 100, 1));
    t.send(match(2, 20, 120, 1));
    t.send(match(3, 61, 110, 1)); // minute 0 closes with volume 2 in our version
    await new Promise((r) => setTimeout(r, 40));
    expect(t.corrections).toEqual([{ time: BASE, open: 100, high: 130, low: 95, close: 98, volume: 7.5 }]);
    expect(t.urls.some((u) => u.includes('/candles?granularity=60'))).toBe(true);
  });
  it('an identical version causes no correction', async () => {
    const t = setup({ reconcileDelayMs: 5, candles: [[BASE, 100, 120, 100, 120, 2]] });
    t.send(lastMatch(0));
    t.send(match(1, 10, 100, 1));
    t.send(match(2, 20, 120, 1));
    t.send(match(3, 61, 110, 1));
    await new Promise((r) => setTimeout(r, 40));
    expect(t.corrections).toEqual([]);
  });
  it('the seed candle, which may have been incomplete, is checked when it closes', async () => {
    const t = setup({ reconcileDelayMs: 5, seed: { time: BASE, open: 100, high: 101, low: 99, close: 100, volume: 1 }, candles: [[BASE, 99, 150, 100, 140, 30]] });
    t.send(lastMatch(0));
    t.send(match(1, 61, 110, 1));
    await new Promise((r) => setTimeout(r, 40));
    expect(t.corrections).toEqual([{ time: BASE, open: 100, high: 150, low: 99, close: 140, volume: 30 }]);
  });
  it('a failing check or a missing candle changes nothing', async () => {
    const a = setup({ reconcileDelayMs: 5, failRest: true });
    a.send(lastMatch(0));
    a.send(match(1, 10, 100, 1));
    a.send(match(2, 61, 110, 1));
    const b = setup({ reconcileDelayMs: 5, candles: [] });
    b.send(lastMatch(0));
    b.send(match(1, 10, 100, 1));
    b.send(match(2, 61, 110, 1));
    await new Promise((r) => setTimeout(r, 40));
    expect(a.corrections).toEqual([]);
    expect(b.corrections).toEqual([]);
    expect(a.resyncs).toEqual([]);
  });
  it('retries a failed reconciliation and applies the exchange candle when REST recovers', async () => {
    let attempts = 0;
    const fetchFn = async () => {
      attempts++;
      if (attempts === 1) throw new TypeError('temporary network failure');
      return ok([[BASE, 95, 130, 100, 98, 7.5]]);
    };
    const t = setup({ reconcileDelayMs: 1, reconcileRetryMs: 1, fetchFn });
    t.send(lastMatch(0));
    t.send(match(1, 10, 100, 1));
    t.send(match(2, 61, 110, 1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(attempts).toBe(2);
    expect(t.corrections).toEqual([{ time: BASE, open: 100, high: 130, low: 95, close: 98, volume: 7.5 }]);
    expect(t.events).toContainEqual(expect.objectContaining({ type: 'reconcile-retry', attempt: 1, reason: 'temporary network failure' }));
  });
  it('reports a reconciliation failure after bounded retries', async () => {
    let attempts = 0;
    const t = setup({
      reconcileDelayMs: 1, reconcileRetryMs: 1, reconcileAttempts: 2,
      fetchFn: async () => { attempts++; throw new TypeError('REST unavailable'); },
    });
    t.send(lastMatch(0));
    t.send(match(1, 10, 100, 1));
    t.send(match(2, 61, 110, 1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(attempts).toBe(2);
    expect(t.events).toContainEqual(expect.objectContaining({ type: 'reconcile-failed', attempts: 2, reason: 'REST unavailable' }));
    expect(t.resyncs).toEqual([]);
  });
  it('is off when reconcileDelayMs is null', async () => {
    const t = setup({ reconcileDelayMs: null, candles: [[BASE, 1, 2, 1, 2, 9]] });
    t.send(lastMatch(0));
    t.send(match(1, 10, 100, 1));
    t.send(match(2, 61, 110, 1));
    await new Promise((r) => setTimeout(r, 30));
    expect(t.urls).toEqual([]);
  });
});

describe('stream: whatever is lost, repeated or swapped, the result equals the ideal candles', () => {
  // The ideal result: candles built from the complete, ordered list of trades.
  const ideal = (all) => {
    const m = new Map();
    for (const [id, s, price, size] of all) {
      const bucket = bucketAt(s);
      const c = m.get(bucket);
      m.set(bucket, c ? { ...c, high: Math.max(c.high, price), low: Math.min(c.low, price), close: price, volume: c.volume + size }
        : { time: bucket, open: price, high: price, low: price, close: price, volume: size });
    }
    return m;
  };

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`random feed, seed ${seed}`, async () => {
      const rnd = mulberry32(seed);
      let price = 100;
      let s = 0;
      const all = Array.from({ length: 150 }, (_, i) => {
        s += rnd() * 4;
        price = Math.max(1, price + (rnd() - 0.5) * 8);
        return [i + 1, s, Math.round(price * 100) / 100, Math.round(rnd() * 300) / 100 + 0.01];
      });
      // the delivered feed: ~12% lost, ~10% repeated, some neighbours swapped
      let delivered = all.filter(() => rnd() > 0.12);
      delivered = delivered.flatMap((m) => (rnd() < 0.1 ? [m, m] : [m]));
      for (let i = 0; i < delivered.length - 1; i++) if (rnd() < 0.08) [delivered[i], delivered[i + 1]] = [delivered[i + 1], delivered[i]];
      const t = setup({ trades: all.map(([id, sec, p, z]) => [id, sec, p, z]), graceMs: 0 });
      t.send(lastMatch(0, 0));
      for (const [id, sec, p, z] of delivered) { t.send(match(id, sec, p, z)); if (rnd() < 0.3) await new Promise((r) => setTimeout(r, 1)); }
      const lastId = all.at(-1)[0];
      t.send(heartbeat(lastId));
      t.send(heartbeat(lastId));
      await flush();
      await flush();

      expect(t.resyncs).toEqual([]);
      const want = ideal(all);
      const got = new Map();
      for (const c of t.candles) got.set(c.time, c);
      expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
      for (const [time, c] of want) {
        const g = got.get(time);
        expect(g.open).toBe(c.open);
        expect(g.high).toBe(c.high);
        expect(g.low).toBe(c.low);
        expect(g.close).toBe(c.close);
        expect(g.volume).toBeCloseTo(c.volume, 8);
        expect(validateCandle(g)).toBeNull();
      }
    });
  }
});

describe('provider registry', () => {
  it('lists both exchanges with their own symbols and the two functions', () => {
    expect(Object.keys(PROVIDERS)).toEqual(['binance', 'coinbase']);
    expect(PROVIDERS.binance.symbols[0]).toBe('BTCUSDT');
    expect(PROVIDERS.coinbase.symbols[0]).toBe('BTC-USD');
    for (const p of Object.values(PROVIDERS)) {
      expect(typeof p.fetchHistory).toBe('function');
      expect(typeof p.openStream).toBe('function');
    }
  });
});
