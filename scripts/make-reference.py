"""Calculates indicator values with independent libraries and stores them in tests/fixtures/talib-reference.json.
The app's own results are compared against this file (checks.html).

  SMA, Bollinger Bands, RSI       TA-Lib (industry-standard C library)
  EMA, first value as the start   pandas  ewm(span, adjust=False): y0 = x0, y[t] = a*x[t] + (1-a)*y[t-1]  (the reference
                                  implementation in the TradingView Pine documentation does the same)
  EMA, SMA of the first N values  TA-Lib  (TA-Lib's own start)

Run:  python scripts/make-reference.py        (needs:  pip install TA-Lib numpy pandas)
"""
import json
import pathlib

import numpy as np
import pandas as pd
import talib

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"

SOURCES = ["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4"]


def source_values(c, source):
    # TA-Lib's own price transforms, so the price sources are independent of the app too
    if source == "hl2":
        return talib.MEDPRICE(c["high"], c["low"])
    if source == "hlc3":
        return talib.TYPPRICE(c["high"], c["low"], c["close"])
    if source == "ohlc4":
        return talib.AVGPRICE(c["open"], c["high"], c["low"], c["close"])
    return c[source]


def cleaned(values):
    return [None if not np.isfinite(v) else round(float(v), 10) for v in values]


def series_for(c, indicator, source, period, mult=2):
    x = np.ascontiguousarray(source_values(c, source), dtype=float)
    if indicator == "sma":
        lines = {"sma": talib.SMA(x, period)}
    elif indicator == "ema":  # see `ema_series` for the two starts
        raise ValueError("use ema_series")
    elif indicator == "rsi":
        lines = {"rsi": talib.RSI(x, period)}
    else:  # Bollinger Bands: population standard deviation, SMA basis
        upper, middle, lower = talib.BBANDS(x, period, mult, mult, 0)
        lines = {"upper": upper, "basis": middle, "lower": lower}
    out = {"indicator": indicator, "source": source, "period": period, "lines": {k: cleaned(v) for k, v in lines.items()}}
    if indicator == "bb":
        out["mult"] = mult
    return out


def ema_series(c, source, period, seed):
    x = np.ascontiguousarray(source_values(c, source), dtype=float)
    if seed == "first":
        values = pd.Series(x).ewm(span=period, adjust=False).mean().to_numpy()
        reference = "pandas"
    else:
        values = talib.EMA(x, period)
        reference = "TA-Lib"
    return {"indicator": "ema", "seed": seed, "reference": reference, "source": source, "period": period, "lines": {"ema": cleaned(values)}}


def build(dataset_id, title, rows, sources, periods):
    c = {k: np.array([r[k] for r in rows], dtype=float) for k in ("open", "high", "low", "close", "volume")}
    series = []
    for source in sources:
        for period in periods:
            if period >= len(rows):
                continue
            series.append(series_for(c, "sma", source, period))
            series.append(ema_series(c, source, period, "first"))
            series.append(ema_series(c, source, period, "sma"))
            series.append(series_for(c, "bb", source, period))
            series.append(series_for(c, "rsi", source, period))
    return {"id": dataset_id, "title": title, "candles": rows, "series": series}


def real_rows():
    raw = json.loads((FIXTURES / "btcusdt-1m.json").read_text())
    return [
        {"time": int(r[0]) // 1000, "open": float(r[1]), "high": float(r[2]), "low": float(r[3]), "close": float(r[4]), "volume": float(r[5])}
        for r in raw
    ]


def random_walk_rows(count=300, seed=7):
    rng = np.random.RandomState(seed)
    close = 100 + np.cumsum(rng.normal(0, 1.5, count))
    rows, prev = [], 100.0
    for i in range(count):
        o, c = prev, float(close[i])
        rows.append({
            "time": 1_700_000_000 + 60 * i,
            "open": round(o, 2), "close": round(c, 2),
            "high": round(max(o, c) + float(rng.uniform(0, 1.5)), 2),
            "low": round(min(o, c) - float(rng.uniform(0, 1.5)), 2),
            "volume": round(float(rng.uniform(1000, 10000)), 2),
        })
        prev = c
    return rows


datasets = [
    build("real50", "50 real BTCUSDT 1m bars from Binance", real_rows(), SOURCES, [5, 14, 20]),
    build("walk300", "300 random-walk bars (generated independently of the app)", random_walk_rows(), ["close", "hlc3", "volume"], [14, 50, 200]),
]
# --- RSI edge cases: what each convention says when there is no movement at all -----------------------------------
# TradingView's published RSI code:  up = rma(max(change, 0), n); down = rma(-min(change, 0), n)
#                                    rsi = down == 0 ? 100 : up == 0 ? 0 : 100 - 100 / (1 + up / down)
# (rma seeds with the SMA of the first n values; IEEE doubles like everywhere else). TA-Lib returns 50 for "no movement".
def tradingview_rsi(x, p):
    n = len(x)
    out, flat_bars = [None] * n, []
    if n <= p:
        return out, flat_bars
    ups = [0.0] + [max(x[i] - x[i - 1], 0.0) for i in range(1, n)]
    downs = [0.0] + [max(x[i - 1] - x[i], 0.0) for i in range(1, n)]
    up, down = sum(ups[1:p + 1]) / p, sum(downs[1:p + 1]) / p
    alpha = 1.0 / p

    def value(i):
        if up == 0.0 and down == 0.0:
            flat_bars.append(i)
        out[i] = 100.0 if down == 0.0 else (0.0 if up == 0.0 else 100.0 - 100.0 / (1.0 + up / down))

    value(p)
    for i in range(p + 1, n):
        up = alpha * ups[i] + (1.0 - alpha) * up
        down = alpha * downs[i] + (1.0 - alpha) * down
        value(i)
    return out, flat_bars


def rsi_edge_scenarios():
    rise, fall = [float(i) for i in range(1, 13)], [float(i) for i in range(12, 0, -1)]
    return [
        ("flat", [5.0] * 12, 3),
        ("flat, period 14", [5.0] * 40, 14),
        ("only up", rise, 3),
        ("only down", fall, 3),
        ("only up, period 14", [float(i) for i in range(1, 41)], 14),
        ("only down, period 14", [float(i) for i in range(40, 0, -1)], 14),
        ("up, then flat", [float(i) for i in range(1, 9)] + [8.0] * 10, 3),
        ("down, then flat", [float(i) for i in range(8, 0, -1)] + [1.0] * 10, 3),
        ("zigzag up, then flat", [1.0, 3.0, 2.0, 4.0, 3.0, 5.0, 4.0, 6.0] + [6.0] * 12, 3),
        ("zigzag down, then flat", [6.0, 4.0, 5.0, 3.0, 4.0, 2.0, 3.0, 1.0] + [1.0] * 12, 3),
        ("flat, then up", [5.0] * 6 + [6.0, 7.0, 8.0], 3),
        ("flat, then down", [5.0] * 6 + [4.0, 3.0, 2.0], 3),
        ("up, flat, down", [float(i) for i in range(1, 7)] + [6.0] * 6 + [5.0, 4.0, 3.0], 3),
        ("period 2, up, then 1300 flat bars (the averages underflow to zero)", [1.0, 3.0, 2.0, 4.0, 3.0, 5.0, 4.0] + [5.0] * 1300, 2),
        ("period 1: up, flat, down", [1.0, 2.0, 2.0, 1.0, 1.0, 3.0], 1),
    ]


rsi_edge = []
for title, closes, period in rsi_edge_scenarios():
    tv, flat_bars = tradingview_rsi(closes, period)
    ta = cleaned(talib.RSI(np.array(closes), period)) if period >= 2 else None  # TA-Lib needs a period of at least 2
    rsi_edge.append({"title": title, "period": period, "closes": closes, "tradingview": tv, "talib": ta, "flatBars": flat_bars})

doc = {"generatedWith": {"TA-Lib": talib.__version__, "pandas": pd.__version__, "numpy": np.__version__}, "datasets": datasets, "rsiEdge": rsi_edge}
path = FIXTURES / "talib-reference.json"
path.write_text(json.dumps(doc, separators=(",", ":")))
print(path, f"{path.stat().st_size / 1024:.0f} KB", [(d["id"], len(d["series"])) for d in datasets])
