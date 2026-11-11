// Checks against the REAL exchanges, run from the self-check page with its own button ("Check the real exchanges").
// They are not part of "Run all checks", of `npm test` or of CI: they need the internet and the exchanges' answers change by the second.
//
// What they answer: can this page, from this browser and this network, still read what Binance and Coinbase send today?
// They use the page's own readers (the strict parsers, the candle rule, the history and trade requests), so a change in an
// exchange's format shows up here as a failed check with the reason, instead of as a chart that quietly shows nothing.
import { assert } from './assert.js';
import { fetchHistory as binanceHistory, parseKlineMessage, INTERVAL_SECONDS, KLINES_URL, WS_URL } from '../src/live.js';
import { fetchHistory as coinbaseHistory, parseMatch, parseHeartbeat, COINBASE_REST, COINBASE_WS } from '../src/coinbase.js';
import { validateCandle } from '../src/sanitize.js';
import { parseFiniteNumber } from '../src/parse.js';

const BINANCE_REST = new URL(KLINES_URL).origin;
const INTERVALS = Object.keys(INTERVAL_SECONDS);

// A failed request, told in words a person can act on.
function httpProblem(status) {
  if (status === 451 || status === 403) return `HTTP ${status}: the exchange does not serve this network or region (try without a VPN, or from another network)`;
  if (status === 429 || status === 418) return `HTTP ${status}: too many requests, wait a minute and run the checks again`;
  return `HTTP ${status}`;
}

async function getJson(fetchFn, url) {
  let res;
  try { res = await fetchFn(url); } catch (e) { throw new Error(`could not reach ${new URL(url).host}: ${e.message}`); }
  if (!res.ok) throw new Error(httpProblem(res.status));
  try { return { body: await res.json(), headers: res.headers }; } catch { throw new Error('the answer is not JSON'); }
}

// Opens a WebSocket, sends `hello` when it is open, and collects JSON messages until `done(messages)` is true or time runs out.
function listen(WS, url, { hello, done, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const messages = [];
    let ws;
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* already closed */ }
      error ? reject(error) : resolve(messages);
    };
    const timer = setTimeout(() => finish(new Error(`nothing suitable arrived within ${timeoutMs >= 10_000 ? Math.round(timeoutMs / 1000) : (timeoutMs / 1000).toFixed(1)} s (got ${messages.length} message(s))`)), timeoutMs);
    try { ws = new WS(url); } catch (e) { return finish(new Error(`could not open the connection: ${e.message}`)); }
    ws.onopen = () => { if (hello) ws.send(JSON.stringify(hello)); };
    ws.onerror = () => finish(new Error(`the connection to ${new URL(url).host} failed`));
    ws.onclose = () => finish(new Error(`the connection to ${new URL(url).host} was closed before what we wait for arrived`));
    ws.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { data = event.data; }
      messages.push(data);
      if (done(messages)) finish();
    };
  });
}

const newest = (candles) => candles[candles.length - 1];

function assertCandles(candles, label) {
  assert(candles.length > 0, `${label}: no candles came back`);
  assert(!candles.invalidCount, `${label}: ${candles.invalidCount} row(s) could not be read by the strict parser`);
  candles.forEach((c) => { const why = validateCandle(c); assert(why === null, `${label}: a candle is not valid (${why}): ${JSON.stringify(c)}`); });
  candles.slice(1).forEach((c, i) => assert(c.time > candles[i].time, `${label}: candles are not oldest first`));
}

export function buildLiveGroups({ fetchFn = (...a) => fetch(...a), WS = WebSocket, timeoutMs = 10_000 } = {}) {
  const binanceNow = async () => (await getJson(fetchFn, `${BINANCE_REST}/api/v3/time`)).body.serverTime;
  const coinbaseNow = async () => Number((await getJson(fetchFn, `${COINBASE_REST}/time`)).body.epoch) * 1000;
  const check = (name, run) => ({ name, run });

  const binance = {
    id: 'live-binance', title: 'Binance (the real exchange)',
    checks: [
      check('candles: the answer is a list of rows with at least 12 fields each', async () => {
        const { body } = await getJson(fetchFn, `${KLINES_URL}?symbol=BTCUSDT&interval=1m&limit=5`);
        assert(Array.isArray(body), 'the answer is not a list');
        assert(body.length === 5, `asked for 5 candles, got ${body.length}`);
        body.forEach((row, i) => assert(Array.isArray(row) && row.length >= 12, `row ${i} has ${Array.isArray(row) ? row.length : 'no'} fields, expected at least 12`));
      }),
      check('candles: every row is read by the strict parser and is a valid candle', async () => {
        assertCandles(await binanceHistory({ symbol: 'BTCUSDT', interval: '1m', limit: 5, fetchFn }), 'BTCUSDT 1m');
      }),
      check('candles: one bar per minute, on the minute grid', async () => {
        const c = await binanceHistory({ symbol: 'BTCUSDT', interval: '1m', limit: 5, fetchFn });
        c.slice(1).forEach((x, i) => assert(x.time - c[i].time === 60, `bars ${i} and ${i + 1} are ${x.time - c[i].time} s apart, expected 60`));
      }),
      check('candles: the newest bar is recent by the exchange\'s own clock', async () => {
        const [c, now] = [await binanceHistory({ symbol: 'BTCUSDT', interval: '1m', limit: 3, fetchFn }), await binanceNow()];
        const age = (now - newest(c).time * 1000) / 1000;
        assert(age >= 0 && age < 180, `the newest bar opened ${Math.round(age)} s before the exchange's time`);
      }),
      ...INTERVALS.map((interval) => check(`candles: the ${interval} timeframe is read and lies on its grid`, async () => {
        const c = await binanceHistory({ symbol: 'BTCUSDT', interval, limit: 3, fetchFn });
        assertCandles(c, `BTCUSDT ${interval}`);
        c.forEach((x) => assert(x.time % INTERVAL_SECONDS[interval] === 0, `a ${interval} bar starts at ${x.time}, which is not on the grid`));
      })),
      check('every symbol the page offers exists and answers', async () => {
        for (const symbol of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT']) assertCandles(await binanceHistory({ symbol, interval: '1m', limit: 2, fetchFn }), symbol);
      }),
      check('the computer\'s clock is within a minute of the exchange\'s', async () => {
        const skew = Math.abs(Date.now() - await binanceNow()) / 1000;
        assert(skew < 60, `this computer's clock differs from Binance's by ${Math.round(skew)} s (the update time and the age shown on the chart will be off)`);
      }),
      check('the stream: a kline message arrives and is understood', async () => {
        const messages = await listen(WS, `${WS_URL}/btcusdt@kline_1m`, { timeoutMs, done: (m) => m.some((x) => parseKlineMessage(x, { symbol: 'BTCUSDT', interval: '1m' })) });
        const parsed = messages.map((x) => parseKlineMessage(x, { symbol: 'BTCUSDT', interval: '1m' })).find(Boolean);
        assertCandles([parsed.candle], 'the streamed candle');
      }),
      check('the stream: the message is current and its bar is the one in progress', async () => {
        const [messages, now] = [await listen(WS, `${WS_URL}/btcusdt@kline_1m`, { timeoutMs, done: (m) => m.some((x) => parseKlineMessage(x, { symbol: 'BTCUSDT', interval: '1m' })) }), await binanceNow()];
        const message = messages.find((x) => parseKlineMessage(x, { symbol: 'BTCUSDT', interval: '1m' }));
        assert(Number.isFinite(message.E) && Math.abs(message.E - now) < 60_000, `the event time ${message.E} is not within a minute of the exchange's time ${now}`);
        const { candle } = parseKlineMessage(message, { symbol: 'BTCUSDT', interval: '1m' });
        assert(now - candle.time * 1000 < 120_000, `the streamed bar opened ${Math.round((now - candle.time * 1000) / 1000)} s ago`);
      }),
    ],
  };

  const coinbase = {
    id: 'live-coinbase', title: 'Coinbase (the real exchange)',
    checks: [
      check('candles: the answer is a list of rows with 6 fields each', async () => {
        const { body } = await getJson(fetchFn, `${COINBASE_REST}/products/BTC-USD/candles?granularity=60`);
        assert(Array.isArray(body) && body.length > 0, 'the answer is not a list of candles');
        body.slice(0, 5).forEach((row, i) => assert(Array.isArray(row) && row.length >= 6, `row ${i} has ${Array.isArray(row) ? row.length : 'no'} fields, expected at least 6`));
      }),
      check('candles: every row is read by the strict parser and is a valid candle', async () => {
        assertCandles(await coinbaseHistory({ symbol: 'BTC-USD', interval: '1m', limit: 5, fetchFn }), 'BTC-USD 1m');
      }),
      check('candles: the newest bar is recent by the exchange\'s own clock', async () => {
        const [c, now] = [await coinbaseHistory({ symbol: 'BTC-USD', interval: '1m', limit: 3, fetchFn }), await coinbaseNow()];
        const age = (now - newest(c).time * 1000) / 1000;
        assert(age >= 0 && age < 600, `the newest bar opened ${Math.round(age)} s before the exchange's time`);
      }),
      ...INTERVALS.map((interval) => check(`candles: the ${interval} timeframe is read and lies on its grid`, async () => {
        const c = await coinbaseHistory({ symbol: 'BTC-USD', interval, limit: 3, fetchFn });
        assertCandles(c, `BTC-USD ${interval}`);
        c.forEach((x) => assert(x.time % INTERVAL_SECONDS[interval] === 0, `a ${interval} bar starts at ${x.time}, which is not on the grid`));
      })),
      check('every symbol the page offers exists and answers', async () => {
        for (const symbol of ['BTC-USD', 'ETH-USD', 'SOL-USD']) assertCandles(await coinbaseHistory({ symbol, interval: '1m', limit: 2, fetchFn }), symbol);
      }),
      check('trades: whole-number ids that follow each other one by one (the recovery of lost trades relies on it)', async () => {
        const { body } = await getJson(fetchFn, `${COINBASE_REST}/products/BTC-USD/trades?limit=50`);
        assert(Array.isArray(body) && body.length > 10, 'the answer is not a list of trades');
        const ids = body.map((t) => t.trade_id);
        ids.forEach((id) => assert(Number.isSafeInteger(id) && id >= 0, `trade id ${JSON.stringify(id)} is not a whole number`));
        ids.slice(1).forEach((id, i) => assert(ids[i] - id === 1, `ids ${ids[i]} and ${id} do not follow each other (newest first)`));
      }),
      check('trades: price and size are numbers and the time is a date', async () => {
        const { body } = await getJson(fetchFn, `${COINBASE_REST}/products/BTC-USD/trades?limit=20`);
        body.forEach((t) => {
          assert(parseFiniteNumber(t.price) > 0, `price ${JSON.stringify(t.price)} is not a positive number`);
          assert(parseFiniteNumber(t.size) > 0, `size ${JSON.stringify(t.size)} is not a positive number`);
          assert(Number.isFinite(Date.parse(t.time)), `time ${JSON.stringify(t.time)} is not a date`);
        });
      }),
      check('the computer\'s clock is within a minute of the exchange\'s', async () => {
        const skew = Math.abs(Date.now() - await coinbaseNow()) / 1000;
        assert(skew < 60, `this computer's clock differs from Coinbase's by ${Math.round(skew)} s`);
      }),
      check('the stream: the subscription is accepted, with no error message', async () => {
        const messages = await listen(WS, COINBASE_WS, { timeoutMs, hello: subscribe(), done: (m) => m.some((x) => x?.type === 'subscriptions' || x?.type === 'error') });
        const error = messages.find((x) => x?.type === 'error');
        assert(!error, `the exchange answered with an error: ${error?.message ?? ''} ${error?.reason ?? ''}`.trim());
      }),
      check('the stream: a heartbeat arrives and carries the number of the last trade', async () => {
        const messages = await listen(WS, COINBASE_WS, { timeoutMs, hello: subscribe(), done: (m) => m.some((x) => parseHeartbeat(x, { symbol: 'BTC-USD' })) });
        assert(messages.some((x) => parseHeartbeat(x, { symbol: 'BTC-USD' })), 'no heartbeat');
      }),
      check('the stream: the newest trade is announced and read', async () => {
        const messages = await listen(WS, COINBASE_WS, { timeoutMs, hello: subscribe(), done: (m) => m.some((x) => parseMatch(x, { symbol: 'BTC-USD' })) });
        const trade = messages.map((x) => parseMatch(x, { symbol: 'BTC-USD' })).find(Boolean);
        assert(trade.price > 0 && trade.size > 0, `the trade is not usable: ${JSON.stringify(trade)}`);
      }),
    ],
  };

  const cross = {
    id: 'live-cross', title: 'The two exchanges against each other',
    checks: [
      check('the last price of BTC on Binance and on Coinbase agree within 1%', async () => {
        const [b, c] = await Promise.all([
          binanceHistory({ symbol: 'BTCUSDT', interval: '1m', limit: 2, fetchFn }),
          coinbaseHistory({ symbol: 'BTC-USD', interval: '1m', limit: 2, fetchFn }),
        ]);
        const [pb, pc] = [newest(b).close, newest(c).close];
        assert(Math.abs(pb - pc) / pc < 0.01, `Binance says ${pb}, Coinbase says ${pc}: one of them is read wrongly`);
      }),
    ],
  };

  return [binance, coinbase, cross];
}

const subscribe = () => ({ type: 'subscribe', channels: [{ name: 'matches', product_ids: ['BTC-USD'] }, { name: 'heartbeat', product_ids: ['BTC-USD'] }] });
