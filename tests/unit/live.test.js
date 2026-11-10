import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseKline, parseKlineMessage, fetchHistory, openStream, INTERVAL_SECONDS, utcDay, dayChangePercent, formatPercent } from '../../src/live.js';
import { computeSMA } from '../../src/sma.js';

const RAW = JSON.parse(readFileSync(new URL('../fixtures/btcusdt-1m.json', import.meta.url)));
const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

describe('parseKline', () => {
  it('converts a real Binance row (strings, ms) to a candle (numbers, seconds)', () => {
    expect(parseKline(RAW[0])).toEqual({
      time: 1794324480, open: 74258, high: 74259.3, low: 74126.64, close: 74132.1, volume: 15.78972,
    });
  });
  it.each([[null], [undefined], [[]], [[1, 2]], ['x'], [{}]])('rejects %j', (row) => {
    expect(parseKline(row)).toBeNull();
  });
  it('garbage numbers become NaN so the sanitizer can drop them', () => {
    expect(parseKline([1000, 'abc', '1', '1', '1', '1']).open).toBeNaN();
  });
});

describe('parseKlineMessage', () => {
  const msg = (over = {}) => ({
    e: 'kline', s: 'BTCUSDT',
    k: { t: 1794327420000, s: 'BTCUSDT', i: '1m', o: '73484.00', h: '73510.00', l: '73482.00', c: '73500.00', v: '2.5', x: false, ...over },
  });
  const ctx = { symbol: 'BTCUSDT', interval: '1m' };

  it('parses a forming kline', () => {
    expect(parseKlineMessage(JSON.stringify(msg()), ctx)).toEqual({
      candle: { time: 1794327420, open: 73484, high: 73510, low: 73482, close: 73500, volume: 2.5 }, closed: false,
    });
  });
  it('reports a closed kline', () => {
    expect(parseKlineMessage(msg({ x: true }), ctx).closed).toBe(true);
  });
  it.each([
    ['invalid JSON', '{nope'],
    ['empty string', ''],
    ['other event', JSON.stringify({ e: 'trade', k: {} })],
    ['no kline body', JSON.stringify({ e: 'kline' })],
    ['null', 'null'],
    ['a subscription ack', JSON.stringify({ result: null, id: 1 })],
  ])('ignores %s', (_, data) => {
    expect(parseKlineMessage(data, ctx)).toBeNull();
  });
  it('ignores another symbol or interval (stale connection)', () => {
    expect(parseKlineMessage(msg({ s: 'ETHUSDT' }), ctx)).toBeNull();
    expect(parseKlineMessage(msg({ i: '5m' }), ctx)).toBeNull();
  });
  it('symbol match is case-insensitive', () => {
    expect(parseKlineMessage(msg(), { symbol: 'btcusdt', interval: '1m' })).not.toBeNull();
  });
});

describe('fetchHistory', () => {
  it('asks for the right url and returns candles', async () => {
    let url;
    const candles = await fetchHistory({
      symbol: 'BTCUSDT', interval: '5m', limit: 50, fetchFn: async (u) => { url = u; return okResponse(RAW); },
    });
    expect(url).toBe('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=50');
    expect(candles).toHaveLength(50);
    expect(candles.at(-1).time).toBe(1794327420);
  });
  it('drops rows that are not rows', async () => {
    const candles = await fetchHistory({ symbol: 'X', interval: '1m', fetchFn: async () => okResponse([RAW[0], null, 'x', RAW[1]]) });
    expect(candles).toHaveLength(2);
  });
  describe('the limit contract', () => {
    const run = (limit, fetchFn = async () => okResponse(RAW)) => fetchHistory({ symbol: 'BTCUSDT', interval: '1m', limit, fetchFn });
    it('zero gives an empty list and makes no request', async () => {
      let called = false;
      expect(await run(0, async () => { called = true; return okResponse(RAW); })).toEqual([]);
      expect(called).toBe(false);
    });
    it('is passed on as asked, up to Binance\'s 1000', async () => {
      const urls = [];
      for (const limit of [1, 500, 1000]) await run(limit, async (u) => { urls.push(u); return okResponse([]); });
      expect(urls.map((u) => u.match(/limit=(\d+)/)[1])).toEqual(['1', '500', '1000']);
    });
    it('more than 1000 is cut to 1000 in the request', async () => {
      let url;
      await run(5000, async (u) => { url = u; return okResponse([]); });
      expect(url).toMatch(/limit=1000$/);
    });
    it.each([[-1], [NaN], [1.5], [Infinity], ['5'], [null], [{}]])('rejects %j before any request', async (limit) => {
      let called = false;
      await expect(run(limit, async () => { called = true; return okResponse([]); })).rejects.toThrow(RangeError);
      expect(called).toBe(false);
    });
    it('no limit means 500', async () => {
      let url;
      await fetchHistory({ symbol: 'X', interval: '1m', fetchFn: async (u) => { url = u; return okResponse([]); } });
      expect(url).toMatch(/limit=500$/);
    });
  });
  it('HTTP error', async () => {
    await expect(fetchHistory({ symbol: 'X', interval: '1m', fetchFn: async () => ({ ok: false, status: 429 }) })).rejects.toThrow('HTTP 429');
  });
  it('Binance error object is turned into its message', async () => {
    const fetchFn = async () => okResponse({ code: -1121, msg: 'Invalid symbol.' });
    await expect(fetchHistory({ symbol: 'X', interval: '1m', fetchFn })).rejects.toThrow('Invalid symbol.');
  });
  it('unexpected body', async () => {
    await expect(fetchHistory({ symbol: 'X', interval: '1m', fetchFn: async () => okResponse(null) })).rejects.toThrow('unexpected response');
  });
  it('network failure is passed on', async () => {
    await expect(fetchHistory({ symbol: 'X', interval: '1m', fetchFn: async () => { throw new TypeError('Failed to fetch'); } })).rejects.toThrow('Failed to fetch');
  });
});

describe('openStream', () => {
  class FakeWS {
    static last;
    constructor(url) { this.url = url; this.closed = false; FakeWS.last = this; }
    close() { this.closed = true; }
  }
  const kline = (over = {}) => JSON.stringify({ e: 'kline', s: 'BTCUSDT', k: { t: 1000, s: 'BTCUSDT', i: '1m', o: '1', h: '2', l: '0.5', c: '1.5', v: '3', x: false, ...over } });

  it('connects to the lower-cased stream name', () => {
    openStream({ symbol: 'BTCUSDT', interval: '1h', onKline() {}, WS: FakeWS });
    expect(FakeWS.last.url).toBe('wss://stream.binance.com:9443/ws/btcusdt@kline_1h');
  });
  it('delivers valid klines and skips garbage', () => {
    const got = [];
    openStream({ symbol: 'BTCUSDT', interval: '1m', onKline: (k) => got.push(k), WS: FakeWS });
    FakeWS.last.onmessage({ data: kline() });
    FakeWS.last.onmessage({ data: 'garbage' });
    FakeWS.last.onmessage({ data: kline({ s: 'ETHUSDT' }) });
    expect(got).toHaveLength(1);
    expect(got[0].candle.close).toBe(1.5);
  });
  it('onClose fires when the server drops the connection', () => {
    let dropped = 0;
    openStream({ symbol: 'BTCUSDT', interval: '1m', onKline() {}, onClose: () => dropped++, WS: FakeWS });
    FakeWS.last.onclose();
    expect(dropped).toBe(1);
  });
  it('onClose does not fire when we close it ourselves', () => {
    let dropped = 0;
    const conn = openStream({ symbol: 'BTCUSDT', interval: '1m', onKline() {}, onClose: () => dropped++, WS: FakeWS });
    conn.close();
    FakeWS.last.onclose();
    expect(FakeWS.last.closed).toBe(true);
    expect(dropped).toBe(0);
  });
});

describe('timeframes', () => {
  it('interval lengths in seconds', () => {
    expect(INTERVAL_SECONDS).toEqual({ '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1d': 86400 });
  });
});

// Expected values were calculated outside JavaScript (Python, Decimal) from the same 50 real BTCUSDT 1m bars.
// 2026-11-10 15:28 UTC .. 16:17 UTC. Compare the last ones with TradingView (BINANCE:BTCUSDT, 1m).
describe('golden SMA values on real BTCUSDT data', () => {
  const candles = RAW.map(parseKline);
  const last = (period, source) => computeSMA(candles, period, source).at(-1).value;

  it('close, period 20', () => expect(last(20, 'close')).toBeCloseTo(73310.6635, 6));
  it('close, period 5', () => expect(last(5, 'close')).toBeCloseTo(73419.49, 6));
  it('close, period 50 (all bars)', () => expect(last(50, 'close')).toBeCloseTo(73383.8202, 6));
  it('hl2, period 10', () => expect(last(10, 'hl2')).toBeCloseTo(73350.4345, 6));
  it('ohlc4, period 20', () => expect(last(20, 'ohlc4')).toBeCloseTo(73305.9495, 6));
  it('hlc3, period 14', () => expect(last(14, 'hlc3')).toBeCloseTo(73318.01214285714, 6));
  it('volume, period 10', () => expect(last(10, 'volume')).toBeCloseTo(15.738642, 6));
  it('first close SMA(20) point sits on the 20th bar', () => {
    const first = computeSMA(candles, 20, 'close')[0];
    expect(first.time).toBe(1794325620);
    expect(first.value).toBeCloseTo(73521.755, 6);
  });
});

describe('change per day', () => {
  it('hand-calculated values', () => {
    expect(dayChangePercent(73488, 75800)).toBeCloseTo(-3.0501319, 6);
    expect(dayChangePercent(76000, 75800)).toBeCloseTo(0.2638522, 6);
    expect(dayChangePercent(100, 100)).toBe(0);
    expect(dayChangePercent(150, 100)).toBe(50);
  });
  it.each([[NaN, 100], [100, NaN], [null, 100], [100, null], [undefined, 100], [100, 0], [Infinity, 100], [100, Infinity]])('cannot be calculated for %s / %s', (a, b) => {
    expect(dayChangePercent(a, b)).toBeNull();
  });
  it.each([
    [-3.0501319, '-3.05%'], [0.2638522, '+0.26%'], [0, '0.00%'], [0.004, '0.00%'], [-0.004, '0.00%'],
    [0.005, '+0.01%'], [-0.005, '-0.01%'], [12.3456, '+12.35%'], [-100, '-100.00%'], [null, '—'], [NaN, '—'], [Infinity, '—'],
  ])('formats %s as %s', (value, text) => {
    expect(formatPercent(value)).toBe(text);
  });
  it('UTC day number changes exactly at midnight UTC', () => {
    expect(utcDay(Date.UTC(2026, 10, 10, 23, 59, 59, 999))).toBe(utcDay(Date.UTC(2026, 10, 10, 0, 0, 0)));
    expect(utcDay(Date.UTC(2026, 10, 11, 0, 0, 0))).toBe(utcDay(Date.UTC(2026, 10, 10, 0, 0, 0)) + 1);
  });
});
