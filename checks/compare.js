// Compares the app's indicator values with values calculated by another implementation (TA-Lib).
import { computeIndicator } from '../src/indicators.js';

export const IDENTICAL = 1e-8; // relative; floating point noise only

// "To the cent": closer than half a cent. (Rounding both numbers first would fail on exact halves by 1e-11.)
const withinCent = (a, b) => Math.abs(a - b) < 0.005;

/**
 * @param ours   [{time, value}] points calculated by the app
 * @param theirs values aligned with `times` (null where the other implementation gives nothing)
 */
export function compareLine(ours, theirs, times) {
  const byTime = new Map(ours.map((p) => [p.time, p.value]));
  const stats = { compared: 0, identical: 0, cents: 0, missing: 0, extra: 0, maxDiff: 0, sumDiff: 0, worst: null };
  times.forEach((time, i) => {
    const want = theirs[i];
    const got = byTime.get(time);
    if (want === null || want === undefined) {
      if (got !== undefined) stats.extra++; // the app has a value where the other implementation has none
      return;
    }
    if (got === undefined) { stats.missing++; return; }
    const diff = Math.abs(got - want);
    stats.compared++;
    stats.sumDiff += diff;
    if (diff <= IDENTICAL * Math.max(1, Math.abs(want))) stats.identical++;
    if (withinCent(got, want)) stats.cents++;
    if (diff > stats.maxDiff) { stats.maxDiff = diff; stats.worst = { time, ours: got, theirs: want }; }
  });
  return stats;
}

export function mergeStats(list) {
  const total = { compared: 0, identical: 0, cents: 0, missing: 0, extra: 0, maxDiff: 0, sumDiff: 0, worst: null, series: 0 };
  for (const s of list) {
    for (const k of ['compared', 'identical', 'cents', 'missing', 'extra', 'sumDiff']) total[k] += s[k];
    if (s.maxDiff > total.maxDiff) { total.maxDiff = s.maxDiff; total.worst = s.worst; }
    total.series++;
  }
  total.meanDiff = total.compared ? total.sumDiff / total.compared : 0;
  return total;
}

/**
 * Statistics for one indicator of one reference dataset (all of its sources, periods and lines).
 * `start` selects the EMA variant ('first' or 'sma'); other indicators have none.
 */
export function compareIndicator(dataset, indicator, start) {
  const times = dataset.candles.map((c) => c.time);
  const all = [];
  const chosen = dataset.series.filter((x) => x.indicator === indicator && (start === undefined || x.seed === start));
  for (const s of chosen) {
    const got = computeIndicator(indicator, dataset.candles, { period: s.period, mult: s.mult, start: s.seed }, s.source);
    for (const [line, values] of Object.entries(s.lines)) {
      all.push({ ...compareLine(got[line] ?? [], values, times), label: `${s.source}/${s.period}/${line}` });
    }
  }
  return { ...mergeStats(all), reference: chosen[0]?.reference ?? 'TA-Lib' };
}
