// Coinbase Exchange public market data (no API key): REST candles + WebSocket ticker.
// Candle rows: [time (s, start of bucket), low, high, open, close, volume], newest first, at most 300 per request.

export const COINBASE_GRANULARITY = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1d': 86400 };
export const COINBASE_REST = 'https://api.exchange.coinbase.com';
export const COINBASE_WS = 'wss://ws-feed.exchange.coinbase.com';
export const MAX_CANDLES = 300;

export function parseCandleRow(row) {
  if (!Array.isArray(row) || row.length < 6) return null;
  const [time, low, high, open, close, volume] = row.map(Number);
  return { time, open, high, low, close, volume };
}

export async function fetchHistory({ symbol, interval, limit = MAX_CANDLES, signal, fetchFn = fetch }) {
  const granularity = COINBASE_GRANULARITY[interval];
  if (!granularity) throw new Error(`Coinbase has no ${interval} timeframe`);
  const url = `${COINBASE_REST}/products/${encodeURIComponent(symbol)}/candles?granularity=${granularity}`;
  const res = await fetchFn(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error(body?.message || 'unexpected response');
  const candles = body.map(parseCandleRow).filter(Boolean).sort((a, b) => a.time - b.time);
  return candles.slice(-Math.min(limit, MAX_CANDLES));
}

// {"type":"ticker","product_id":"BTC-USD","price":"73068.94","last_size":"0.01","time":"2026-11-10T16:34:51.123456Z", ...}
// Returns null for anything that is not a well-formed ticker of the expected product.
export function parseTicker(data, { symbol } = {}) {
  let msg = data;
  if (typeof data === 'string') {
    try { msg = JSON.parse(data); } catch { return null; }
  }
  if (msg?.type !== 'ticker') return null;
  if (symbol && msg.product_id !== symbol) return null;
  const price = Number(msg.price);
  const time = Date.parse(msg.time) / 1000;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(time)) return null;
  const size = Number(msg.last_size);
  return { price, size: Number.isFinite(size) && size > 0 ? size : 0, time };
}

/**
 * Opens the ticker stream and turns trades into candles of the chosen timeframe.
 * `seed` is the newest candle of the history, so a candle that is already under way is continued, not restarted.
 * onClose fires only when the connection ends without close() being called; onError for an error message of the server.
 */
export function openStream({ symbol, interval, onKline, onClose, onError, seed, WS = WebSocket }) {
  const granularity = COINBASE_GRANULARITY[interval];
  const ws = new WS(COINBASE_WS);
  let closedByUs = false;
  let current = seed ? { ...seed } : null;

  ws.onopen = () => ws.send(JSON.stringify({
    type: 'subscribe',
    channels: [{ name: 'ticker', product_ids: [symbol] }, { name: 'heartbeat', product_ids: [symbol] }], // heartbeat keeps the socket open
  }));

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg?.type === 'error') return void onError?.(msg.message || msg.reason || 'error');
    const trade = parseTicker(msg, { symbol });
    if (!trade) return;
    const bucket = Math.floor(trade.time / granularity) * granularity;
    if (current && bucket < current.time) return; // a late message of an older candle
    if (!current || bucket > current.time) {
      current = { time: bucket, open: trade.price, high: trade.price, low: trade.price, close: trade.price, volume: trade.size };
    } else {
      current = {
        ...current,
        high: Math.max(current.high, trade.price),
        low: Math.min(current.low, trade.price),
        close: trade.price,
        volume: current.volume + trade.size,
      };
    }
    onKline({ candle: { ...current }, closed: false });
  };

  ws.onclose = () => { if (!closedByUs) onClose?.(); };
  return { close() { closedByUs = true; ws.close(); } };
}
