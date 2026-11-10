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

const ticker = ({ time, price, size = 0.1, product = 'BTC-USD' }) =>
  JSON.stringify({ type: 'ticker', product_id: product, price: String(price), last_size: String(size), time: iso(time), trade_id: 1, side: 'buy' });

/** respond(url, n) answers history requests; `daily` answers the two-bar day request behind the change figure. */
async function mockCoinbase(page, respond, { daily } = {}) {
  const requests = [];
  const dailyRequests = [];
  const sockets = [];
  const state = { dailyHistory: false }; // set before switching to the 1d timeframe: its history request has the same url
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
  await page.routeWebSocket(/ws-feed\.exchange\.coinbase\.com/, (ws) => {
    const entry = { ws, url: ws.url(), closed: false, received: [] };
    ws.onMessage((m) => entry.received.push(JSON.parse(String(m))));
    ws.onClose(() => { entry.closed = true; });
    sockets.push(entry);
  });
  return { requests, dailyRequests, sockets, state };
}

async function goLive(page, mock, n = 1) {
  await open(page);
  await page.getByTestId('scenario').selectOption('coinbase');
  await expect.poll(() => mock.sockets.length).toBe(n);
  await expect(page.getByTestId('status')).toHaveText(/^Live /);
}

const lineData = (page, key) => page.evaluate((k) => window.__app.lineData(k), key);

test.describe('Coinbase history', () => {
  test('BTC-USD is the default; bars come oldest first; SMA/EMA/BB/RSI match the golden values', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    await expect(page.getByTestId('status')).toHaveText('Live BTC-USD 1m');
    expect(await page.getByTestId('symbol').locator('option').allTextContents()).toEqual(['BTC-USD', 'ETH-USD', 'SOL-USD']);
    await expect(page.getByTestId('bar-count')).toHaveText('50');
    expect((await candleData(page)).map(ohlc)).toEqual(CANDLES.map(ohlc));
    expectSeriesClose(await smaData(page), refSMA(CANDLES, 20, 'close'));
    await expect(page.getByTestId('last-close')).toHaveText('73488.00');
    await expect(page.getByTestId('last-sma')).toHaveText('73310.66');
    await page.getByTestId('indicator').selectOption('ema');
    await expect(page.getByTestId('last-sma')).toHaveText('73346.25');
    await page.getByTestId('indicator').selectOption('bb');
    await expect(page.getByTestId('last-bb-upper')).toHaveText('73476.76');
    await expect(page.getByTestId('last-bb-lower')).toHaveText('73144.57');
    await page.getByTestId('indicator').selectOption('rsi');
    await expect(page.getByTestId('last-sma')).toHaveText('57.94');
  });

  test('the request and the subscription are the ones Coinbase expects', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    expect(mock.requests[0].pathname).toBe('/products/BTC-USD/candles');
    expect(mock.requests[0].search).toBe('?granularity=60');
    expect(mock.sockets[0].url).toBe('wss://ws-feed.exchange.coinbase.com/');
    await expect.poll(() => mock.sockets[0].received.length).toBe(1);
    expect(mock.sockets[0].received[0]).toEqual({
      type: 'subscribe',
      channels: [{ name: 'ticker', product_ids: ['BTC-USD'] }, { name: 'heartbeat', product_ids: ['BTC-USD'] }],
    });
  });

  test('the SMA line is drawn at the right height', async ({ page }) => {
    await goLive(page, await mockCoinbase(page));
    await expectLineAt(page);
  });

  test('an empty history: the first trade creates the first bar', async ({ page }) => {
    const mock = await mockCoinbase(page, () => ({ body: [] }));
    await goLive(page, mock);
    await expect(page.getByTestId('bar-count')).toHaveText('0');
    mock.sockets[0].ws.send(ticker({ time: T0 + 30, price: 100, size: 2 }));
    await expect(page.getByTestId('bar-count')).toHaveText('1');
    await expect(page.getByTestId('last-close')).toHaveText('100.00');
  });
});

test.describe('Coinbase live trades', () => {
  test('a trade inside the newest minute updates close/high, keeps open/low, continues the volume', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    mock.sockets[0].ws.send(ticker({ time: T0 + 30, price: 73500, size: 0.5 }));
    await expect(page.getByTestId('last-close')).toHaveText('73500.00');
    await expect(page.getByTestId('bar-count')).toHaveText('50');
    expect(ohlc((await candleData(page)).at(-1))).toEqual({ time: T0, open: 73484, high: 73500, low: 73482, close: 73500 });
    const expected = CANDLES.map((c, i) => (i === CANDLES.length - 1 ? { ...c, high: 73500, close: 73500, volume: c.volume + 0.5 } : c));
    expectSeriesClose(await smaData(page), refSMA(expected, 20, 'close'));
    await page.getByTestId('source').selectOption('volume'); // volume continued from the history bar: 1.02338 + 0.5
    await page.getByTestId('period').fill('1');
    await expect(page.getByTestId('last-sma')).toHaveText('1.52');
  });

  test('a trade in a lower price moves the low', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    mock.sockets[0].ws.send(ticker({ time: T0 + 10, price: 73400 }));
    await expect(page.getByTestId('last-close')).toHaveText('73400.00');
    expect(ohlc((await candleData(page)).at(-1))).toMatchObject({ low: 73400, high: 73488.01 });
  });

  test('the first trade of the next minute opens a new bar at its own price', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    mock.sockets[0].ws.send(ticker({ time: T0 + 65, price: 73600 }));
    await expect(page.getByTestId('bar-count')).toHaveText('51');
    expect(ohlc((await candleData(page)).at(-1))).toEqual({ time: T0 + 60, open: 73600, high: 73600, low: 73600, close: 73600 });
    const expected = [...CANDLES, { time: T0 + 60, open: 73600, high: 73600, low: 73600, close: 73600, volume: 0.1 }];
    expectSeriesClose(await smaData(page), refSMA(expected, 20, 'close'));
  });

  test('many trades across several minutes build the expected bars and every indicator follows', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
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
      mock.sockets[0].ws.send(ticker({ time, price }));
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
  });

  test('garbage, other products and late trades are ignored', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    const ws = mock.sockets[0].ws;
    ws.send('not json');
    ws.send(JSON.stringify({ type: 'subscriptions', channels: [{ name: 'ticker', product_ids: ['BTC-USD'] }] }));
    ws.send(JSON.stringify({ type: 'heartbeat', product_id: 'BTC-USD', time: iso(T0 + 5) }));
    ws.send(ticker({ time: T0 + 5, price: 1, product: 'ETH-USD' }));
    ws.send(ticker({ time: T0 + 5, price: 'NaN' }));
    ws.send(ticker({ time: T0 + 5, price: 0 }));
    ws.send(JSON.stringify({ type: 'ticker', product_id: 'BTC-USD', price: '5', time: 'yesterday' }));
    ws.send(ticker({ time: T0 - 600, price: 1 })); // older than the newest bar
    ws.send(ticker({ time: T0 + 30, price: 73499 })); // a valid one proves the rest was processed
    await expect(page.getByTestId('last-close')).toHaveText('73499.00');
    await expect(page.getByTestId('bar-count')).toHaveText('50');
    expect(ohlc((await candleData(page)).at(-1))).toMatchObject({ high: 73499, low: 73482, close: 73499 });
  });

  test('a gap in the stream triggers a fresh history request', async ({ page }) => {
    const extended = [[T0 + 360, 73488, 73488, 73488, 73488, 0.1], [T0 + 300, 73488, 73488, 73488, 73488, 0.1], [T0 + 240, 73488, 73488, 73488, 73488, 0.1], ...CB_ROWS];
    const mock = await mockCoinbase(page, (_, n) => (n === 1 ? {} : { body: extended }));
    await goLive(page, mock);
    mock.sockets[0].ws.send(ticker({ time: T0 + 360, price: 73488 }));
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
    mock.sockets[0].ws.send(ticker({ time: T0 + 30, price: 73500 }));
    await expect(page.getByTestId('last-update')).toHaveText('16:34:57 (0 s ago)');
  });
});

test.describe('Coinbase day change', () => {
  test('it uses the previous day close from the daily candles and follows the price', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    await expect(page.getByTestId('day-change')).toHaveText('-3.05%'); // (73488 - 75800) / 75800
    expect(mock.dailyRequests).toHaveLength(1);
    expect(mock.dailyRequests[0].search).toBe('?granularity=86400');
    mock.sockets[0].ws.send(ticker({ time: T0 + 30, price: 76000 }));
    await expect(page.getByTestId('day-change')).toHaveText('+0.26%');
  });

  test('1d timeframe takes it from its own bars and asks nothing extra', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    mock.state.dailyHistory = true; // the next 86400 request is the 1d chart history
    await page.getByTestId('interval').selectOption('1d');
    await expect(page.getByTestId('status')).toHaveText('Live BTC-USD 1d');
    await expect(page.getByTestId('day-change')).toHaveText('+0.01%'); // last two bars: 73484.01 -> 73488
    expect(mock.dailyRequests).toHaveLength(1);
    expect(mock.requests.at(-1).search).toBe('?granularity=86400');
  });

  test('a failing daily request only hides the figure', async ({ page, errors }) => {
    const mock = await mockCoinbase(page, undefined, { daily: () => ({ status: 500, body: '' }) });
    await goLive(page, mock);
    await expect(page.getByTestId('status')).toHaveText('Live BTC-USD 1m');
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
    await expect(page.getByTestId('status')).toHaveText('Live BTC-USD 1h');
  });

  test('on a 5m chart a trade lands in its five-minute bar', async ({ page }) => {
    const T5 = Math.floor(T0 / 300) * 300; // newest 5m bar, aligned like Coinbase aligns them
    const fiveMinute = Array.from({ length: 10 }, (_, i) => [T5 - 300 * i, 73000, 73100, 73050, 73060 + i, 5]);
    const mock = await mockCoinbase(page, (u) => (u.searchParams.get('granularity') === '300' ? { body: fiveMinute } : {}));
    await goLive(page, mock);
    await page.getByTestId('interval').selectOption('5m');
    await expect(page.getByTestId('status')).toHaveText('Live BTC-USD 5m');
    await expect.poll(() => mock.sockets.length).toBe(2);
    await expect(page.getByTestId('bar-count')).toHaveText('10');
    mock.sockets[1].ws.send(ticker({ time: T5 + 299, price: 73555 })); // the last second of the newest 5m bar
    await expect(page.getByTestId('last-close')).toHaveText('73555.00');
    await expect(page.getByTestId('bar-count')).toHaveText('10');
    mock.sockets[1].ws.send(ticker({ time: T5 + 300, price: 73560 })); // the next 5m bar
    await expect(page.getByTestId('bar-count')).toHaveText('11');
    expect((await candleData(page)).at(-1).time).toBe(T5 + 300);
  });

  test('symbol switch asks for the other product and subscribes to it', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    await page.getByTestId('symbol').selectOption('ETH-USD');
    await expect(page.getByTestId('status')).toHaveText('Live ETH-USD 1m');
    expect(mock.requests.at(-1).pathname).toBe('/products/ETH-USD/candles');
    await expect.poll(() => mock.sockets.at(-1).received.length).toBe(1);
    expect(mock.sockets.at(-1).received[0].channels[0].product_ids).toEqual(['ETH-USD']);
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
    await expect(page.getByTestId('status')).toHaveText('Live BTCUSDT 1m');
    expect(await page.getByTestId('symbol').locator('option').allTextContents()).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT']);
    await expect.poll(() => mock.sockets[0].closed).toBe(true);
    await page.getByTestId('scenario').selectOption('coinbase');
    await expect(page.getByTestId('status')).toHaveText('Live BTC-USD 1m');
    expect(await page.getByTestId('symbol').locator('option').allTextContents()).toEqual(['BTC-USD', 'ETH-USD', 'SOL-USD']);
    await expect.poll(() => binanceSockets[0].closed).toBe(true);
  });

  test('the selected symbol is reset to the exchange default, not carried over', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    await page.getByTestId('symbol').selectOption('SOL-USD');
    await expect(page.getByTestId('status')).toHaveText('Live SOL-USD 1m');
    await page.getByTestId('scenario').selectOption('normal');
    await page.getByTestId('scenario').selectOption('coinbase');
    await expect(page.getByTestId('status')).toHaveText('Live SOL-USD 1m'); // same exchange list: the choice stays
  });
});

test.describe('Coinbase connection problems', () => {
  test('HTTP 429 and an error object are shown clearly', async ({ page, errors }) => {
    const mock = await mockCoinbase(page, (_, n) => (n === 1 ? { status: 429, body: '' } : { body: { message: 'NotFound' } }));
    await open(page);
    await page.getByTestId('scenario').selectOption('coinbase');
    await expect(page.getByTestId('status')).toHaveText('Failed to load BTC-USD 1m: HTTP 429');
    await expect(page.getByTestId('bar-count')).toHaveText('0');
    await page.getByTestId('symbol').selectOption('SOL-USD');
    await expect(page.getByTestId('status')).toHaveText('Failed to load SOL-USD 1m: NotFound');
    expect(mock.sockets).toHaveLength(0);
    expect(errors.filter((e) => !/Failed to load resource.*429/.test(e))).toEqual([]);
    errors.length = 0;
  });

  test('an error message from the feed is shown with its text and can be recovered with Reconnect', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    mock.sockets[0].ws.send(JSON.stringify({ type: 'error', message: 'Failed to subscribe', reason: 'BTC-USD is not available' }));
    await expect(page.getByTestId('status')).toHaveText('Feed disconnected: Failed to subscribe');
    await expect.poll(() => mock.sockets[0].closed).toBe(true);
    await page.getByTestId('reconnect').click();
    await expect.poll(() => mock.sockets.length).toBe(2);
    await expect(page.getByTestId('status')).toHaveText('Live BTC-USD 1m');
  });

  test('disconnect, then reconnect backfills the missed bars', async ({ page }) => {
    const extended = [[T0 + 120, 73488, 73488, 73488, 73488, 0.1], [T0 + 60, 73488, 73488, 73488, 73488, 0.1], ...CB_ROWS];
    const mock = await mockCoinbase(page, (_, n) => (n === 1 ? {} : { body: extended }));
    await goLive(page, mock);
    await page.getByTestId('disconnect').click();
    await expect(page.getByTestId('status')).toHaveText('Feed disconnected');
    await expect.poll(() => mock.sockets[0].closed).toBe(true);
    await page.getByTestId('reconnect').click();
    await expect(page.getByTestId('bar-count')).toHaveText('52');
    await expect(page.getByTestId('status')).toHaveText('Live BTC-USD 1m');
  });

  test('the server dropping the connection is shown', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    mock.sockets[0].ws.close();
    await expect(page.getByTestId('status')).toHaveText('Feed disconnected');
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
    await expect(page.getByTestId('status')).toHaveText('Live ETH-USD 1m');
    expect(mock.sockets).toHaveLength(1);
  });

  test('leaving live mode closes the feed and hides the day figure', async ({ page }) => {
    const mock = await mockCoinbase(page);
    await goLive(page, mock);
    await page.getByTestId('scenario').selectOption('normal');
    await expect.poll(() => mock.sockets[0].closed).toBe(true);
    await expect(page.getByTestId('day-change')).toBeHidden();
    await expect(page.getByTestId('status')).toHaveText('OK');
  });
});
