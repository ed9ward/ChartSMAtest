import { readFileSync } from 'node:fs';
import { test, expect, open, smaData, candleData, expectLineAt } from './fixtures.js';
import { refSMA, refEMA, refBB, refRSI, expectSeriesClose } from '../unit/helpers.js';

// The 50 real BTCUSDT bars, reshaped like Coinbase's API: [time s, low, high, open, close, volume], newest first.
const RAW = JSON.parse(readFileSync(new URL('../fixtures/btcusdt-1m.json', import.meta.url)));
const CB_ROWS = RAW.map((r) => [r[0] / 1000, +r[3], +r[2], +r[1], +r[4], +r[5]]).reverse();
const CANDLES = RAW.map((r) => ({ time: r[0] / 1000, open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] }));
const ohlc = ({ time, open, high, low, close }) => ({ time, open, high, low, close });
const fmt = (n) => n.toFixed(2);
const T0 = CANDLES.at(-1).time; // 2026-11-10T16:17:00Z, the newest bar
const iso = (seconds) => new Date(seconds * 1000).toISOString();

// Two daily bars, newest first: yesterday closed at 75800.
const dailyRows = (prevClose = 75800) => [
  [Date.UTC(2026, 10, 10) / 1000, 72900, 76500, prevClose, 73488, 900],
  [Date.UTC(2026, 10, 9) / 1000, 73000, 76000, 74000, prevClose, 1000],
];

const matchMsg = ({ id, time, price, size = 0.1, product = 'BTC-USD', type = 'match' }) =>
  JSON.stringify({ type, product_id: product, trade_id: id, price: String(price), size: String(size), time: iso(time), side: 'buy', sequence: id });
const heartbeatMsg = (lastTradeId) => JSON.stringify({ type: 'heartbeat', product_id: 'BTC-USD', sequence: 1, last_trade_id: lastTradeId, time: iso(T0) });

/**
 * respond(url, n) answers history requests (candles); `daily` the two-bar day request.
 * mock.trades is what the REST trades endpoint knows; the tape below keeps it up to date.
 */
async function mockCoinbase(page, respond, { daily, trades } = {}) {
  const requests = [];
  const dailyRequests = [];
  const tradeRequests = [];
  const sockets = [];
  const state = { dailyHistory: false, lastId: 1000, trades: [], restStatus: 200, noLastMatch: false };
  await page.route('https://api.exchange.coinbase.com/products/*/candles*', async (route) => {
    const url = new URL(route.request().url());
    const isDaily = url.searchParams.get('granularity') === '86400' && !state.dailyHistory;
    if (!isDaily && url.searchParams.get('granularity') === '86400') state.dailyHistory = false;
    (isDaily ? dailyRequests : requests).push(url);
    const out = (isDaily ? await (daily?.(url, dailyRequests.length) ?? { body: dailyRows() }) : await respond?.(url, requests.length)) ?? {};
    if (out.abort) return route.abort();
    await route.fulfill({
      status: out.status ?? 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? CB_ROWS),
    });
  });
  await page.route('https://api.exchange.coinbase.com/products/*/trades*', async (route) => {
    tradeRequests.push(new URL(route.request().url()));
    await route.fulfill({
      status: state.restStatus,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify([...(trades ?? state.trades)].sort((a, b) => b.trade_id - a.trade_id)),
    });
  });
  await page.routeWebSocket(/ws-feed\.exchange\.coinbase\.com/, (ws) => {
    const entry = { ws, url: ws.url(), closed: false, received: [] };
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m));
      entry.received.push(msg);
      // like Coinbase: the first message after subscribing is the newest trade that already happened
      if (msg.type === 'subscribe' && !state.noLastMatch) ws.send(matchMsg({ id: state.lastId, time: T0 + 1, price: 73488, type: 'last_match' }));
    });
    ws.onClose(() => { entry.closed = true; });
    sockets.push(entry);
  });
  return { requests, dailyRequests, tradeRequests, sockets, state };
}

/** A tape of trades with consecutive ids: send() delivers one, lose() only lets REST know it, again() repeats one. */
function tape(mock) {
  const make = (time, price, size = 0.1) => {
    const trade = { id: ++mock.state.lastId, time, price, size };
    mock.state.trades.push({ trade_id: trade.id, time: iso(time), price: String(price), size: String(size), side: 'buy' });
    return trade;
  };
  const deliver = (socket, trade) => mock.sockets[socket].ws.send(matchMsg(trade));
  return {
    send: (socket, time, price, size) => { const t = make(time, price, size); deliver(socket, t); return t; },
    lose: (time, price, size) => make(time, price, size),
    again: (socket, trade) => deliver(socket, trade),
    deliver,
    beat: (socket, id = mock.state.lastId) => mock.sockets[socket].ws.send(heartbeatMsg(id)),
  };
}

async function goLive(page, mock, n = 1) {
  await open(page);
  await page.getByTestId('scenario').selectOption('coinbase');
  await expect.poll(() => mock.sockets.length).toBe(n);
  await expect(page.getByTestId('status')).toHaveText(/^Live /);
  await expect.poll(() => mock.sockets[n - 1].received.length).toBeGreaterThan(0); // subscribed (the last_match is on its way)
}

const lineData = (page, key) => page.evaluate((k) => window.__app.lineData(k), key);
const status = (page) => page.getByTestId('status');

test.describe('Coinbase history', () => {
  test('BTC-USD is the default; bars come oldest first; SMA/EMA/BB/RSI match the golden values', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    await expect(status(page)).toHaveText('Live BTC-USD 1m');
    expect(await page.getByTestId('symbol').locator('option').allTextContents()).toEqual(['BTC-USD', 'ETH-USD', 'SOL-USD']);
    await expect(page.getByTestId('bar-count')).toHaveText('50');
    expect((await candleData(page)).map(ohlc)).toEqual(CANDLES.map(ohlc));
    expectSeriesClose(await smaData(page), refSMA(CANDLES, 20, 'close'));
    await expect(page.getByTestId('last-close')).toHaveText('73488.00');
    await expect(page.getByTestId('last-sma')).toHaveText('73310.66');
    await page.getByTestId('indicator').selectOption('ema');
    await expect(page.getByTestId('last-sma')).toHaveText('73342.91'); // first value as start
    await page.getByTestId('indicator').selectOption('bb');
    await expect(page.getByTestId('last-bb-upper')).toHaveText('73476.76');
    await expect(page.getByTestId('last-bb-lower')).toHaveText('73144.57');
    await page.getByTestId('indicator').selectOption('rsi');
    await expect(page.getByTestId('last-sma')).toHaveText('57.94');
  });

  test('the requests and the subscription are the ones Coinbase expects', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    expect(mock.requests[0].pathname).toBe('/products/BTC-USD/candles');
    expect(mock.requests[0].search).toBe('?granularity=60');
    expect(mock.sockets[0].url).toBe('wss://ws-feed.exchange.coinbase.com/');
    expect(mock.sockets[0].received).toEqual([{
      type: 'subscribe',
      channels: [{ name: 'matches', product_ids: ['BTC-USD'] }, { name: 'heartbeat', product_ids: ['BTC-USD'] }],
    }]);
    expect(mock.tradeRequests).toHaveLength(0); // trades are only asked for when something was lost
  });

  test('the first message after subscribing (last_match) changes nothing on the chart', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    await page.waitForTimeout(200);
    await expect(page.getByTestId('last-close')).toHaveText('73488.00');
    expect((await candleData(page)).map(ohlc)).toEqual(CANDLES.map(ohlc));
  });

  test('the SMA line is drawn at the right height', async ({ page }) => {
    await goLive(page, await mockCoinbase(page));
    await expectLineAt(page);
  });

  test('an empty history: the first trade creates the first bar', async ({ page }) => {
    const mock = await mockCoinbase(page, () => ({ body: [] }));
    await goLive(page, mock);
    await expect(page.getByTestId('bar-count')).toHaveText('0');
    tape(mock).send(0, T0 + 30, 100, 2);
    await expect(page.getByTestId('bar-count')).toHaveText('1');
    await expect(page.getByTestId('last-close')).toHaveText('100.00');
  });
});

test.describe('Coinbase impossible candles', () => {
  test('history rows with low above high or a negative volume are dropped', async ({ page }) => {
    const rows = CB_ROWS.map((r) => [...r]);
    rows[5] = [rows[5][0], 80000, 1, rows[5][3], rows[5][4], rows[5][5]]; // low above high
    rows[15][5] = -2;                                                    // negative volume
    const mock = await mockCoinbase(page, () => ({ body: rows }));
    await goLive(page, mock);
    await expect(page.getByTestId('bar-count')).toHaveText('48');
    await expect(status(page)).toHaveText('Live BTC-USD 1m; dropped 2 inconsistent candle(s) (impossible high/low or negative volume)');
  });
});

test.describe('Coinbase live trades', () => {
  test('a trade inside the newest minute updates close/high, keeps open/low, continues the volume', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    tape(mock).send(0, T0 + 30, 73500, 0.5);
    await expect(page.getByTestId('last-close')).toHaveText('73500.00');
    await expect(page.getByTestId('bar-count')).toHaveText('50');
    expect(ohlc((await candleData(page)).at(-1))).toEqual({ time: T0, open: 73484, high: 73500, low: 73482, close: 73500 });
    const expected = CANDLES.map((c, i) => (i === CANDLES.length - 1 ? { ...c, high: 73500, close: 73500, volume: c.volume + 0.5 } : c));
    expectSeriesClose(await smaData(page), refSMA(expected, 20, 'close'));
    await page.getByTestId('source').selectOption('volume'); // volume continued from the history bar: 1.02338 + 0.5
    await page.getByTestId('period').fill('1');
    await expect(page.getByTestId('last-sma')).toHaveText('1.52');
  });

  test('a trade at a lower price moves the low', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    tape(mock).send(0, T0 + 10, 73400);
    await expect(page.getByTestId('last-close')).toHaveText('73400.00');
    expect(ohlc((await candleData(page)).at(-1))).toMatchObject({ low: 73400, high: 73488.01 });
  });

  test('the first trade of the next minute opens a new bar at its own price', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    tape(mock).send(0, T0 + 65, 73600);
    await expect(page.getByTestId('bar-count')).toHaveText('51');
    expect(ohlc((await candleData(page)).at(-1))).toEqual({ time: T0 + 60, open: 73600, high: 73600, low: 73600, close: 73600 });
    const expected = [...CANDLES, { time: T0 + 60, open: 73600, high: 73600, low: 73600, close: 73600, volume: 0.1 }];
    expectSeriesClose(await smaData(page), refSMA(expected, 20, 'close'));
  });

  test('many trades across several minutes build the expected bars and every indicator follows', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    const t = tape(mock);
    const bars = CANDLES.map((c) => ({ ...c }));
    let price = 73488;
    for (let i = 1; i <= 30; i++) {
      price += (i % 4 === 0 ? -1 : 1) * i * 1.1;
      const time = T0 + 20 * i; // 3 trades per minute
      const bucket = Math.floor(time / 60) * 60;
      const last = bars.at(-1);
      if (last.time === bucket) {
        Object.assign(last, { high: Math.max(last.high, price), low: Math.min(last.low, price), close: price, volume: last.volume + 0.1 });
      } else {
        bars.push({ time: bucket, open: price, high: price, low: price, close: price, volume: 0.1 });
      }
      t.send(0, time, price);
    }
    await expect(page.getByTestId('bar-count')).toHaveText(String(bars.length));
    await expect(page.getByTestId('last-close')).toHaveText(fmt(price));
    expect((await candleData(page)).map(ohlc)).toEqual(bars.map(ohlc));
    expectSeriesClose(await smaData(page), refSMA(bars, 20, 'close'));
    await page.getByTestId('indicator').selectOption('ema');
    expectSeriesClose(await lineData(page, 'ema'), refEMA(bars, 20, 'close'));
    await page.getByTestId('indicator').selectOption('bb');
    const bb = refBB(bars, 20, 2, 'close');
    for (const key of ['upper', 'basis', 'lower']) expectSeriesClose(await lineData(page, key), bb[key]);
    await page.getByTestId('indicator').selectOption('rsi');
    expectSeriesClose(await lineData(page, 'rsi'), refRSI(bars, 14, 'close'));
    await expect(status(page)).toHaveText('Live BTC-USD 1m'); // an orderly feed leaves no traces
    expect(mock.tradeRequests).toHaveLength(0);
  });

  test('garbage, other products and bad numbers are ignored', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    const ws = mock.sockets[0].ws;
    ws.send('not json');
    ws.send(JSON.stringify({ type: 'subscriptions', channels: [{ name: 'matches', product_ids: ['BTC-USD'] }] }));
    ws.send(JSON.stringify({ type: 'ticker', product_id: 'BTC-USD', price: '1', time: iso(T0 + 5) }));
    ws.send(matchMsg({ id: 1001, time: T0 + 5, price: 1, product: 'ETH-USD' }));
    ws.send(matchMsg({ id: 1001, time: T0 + 5, price: 'NaN' }));
    ws.send(matchMsg({ id: 1001, time: T0 + 5, price: 0 }));
    ws.send(JSON.stringify({ type: 'match', product_id: 'BTC-USD', trade_id: null, price: '5', size: '1', time: iso(T0 + 5) }));
    ws.send(JSON.stringify({ type: 'match', product_id: 'BTC-USD', trade_id: 1001, price: '5', size: '1', time: 'yesterday' }));
    tape(mock).send(0, T0 + 30, 73499); // a valid trade with the next id proves the rest was processed
    await expect(page.getByTestId('last-close')).toHaveText('73499.00');
    await expect(page.getByTestId('bar-count')).toHaveText('50');
    expect(ohlc((await candleData(page)).at(-1))).toMatchObject({ high: 73499, low: 73482, close: 73499 });
    await expect(status(page)).toHaveText('Live BTC-USD 1m');
  });

  test('a gap of whole minutes without trades triggers a fresh history request', async ({ page }) => {
    const extended = [[T0 + 360, 73488, 73488, 73488, 73488, 0.1], [T0 + 300, 73488, 73488, 73488, 73488, 0.1], [T0 + 240, 73488, 73488, 73488, 73488, 0.1], ...CB_ROWS];
    const mock = await mockCoinbase(page, (_, n) => (n === 1 ? {} : { body: extended }));
    await goLive(page, mock);
    tape(mock).send(0, T0 + 360, 73488);
    await expect.poll(() => mock.requests.length).toBe(2);
    await expect(page.getByTestId('bar-count')).toHaveText('53');
    await expect.poll(() => mock.sockets.length).toBe(2);
    expect(mock.sockets[0].closed).toBe(true);
  });

  test('the update time follows the trades', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-11-10T16:34:51Z') });
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    await page.clock.fastForward(6000);
    await expect(page.getByTestId('last-update')).toHaveText('16:34:51 (6 s ago)');
    tape(mock).send(0, T0 + 30, 73500);
    await expect(page.getByTestId('last-update')).toHaveText('16:34:57 (0 s ago)');
  });
});

test.describe('Coinbase lost, repeated and reordered messages', () => {
  test('a trade lost inside the candle is fetched from REST: volume, extreme and last price are complete', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    const t = tape(mock);
    t.send(0, T0 + 10, 73490, 0.2);
    t.lose(T0 + 20, 73600, 3);        // a new high, lost on the way
    t.send(0, T0 + 30, 73495, 0.1);   // the next one reveals the hole
    await expect(status(page)).toHaveText('Live BTC-USD 1m; recovered 1 missed trade(s)');
    expect(mock.tradeRequests).toHaveLength(1);
    expect(mock.tradeRequests[0].search).toBe('?limit=1000');
    expect(ohlc((await candleData(page)).at(-1))).toEqual({ time: T0, open: 73484, high: 73600, low: 73482, close: 73495 });
    await page.getByTestId('source').selectOption('volume');
    await page.getByTestId('period').fill('1');
    await expect(page.getByTestId('last-sma')).toHaveText((1.02338 + 0.2 + 3 + 0.1).toFixed(2)); // nothing missing in the volume
  });

  test('several lost trades in a row are all recovered', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    const t = tape(mock);
    t.send(0, T0 + 10, 73490);
    for (let i = 0; i < 5; i++) t.lose(T0 + 12 + i, 73490 + i, 1);
    t.send(0, T0 + 30, 73500);
    await expect(status(page)).toHaveText('Live BTC-USD 1m; recovered 5 missed trade(s)');
    expect(ohlc((await candleData(page)).at(-1))).toMatchObject({ high: 73500, close: 73500 });
  });

  test('a repeated message is ignored and reported; the volume is not doubled', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    const t = tape(mock);
    const trade = t.send(0, T0 + 10, 73490, 2);
    t.again(0, trade);
    t.again(0, trade);
    await expect(status(page)).toHaveText('Live BTC-USD 1m; ignored 2 duplicate message(s)');
    await page.getByTestId('source').selectOption('volume');
    await page.getByTestId('period').fill('1');
    await expect(page.getByTestId('last-sma')).toHaveText((1.02338 + 2).toFixed(2));
    expect(mock.tradeRequests).toHaveLength(0);
  });

  test('swapped messages are put in order without asking REST', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    const t = tape(mock);
    const a = t.send(0, T0 + 10, 73490, 1);
    // make two trades but deliver the second before the first
    const first = { id: ++mock.state.lastId, time: T0 + 20, price: 73600, size: 1 };
    const second = { id: ++mock.state.lastId, time: T0 + 25, price: 73450, size: 1 };
    mock.state.trades.push({ trade_id: first.id, time: iso(first.time), price: '73600', size: '1', side: 'buy' }, { trade_id: second.id, time: iso(second.time), price: '73450', size: '1', side: 'buy' });
    t.deliver(0, second);
    t.deliver(0, first);
    await expect.poll(async () => (await candleData(page)).at(-1).close).toBe(73450);
    expect(ohlc((await candleData(page)).at(-1))).toEqual({ time: T0, open: 73484, high: 73600, low: 73450, close: 73450 });
    expect(a.id).toBeLessThan(first.id);
    await page.waitForTimeout(600); // longer than the grace period for a late predecessor
    expect(mock.tradeRequests).toHaveLength(0);
    await expect(status(page)).toHaveText('Live BTC-USD 1m');
  });

  test('the newest trades were lost: two heartbeats reveal it, one is not enough', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    const t = tape(mock);
    t.send(0, T0 + 10, 73490, 1);
    t.lose(T0 + 20, 73100, 5); // nothing arrives after it: only the heartbeat knows
    t.beat(0);
    await page.waitForTimeout(500);
    expect(mock.tradeRequests).toHaveLength(0);
    t.beat(0);
    await expect(status(page)).toHaveText('Live BTC-USD 1m; recovered 1 missed trade(s)');
    expect(ohlc((await candleData(page)).at(-1))).toMatchObject({ low: 73100, close: 73100 });
  });

  test('a heartbeat that is merely ahead of a late message fetches nothing', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    const t = tape(mock);
    const late = { id: ++mock.state.lastId, time: T0 + 20, price: 73495, size: 1 };
    mock.state.trades.push({ trade_id: late.id, time: iso(late.time), price: '73495', size: '1', side: 'buy' });
    t.beat(0);
    t.deliver(0, late);
    t.beat(0);
    t.beat(0);
    await expect(page.getByTestId('last-close')).toHaveText('73495.00');
    await page.waitForTimeout(400);
    expect(mock.tradeRequests).toHaveLength(0);
    await expect(status(page)).toHaveText('Live BTC-USD 1m');
  });

  test('trades that are lost across a minute boundary end up in the right bars', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    const t = tape(mock);
    t.send(0, T0 + 10, 73490, 1);
    t.lose(T0 + 40, 73550, 1);   // old minute
    t.lose(T0 + 59, 73440, 1);   // old minute
    t.lose(T0 + 61, 73700, 1);   // new minute
    t.send(0, T0 + 70, 73710, 1);
    await expect(page.getByTestId('bar-count')).toHaveText('51');
    await expect(status(page)).toContainText('recovered 3 missed trade(s)');
    const bars = await candleData(page);
    expect(ohlc(bars.at(-2))).toEqual({ time: T0, open: 73484, high: 73550, low: 73440, close: 73440 });
    expect(ohlc(bars.at(-1))).toEqual({ time: T0 + 60, open: 73700, high: 73710, low: 73700, close: 73710 });
  });

  test('the notes appear in the status and start again after a reload of the data', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    const t = tape(mock);
    const trade = t.send(0, T0 + 10, 73490, 1);
    t.again(0, trade);
    t.lose(T0 + 12, 73491, 1);
    t.send(0, T0 + 14, 73492, 1);
    await expect(status(page)).toHaveText('Live BTC-USD 1m; ignored 1 duplicate message(s); recovered 1 missed trade(s)');
    await page.getByTestId('interval').selectOption('5m');
    await expect(status(page)).toHaveText('Live BTC-USD 5m');
  });

  test('when the missing trades cannot be fetched the page reloads everything and says so', async ({ page }) => {
    const mock = await mockCoinbase(page, undefined, { trades: [] }); // REST knows no trades at all
    await goLive(page, mock);
    const t = tape(mock);
    t.send(0, T0 + 10, 73490, 1);
    t.lose(T0 + 20, 73100, 1);
    t.send(0, T0 + 30, 73495, 1);
    await expect.poll(() => mock.sockets.length).toBe(2);
    await expect(status(page)).toHaveText('Live BTC-USD 1m; resynced 1 time(s)');
    expect(mock.requests).toHaveLength(2);        // the history was loaded again
    expect(mock.sockets[0].closed).toBe(true);    // and the old feed was dropped
    await expect(page.getByTestId('bar-count')).toHaveText('50');
    await expect(page.getByTestId('last-close')).toHaveText('73488.00'); // back to the exchange's own history
  });

  test('a REST error while recovering also reloads everything', async ({ page, errors }) => {
    const mock = await mockCoinbase(page);
    mock.state.restStatus = 500;
    await goLive(page, mock);
    const t = tape(mock);
    t.send(0, T0 + 10, 73490, 1);
    t.lose(T0 + 20, 73100, 1);
    t.send(0, T0 + 30, 73495, 1);
    await expect.poll(() => mock.sockets.length).toBe(2);
    await expect(status(page)).toHaveText('Live BTC-USD 1m; resynced 1 time(s)');
    expect(errors.filter((e) => !/Failed to load resource.*500/.test(e))).toEqual([]);
    errors.length = 0;
  });

  test('the feed keeps working after a recovery', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    const t = tape(mock);
    t.send(0, T0 + 10, 73490, 1);
    t.lose(T0 + 12, 73491, 1);
    t.send(0, T0 + 14, 73492, 1);
    await expect(status(page)).toContainText('recovered 1');
    t.send(0, T0 + 20, 73555, 1);
    await expect(page.getByTestId('last-close')).toHaveText('73555.00');
    t.lose(T0 + 22, 73666, 1);
    t.send(0, T0 + 24, 73556, 1);
    await expect(status(page)).toContainText('recovered 2 missed trade(s)');
    expect(ohlc((await candleData(page)).at(-1))).toMatchObject({ high: 73666, close: 73556 });
  });
});

test.describe('Coinbase closed candles are checked against the exchange', () => {
  test('a candle that closed with less volume than the exchange says is corrected', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-11-10T16:34:51Z') });
    // the exchange's final version of the newest minute: a higher high, a lower low and more volume than the stream showed
    const fixed = CB_ROWS.map((r) => (r[0] === T0 ? [T0, 73400, 73650, 73484, 73490, 9.5] : r));
    const mock = await mockCoinbase(page, (_, n) => (n === 1 ? {} : { body: fixed }));
    await goLive(page, mock);
    tape(mock).send(0, T0 + 30, 73490, 0.2);
    tape(mock).send(0, T0 + 65, 73500, 0.1); // the next minute starts: the one before is closed
    await expect(page.getByTestId('bar-count')).toHaveText('51');
    await page.clock.fastForward(2500);      // the app now asks the exchange for its version
    await expect(status(page)).toHaveText('Live BTC-USD 1m; corrected 1 candle(s) from the exchange');
    await expect(page.getByTestId('bar-count')).toHaveText('51');
    const bars = await candleData(page);
    expect(ohlc(bars.at(-2))).toEqual({ time: T0, open: 73484, high: 73650, low: 73400, close: 73490 });
    expect(ohlc(bars.at(-1))).toMatchObject({ time: T0 + 60, close: 73500 }); // the new minute is untouched
  });

  test('a candle that matches the exchange is left alone', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-11-10T16:34:51Z') });
    // the exchange's version of the newest minute equals what the stream builds from the history bar plus our two trades
    const same = CB_ROWS.map((r) => (r[0] === T0 ? [T0, 73482, 73490, 73484, 73490, 1.02338 + 0.2] : r));
    const mock = await mockCoinbase(page, (_, n) => (n === 1 ? {} : { body: same }));
    await goLive(page, mock);
    const t = tape(mock);
    t.send(0, T0 + 30, 73490, 0.2);
    t.send(0, T0 + 65, 73500, 0.1);
    await expect(page.getByTestId('bar-count')).toHaveText('51');
    await page.clock.fastForward(2500);
    await expect.poll(() => mock.requests.length).toBe(2); // the check was made...
    await page.waitForTimeout(200);
    await expect(status(page)).toHaveText('Live BTC-USD 1m'); // ...and found nothing to correct
  });

  test('an impossible version from the exchange is rejected like any other bad candle', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-11-10T16:34:51Z') });
    const broken = CB_ROWS.map((r) => (r[0] === T0 ? [T0, 73600, 73400, 73484, 73490, 5] : r)); // low above high
    const mock = await mockCoinbase(page, (_, n) => (n === 1 ? {} : { body: broken }));
    await goLive(page, mock);
    const t = tape(mock);
    t.send(0, T0 + 30, 73490, 0.2);
    t.send(0, T0 + 65, 73500, 0.1);
    await page.clock.fastForward(2500);
    await expect.poll(() => mock.requests.length).toBe(2);
    await expect(status(page)).toHaveText('Live BTC-USD 1m; ignored 1 invalid update(s)');
    expect(ohlc((await candleData(page)).at(-2))).toEqual({ time: T0, open: 73484, high: 73490, low: 73482, close: 73490 });
  });
});

test.describe('Coinbase day change', () => {
  test('it uses the previous day close from the daily candles and follows the price', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    await expect(page.getByTestId('day-change')).toHaveText('-3.05%'); // (73488 - 75800) / 75800
    expect(mock.dailyRequests).toHaveLength(1);
    expect(mock.dailyRequests[0].search).toBe('?granularity=86400');
    tape(mock).send(0, T0 + 30, 76000);
    await expect(page.getByTestId('day-change')).toHaveText('+0.26%');
  });

  test('1d timeframe takes it from its own bars and asks nothing extra', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    mock.state.dailyHistory = true; // the next 86400 request is the 1d chart history
    await page.getByTestId('interval').selectOption('1d');
    await expect(status(page)).toHaveText('Live BTC-USD 1d');
    await expect(page.getByTestId('day-change')).toHaveText('+0.01%'); // last two bars: 73484.01 -> 73488
    expect(mock.dailyRequests).toHaveLength(1);
    expect(mock.requests.at(-1).search).toBe('?granularity=86400');
  });

  test('a failing daily request only hides the figure', async ({ page, errors }) => {
    const mock = await mockCoinbase(page, undefined, { daily: () => ({ status: 500, body: '' }) });
    await goLive(page, mock);
    await expect(status(page)).toHaveText('Live BTC-USD 1m');
    await expect(page.getByTestId('day-change')).toHaveText('—');
    expect(errors.filter((e) => !/Failed to load resource.*500/.test(e))).toEqual([]);
    errors.length = 0;
  });
});

test.describe('Coinbase timeframes and symbols', () => {
  test('every timeframe asks for its granularity and resubscribes; the old socket is closed', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    for (const [tf, g] of [['5m', '300'], ['15m', '900'], ['1h', '3600']]) {
      const n = mock.requests.length;
      await page.getByTestId('interval').selectOption(tf);
      await expect.poll(() => mock.requests.length).toBe(n + 1);
      expect(mock.requests.at(-1).searchParams.get('granularity')).toBe(g);
    }
    await expect.poll(() => mock.sockets.length).toBe(4);
    expect(mock.sockets.slice(0, 3).every((s) => s.closed)).toBe(true);
    await expect(status(page)).toHaveText('Live BTC-USD 1h');
  });

  test('on a 5m chart a trade lands in its five-minute bar', async ({ page }) => {
    const T5 = Math.floor(T0 / 300) * 300; // newest 5m bar, aligned like Coinbase aligns them
    const fiveMinute = Array.from({ length: 10 }, (_, i) => [T5 - 300 * i, 73000, 73100, 73050, 73060 + i, 5]);
    const mock = await mockCoinbase(page, (u) => (u.searchParams.get('granularity') === '300' ? { body: fiveMinute } : {}));
    await goLive(page, mock);
    await page.getByTestId('interval').selectOption('5m');
    await expect(status(page)).toHaveText('Live BTC-USD 5m');
    await expect.poll(() => mock.sockets.length).toBe(2);
    await expect(page.getByTestId('bar-count')).toHaveText('10');
    const t = tape(mock);
    t.send(1, T5 + 299, 73555); // the last second of the newest 5m bar
    await expect(page.getByTestId('last-close')).toHaveText('73555.00');
    await expect(page.getByTestId('bar-count')).toHaveText('10');
    t.send(1, T5 + 300, 73560); // the next 5m bar
    await expect(page.getByTestId('bar-count')).toHaveText('11');
    expect((await candleData(page)).at(-1).time).toBe(T5 + 300);
  });

  test('symbol switch asks for the other product and subscribes to it', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    await page.getByTestId('symbol').selectOption('ETH-USD');
    await expect(status(page)).toHaveText('Live ETH-USD 1m');
    expect(mock.requests.at(-1).pathname).toBe('/products/ETH-USD/candles');
    await expect.poll(() => mock.sockets.at(-1).received.length).toBe(1);
    expect(mock.sockets.at(-1).received[0].channels[0]).toEqual({ name: 'matches', product_ids: ['ETH-USD'] });
  });

  test('switching exchanges swaps the symbol list and closes the other feed', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await page.route('https://api.binance.com/api/v3/klines*', (route) => route.fulfill({
      contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(RAW),
    }));
    const binanceSockets = [];
    await page.routeWebSocket(/stream\.binance\.com/, (ws) => { const e = { closed: false }; ws.onClose(() => { e.closed = true; }); binanceSockets.push(e); });
    await goLive(page, mock);
    await page.getByTestId('scenario').selectOption('binance');
    await expect(status(page)).toHaveText('Live BTCUSDT 1m');
    expect(await page.getByTestId('symbol').locator('option').allTextContents()).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT']);
    await expect.poll(() => mock.sockets[0].closed).toBe(true);
    await page.getByTestId('scenario').selectOption('coinbase');
    await expect(status(page)).toHaveText('Live BTC-USD 1m');
    expect(await page.getByTestId('symbol').locator('option').allTextContents()).toEqual(['BTC-USD', 'ETH-USD', 'SOL-USD']);
    await expect.poll(() => binanceSockets[0].closed).toBe(true);
  });

  test('the selected symbol stays while the exchange stays the same', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    await page.getByTestId('symbol').selectOption('SOL-USD');
    await expect(status(page)).toHaveText('Live SOL-USD 1m');
    await page.getByTestId('scenario').selectOption('normal');
    await page.getByTestId('scenario').selectOption('coinbase');
    await expect(status(page)).toHaveText('Live SOL-USD 1m');
  });
});

test.describe('Coinbase connection problems', () => {
  test('HTTP 429 and an error object are shown clearly', async ({ page, errors }) => {
    const mock = await mockCoinbase(page, (_, n) => (n === 1 ? { status: 429, body: '' } : { body: { message: 'NotFound' } }));
    await open(page);
    await page.getByTestId('scenario').selectOption('coinbase');
    await expect(status(page)).toHaveText('Failed to load BTC-USD 1m: HTTP 429');
    await expect(page.getByTestId('bar-count')).toHaveText('0');
    await page.getByTestId('symbol').selectOption('SOL-USD');
    await expect(status(page)).toHaveText('Failed to load SOL-USD 1m: NotFound');
    expect(mock.sockets).toHaveLength(0);
    expect(errors.filter((e) => !/Failed to load resource.*429/.test(e))).toEqual([]);
    errors.length = 0;
  });

  test('an error message from the feed is shown with its text and can be recovered with Reconnect', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    mock.sockets[0].ws.send(JSON.stringify({ type: 'error', message: 'Failed to subscribe', reason: 'BTC-USD is not available' }));
    await expect(status(page)).toHaveText('Feed disconnected: Failed to subscribe');
    await expect.poll(() => mock.sockets[0].closed).toBe(true);
    await page.getByTestId('reconnect').click();
    await expect.poll(() => mock.sockets.length).toBe(2);
    await expect(status(page)).toHaveText('Live BTC-USD 1m');
  });

  test('disconnect, then reconnect backfills the missed bars', async ({ page }) => {
    const extended = [[T0 + 120, 73488, 73488, 73488, 73488, 0.1], [T0 + 60, 73488, 73488, 73488, 73488, 0.1], ...CB_ROWS];
    const mock = await mockCoinbase(page, (_, n) => (n === 1 ? {} : { body: extended }));
    await goLive(page, mock);
    await page.getByTestId('disconnect').click();
    await expect(status(page)).toHaveText('Feed disconnected');
    await expect.poll(() => mock.sockets[0].closed).toBe(true);
    await page.getByTestId('reconnect').click();
    await expect(page.getByTestId('bar-count')).toHaveText('52');
    await expect(status(page)).toHaveText('Live BTC-USD 1m');
  });

  test('the server dropping the connection is shown', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    mock.sockets[0].ws.close();
    await expect(status(page)).toHaveText('Feed disconnected');
  });

  test('a slow answer for a superseded request never overwrites the newer data', async ({ page }) => {
    const shifted = CB_ROWS.map((r) => [r[0], r[1] - 70000, r[2] - 70000, r[3] - 70000, r[4] - 70000, r[5]]);
    const mock = await mockCoinbase(page, async (u) => {
      if (u.pathname.includes('BTC-USD')) { await new Promise((r) => setTimeout(r, 900)); return {}; }
      return { body: shifted };
    });
    await open(page);
    await page.getByTestId('scenario').selectOption('coinbase');
    await page.getByTestId('symbol').selectOption('ETH-USD');
    await expect(page.getByTestId('last-close')).toHaveText('3488.00');
    await page.waitForTimeout(1300);
    await expect(page.getByTestId('last-close')).toHaveText('3488.00');
    await expect(status(page)).toHaveText('Live ETH-USD 1m');
    expect(mock.sockets).toHaveLength(1);
  });

  test('leaving live mode closes the feed and hides the day figure', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    await page.getByTestId('scenario').selectOption('normal');
    await expect.poll(() => mock.sockets[0].closed).toBe(true);
    await expect(page.getByTestId('day-change')).toBeHidden();
    await expect(status(page)).toHaveText('OK');
  });
});
