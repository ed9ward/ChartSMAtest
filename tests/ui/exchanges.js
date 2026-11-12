import { readFileSync } from 'node:fs';
import { expect } from './fixtures.js';
import { PROVIDERS } from '../../src/providers.js';

// Pretend Binance and Coinbase for the browser tests: REST history, the daily bars behind "change per day", and the streams.
// The data is 500 real BTCUSDT 1-minute bars (tests/fixtures), scaled to the price each instrument really has, or any
// candles a test brings. Nothing here touches the network.
export const REAL_ROWS = JSON.parse(readFileSync(new URL('../fixtures/binance-btcusdt-1m-500.json', import.meta.url)));
export const T_LAST = REAL_ROWS.at(-1)[0]; // ms; the open of the newest bar
const BASE_PRICE = 73_500;
export const PRICES = { BTCUSDT: 73_500, ETHUSDT: 3_500, SOLUSDT: 150, BNBUSDT: 620, 'BTC-USD': 73_500, 'ETH-USD': 3_500, 'SOL-USD': 150 };
export const priceOf = (symbol) => PRICES[symbol] ?? 100;
const HEADERS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

// candles ([{ time (s), open, high, low, close, volume }]) as the rows each exchange sends
export const toBinanceRows = (candles) => candles.map((c) => [c.time * 1000, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume), c.time * 1000 + 59_999, '0', 0, '0', '0', '0']);
export const toCoinbaseRows = (candles) => candles.map((c) => [c.time, c.low, c.high, c.open, c.close, c.volume]).reverse(); // newest first

export const realCandles = (symbol = 'BTCUSDT') => {
  const k = priceOf(symbol) / BASE_PRICE;
  return REAL_ROWS.map((r) => ({ time: r[0] / 1000, open: +r[1] * k, high: +r[2] * k, low: +r[3] * k, close: +r[4] * k, volume: +r[5] }));
};

/**
 * @param {object} options
 *   candles     what the exchange has as history (default: the real bars, scaled per instrument)
 *   binanceRows / coinbaseRows  raw rows instead (to send bad data), a function (symbol, interval, limit) => rows
 *   prevClose   yesterday's close for the change per day (default: 2% above the newest close)
 *   slow        delay of every REST answer, ms
 */
export async function pretendExchanges(page, { candles, binanceRows, coinbaseRows, prevClose, slow = 0, onRequest } = {}) {
  const mock = { requests: [], sockets: [], dailyRequests: [], lastId: 1000 };
  const bars = (symbol) => candles ?? realCandles(symbol);
  const dayOf = (symbol) => {
    const c = bars(symbol).at(-1);
    const last = c.close;
    const day = Math.floor(c.time / 86_400) * 86_400;
    const previous = prevClose ?? last * 1.02;
    return [{ time: day - 86_400, open: previous, high: previous, low: previous, close: previous, volume: 1 }, { time: day, open: last, high: last, low: last, close: last, volume: 1 }];
  };

  await page.route('https://api.binance.com/api/v3/klines*', async (route) => {
    const q = new URL(route.request().url()).searchParams;
    const [symbol, interval, limit] = [q.get('symbol'), q.get('interval'), Number(q.get('limit'))];
    mock.requests.push({ exchange: 'binance', symbol, interval, limit });
    onRequest?.(mock.requests.at(-1));
    if (slow) await new Promise((r) => setTimeout(r, slow));
    if (interval === '1d' && limit === 2) mock.dailyRequests.push(symbol);
    const rows = binanceRows ? binanceRows(symbol, interval, limit)
      : interval === '1d' ? toBinanceRows(dayOf(symbol)) : toBinanceRows(bars(symbol).slice(-limit));
    await route.fulfill({ headers: HEADERS, body: JSON.stringify(rows) });
  });
  await page.route('https://api.exchange.coinbase.com/products/*/candles*', async (route) => {
    const u = new URL(route.request().url());
    const symbol = u.pathname.split('/')[2];
    const granularity = Number(u.searchParams.get('granularity'));
    mock.requests.push({ exchange: 'coinbase', symbol, granularity });
    onRequest?.(mock.requests.at(-1));
    if (slow) await new Promise((r) => setTimeout(r, slow));
    const rows = coinbaseRows ? coinbaseRows(symbol, granularity)
      : granularity === 86_400 ? toCoinbaseRows(dayOf(symbol)) : toCoinbaseRows(bars(symbol).slice(-300));
    await route.fulfill({ headers: HEADERS, body: JSON.stringify(rows) });
  });
  await page.route('https://api.exchange.coinbase.com/products/*/trades*', (route) => route.fulfill({ headers: HEADERS, body: '[]' }));

  await page.routeWebSocket(/stream\.binance\.com|ws-feed\.exchange\.coinbase\.com/, (ws) => {
    const entry = { ws, url: ws.url(), closed: false, exchange: ws.url().includes('coinbase') ? 'coinbase' : 'binance' };
    ws.onClose(() => { entry.closed = true; });
    ws.onMessage((m) => {
      const hello = JSON.parse(String(m));
      if (hello.type !== 'subscribe') return;
      const product = hello.channels[0].product_ids[0];
      const c = bars(product).at(-1);
      ws.send(JSON.stringify({ type: 'subscriptions', channels: [] }));
      ws.send(JSON.stringify({ type: 'last_match', trade_id: mock.lastId, product_id: product, price: String(c.close), size: '0.1', time: new Date(c.time * 1000).toISOString(), side: 'buy' }));
    });
    mock.sockets.push(entry);
  });

  mock.open = () => mock.sockets.filter((s) => !s.closed);
  mock.live = () => mock.open().at(-1);
  // A tick on the newest bar of `symbol`: a kline message (Binance) or a trade (Coinbase).
  mock.tick = (symbol, price, { exchange = symbol.includes('-') ? 'coinbase' : 'binance', time = bars(symbol).at(-1).time, closed = false } = {}) => {
    const socket = mock.open().filter((s) => s.exchange === exchange).at(-1);
    if (!socket) throw new Error(`no open ${exchange} stream`);
    if (exchange === 'binance') {
      socket.ws.send(JSON.stringify({ e: 'kline', s: symbol, k: { t: time * 1000, s: symbol, i: '1m', o: String(price), h: String(price * 1.001), l: String(price * 0.999), c: String(price), v: '2', x: closed } }));
    } else {
      mock.lastId += 1;
      socket.ws.send(JSON.stringify({ type: 'match', trade_id: mock.lastId, product_id: symbol, price: String(price), size: '0.1', time: new Date((time + 10) * 1000).toISOString(), side: 'buy' }));
    }
  };
  return mock;
}

// Opens the page on an exchange and waits until it is live.
export async function openLive(page, { exchange = 'binance', symbol = PROVIDERS[exchange].symbols[0], interval = '1m' } = {}) {
  await page.goto('/');
  await page.waitForFunction(() => window.__app);
  await page.getByTestId('scenario').selectOption(exchange);
  if (symbol !== PROVIDERS[exchange].symbols[0]) await page.getByTestId('symbol').selectOption(symbol);
  if (interval !== '1m') await page.getByTestId('interval').selectOption(interval);
  await expect(page.getByTestId('status')).toHaveText(`Live ${symbol} ${interval}`);
}
