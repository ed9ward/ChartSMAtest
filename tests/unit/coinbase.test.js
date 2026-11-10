import { describe, it, expect } from 'vitest';
import { COINBASE_GRANULARITY, MAX_CANDLES, parseCandleRow, fetchHistory, parseTicker, openStream } from '../../src/coinbase.js';
import { INTERVAL_SECONDS } from '../../src/live.js';
import { PROVIDERS } from '../../src/providers.js';

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
    const candles = await fetchHistory({ symbol: 'BTC-USD', interval: '5m', fetchFn: async (u) => { url = u; return ok(ROWS); } });
    expect(url).toBe('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=300');
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
  it('drops broken rows', async () => {
    const candles = await fetchHistory({ symbol: 'X', interval: '1m', fetchFn: async () => ok([ROWS[0], null, 'x', [1]]) });
    expect(candles).toHaveLength(1);
  });
  it('empty answer is fine', async () => {
    expect(await fetchHistory({ symbol: 'X', interval: '1m', fetchFn: async () => ok([]) })).toEqual([]);
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

describe('parseTicker', () => {
  const msg = (over = {}) => ({ type: 'ticker', product_id: 'BTC-USD', price: '73068.94', last_size: '0.25', time: '2026-11-10T16:34:51.123456Z', ...over });
  it('parses price, size and time (seconds)', () => {
    expect(parseTicker(JSON.stringify(msg()), { symbol: 'BTC-USD' })).toEqual({ price: 73068.94, size: 0.25, time: Date.parse('2026-11-10T16:34:51.123Z') / 1000 });
  });
  it('a missing or broken size counts as zero volume', () => {
    expect(parseTicker(msg({ last_size: undefined }), { symbol: 'BTC-USD' }).size).toBe(0);
    expect(parseTicker(msg({ last_size: 'abc' }), { symbol: 'BTC-USD' }).size).toBe(0);
    expect(parseTicker(msg({ last_size: '-1' }), { symbol: 'BTC-USD' }).size).toBe(0);
  });
  it.each([
    ['invalid JSON', '{nope'], ['empty string', ''], ['null', 'null'], ['heartbeat', { type: 'heartbeat', product_id: 'BTC-USD' }],
    ['subscriptions ack', { type: 'subscriptions', channels: [] }], ['other product', msg({ product_id: 'ETH-USD' })],
    ['broken price', msg({ price: 'x' })], ['zero price', msg({ price: '0' })], ['negative price', msg({ price: '-5' })],
    ['missing price', msg({ price: undefined })], ['broken time', msg({ time: 'yesterday' })], ['missing time', msg({ time: undefined })],
  ])('ignores %s', (_, data) => {
    expect(parseTicker(data, { symbol: 'BTC-USD' })).toBeNull();
  });
});

describe('openStream builds candles from trades', () => {
  class FakeWS {
    static last;
    constructor(url) { this.url = url; this.sent = []; this.closed = false; FakeWS.last = this; }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.closed = true; }
  }
  const trade = (iso, price, size = 1) => ({ data: JSON.stringify({ type: 'ticker', product_id: 'BTC-USD', price: String(price), last_size: String(size), time: iso }) });
  const open = (opts = {}) => {
    const got = [];
    const conn = openStream({ symbol: 'BTC-USD', interval: '1m', onKline: (k) => got.push(k.candle), WS: FakeWS, ...opts });
    return { got, conn, ws: FakeWS.last };
  };
  const T = (min, sec = 0) => `2026-11-10T16:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}Z`;
  const unix = (iso) => Date.parse(iso) / 1000;

  it('connects to the public feed and subscribes to ticker and heartbeat of the product on open', () => {
    const { ws } = open();
    expect(ws.url).toBe('wss://ws-feed.exchange.coinbase.com');
    expect(ws.sent).toEqual([]); // nothing is sent before the socket is open
    ws.onopen();
    expect(ws.sent).toEqual([{ type: 'subscribe', channels: [{ name: 'ticker', product_ids: ['BTC-USD'] }, { name: 'heartbeat', product_ids: ['BTC-USD'] }] }]);
  });
  it('the first trade opens a candle at the start of its minute', () => {
    const { got, ws } = open();
    ws.onmessage(trade(T(34, 51), 100, 2));
    expect(got).toEqual([{ time: unix(T(34)), open: 100, high: 100, low: 100, close: 100, volume: 2 }]);
  });
  it('later trades in the same minute move high, low, close and add volume', () => {
    const { got, ws } = open();
    ws.onmessage(trade(T(34, 5), 100, 1));
    ws.onmessage(trade(T(34, 20), 105, 2));
    ws.onmessage(trade(T(34, 40), 98, 0.5));
    ws.onmessage(trade(T(34, 59), 101, 1));
    expect(got.at(-1)).toEqual({ time: unix(T(34)), open: 100, high: 105, low: 98, close: 101, volume: 4.5 });
    expect(got).toHaveLength(4);
  });
  it('a trade exactly at the next boundary starts a new candle', () => {
    const { got, ws } = open();
    ws.onmessage(trade(T(34, 59), 100));
    ws.onmessage(trade(T(35, 0), 110));
    expect(got.at(-1)).toMatchObject({ time: unix(T(35)), open: 110, close: 110 });
    expect(got[0].time).toBe(unix(T(34)));
  });
  it('a seed candle is continued when the first trade belongs to it', () => {
    const seed = { time: unix(T(34)), open: 90, high: 120, low: 80, close: 100, volume: 10 };
    const { got, ws } = open({ seed });
    ws.onmessage(trade(T(34, 30), 101, 1));
    expect(got[0]).toEqual({ time: unix(T(34)), open: 90, high: 120, low: 80, close: 101, volume: 11 });
  });
  it('a seed candle of an older minute is not continued', () => {
    const seed = { time: unix(T(33)), open: 90, high: 120, low: 80, close: 100, volume: 10 };
    const { got, ws } = open({ seed });
    ws.onmessage(trade(T(35, 1), 150, 1));
    expect(got[0]).toEqual({ time: unix(T(35)), open: 150, high: 150, low: 150, close: 150, volume: 1 });
  });
  it('a late message of an older candle is ignored', () => {
    const { got, ws } = open();
    ws.onmessage(trade(T(35, 10), 100));
    ws.onmessage(trade(T(34, 59), 999));
    expect(got).toHaveLength(1);
  });
  it.each([['5m', 300], ['15m', 900], ['1h', 3600], ['1d', 86400]])('candles of %s start at multiples of %i s', (interval, g) => {
    const { got, ws } = open({ interval });
    ws.onmessage(trade('2026-11-10T16:34:51Z', 100));
    expect(got[0].time % g).toBe(0);
    expect(unix('2026-11-10T16:34:51Z') - got[0].time).toBeLessThan(g);
    expect(got[0].time).toBeLessThanOrEqual(unix('2026-11-10T16:34:51Z'));
  });
  it('the day candle starts at midnight UTC', () => {
    const { got, ws } = open({ interval: '1d' });
    ws.onmessage(trade('2026-11-10T23:59:59Z', 100));
    expect(got[0].time).toBe(Date.UTC(2026, 10, 10) / 1000);
  });
  it('ignores heartbeats, acks, garbage and foreign products without emitting anything', () => {
    const { got, ws } = open();
    for (const data of ['{nope', JSON.stringify({ type: 'heartbeat', product_id: 'BTC-USD' }), JSON.stringify({ type: 'subscriptions', channels: [] }),
      JSON.stringify({ type: 'ticker', product_id: 'ETH-USD', price: '1', time: T(34) }), JSON.stringify({ type: 'ticker', product_id: 'BTC-USD', price: 'x', time: T(34) })]) {
      ws.onmessage({ data });
    }
    expect(got).toEqual([]);
  });
  it('the emitted candle is a copy: changing it does not corrupt the next one', () => {
    const { got, ws } = open();
    ws.onmessage(trade(T(34, 1), 100));
    got[0].high = 1e9;
    ws.onmessage(trade(T(34, 2), 101));
    expect(got[1].high).toBe(101);
  });
  it('an error message of the server is passed on with its text', () => {
    const errors = [];
    const { ws, got } = open({ onError: (m) => errors.push(m) });
    ws.onmessage({ data: JSON.stringify({ type: 'error', message: 'Failed to subscribe', reason: 'BTC-XYZ is not a valid product' }) });
    ws.onmessage({ data: JSON.stringify({ type: 'error', reason: 'only the reason' }) });
    ws.onmessage({ data: JSON.stringify({ type: 'error' }) });
    expect(errors).toEqual(['Failed to subscribe', 'only the reason', 'error']);
    expect(got).toEqual([]);
  });
  it('onClose fires when the server drops the connection, not when we close it', () => {
    let dropped = 0;
    const a = open({ onClose: () => dropped++ });
    a.ws.onclose();
    expect(dropped).toBe(1);
    const b = open({ onClose: () => dropped++ });
    b.conn.close();
    b.ws.onclose();
    expect(b.ws.closed).toBe(true);
    expect(dropped).toBe(1);
  });
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
