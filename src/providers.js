// The live data sources the page can choose from. Each provides fetchHistory() and openStream().
import * as binance from './live.js';
import * as coinbase from './coinbase.js';

export const PROVIDERS = {
  binance: {
    label: 'Binance',
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'],
    fetchHistory: binance.fetchHistory,
    openStream: binance.openStream,
  },
  coinbase: {
    label: 'Coinbase',
    symbols: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
    fetchHistory: coinbase.fetchHistory,
    openStream: coinbase.openStream,
  },
};
