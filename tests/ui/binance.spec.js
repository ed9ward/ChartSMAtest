import { readFileSync } from 'node:fs';
import { test, expect, open, smaData, candleData, expectLineAt } from './fixtures.js';
import { refSMA, refEMA, refBB, refRSI, expectSeriesClose } from '../unit/helpers.js';

// Real BTCUSDT 1m klines saved from Binance. Only the network is replaced; parsing, SMA and drawing are real.
const RAW = JSON.parse(readFileSync(new URL('../fixtures/btcusdt-1m.json', import.meta.url)));
// Independent mapping, not the app's parser.
const toCandle = (r) => ({
  time: r[0] / 1000, open: parseFloat(r[1]), high: parseFloat(r[2]), low: parseFloat(r[3]), close: parseFloat(r[4]), volume: parseFloat(r[5]),
});
const CANDLES = RAW.map(toCandle);
const ohlc = ({ time, open, high, low, close }) => ({ time, open, high, low, close });
const fmt = (n) => n.toFixed(2);
const T0 = RAW.at(-1)[0]; // open time (ms) of the newest bar

const klineMsg = ({ t, o, h, l, c, v = '1', s = 'BTCUSDT', i = '1m', x = false }) =>
  JSON.stringify({ e: 'kline', E: t + 1, s, k: { t, T: t + 59999, s, i, o: String(o), c: String(c), h: String(h), l: String(l), v: String(v), x } });

const extend = (rows, n) => [...rows, ...Array.from({ length: n }, (_, j) => {
  const base = rows.at(-1);
  return [base[0] + 60000 * (j + 1), base[1], base[2], base[3], base[4], base[5], 0, '0', 0, '0', '0', '0'];
})];

// Two daily bars for the "change per day" figure: yesterday closed at 75800.
const dailyRows = (prevClose = 75800) => [
  [Date.UTC(2026, 10, 9), '74000', '76000', '73000', String(prevClose), '1000', 0, '0', 0, '0', '0', '0'],
  [Date.UTC(2026, 10, 10), String(prevClose), '76500', '72900', '73488', '900', 0, '0', 0, '0', '0', '0'],
];

async function mockBinance(page, respond, { daily } = {}) {
  const requests = [];       // history requests
  const dailyRequests = [];  // the two-bar 1d requests behind the change-per-day figure
  const sockets = [];
  await page.route('https://api.binance.com/api/v3/klines*', async (route) => {
    const url = new URL(route.request().url());
    const isDaily = url.searchParams.get('interval') === '1d' && url.searchParams.get('limit') === '2';
    (isDaily ? dailyRequests : requests).push(url);
    const out = (isDaily
      ? await (daily?.(url, dailyRequests.length) ?? { body: dailyRows() })
      : await respond?.(url, requests.length)) ?? {};
    if (out.abort) return route.abort();
    await route.fulfill({
      status: out.status ?? 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? RAW),
    });
  });
  await page.routeWebSocket(/stream\.binance\.com/, (ws) => {
    const entry = { ws, url: ws.url(), closed: false };
    ws.onClose(() => { entry.closed = true; });
    sockets.push(entry);
  });
  return { requests, dailyRequests, sockets };
}

async function goLive(page, mock, n = 1) {
  await open(page);
  await page.getByTestId('scenario').selectOption('binance');
  await expect.poll(() => mock.sockets.length).toBe(n);
  await expect(page.getByTestId('status')).toHaveText(/^Live /);
}

const withLastClose = (close) => CANDLES.map((c, i) => (i === CANDLES.length - 1 ? { ...c, close } : c));

test.describe('history', () => {
  test('real bars are loaded and drawn; SMA matches the independent reference and golden values', async ({ page }) => {
    const mock = await mockBinance(page);
    await goLive(page, mock);
    await expect(page.getByTestId('bar-count')).toHaveText('50');
    await expect(page.getByTestId('status')).toHaveText('Live BTCUSDT 1m');
    expect((await candleData(page)).map(ohlc)).toEqual(CANDLES.map(ohlc));
    expectSeriesClose(await smaData(page), refSMA(CANDLES, 20, 'close'));
    // golden values were calculated outside JavaScript
    await expect(page.getByTestId('last-close')).toHaveText('73488.00');
    await expect(page.getByTestId('last-sma')).toHaveText('73310.66');
    expect(mock.requests[0].search).toBe('?symbol=BTCUSDT&interval=1m&limit=500');
    expect(mock.sockets[0].url).toContain('btcusdt@kline_1m');
  });

  test('settings on real data: hl2 / 10 and ohlc4 / 20 match golden values', async ({ page }) => {
    const mock = await mockBinance(page);
    await goLive(page, mock);
    await page.getByTestId('source').selectOption('hl2');
    await page.getByTestId('period').fill('10');
    await expect(page.getByTestId('last-sma')).toHaveText('73350.43');
    await page.getByTestId('source').selectOption('ohlc4');
    await page.getByTestId('period').fill('20');
    await expect(page.getByTestId('last-sma')).toHaveText('73305.95');
    await page.getByTestId('source').selectOption('volume');
    await page.getByTestId('period').fill('10');
    await expect(page.getByTestId('last-sma')).toHaveText('15.74');
  });

  test('SMA line is drawn at the right height on real prices', async ({ page }) => {
    const mock = await mockBinance(page);
    await goLive(page, mock);
    // the chart finishes its layout a moment after the async data arrives
    await expectLineAt(page);
  });
});

test.describe('live updates', () => {
  test('update of the forming bar changes close, high and SMA but not the bar count', async ({ page }) => {
    const mock = await mockBinance(page);
    await goLive(page, mock);
    mock.sockets[0].ws.send(klineMsg({ t: T0, o: 73484, h: 73510, l: 73482, c: 73500, v: 2.5 }));
    await expect(page.getByTestId('last-close')).toHaveText('73500.00');
    await expect(page.getByTestId('bar-count')).toHaveText('50');
    const last = (await candleData(page)).at(-1);
    expect(ohlc(last)).toEqual({ time: T0 / 1000, open: 73484, high: 73510, low: 73482, close: 73500 });
    expectSeriesClose(await smaData(page), refSMA(withLastClose(73500).map((c, i, a) => (i === a.length - 1 ? { ...c, high: 73510, volume: 2.5 } : c)), 20, 'close'));
  });

  test('a new bar is appended and SMA gets a new point', async ({ page }) => {
    const mock = await mockBinance(page);
    await goLive(page, mock);
    mock.sockets[0].ws.send(klineMsg({ t: T0 + 60000, o: 73488, h: 73500, l: 73470, c: 73490 }));
    await expect(page.getByTestId('bar-count')).toHaveText('51');
    const expected = [...CANDLES, { time: T0 / 1000 + 60, open: 73488, high: 73500, low: 73470, close: 73490, volume: 1 }];
    expectSeriesClose(await smaData(page), refSMA(expected, 20, 'close'));
    await expect(page.getByTestId('last-close')).toHaveText('73490.00');
  });

  test('many ticks in a row, both updating and opening bars', async ({ page }) => {
    const mock = await mockBinance(page);
    await goLive(page, mock);
    const expected = CANDLES.map((c) => ({ ...c }));
    let price = 73488;
    for (let i = 1; i <= 24; i++) {
      price += (i % 3 === 0 ? -1 : 1) * (i * 1.37);
      const t = T0 + 60000 * Math.floor(i / 4); // 4 ticks per bar
      const c = { time: t / 1000, open: 73488, high: price + 5, low: price - 5, close: price, volume: i };
      if (expected.at(-1).time === c.time) expected[expected.length - 1] = c; else expected.push(c);
      mock.sockets[0].ws.send(klineMsg({ t, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume }));
    }
    await expect(page.getByTestId('bar-count')).toHaveText(String(expected.length));
    await expect(page.getByTestId('last-close')).toHaveText(fmt(price));
    expectSeriesClose(await smaData(page), refSMA(expected, 20, 'close'));
    expect((await candleData(page)).map(ohlc)).toEqual(expected.map(ohlc));
  });

  test('settings can be changed while live data keeps arriving', async ({ page }) => {
    const mock = await mockBinance(page);
    await goLive(page, mock);
    await page.getByTestId('source').selectOption('hlc3');
    await page.getByTestId('period').fill('7');
    mock.sockets[0].ws.send(klineMsg({ t: T0 + 60000, o: 73488, h: 73600, l: 73400, c: 73550 }));
    await expect(page.getByTestId('bar-count')).toHaveText('51');
    const expected = [...CANDLES, { time: T0 / 1000 + 60, open: 73488, high: 73600, low: 73400, close: 73550, volume: 1 }];
    expectSeriesClose(await smaData(page), refSMA(expected, 7, 'hlc3'));
  });

  test('garbage, foreign and stale messages are ignored', async ({ page }) => {
    const mock = await mockBinance(page);
    await goLive(page, mock);
    const before = { candles: await candleData(page), sma: await smaData(page) };
    const ws = mock.sockets[0].ws;
    ws.send('not json');
    ws.send(JSON.stringify({ result: null, id: 1 }));
    ws.send(JSON.stringify({ e: 'trade', p: '1' }));
    ws.send(klineMsg({ t: T0, o: 1, h: 1, l: 1, c: 1, s: 'ETHUSDT' }));        // other symbol
    ws.send(klineMsg({ t: T0, o: 1, h: 1, l: 1, c: 1, i: '5m' }));             // other interval
    ws.send(klineMsg({ t: T0 + 60000, o: 'NaN', h: 1, l: 1, c: 1 }));          // broken number on a new bar
    ws.send(klineMsg({ t: T0 - 600000, o: 1, h: 1, l: 1, c: 1 }));             // older than we hold
    ws.send(klineMsg({ t: T0, o: 73484, h: 73490, l: 73480, c: 73488, v: 7 })); // sentinel: valid update
    await expect(page.getByTestId('last-close')).toHaveText('73488.00');
    await expect(page.getByTestId('bar-count')).toHaveText('50');
    const after = await candleData(page);
    expect(after).toHaveLength(50);
    expect(after.slice(0, -1)).toEqual(before.candles.slice(0, -1));
  });

  test('a gap in the stream triggers a fresh history request', async ({ page }) => {
    const mock = await mockBinance(page, (_, n) => (n === 1 ? {} : { body: extend(RAW, 6) }));
    await goLive(page, mock);
    mock.sockets[0].ws.send(klineMsg({ t: T0 + 60000 * 6, o: 73488, h: 73488, l: 73488, c: 73488 }));
    await expect.poll(() => mock.requests.length).toBe(2);
    await expect(page.getByTestId('bar-count')).toHaveText('56');
    await expect.poll(() => mock.sockets.length).toBe(2);
    expect(mock.sockets[0].closed).toBe(true);
    const bars = (await candleData(page)).map((c) => c.time);
    bars.slice(1).forEach((t, i) => expect(t - bars[i]).toBe(60));
  });
});

test.describe('instrument and timeframe', () => {
  test('timeframe switch refetches and resubscribes, the old socket is closed', async ({ page }) => {
    const mock = await mockBinance(page);
    await goLive(page, mock);
    await page.getByTestId('interval').selectOption('5m');
    await expect.poll(() => mock.sockets.length).toBe(2);
    expect(mock.requests[1].searchParams.get('interval')).toBe('5m');
    expect(mock.sockets[1].url).toContain('btcusdt@kline_5m');
    expect(mock.sockets[0].closed).toBe(true);
    await expect(page.getByTestId('status')).toHaveText('Live BTCUSDT 5m');
  });

  test('every timeframe is requested as chosen', async ({ page }) => {
    const mock = await mockBinance(page);
    await goLive(page, mock);
    for (const tf of ['5m', '15m', '1h', '1d', '1m']) {
      const n = mock.requests.length;
      await page.getByTestId('interval').selectOption(tf);
      await expect.poll(() => mock.requests.length).toBe(n + 1);
      expect(mock.requests.at(-1).searchParams.get('interval')).toBe(tf);
    }
  });

  test('symbol switch loads the other instrument', async ({ page }) => {
    const shifted = RAW.map((r) => [r[0], ...r.slice(1, 5).map((x) => String(parseFloat(x) - 70000)), ...r.slice(5)]);
    const mock = await mockBinance(page, (u) => (u.searchParams.get('symbol') === 'ETHUSDT' ? { body: shifted } : {}));
    await goLive(page, mock);
    await page.getByTestId('symbol').selectOption('ETHUSDT');
    await expect(page.getByTestId('status')).toHaveText('Live ETHUSDT 1m');
    await expect(page.getByTestId('last-close')).toHaveText('3488.00');
    expect(mock.sockets.at(-1).url).toContain('ethusdt@kline_1m');
    expectSeriesClose(await smaData(page), refSMA(shifted.map(toCandle), 20, 'close'));
  });

  test('a slow answer for a superseded request never overwrites the newer data', async ({ page }) => {
    const shifted = RAW.map((r) => [r[0], ...r.slice(1, 5).map((x) => String(parseFloat(x) - 70000)), ...r.slice(5)]);
    const mock = await mockBinance(page, async (u) => {
      if (u.searchParams.get('symbol') === 'BTCUSDT') { await new Promise((r) => setTimeout(r, 900)); return {}; }
      return { body: shifted };
    });
    await open(page);
    await page.getByTestId('scenario').selectOption('binance');          // BTC request starts (slow)
    await page.getByTestId('symbol').selectOption('ETHUSDT');            // ETH request supersedes it
    await expect(page.getByTestId('last-close')).toHaveText('3488.00');
    await page.waitForTimeout(1300);                                       // the slow BTC answer arrives now
    await expect(page.getByTestId('last-close')).toHaveText('3488.00');
    await expect(page.getByTestId('status')).toHaveText('Live ETHUSDT 1m');
    expect(mock.sockets).toHaveLength(1);
    expect(mock.sockets[0].url).toContain('ethusdt');
  });
});

test.describe('connection problems', () => {
  test('lost connection and recovery: history is loaded again with the missed bars', async ({ page }) => {
    const mock = await mockBinance(page, (_, n) => (n === 1 ? {} : { body: extend(RAW, 4) }));
    await goLive(page, mock);
    await page.getByTestId('disconnect').click();
    await expect(page.getByTestId('status')).toHaveText('Feed disconnected');
    await expect.poll(() => mock.sockets[0].closed).toBe(true);
    await expect(page.getByTestId('bar-count')).toHaveText('50');

    await page.getByTestId('reconnect').click();
    await expect(page.getByTestId('bar-count')).toHaveText('54');
    await expect(page.getByTestId('status')).toHaveText('Live BTCUSDT 1m');
    await expect.poll(() => mock.sockets.length).toBe(2);
    expectSeriesClose(await smaData(page), refSMA(extend(RAW, 4).map(toCandle), 20, 'close'));
    mock.sockets[1].ws.send(klineMsg({ t: T0 + 60000 * 4, o: 1, h: 99999, l: 1, c: 5000 }));
    await expect(page.getByTestId('last-close')).toHaveText('5000.00');
  });

  test('the server dropping the connection is shown and can be recovered', async ({ page }) => {
    const mock = await mockBinance(page);
    await goLive(page, mock);
    mock.sockets[0].ws.close();
    await expect(page.getByTestId('status')).toHaveText('Feed disconnected');
    await page.getByTestId('reconnect').click();
    await expect.poll(() => mock.sockets.length).toBe(2);
    await expect(page.getByTestId('status')).toHaveText('Live BTCUSDT 1m');
  });

  test('settings changed while disconnected apply to the data', async ({ page }) => {
    const mock = await mockBinance(page);
    await goLive(page, mock);
    await page.getByTestId('disconnect').click();
    await page.getByTestId('period').fill('5');
    await expect(page.getByTestId('status')).toHaveText('Feed disconnected');
    await expect(page.getByTestId('last-sma')).toHaveText('73419.49');
  });

  test('HTTP 500: clear message, empty chart, no stream', async ({ page, errors }) => {
    const mock = await mockBinance(page, () => ({ status: 500, body: 'oops' }));
    await open(page);
    await page.getByTestId('scenario').selectOption('binance');
    await expect(page.getByTestId('status')).toHaveText('Failed to load BTCUSDT 1m: HTTP 500');
    await expect(page.getByTestId('bar-count')).toHaveText('0');
    expect(mock.sockets).toHaveLength(0);
    expect(errors.join()).toMatch(/500/);
    errors.length = 0; // the browser logs failed requests; the page itself did not throw
  });

  test('Binance error object (invalid symbol) shows its message', async ({ page, errors }) => {
    await mockBinance(page, () => ({ body: { code: -1121, msg: 'Invalid symbol.' } }));
    await open(page);
    await page.getByTestId('scenario').selectOption('binance');
    await expect(page.getByTestId('status')).toContainText('Invalid symbol.');
    await expect(page.getByTestId('bar-count')).toHaveText('0');
    expect(errors).toEqual([]);
  });

  test('network failure', async ({ page, errors }) => {
    await mockBinance(page, () => ({ abort: true }));
    await open(page);
    await page.getByTestId('scenario').selectOption('binance');
    await expect(page.getByTestId('status')).toContainText('Failed to load BTCUSDT 1m');
    errors.length = 0;
  });

  test('invalid JSON in the answer', async ({ page }) => {
    await mockBinance(page, () => ({ body: '{not json' }));
    await open(page);
    await page.getByTestId('scenario').selectOption('binance');
    await expect(page.getByTestId('status')).toContainText('Failed to load BTCUSDT 1m');
  });

  test('partly broken rows are dropped, the rest is shown', async ({ page }) => {
    await mockBinance(page, () => ({ body: [RAW[0], null, ['x'], RAW[1], [RAW[2][0], 'abc', '1', '1', '1', '1'], RAW[3]] }));
    await open(page);
    await page.getByTestId('scenario').selectOption('binance');
    await expect(page.getByTestId('bar-count')).toHaveText('3');
    await expect(page.getByTestId('status')).toContainText('dropped 1 invalid');
  });

  test('after a failure the app recovers when the request works again', async ({ page, errors }) => {
    await mockBinance(page, (_, n) => (n === 1 ? { status: 503, body: '' } : {}));
    await open(page);
    await page.getByTestId('scenario').selectOption('binance');
    await expect(page.getByTestId('status')).toContainText('HTTP 503');
    await page.getByTestId('interval').selectOption('5m');
    await expect(page.getByTestId('bar-count')).toHaveText('50');
    await expect(page.getByTestId('status')).toHaveText('Live BTCUSDT 5m');
    errors.length = 0;
  });
});

test.describe('leaving live mode', () => {
  test('switching to a local data set closes the socket and ignores late messages', async ({ page }) => {
    const mock = await mockBinance(page);
    await goLive(page, mock);
    await page.getByTestId('scenario').selectOption('normal');
    await expect.poll(() => mock.sockets[0].closed).toBe(true);
    await expect(page.getByTestId('bar-count')).toHaveText('60');
    await expect(page.getByTestId('status')).toHaveText('OK');
  });

  test('streaming buttons do not start the demo feed on live data', async ({ page }) => {
    const mock = await mockBinance(page);
    await goLive(page, mock);
    await page.getByTestId('start').click();
    await expect(page.getByTestId('status')).toContainText('Streaming is available');
    await page.waitForTimeout(500);
    await expect(page.getByTestId('bar-count')).toHaveText('50');
  });
});

test.describe('other indicators on real data', () => {
  // Golden values calculated outside JavaScript (Python, Decimal) from the same 50 bars.
  test('EMA 20 and 5', async ({ page }) => {
    await goLive(page, await mockBinance(page));
    await page.getByTestId('indicator').selectOption('ema');
    await expect(page.getByTestId('last-sma')).toHaveText('73346.25');
    await page.getByTestId('period').fill('5');
    await expect(page.getByTestId('last-sma')).toHaveText('73429.15');
  });

  test('Bollinger (20, 2) and (10, 3)', async ({ page }) => {
    await goLive(page, await mockBinance(page));
    await page.getByTestId('indicator').selectOption('bb');
    await expect(page.getByTestId('last-bb-upper')).toHaveText('73476.76');
    await expect(page.getByTestId('last-sma')).toHaveText('73310.66');
    await expect(page.getByTestId('last-bb-lower')).toHaveText('73144.57');
    await page.getByTestId('period').fill('10');
    await page.getByTestId('mult').fill('3');
    await expect(page.getByTestId('last-bb-upper')).toHaveText('73589.62');
    await expect(page.getByTestId('last-sma')).toHaveText('73361.73');
    await expect(page.getByTestId('last-bb-lower')).toHaveText('73133.83');
  });

  test('RSI 14 and 5', async ({ page }) => {
    await goLive(page, await mockBinance(page));
    await page.getByTestId('indicator').selectOption('rsi');
    await expect(page.getByTestId('last-sma')).toHaveText('57.94');
    await page.getByTestId('period').fill('5');
    await expect(page.getByTestId('last-sma')).toHaveText('77.71');
  });

  test('live ticks update every indicator on real data', async ({ page }) => {
    const mock = await mockBinance(page);
    await goLive(page, mock);
    const expected = [...CANDLES, { time: T0 / 1000 + 60, open: 73488, high: 73600, low: 73400, close: 73550, volume: 1 }];
    mock.sockets[0].ws.send(klineMsg({ t: T0 + 60000, o: 73488, h: 73600, l: 73400, c: 73550 }));
    await expect(page.getByTestId('bar-count')).toHaveText('51');
    const cases = [
      ['ema', 20, (c) => ({ ema: refEMA(c, 20, 'close') })],
      ['bb', 20, (c) => refBB(c, 20, 2, 'close')],
      ['rsi', 14, (c) => ({ rsi: refRSI(c, 14, 'close') })],
    ];
    for (const [kind, , ref] of cases) {
      await page.getByTestId('indicator').selectOption(kind);
      const want = ref(expected);
      for (const [key, points] of Object.entries(want)) {
        expectSeriesClose(await page.evaluate((k) => window.__app.lineData(k), key), points);
      }
    }
  });
});

test.describe('update time and change per day', () => {
  const NOW = new Date('2026-11-10T16:34:51Z');

  test('demo data: the update time counts its age and refreshes on a tick; no day figure', async ({ page }) => {
    await page.clock.install({ time: NOW });
    await open(page);
    await expect(page.getByTestId('last-update')).toHaveText('16:34:51 (0 s ago)');
    await page.clock.fastForward(5000);
    await expect(page.getByTestId('last-update')).toHaveText('16:34:51 (5 s ago)');
    await page.evaluate(() => window.__app.step());
    await expect(page.getByTestId('last-update')).toHaveText('16:34:56 (0 s ago)');
    await expect(page.getByTestId('day-change')).toBeHidden();
  });

  test('live data: time of the last update follows every tick', async ({ page }) => {
    await page.clock.install({ time: NOW });
    const mock = await mockBinance(page);
    await goLive(page, mock);
    await expect(page.getByTestId('last-update')).toHaveText('16:34:51 (0 s ago)');
    await page.clock.fastForward(7000);
    await expect(page.getByTestId('last-update')).toHaveText('16:34:51 (7 s ago)');
    mock.sockets[0].ws.send(klineMsg({ t: T0, o: 73484, h: 73510, l: 73482, c: 73500 }));
    await expect(page.getByTestId('last-update')).toHaveText('16:34:58 (0 s ago)');
  });

  test('ignored garbage does not count as an update', async ({ page }) => {
    await page.clock.install({ time: NOW });
    const mock = await mockBinance(page);
    await goLive(page, mock);
    await page.clock.fastForward(4000);
    mock.sockets[0].ws.send('not json');
    mock.sockets[0].ws.send(klineMsg({ t: T0, o: 'NaN', h: 1, l: 1, c: 1 }));
    mock.sockets[0].ws.send(klineMsg({ t: T0 - 600000, o: 1, h: 1, l: 1, c: 1 }));
    // a valid tick after them proves the garbage was processed
    mock.sockets[0].ws.send(klineMsg({ t: T0, o: 73484, h: 73510, l: 73482, c: 73499 }));
    await expect(page.getByTestId('last-close')).toHaveText('73499.00');
    await expect(page.getByTestId('last-update')).toHaveText('16:34:55 (0 s ago)');
  });

  test('day change is taken against the previous day close and follows the price', async ({ page }) => {
    const mock = await mockBinance(page);
    await goLive(page, mock);
    await expect(page.getByTestId('day-change')).toBeVisible();
    await expect(page.getByTestId('day-change')).toHaveText('-3.05%'); // (73488 - 75800) / 75800
    await expect(page.getByTestId('day-change')).toHaveClass('down');
    mock.sockets[0].ws.send(klineMsg({ t: T0, o: 73484, h: 76100, l: 73482, c: 76000 }));
    await expect(page.getByTestId('day-change')).toHaveText('+0.26%');
    await expect(page.getByTestId('day-change')).toHaveClass('up');
    mock.sockets[0].ws.send(klineMsg({ t: T0, o: 73484, h: 76100, l: 73482, c: 75800 }));
    await expect(page.getByTestId('day-change')).toHaveText('0.00%');
    await expect(page.getByTestId('day-change')).toHaveClass('');
    expect(mock.dailyRequests).toHaveLength(1);
    expect(mock.dailyRequests[0].search).toBe('?symbol=BTCUSDT&interval=1d&limit=2');
  });

  test('1d timeframe uses its own bars and asks for nothing extra', async ({ page }) => {
    const mock = await mockBinance(page);
    await goLive(page, mock);
    await page.getByTestId('interval').selectOption('1d');
    await expect(page.getByTestId('status')).toHaveText('Live BTCUSDT 1d');
    // the mock returns the same 50 rows as "daily" bars: previous close 73484.01, last close 73488
    await expect(page.getByTestId('day-change')).toHaveText('+0.01%');
    expect(mock.dailyRequests).toHaveLength(1); // only from the first (1m) load
    mock.sockets.at(-1).ws.send(klineMsg({ t: T0, o: 73484, h: 74000, l: 73000, c: 74000, i: '1d' }));
    await expect(page.getByTestId('day-change')).toHaveText('+0.70%'); // (74000 - 73484.01) / 73484.01
  });

  test('timeframe and symbol changes ask for the previous close again', async ({ page }) => {
    const mock = await mockBinance(page, undefined, { daily: (_, n) => ({ body: dailyRows(n === 1 ? 75800 : 70000) }) });
    await goLive(page, mock);
    await expect(page.getByTestId('day-change')).toHaveText('-3.05%');
    await page.getByTestId('interval').selectOption('5m');
    await expect.poll(() => mock.dailyRequests.length).toBe(2);
    await expect(page.getByTestId('day-change')).toHaveText('+4.98%'); // (73488 - 70000) / 70000
  });

  test('a failing daily request only hides the figure', async ({ page, errors }) => {
    const mock = await mockBinance(page, undefined, { daily: () => ({ status: 500, body: '' }) });
    await goLive(page, mock);
    await expect(page.getByTestId('status')).toHaveText('Live BTCUSDT 1m');
    await expect(page.getByTestId('day-change')).toHaveText('—');
    await expect(page.getByTestId('bar-count')).toHaveText('50');
    mock.sockets[0].ws.send(klineMsg({ t: T0, o: 73484, h: 73510, l: 73482, c: 73500 }));
    await expect(page.getByTestId('last-close')).toHaveText('73500.00');
    await expect(page.getByTestId('day-change')).toHaveText('—');
    // the browser logs the failed request itself; nothing else (no uncaught error from the page) is allowed
    expect(errors.filter((e) => !/Failed to load resource.*500/.test(e))).toEqual([]);
    errors.length = 0;
  });

  test('a daily answer with one bar only gives no figure', async ({ page }) => {
    const mock = await mockBinance(page, undefined, { daily: () => ({ body: dailyRows().slice(1) }) });
    await goLive(page, mock);
    await expect(page.getByTestId('day-change')).toHaveText('—');
  });

  test('a new UTC day refreshes the previous close', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-11-10T23:59:50Z') });
    const mock = await mockBinance(page, undefined, { daily: (_, n) => ({ body: dailyRows(n === 1 ? 75800 : 74000) }) });
    await goLive(page, mock);
    await expect(page.getByTestId('day-change')).toHaveText('-3.05%');
    await page.clock.fastForward(20_000); // it is now 2026-11-11 00:00:10 UTC
    mock.sockets[0].ws.send(klineMsg({ t: T0, o: 73484, h: 73510, l: 73482, c: 73488 }));
    await expect.poll(() => mock.dailyRequests.length).toBe(2);
    await expect(page.getByTestId('day-change')).toHaveText('-0.69%'); // (73488 - 74000) / 74000
    mock.sockets[0].ws.send(klineMsg({ t: T0, o: 73484, h: 73510, l: 73482, c: 73489 }));
    await page.waitForTimeout(200);
    expect(mock.dailyRequests).toHaveLength(2); // asked once for the new day, not on every tick
  });

  test('switching to demo data hides the day figure again', async ({ page }) => {
    const mock = await mockBinance(page);
    await goLive(page, mock);
    await page.getByTestId('scenario').selectOption('normal');
    await expect(page.getByTestId('day-change')).toBeHidden();
  });

  test('a slow daily answer for a superseded request is ignored', async ({ page }) => {
    const mock = await mockBinance(page, undefined, {
      daily: async (u, n) => { if (n === 1) { await new Promise((r) => setTimeout(r, 700)); return { body: dailyRows(90000) }; } return { body: dailyRows(75800) }; },
    });
    await open(page);
    await page.getByTestId('scenario').selectOption('binance');
    await page.getByTestId('interval').selectOption('5m'); // second load starts before the first daily answer arrives
    await expect(page.getByTestId('day-change')).toHaveText('-3.05%');
    await page.waitForTimeout(1000);
    await expect(page.getByTestId('day-change')).toHaveText('-3.05%');
    expect(mock.dailyRequests.length).toBeGreaterThanOrEqual(2);
  });
});
