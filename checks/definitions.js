// All checks, grouped by indicator. Pure checks run anywhere (browser, Node); UI checks need ctx.ui (see ui.js).
import { SOURCES, computeSMA } from '../src/sma.js';
import { INDICATORS, computeIndicator } from '../src/indicators.js';
import { generateCandles, partialCandle } from '../src/generator.js';
import { sanitizeCandles } from '../src/sanitize.js';
import { SCENARIOS } from '../src/scenarios.js';
import { createFeed, TICKS_PER_CANDLE } from '../src/feed.js';
import { parseKline, parseKlineMessage, dayChangePercent, formatPercent, INTERVAL_SECONDS } from '../src/live.js';
import { refSMA, refEMA, refBB, refRSI, compareSeries } from './reference.js';
import { expectedBars } from './data.js';
import { assert, equal, close, throws } from './assert.js';
import { compareIndicator } from './compare.js';
import { parseCandleRow, parseTicker, openStream as openCoinbaseStream, COINBASE_GRANULARITY } from '../src/coinbase.js';

const DATA = generateCandles({ seed: 42, count: 300 });
const candle = (time, value) => ({ time, open: value, high: value, low: value, close: value, volume: 100 });
const closes = (xs) => xs.map((x, i) => candle(i + 1, x));
const pointValues = (pts) => pts.map((p) => p.value);

const REFERENCE = {
  sma: (c, p, s) => ({ sma: refSMA(c, p.period, s) }),
  ema: (c, p, s) => ({ ema: refEMA(c, p.period, s) }),
  bb: (c, p, s) => refBB(c, p.period, p.mult, s),
  rsi: (c, p, s) => ({ rsi: refRSI(c, p.period, s) }),
};

// Indicator output must equal the independent reference on every line.
function matchReference(kind, candles, params, source) {
  const got = computeIndicator(kind, candles, params, source);
  const want = REFERENCE[kind](candles, params, source);
  for (const key of Object.keys(want)) compareSeries(got[key], want[key]);
}

// --- what is checked per indicator -----------------------------------------
const GRID = {
  sma: [{ period: 1 }, { period: 5 }, { period: 20 }, { period: 50 }],
  ema: [{ period: 1 }, { period: 5 }, { period: 20 }, { period: 50 }],
  bb: [{ period: 1, mult: 2 }, { period: 5, mult: 2 }, { period: 20, mult: 2 }, { period: 20, mult: 3.5 }, { period: 50, mult: 2 }],
  rsi: [{ period: 1 }, { period: 5 }, { period: 14 }, { period: 50 }],
};
const label = (p) => `period ${p.period}${p.mult !== undefined ? `, mult ${p.mult}` : ''}`;

// Hand-calculated results: [candles, params, expected lines]
const HAND = {
  sma: () => equal(computeIndicator('sma', closes([1, 2, 3]), { period: 2 }).sma, [{ time: 2, value: 1.5 }, { time: 3, value: 2.5 }]),
  ema: () => equal(computeIndicator('ema', closes([1, 2, 3, 4, 5]), { period: 3 }).ema, [{ time: 3, value: 2 }, { time: 4, value: 3 }, { time: 5, value: 4 }]),
  bb: () => {
    const r = computeIndicator('bb', closes([1, 2, 3]), { period: 3, mult: 2 });
    close(r.basis[0].value, 2, 12);
    close(r.upper[0].value, 2 + 2 * Math.sqrt(2 / 3), 12);
    close(r.lower[0].value, 2 - 2 * Math.sqrt(2 / 3), 12);
  },
  rsi: () => {
    const r = computeIndicator('rsi', closes([10, 12, 11, 13]), { period: 2 }).rsi;
    close(r[0].value, 200 / 3, 10);
    close(r[1].value, 600 / 7, 10);
    equal(pointValues(computeIndicator('rsi', closes([1, 2, 3, 4, 5, 6]), { period: 3 }).rsi), [100, 100, 100]);
    equal(pointValues(computeIndicator('rsi', closes([6, 5, 4, 3, 2, 1]), { period: 3 }).rsi), [0, 0, 0]);
  },
};

// Last-bar values calculated outside JavaScript (Python, Decimal) from 50 real BTCUSDT 1m bars.
const GOLDEN = {
  sma: (real) => {
    const last = (p, s) => computeIndicator('sma', real, { period: p }, s).sma.at(-1).value;
    close(last(20, 'close'), 73310.6635, 6, 'close/20');
    close(last(5, 'close'), 73419.49, 6, 'close/5');
    close(last(50, 'close'), 73383.8202, 6, 'close/50');
    close(last(10, 'hl2'), 73350.4345, 6, 'hl2/10');
    close(last(20, 'ohlc4'), 73305.9495, 6, 'ohlc4/20');
    close(last(14, 'hlc3'), 73318.01214285714, 6, 'hlc3/14');
    close(last(10, 'volume'), 15.738642, 6, 'volume/10');
  },
  ema: (real) => {
    const ema = (p) => computeIndicator('ema', real, { period: p }).ema;
    close(ema(20).at(-1).value, 73346.247551, 5, 'ema 20');
    close(ema(5).at(-1).value, 73429.147754, 5, 'ema 5');
    close(ema(20)[0].value, 73521.755, 5, 'ema 20 first');
    close(ema(20).at(-2).value, 73331.326241, 5, 'ema 20 at 16:16 UTC');
  },
  bb: (real) => {
    const r = computeIndicator('bb', real, { period: 20, mult: 2 });
    close(r.upper.at(-1).value, 73476.760393, 5, 'upper');
    close(r.basis.at(-1).value, 73310.6635, 5, 'basis');
    close(r.lower.at(-1).value, 73144.566607, 5, 'lower');
    close(r.upper.at(-2).value, 73445.283309, 5, 'upper at 16:16 UTC');
    const r2 = computeIndicator('bb', real, { period: 10, mult: 3 });
    close(r2.upper.at(-1).value, 73589.618664, 5, 'upper 10/3');
    close(r2.lower.at(-1).value, 73133.833336, 5, 'lower 10/3');
  },
  rsi: (real) => {
    const rsi = (p) => computeIndicator('rsi', real, { period: p }).rsi;
    close(rsi(14).at(-1).value, 57.935321, 5, 'rsi 14');
    close(rsi(14).at(-2).value, 57.717625, 5, 'rsi 14 at 16:16 UTC');
    close(rsi(14)[0].value, 5.056512, 5, 'rsi 14 first');
    close(rsi(5).at(-1).value, 77.714201, 5, 'rsi 5');
  },
};

function logicChecks(kind, ctx) {
  const def = INDICATORS[kind];
  const defaults = def.defaults;
  const checks = [];

  for (const source of SOURCES) {
    for (const params of GRID[kind]) {
      checks.push({ name: `${source}, ${label(params)} matches the reference`, run: () => matchReference(kind, DATA, { mult: 2, ...params }, source) });
    }
  }
  checks.push({ name: 'hand-calculated values', run: HAND[kind] });
  checks.push({
    name: 'period longer than the data gives an empty result',
    run: () => { for (const pts of Object.values(computeIndicator(kind, DATA, { period: DATA.length + 1, mult: 2 }))) equal(pts, []); },
  });
  checks.push({
    name: 'invalid periods are rejected',
    run: () => { for (const period of [0, -1, 1.5, NaN, Infinity]) throws(() => computeIndicator(kind, DATA, { period, mult: 2 }), /period/i); },
  });
  checks.push({
    name: 'bad values (NaN, null, Infinity) never reach the output',
    run: () => {
      const dirty = DATA.map((c) => ({ ...c }));
      dirty[100].close = NaN; dirty[150].close = null; dirty[200].close = Infinity;
      for (const pts of Object.values(computeIndicator(kind, dirty, { ...defaults, mult: 2 }))) {
        assert(pts.length > 0, 'nothing was calculated');
        assert(pts.every((p) => Number.isFinite(p.value)), 'a non-finite value reached the output');
      }
    },
  });
  checks.push({
    name: 'negative and very large prices',
    run: () => {
      matchReference(kind, DATA.map((c) => ({ ...c, open: c.open - 500, high: c.high - 500, low: c.low - 500, close: c.close - 500 })), { ...defaults, mult: 2 }, 'ohlc4');
      matchReference(kind, DATA.map((c) => ({ ...c, open: c.open * 1e9, high: c.high * 1e9, low: c.low * 1e9, close: c.close * 1e9 })), { ...defaults, mult: 2 }, 'close');
    },
  });
  checks.push({
    name: 'real BTCUSDT data: last-bar values match numbers calculated outside JavaScript',
    run: async () => GOLDEN[kind](await ctx.realCandles()),
  });
  return checks;
}

function uiChecks(kind, ctx) {
  const ui = () => ctx.ui;
  const def = INDICATORS[kind];
  const NORMAL = sanitizeCandles(SCENARIOS.normal()).candles;
  const defaults = { mult: 2, ...def.defaults };
  const keys = def.lines.map((l) => l.key);
  const snapshot = () => Object.fromEntries(keys.map((k) => [k, ui().app().lineData(k)]));
  const matchChart = (candles, params, source) => {
    const want = REFERENCE[kind](candles, params, source);
    for (const key of keys) compareSeries(ui().app().lineData(key), want[key]);
  };
  const checks = [];
  const add = (name, run) => checks.push({ name, ui: true, run });

  for (const source of SOURCES) {
    add(`chart: source ${source} matches the reference`, () => {
      ui().setup({ indicator: kind, source });
      matchChart(NORMAL, defaults, source);
    });
  }
  for (const period of [3, 10]) {
    add(`chart: period ${period} matches the reference`, () => {
      ui().setup({ indicator: kind });
      ui().type('period', period);
      matchChart(NORMAL, { ...defaults, period }, 'close');
    });
  }
  if (kind === 'bb') {
    add('chart: multiplier 3.5 matches the reference', () => {
      ui().setup({ indicator: kind });
      ui().type('mult', 3.5);
      matchChart(NORMAL, { ...defaults, mult: 3.5 }, 'close');
    });
    add('chart: invalid multiplier shows an error and keeps the bands', () => {
      ui().setup({ indicator: kind });
      const before = snapshot();
      ui().type('mult', -1);
      assert(/Invalid multiplier/.test(ui().text('status')), `status is "${ui().text('status')}"`);
      equal(snapshot(), before);
    });
  }
  add('chart: invalid period shows an error and keeps the lines', () => {
    ui().setup({ indicator: kind });
    const before = snapshot();
    ui().type('period', 0);
    assert(/Invalid period/.test(ui().text('status')), `status is "${ui().text('status')}"`);
    equal(snapshot(), before);
  });
  add('legend shows the last value of the main line', () => {
    ui().setup({ indicator: kind });
    const want = REFERENCE[kind](NORMAL, defaults, 'close')[def.lines.find((l) => l.primary).key].at(-1).value;
    equal(ui().text('last-sma'), want.toFixed(2));
    equal(ui().text('legend-label'), def.label);
  });
  add('every line is drawn at the right height on the canvas', async () => {
    ui().setup({ indicator: kind });
    for (const key of keys) {
      // the chart repaints a moment after a change, so look again for a while before calling it wrong
      await ui().until(() => {
        const probe = ui().app().probeLine(key);
        if (!probe || probe.ys.length === 0) return `line "${key}" is not on the canvas`;
        if (Math.max(...probe.ys) - Math.min(...probe.ys) > 12) return `line "${key}": the pixels found are not a thin line`;
        const mean = probe.ys.reduce((a, b) => a + b, 0) / probe.ys.length;
        return Math.abs(mean - probe.expectedY) <= 3 ? null
          : `line "${key}" is at y=${mean.toFixed(1)}, expected ${probe.expectedY.toFixed(1)}`;
      });
    }
  });
  add('live ticks keep the lines correct (1, 3, 5, 7, 12 ticks)', () => {
    ui().setup({ indicator: kind });
    let done = 0;
    for (const target of [1, 3, 5, 7, 12]) {
      while (done < target) { ui().app().step(); done++; }
      matchChart(expectedBars(60, target), defaults, 'close');
    }
  });
  for (const name of ['negative', 'huge', 'overflow', 'nan', 'duplicates', 'unordered', 'empty']) {
    add(`strange data "${name}": page survives, lines match the reference`, () => {
      const errorsBefore = ui().errors.length;
      ui().setup({ indicator: kind, scenario: name });
      matchChart(sanitizeCandles(SCENARIOS[name]()).candles, defaults, 'close');
      assert(ui().errors.length === errorsBefore, `page error: ${ui().errors.at(-1)}`);
      assert(ui().text('status').length > 0, 'no status shown');
    });
  }
  return checks;
}

function indicatorGroup(kind, ctx) {
  const def = INDICATORS[kind];
  return {
    id: kind,
    title: { sma: 'SMA', ema: 'EMA', bb: 'Bollinger Bands', rsi: 'RSI' }[kind],
    checks: [...logicChecks(kind, ctx), ...uiChecks(kind, ctx)],
    lines: def.lines.length,
  };
}

function dataGroup(ctx) {
  const c = (name, run) => ({ name, run });
  return {
    id: 'data',
    title: 'Data and demo feed',
    checks: [
      c('generator is deterministic for the same seed', () => equal(generateCandles({ seed: 7, count: 50 }), generateCandles({ seed: 7, count: 50 }))),
      c('generator candles are valid (high >= body >= low, time increases)', () => {
        const cs = generateCandles({ seed: 3, count: 300 });
        cs.forEach((x, i) => {
          assert(x.high >= Math.max(x.open, x.close) && x.low <= Math.min(x.open, x.close), `candle ${i} is invalid`);
          assert(i === 0 || x.time > cs[i - 1].time, `time does not increase at ${i}`);
        });
      }),
      c('a longer run starts with the shorter run (prefix-stable)', () => equal(generateCandles({ seed: 42, count: 1000 }).slice(0, 60), generateCandles({ seed: 42, count: 60 }))),
      c('feed: 5 ticks build exactly the final candle', () => {
        const feed = createFeed({ startIndex: 60 });
        let last;
        for (let i = 0; i < TICKS_PER_CANDLE; i++) last = feed.tick().candle;
        equal(last, generateCandles({ seed: 42, count: 61 })[60]);
      }),
      c('feed: first tick is a new bar, the next ones update it', () => {
        const feed = createFeed({ startIndex: 0 });
        equal(Array.from({ length: 6 }, () => feed.tick().isNew), [true, false, false, false, false, true]);
      }),
      c('feed: partial candles stay valid', () => {
        const final = generateCandles({ seed: 5, count: 1 })[0];
        for (let k = 1; k <= 5; k++) {
          const p = partialCandle(final, k, 5);
          assert(p.high >= Math.max(p.open, p.close) && p.low <= Math.min(p.open, p.close), `tick ${k} is invalid`);
        }
      }),
      c('feed: ends with null when the data is exhausted', () => {
        const feed = createFeed({ startIndex: 0, total: 1 });
        for (let i = 0; i < TICKS_PER_CANDLE; i++) assert(feed.tick(), 'ended too early');
        equal(feed.tick(), null);
      }),
      ...[['negative', 60], ['huge', 60], ['overflow', 59], ['nan', 58], ['duplicates', 60], ['unordered', 60], ['empty', 0]].map(([name, bars]) =>
        c(`sanitizer: "${name}" data set keeps ${bars} bars`, () => {
          const { candles, issues } = sanitizeCandles(SCENARIOS[name]());
          equal(candles.length, bars);
          candles.forEach((x, i) => assert(i === 0 || x.time > candles[i - 1].time, 'not sorted or duplicated'));
          if (name !== 'negative' && name !== 'huge') assert(issues.length > 0, 'the problem was not reported');
        })),
      c('SMA of the sanitized data never contains NaN', () => {
        for (const name of Object.keys(SCENARIOS)) {
          assert(computeSMA(sanitizeCandles(SCENARIOS[name]()).candles, 5, 'ohlc4').every((p) => Number.isFinite(p.value)), name);
        }
      }),
    ],
  };
}

function binanceGroup(ctx) {
  const c = (name, run) => ({ name, run });
  const msg = (over = {}) => ({ e: 'kline', s: 'BTCUSDT', k: { t: 1000, s: 'BTCUSDT', i: '1m', o: '1', h: '2', l: '0.5', c: '1.5', v: '3', x: false, ...over } });
  return {
    id: 'binance',
    title: 'Binance data format',
    checks: [
      c('a real REST row becomes a candle (seconds, numbers)', async () => {
        const [row] = await ctx.realRows();
        equal(parseKline(row), { time: 1794324480, open: 74258, high: 74259.3, low: 74126.64, close: 74132.1, volume: 15.78972 });
      }),
      c('all 50 real rows parse into finite candles with 60 s spacing', async () => {
        const cs = (await ctx.realRows()).map(parseKline);
        equal(cs.length, 50);
        cs.forEach((x, i) => {
          assert([x.time, x.open, x.high, x.low, x.close, x.volume].every(Number.isFinite), `row ${i} is not finite`);
          assert(i === 0 || x.time - cs[i - 1].time === 60, `gap at ${i}`);
        });
      }),
      c('a WebSocket kline message is parsed', () => equal(parseKlineMessage(msg(), { symbol: 'BTCUSDT', interval: '1m' }),
        { candle: { time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 }, closed: false })),
      c('change per day: hand-calculated values and formatting', () => {
        close(dayChangePercent(73488, 75800), -3.0501319, 6);
        equal(dayChangePercent(100, 0), null);
        equal(dayChangePercent(NaN, 100), null);
        equal([-3.0501319, 0.2638522, 0, 0.004, null].map(formatPercent), ['-3.05%', '+0.26%', '0.00%', '0.00%', '—']);
      }),
      c('garbage, foreign symbol and foreign interval are ignored', () => {
        const ctx2 = { symbol: 'BTCUSDT', interval: '1m' };
        for (const bad of ['{nope', '', 'null', JSON.stringify({ e: 'trade' }), msg({ s: 'ETHUSDT' }), msg({ i: '5m' })]) equal(parseKlineMessage(bad, ctx2), null);
      }),
    ],
  };
}

// Statistics against TA-Lib: every value of every series must be identical (floating point noise aside).
function talibGroup(ctx) {
  const titles = { sma: 'SMA', ema: 'EMA', bb: 'Bollinger Bands', rsi: 'RSI' };
  const checks = [];
  for (const datasetId of ['real50', 'walk300']) {
    for (const indicator of ['sma', 'ema', 'bb', 'rsi']) {
      checks.push({
        name: `${titles[indicator]} on ${datasetId} equals TA-Lib`,
        run: async () => {
          const dataset = (await ctx.talibReference()).datasets.find((d) => d.id === datasetId);
          assert(dataset, `dataset ${datasetId} is not in the reference file`);
          const stats = compareIndicator(dataset, indicator);
          const detail = { stats: { ...stats, dataset: dataset.title, datasetId, indicator: titles[indicator] } };
          const fail = (message) => Object.assign(new Error(message), { detail }); // the table still shows the numbers
          if (stats.compared === 0) throw fail('nothing was compared');
          if (stats.missing || stats.extra) throw fail(`${stats.missing} values missing, ${stats.extra} unexpected`);
          if (stats.identical !== stats.compared) {
            throw fail(`${stats.compared - stats.identical} of ${stats.compared} values differ, worst: ${JSON.stringify(stats.worst)}`);
          }
          return detail;
        },
      });
    }
  }
  return { id: 'talib', title: 'Comparison with TA-Lib', checks };
}

function coinbaseGroup() {
  const c = (name, run) => ({ name, run });
  class FakeSocket {
    constructor() { this.sent = []; }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() {}
  }
  const tick = (time, price, size = 1) => ({ data: JSON.stringify({ type: 'ticker', product_id: 'BTC-USD', price: String(price), last_size: String(size), time: new Date(time * 1000).toISOString() }) });
  const stream = (opts = {}) => {
    const candles = [];
    let socket;
    openCoinbaseStream({ symbol: 'BTC-USD', interval: '1m', onKline: (k) => candles.push(k.candle), WS: class extends FakeSocket { constructor() { super(); socket = this; } }, ...opts });
    return { candles, socket };
  };
  return {
    id: 'coinbase',
    title: 'Coinbase data format',
    checks: [
      c('a candle row [time, low, high, open, close, volume] becomes a candle', () =>
        equal(parseCandleRow([1700000000, '70', '75', '71', '74', '1.5']), { time: 1700000000, open: 71, high: 75, low: 70, close: 74, volume: 1.5 })),
      c('timeframes have the same lengths as on Binance', () => equal(COINBASE_GRANULARITY, INTERVAL_SECONDS)),
      c('a ticker message is parsed; garbage, other products and bad numbers are ignored', () => {
        const good = { type: 'ticker', product_id: 'BTC-USD', price: '73068.94', last_size: '0.25', time: '2026-11-10T16:34:51Z' };
        equal(parseTicker(good, { symbol: 'BTC-USD' }), { price: 73068.94, size: 0.25, time: Date.parse('2026-11-10T16:34:51Z') / 1000 });
        for (const bad of ['{nope', { ...good, product_id: 'ETH-USD' }, { ...good, price: 'x' }, { ...good, price: '0' }, { ...good, time: 'later' }, { type: 'heartbeat' }]) {
          equal(parseTicker(bad, { symbol: 'BTC-USD' }), null);
        }
      }),
      c('trades build candles: same minute updates, next minute opens a new one', () => {
        const { candles, socket } = stream();
        const t = Date.UTC(2026, 10, 10, 16, 34, 0) / 1000;
        socket.onmessage(tick(t + 5, 100, 1));
        socket.onmessage(tick(t + 30, 105, 2));
        socket.onmessage(tick(t + 40, 98, 1));
        equal(candles.at(-1), { time: t, open: 100, high: 105, low: 98, close: 98, volume: 4 });
        socket.onmessage(tick(t + 60, 110, 1));
        equal(candles.at(-1), { time: t + 60, open: 110, high: 110, low: 110, close: 110, volume: 1 });
      }),
      c('the stream subscribes to ticker and heartbeat when it opens', () => {
        const { socket } = stream();
        socket.onopen();
        equal(socket.sent, [{ type: 'subscribe', channels: [{ name: 'ticker', product_ids: ['BTC-USD'] }, { name: 'heartbeat', product_ids: ['BTC-USD'] }] }]);
      }),
    ],
  };
}

/** @param ctx { realRows(): Promise<rows>, realCandles(): Promise<candles>, talibReference(): Promise<reference file>, ui?: driver } */
export function buildGroups(ctx) {
  return [
    ...['sma', 'ema', 'bb', 'rsi'].map((kind) => indicatorGroup(kind, ctx)),
    talibGroup(ctx),
    dataGroup(ctx),
    binanceGroup(ctx),
    coinbaseGroup(),
  ];
}
