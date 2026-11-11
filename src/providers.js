// The live data sources the page can choose from. Each provides fetchHistory() and openStream().
import * as binance from './live.js';
import * as coinbase from './coinbase.js';

export const PROVIDERS = {
  binance: {
    label: 'Binance',
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'],
    historyBars: 1000,       // Binance allows 1000 candles per request: the most history for EMA and RSI to settle on
    reloadOnBarGap: true,    // a bar that starts later than the next one may mean lost messages: take the history again
    staleMs: 30_000,         // no message at all for this long: the connection is dead (kline updates come every ~2 s)
    maxConnectionMs: 23 * 60 * 60 * 1000 + 50 * 60 * 1000, // rotate before Binance's 24-hour connection lifetime
    fetchHistory: binance.fetchHistory,
    openStream: binance.openStream,
  },
  coinbase: {
    label: 'Coinbase',
    symbols: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
    historyBars: 300,        // Coinbase allows 300 candles per request
    reloadOnBarGap: false,   // trades are tracked by id, so a minute without trades is just a minute without trades
    sparseHistory: true,     // Coinbase publishes no candle for an interval with no ticks
    bootstrapBucket: true,   // rebuild the forming candle from trades after the first last_match watermark
    staleMs: 10_000,         // heartbeats come every second
    fetchHistory: coinbase.fetchHistory,
    openStream: coinbase.openStream,
  },
};
