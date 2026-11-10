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


# The grid, declared once: it drives the generation and is written into the file as `spec`, and the JS side
# (checks/reference-spec.js) declares the same grid on its own. verify() refuses to write an incomplete file.
SOURCES_ALL = SOURCES
DATASET_SPECS = [
    {"id": "real50", "candles": 50, "sources": SOURCES_ALL, "periods": [5, 14, 20]},
    {"id": "walk300", "candles": 300, "sources": ["close", "hlc3", "volume"], "periods": [14, 50, 200]},
]
VARIANTS = [
    {"indicator": "sma"},
    {"indicator": "ema", "seed": "first", "reference": "pandas"},
    {"indicator": "ema", "seed": "sma", "reference": "TA-Lib"},
    {"indicator": "bb", "mult": 2},
    {"indicator": "rsi"},
]


def make_series(c, variant, source, period):
    if variant["indicator"] == "ema":
        return ema_series(c, source, period, variant["seed"])
    return series_for(c, variant["indicator"], source, period)


def build(dataset_spec, title, rows):
    c = {k: np.array([r[k] for r in rows], dtype=float) for k in ("open", "high", "low", "close", "volume")}
    series = [
        make_series(c, variant, source, period)
        for source in dataset_spec["sources"]
        for period in dataset_spec["periods"]
        for variant in VARIANTS
    ]
    return {"id": dataset_spec["id"], "title": title, "candles": rows, "series": series}


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
    build(DATASET_SPECS[0], "50 real BTCUSDT 1m bars from Binance", real_rows()),
    build(DATASET_SPECS[1], "300 random-walk bars (generated independently of the app)", random_walk_rows()),
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

LINES = {"sma": ["sma"], "ema": ["ema"], "bb": ["upper", "basis", "lower"], "rsi": ["rsi"]}


def warmup(variant, period):
    if variant["indicator"] == "rsi":
        return period
    return 0 if variant["indicator"] == "ema" and variant.get("seed") == "first" else period - 1


def verify(doc):
    """Refuses to write a file that lacks anything it should have, or has something it should not."""
    assert doc["spec"]["datasets"] == [{k: d[k] for k in ("id", "candles", "sources", "periods")} for d in DATASET_SPECS]
    assert [d["id"] for d in doc["datasets"]] == [d["id"] for d in DATASET_SPECS]
    for spec, dataset in zip(DATASET_SPECS, doc["datasets"]):
        n = len(dataset["candles"])
        assert n == spec["candles"], f"{spec['id']}: {n} candles"
        times = [c["time"] for c in dataset["candles"]]
        assert all(b > a for a, b in zip(times, times[1:])), f"{spec['id']}: candle times are not increasing"
        wanted = [(v["indicator"], v.get("seed"), source, period) for source in spec["sources"] for period in spec["periods"] for v in VARIANTS]
        got = [(s["indicator"], s.get("seed"), s["source"], s["period"]) for s in dataset["series"]]
        assert sorted(map(str, got)) == sorted(map(str, wanted)), f"{spec['id']}: the series are not exactly the expected ones"
        assert len(set(map(str, got))) == len(got), f"{spec['id']}: a series appears twice"
        for s in dataset["series"]:
            variant = next(v for v in VARIANTS if v["indicator"] == s["indicator"] and v.get("seed") == s.get("seed"))
            assert sorted(s["lines"]) == sorted(LINES[s["indicator"]]), f"{spec['id']}: lines of {s['indicator']}"
            for line, values in s["lines"].items():
                assert len(values) == n, f"{spec['id']}: {s['indicator']}/{line} has {len(values)} values"
                first = warmup(variant, s["period"])
                assert all((v is None) == (i < first) for i, v in enumerate(values)), f"{spec['id']}: {s['indicator']}/{line} has a wrong warm-up"
    assert [e["title"] for e in doc["rsiEdge"]] == doc["spec"]["rsiEdge"]


doc = {
    "generatedWith": {"TA-Lib": talib.__version__, "pandas": pd.__version__, "numpy": np.__version__},
    "spec": {
        "datasets": [{k: d[k] for k in ("id", "candles", "sources", "periods")} for d in DATASET_SPECS],
        "variants": VARIANTS,
        "rsiEdge": [e["title"] for e in rsi_edge],
        "libraries": ["TA-Lib", "pandas", "numpy"],
    },
    "datasets": datasets,
    "rsiEdge": rsi_edge,
}
verify(doc)
path = FIXTURES / "talib-reference.json"
path.write_text(json.dumps(doc, separators=(",", ":")))
print(path, f"{path.stat().st_size / 1024:.0f} KB", [(d["id"], len(d["series"])) for d in datasets])
