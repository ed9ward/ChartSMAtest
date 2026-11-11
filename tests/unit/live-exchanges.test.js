import { describe, it, expect } from 'vitest';
import { buildLiveGroups } from '../../checks/live-exchanges.js';
import { INTERVAL_SECONDS } from '../../src/live.js';

// A pretend Binance and Coinbase, as they answer today, with a hook to break one thing at a time.
const NOW = Date.now();
const PRICE = 73_500;

const binanceRows = (interval, n, { shift = 0, drop = () => false, fields = 12 } = {}) => {
  const step = INTERVAL_SECONDS[interval];
  const last = Math.floor(NOW / 1000 / step) * step;
  return Array.from({ length: n }, (_, i) => {
    const t = (last - (n - 1 - i) * step) * 1000 + shift;
    const row = [t, String(PRICE), String(PRICE + 20), String(PRICE - 20), String(PRICE + 5), '12.5', t + step * 1000 - 1, '900000', 100, '6', '400000', '0'];
    return drop(i) ? row.map(() => null) : row.slice(0, fields);
  });
};
const coinbaseRows = (granularity, n, { price = PRICE } = {}) => {
  const last = Math.floor(NOW / 1000 / granularity) * granularity;
  return Array.from({ length: n }, (_, i) => [last - i * granularity, price - 20, price + 20, price, price + 5, 3.2]); // newest first
};
const trades = (n, { gapAt = -1, price = String(PRICE) } = {}) => Array.from({ length: n }, (_, i) => ({
  trade_id: 90_000 - i - (gapAt >= 0 && i >= gapAt ? 1 : 0), price, size: '0.01', time: new Date(NOW - i * 500).toISOString(), side: 'buy',
}));

function world(o = {}) {
  const json = (body, status = 200) => ({ ok: status === 200, status, json: async () => body, headers: new Headers() });
  const fetchFn = async (url) => {
    if (o.offline) throw new TypeError('Failed to fetch');
    const u = new URL(url);
    const q = u.searchParams;
    if (u.host === 'api.binance.com' && u.pathname === '/api/v3/time') return json({ serverTime: NOW + (o.binanceClockOffsetMs ?? 0) });
    if (u.host === 'api.binance.com' && u.pathname === '/api/v3/klines') {
      if (o.binanceStatus) return json([], o.binanceStatus);
      return json(o.binanceKlines ? o.binanceKlines(q) : binanceRows(q.get('interval'), Number(q.get('limit')), o.binanceRowOptions));
    }
    if (u.host === 'api.exchange.coinbase.com' && u.pathname === '/time') return json({ iso: new Date(NOW).toISOString(), epoch: NOW / 1000 + (o.coinbaseClockOffsetS ?? 0) });
    if (u.host === 'api.exchange.coinbase.com' && u.pathname.endsWith('/candles')) return json(coinbaseRows(Number(q.get('granularity')), 300, { price: o.coinbasePrice ?? PRICE }));
    if (u.host === 'api.exchange.coinbase.com' && u.pathname.endsWith('/trades')) return json(o.coinbaseTrades ? o.coinbaseTrades() : trades(Number(q.get('limit')), o.tradeOptions));
    throw new Error(`unexpected request ${url}`);
  };

  class FakeWS {
    constructor(url) {
      this.url = url;
      this.coinbase = url.includes('coinbase');
      this.closed = false;
      queueMicrotask(() => { if (!this.closed && !(o.wsRefuse)) this.onopen?.(); else if (o.wsRefuse) this.onerror?.(); });
    }
    send(text) {
      const hello = JSON.parse(text);
      if (!this.coinbase || hello.type !== 'subscribe') return;
      const say = (m) => queueMicrotask(() => { if (!this.closed) this.onmessage?.({ data: JSON.stringify(m) }); });
      if (o.coinbaseSubscribeError) return say({ type: 'error', message: 'Failed to subscribe', reason: 'x' });
      say({ type: 'subscriptions', channels: [] });
      if (!o.noLastMatch) say({ type: 'last_match', trade_id: 90_000, product_id: 'BTC-USD', price: o.lastMatchPrice ?? String(PRICE), size: '0.1', time: new Date(NOW).toISOString(), side: 'buy' });
      if (!o.noHeartbeat) say({ type: 'heartbeat', sequence: 5, last_trade_id: 90_000, product_id: 'BTC-USD', time: new Date(NOW).toISOString() });
    }
    close() { this.closed = true; }
    // Binance streams by itself, from the moment it is open
    set onopen(fn) {
      this._onopen = fn;
      if (!this.coinbase && !o.binanceSilent) {
        queueMicrotask(() => queueMicrotask(() => {
          if (this.closed) return;
          const t = Math.floor(NOW / 60_000) * 60_000;
          const k = { t, s: o.streamSymbol ?? 'BTCUSDT', i: '1m', o: String(PRICE), h: String(o.streamHigh ?? PRICE + 20), l: String(PRICE - 20), c: String(PRICE + 5), v: '1.5', x: false };
          this.onmessage?.({ data: JSON.stringify({ e: 'kline', E: NOW + (o.streamEventOffsetMs ?? 0), s: k.s, k }) });
        }));
      }
    }
    get onopen() { return this._onopen; }
  }
  return { fetchFn, WS: FakeWS };
}

async function runAll(overrides, timeoutMs = 300) {
  const { fetchFn, WS } = world(overrides);
  const results = [];
  for (const group of buildLiveGroups({ fetchFn, WS, timeoutMs })) {
    for (const check of group.checks) {
      try { await check.run(); results.push({ group: group.id, name: check.name, ok: true }); }
      catch (e) { results.push({ group: group.id, name: check.name, ok: false, error: e.message }); }
    }
  }
  return results;
}
const failures = (results) => results.filter((r) => !r.ok);

describe('the checks against the real exchanges (here against pretend ones)', () => {
  it('there are many of them, with distinct names, in three groups', () => {
    const groups = buildLiveGroups({ fetchFn: async () => { throw new Error('no'); }, WS: class {} });
    expect(groups.map((g) => g.id)).toEqual(['live-binance', 'live-coinbase', 'live-cross']);
    const names = groups.flatMap((g) => g.checks.map((c) => `${g.id}: ${c.name}`));
    expect(names.length).toBeGreaterThanOrEqual(29);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all pass when both exchanges send what they send today', async () => {
    const results = await runAll({});
    expect(failures(results)).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(29);
  });

  // one thing broken at a time: which checks notice, and what they say
  const faults = [
    ['Binance sends rows with only 6 fields', { binanceRowOptions: { fields: 6 } }, /has 6 fields, expected at least 12/],
    ['Binance sends null instead of numbers', { binanceRowOptions: { drop: (i) => i === 2 } }, /could not be read by the strict parser/],
    ['Binance bar times are off the grid', { binanceRowOptions: { shift: 1234 } }, /could not be read by the strict parser|no candles came back/],
    ['Binance sends candles that are an hour old', { binanceRowOptions: { shift: -3_600_000 } }, /newest bar opened 36\d\d s before/],
    ['Binance refuses this region (451)', { binanceStatus: 451 }, /HTTP 451: the exchange does not serve this network or region/],
    ['Binance answers too many requests (429)', { binanceStatus: 429 }, /too many requests/],
    ['Binance is 5 minutes ahead of this computer', { binanceClockOffsetMs: 5 * 60_000 }, /differs from Binance's by/],
    ['Binance stream says a symbol other than asked', { streamSymbol: 'ETHUSDT' }, /nothing suitable arrived/],
    ['Binance stream sends an impossible candle', { streamHigh: 1 }, /not valid/],
    ['Binance stream is silent', { binanceSilent: true }, /nothing suitable arrived/],
    ['Binance stream event time is off by an hour', { streamEventOffsetMs: 3_600_000 }, /is not within a minute/],
    ['Coinbase trade ids have a gap', { tradeOptions: { gapAt: 7 } }, /do not follow each other/],
    ['Coinbase trade price is text', { tradeOptions: { price: 'abc' } }, /is not a positive number/],
    ['Coinbase rejects the subscription', { coinbaseSubscribeError: true }, /answered with an error: Failed to subscribe/],
    ['Coinbase sends no heartbeat', { noHeartbeat: true }, /nothing suitable arrived|no heartbeat/],
    ['Coinbase sends no last trade', { noLastMatch: true }, /nothing suitable arrived/],
    ['Coinbase price is 5% off Binance', { coinbasePrice: PRICE * 1.05 }, /one of them is read wrongly/],
    ['the network is down', { offline: true }, /could not reach/],
    ['the WebSocket cannot connect', { wsRefuse: true }, /connection to .* failed/],
  ];
  for (const [name, overrides, message] of faults) {
    it(`${name}: a check fails and says why`, async () => {
      const failed = failures(await runAll(overrides));
      expect(failed.length, 'something must fail').toBeGreaterThan(0);
      expect(failed.map((f) => f.error).join('\n')).toMatch(message);
    });
  }

  it('a problem on one exchange does not fail the checks of the other', async () => {
    const failed = failures(await runAll({ binanceStatus: 451 }));
    expect(failed.every((f) => f.group === 'live-binance' || f.group === 'live-cross')).toBe(true);
    const coinbaseFailed = failures(await runAll({ noHeartbeat: true }));
    expect(coinbaseFailed.every((f) => f.group === 'live-coinbase')).toBe(true);
  });
});
