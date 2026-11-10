import { readFileSync } from 'node:fs';
import { test, expect, open } from './fixtures.js';
import { mulberry32 } from '../../src/generator.js';
import { computeIndicator, settleBars, minBars } from '../../src/indicators.js';
import { compareSeries } from '../../checks/reference.js';

// Random sequences of what a user does and what a network does, with invariants checked after every sequence.
// The sequences are fixed by a seed, so a failure can be replayed: change SEEDS to the failing one.
const RAW = JSON.parse(readFileSync(new URL('../fixtures/btcusdt-1m.json', import.meta.url)));
const CB_ROWS = RAW.map((r) => [r[0] / 1000, +r[3], +r[2], +r[1], +r[4], +r[5]]).reverse();
const T0 = RAW.at(-1)[0];
const JSON_HEADERS = { 'access-control-allow-origin': '*' };
// FUZZ_RUNS=100 npx playwright test tests/ui/fuzz.spec.js  explores many more sequences; a failure names its seed
const SEEDS = Array.from({ length: Number(process.env.FUZZ_RUNS ?? 8) }, (_, i) => i + 1);
const OPS = 70;

async function mocks(page) {
  const sockets = [];
  const state = { lastId: 1000, userOff: false }; // userOff: the user pressed Disconnect and has not asked for anything since
  await page.route('https://api.binance.com/api/v3/klines*', (r) => r.fulfill({ contentType: 'application/json', headers: JSON_HEADERS, body: JSON.stringify(RAW) }));
  await page.route('https://api.exchange.coinbase.com/products/*/candles*', (r) => r.fulfill({ contentType: 'application/json', headers: JSON_HEADERS, body: JSON.stringify(CB_ROWS) }));
  await page.route('https://api.exchange.coinbase.com/products/*/trades*', (r) => r.fulfill({ contentType: 'application/json', headers: JSON_HEADERS, body: '[]' })); // nothing to recover from
  await page.routeWebSocket(/stream\.binance\.com|ws-feed\.exchange\.coinbase\.com/, (ws) => {
    const entry = { ws, coinbase: ws.url().includes('coinbase'), closed: false };
    ws.onMessage((m) => {
      if (entry.coinbase && JSON.parse(String(m)).type === 'subscribe') {
        ws.send(JSON.stringify({ type: 'last_match', product_id: 'BTC-USD', trade_id: state.lastId, price: '73488', size: '0.1', time: new Date((T0 / 1000 + 1) * 1000).toISOString() }));
      }
    });
    ws.onClose(() => { entry.closed = true; });
    sockets.push(entry);
  });
  return { sockets, state };
}

const SCENARIOS = ['normal', 'long', 'negative', 'flat', 'tiny', 'empty', 'binance', 'coinbase', 'binance', 'coinbase'];
const INDICATORS = ['sma', 'ema', 'bb', 'rsi'];
const SOURCES = ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'volume'];
const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];

async function applyOp(page, m, rnd, log) {
  const live = () => m.sockets.filter((s) => !s.closed);
  const kind = rnd();
  const sel = (id, value) => {
    log.push(`${id}=${value}`);
    if (['scenario', 'symbol', 'interval'].includes(id)) m.state.userOff = false; // a new choice of data: connecting again is what the user wants
    return page.getByTestId(id).selectOption(value);
  };
  if (kind < 0.14) return sel('scenario', pick(rnd, SCENARIOS));
  if (kind < 0.22) { const s = await page.getByTestId('symbol').locator('option').allTextContents(); return sel('symbol', pick(rnd, s)); }
  if (kind < 0.30) return sel('interval', pick(rnd, ['1m', '5m', '15m', '1h', '1d']));
  if (kind < 0.38) return sel('indicator', pick(rnd, INDICATORS));
  if (kind < 0.44) return sel('source', pick(rnd, SOURCES));
  if (kind < 0.50) { const v = pick(rnd, ['1', '2', '5', '14', '20', '50', '200', '0', '-3', '1.5', '']); log.push(`period=${v}`); return page.getByTestId('period').fill(v, { timeout: 2000 }); }
  if (kind < 0.53) { const v = pick(rnd, ['0', '1', '2', '3.5', '-1', '']); log.push(`mult=${v}`); return page.getByTestId('mult').fill(v, { timeout: 300 }).catch(() => {}); } // hidden unless Bollinger: skip quickly
  if (kind < 0.56) { const v = pick(rnd, ['first', 'sma']); log.push(`ema-start=${v}`); return page.getByTestId('ema-start').selectOption(v, { timeout: 300 }).catch(() => {}); } // hidden unless EMA
  if (kind < 0.62) { log.push('step'); return page.evaluate(() => window.__app.step()); }
  if (kind < 0.67) { log.push('disconnect'); m.state.userOff = true; return page.getByTestId('disconnect').click(); }
  if (kind < 0.72) { log.push('reconnect'); m.state.userOff = false; return page.getByTestId('reconnect').click(); }
  if (kind < 0.77) { const s = live()[0]; log.push(`drop ${s ? 'socket' : 'nothing'}`); return s?.ws.close(); }
  if (kind < 0.80) { // the connection breaks and the user presses Disconnect while the app is waiting to reconnect
    log.push('drop + disconnect + wait');
    live()[0]?.ws.close();
    await page.waitForTimeout(50);
    m.state.userOff = true;
    await page.getByTestId('disconnect').click({ timeout: 1000 }).catch(() => {});
    return page.clock.runFor(1000 + Math.floor(rnd() * 20_000));
  }
  if (kind < 0.83) { // the connection breaks and the user picks another symbol while the app is waiting to reconnect
    log.push('drop + other symbol + wait');
    live()[0]?.ws.close();
    await page.waitForTimeout(50);
    m.state.userOff = false;
    const symbols = await page.getByTestId('symbol').locator('option').allTextContents();
    await page.getByTestId('symbol').selectOption(pick(rnd, symbols), { timeout: 1000 }).catch(() => {});
    return page.clock.runFor(1000 + Math.floor(rnd() * 20_000));
  }
  if (kind < 0.89) { const ms = Math.floor(rnd() * 40_000); log.push(`clock +${ms}`); return page.clock.runFor(ms); }
  const s = live()[0];
  if (!s) return log.push('message to nobody');
  if (s.coinbase) { // a trade, now and then with ids skipped (lost trades; REST knows none: that ends in a reload)
    const skip = rnd() < 0.15 ? 2 : 1;
    m.state.lastId += skip;
    const id = m.state.lastId;
    log.push(`trade ${id}${skip > 1 ? ' (one lost)' : ''}`);
    return s.ws.send(JSON.stringify({ type: 'match', product_id: 'BTC-USD', trade_id: id, price: String(73400 + Math.floor(rnd() * 200)), size: '0.1', time: new Date((T0 / 1000 + 10 + Math.floor(rnd() * 40)) * 1000).toISOString() }));
  }
  const c = 73400 + Math.floor(rnd() * 200);
  const bad = rnd() < 0.3;
  log.push(`kline ${bad ? '(impossible)' : ''}`);
  return s.ws.send(JSON.stringify({ e: 'kline', s: 'BTCUSDT', k: { t: T0, s: 'BTCUSDT', i: '1m', o: '73484', h: String(bad ? c - 500 : c + 50), l: '73400', c: String(c), v: '2', x: false } }));
}

async function checkInvariants(page, m, trail) {
  const where = `after: ${trail.slice(-12).join(' | ')}`;
  const s = await page.evaluate(() => ({
    app: window.__app.state(), candles: window.__app.candleData(),
    lines: Object.fromEntries(Object.keys(window.__app.lineSeries()).map((k) => [k, window.__app.lineData(k)])),
    status: document.getElementById('status').textContent,
    legendClose: document.getElementById('last-close').textContent,
    precision: window.__app.candleSeries.options().priceFormat.precision,
    note: { hidden: document.getElementById('settle-note').hidden },
    barCount: document.getElementById('bar-count').textContent,
  }));

  expect(s.status, `${where}: still loading`).not.toMatch(/^Loading/);
  expect(Number(s.barCount), `${where}: bar count`).toBe(s.candles.length);
  expect(s.app.bars, `${where}: state bars`).toBe(s.candles.length);
  s.candles.slice(1).forEach((c, i) => expect(c.time, `${where}: candle times`).toBeGreaterThan(s.candles[i].time));
  s.candles.forEach((c) => {
    expect(c.high, `${where}: high`).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
    expect(c.low, `${where}: low`).toBeLessThanOrEqual(Math.min(c.open, c.close));
  });

  // the lines are exactly what the indicator gives for the candles on the chart (volume is not in the chart data: skip that source)
  if (s.app.source !== 'volume' && s.candles.length) {
    const candles = s.candles.map((c) => ({ ...c, volume: 1 }));
    const want = computeIndicator(s.app.indicator, candles, { period: s.app.period, mult: s.app.mult, start: s.app.start }, s.app.source);
    for (const [key, points] of Object.entries(want)) {
      expect(() => compareSeries(s.lines[key], points, 6), `${where}: line ${key} (${s.app.indicator}/${s.app.source}/${s.app.period})`).not.toThrow();
    }
  }

  // a live data set has one open connection, or none while it is offline or waiting to retry; never two
  const open = m.sockets.filter((x) => !x.closed).length;
  expect(open, `${where}: open connections`).toBeLessThanOrEqual(1);
  if (['binance', 'coinbase'].includes(s.app.scenario) && !s.app.offline && !s.status.startsWith('Failed')) {
    expect(open, `${where}: a live data set that is not offline has a connection`).toBe(1);
  }
  if (!['binance', 'coinbase'].includes(s.app.scenario)) expect(open, `${where}: local data has no connection`).toBe(0);
  // after Disconnect nothing connects by itself, however long we wait
  if (m.state.userOff && ['binance', 'coinbase'].includes(s.app.scenario)) expect(open, `${where}: connected again after Disconnect`).toBe(0);

  // the note about indicators that have not settled says what settleBars says
  const needed = settleBars(s.app.indicator, s.app.period, { start: s.app.start });
  const first = minBars(s.app.indicator, s.app.period, { start: s.app.start });
  const bars = s.candles.length;
  expect(s.note.hidden, `${where}: settle note`).toBe(!((bars > 0 && bars < first) || (needed > 0 && bars > 0 && bars < needed)));

  // the legend shows the last close with the decimals the price scale uses
  if (s.candles.length) expect(s.legendClose, `${where}: legend close`).toBe(s.candles.at(-1).close.toFixed(s.precision));
}

for (const seed of SEEDS) {
  test(`random actions and network failures, seed ${seed}: the invariants hold`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.clock.install({ time: new Date('2026-11-10T16:34:51Z') });
    const m = await mocks(page);
    await open(page);
    const rnd = mulberry32(seed);
    const trail = [];
    for (let i = 0; i < OPS; i++) {
      try { await applyOp(page, m, rnd, trail); } catch (e) { trail.push(`(op failed: ${String(e.message).split('\n')[0]})`); }
      if (i % 10 === 9) {
        await page.clock.runFor(1000);
        await expect.poll(() => page.evaluate(() => document.getElementById('status').textContent), { timeout: 10_000 }).not.toMatch(/^Loading/);
        await page.waitForTimeout(150); // let answers that are in flight arrive
        await checkInvariants(page, m, trail);
      }
    }
    await page.clock.runFor(90_000); // every retry has had its turn
    await expect.poll(() => page.evaluate(() => document.getElementById('status').textContent), { timeout: 10_000 }).not.toMatch(/^Loading/);
    await page.waitForTimeout(200);
    await checkInvariants(page, m, trail);
  });
}
