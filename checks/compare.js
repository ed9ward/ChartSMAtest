// Compares the app's indicator values with values calculated by other implementations (TA-Lib, pandas).
import { computeIndicator, INDICATORS } from '../src/indicators.js';
import { REFERENCE_SPEC, expectedKeys, seriesKey } from './reference-spec.js';

export const IDENTICAL = 1e-8; // relative; floating point noise only
const NEAR_ZERO = 1e-3;        // values smaller than this fraction of the line's own scale are judged against that scale

// "To the cent": closer than half a cent. (Rounding both numbers first would fail on exact halves by 1e-11.)
const withinCent = (a, b) => Math.abs(a - b) < 0.005;

const COUNTERS = ['compared', 'identical', 'cents', 'missing', 'extra', 'outside', 'duplicates', 'unordered', 'expected', 'sumDiff'];

/**
 * @param ours   [{time, value}] points calculated by the app
 * @param theirs values aligned with `times` (null where the other implementation gives nothing)
 *
 * Everything that is not an exact match is counted: values the app lacks (missing), values it has where the other side
 * has none (extra), points with a timestamp that is not in the reference at all (outside), a timestamp used twice
 * (duplicates) and points that are not in ascending order (unordered).
 */
export function compareLine(ours, theirs, times) {
  const stats = { compared: 0, identical: 0, cents: 0, missing: 0, extra: 0, outside: 0, duplicates: 0, unordered: 0, expected: 0, maxDiff: 0, sumDiff: 0, worst: null };
  const inRange = new Set(times);
  // The tolerance follows the size of the numbers, so it is as strict for prices around 0.00001 as for prices around 73000;
  // a value that should be 0 may differ from it by noise relative to the scale of the whole line.
  const scale = Math.max(0, ...theirs.filter(Number.isFinite).map(Math.abs));
  const byTime = new Map();
  let newest = -Infinity;
  for (const p of ours) {
    if (p.time < newest) stats.unordered++;
    newest = Math.max(newest, p.time);
    if (byTime.has(p.time)) { stats.duplicates++; continue; } // the first one is compared, the repeat is only counted
    byTime.set(p.time, p.value);
    if (!inRange.has(p.time)) stats.outside++;
  }
  times.forEach((time, i) => {
    const want = theirs[i];
    const got = byTime.get(time);
    if (want === null || want === undefined) {
      if (got !== undefined) stats.extra++; // the app has a value where the other implementation has none
      return;
    }
    stats.expected++;
    if (got === undefined) { stats.missing++; return; }
    const diff = Math.abs(got - want);
    stats.compared++;
    stats.sumDiff += diff;
    if (diff <= IDENTICAL * Math.max(Math.abs(want), NEAR_ZERO * scale)) stats.identical++;
    if (withinCent(got, want)) stats.cents++;
    if (diff > stats.maxDiff) { stats.maxDiff = diff; stats.worst = { time, ours: got, theirs: want }; }
  });
  return stats;
}

export function mergeStats(list) {
  const total = { maxDiff: 0, worst: null, series: 0, ...Object.fromEntries(COUNTERS.map((k) => [k, 0])) };
  for (const s of list) {
    for (const k of COUNTERS) total[k] += s[k];
    if (s.maxDiff > total.maxDiff) { total.maxDiff = s.maxDiff; total.worst = s.worst; }
    total.series++;
  }
  total.meanDiff = total.compared ? total.sumDiff / total.compared : 0;
  return total;
}

const count = (list) => list.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map());

/**
 * Statistics for one indicator of one reference dataset (all of its sources, periods and lines).
 * `start` selects the EMA variant ('first' or 'sma'); other indicators have none.
 * `problems` lists everything structural that is wrong: series of the specification that are missing from the file or
 * repeated in it, series nobody asked for, lines of the indicator that the file or the app lacks (or has too many of),
 * and series where nothing could be compared.
 */
export function compareIndicator(dataset, indicator, start) {
  const times = dataset.candles.map((c) => c.time);
  const problems = [];
  const chosen = dataset.series.filter((x) => x.indicator === indicator && (start === undefined || x.seed === start));

  const spec = REFERENCE_SPEC.datasets.find((d) => d.id === dataset.id);
  if (!spec) {
    problems.push(`dataset ${dataset.id} is not in the specification`);
  } else {
    const wanted = expectedKeys(spec, indicator, start);
    const have = count(chosen.map(seriesKey));
    for (const key of wanted) if (!have.has(key)) problems.push(`series ${key} is missing from the reference`);
    for (const [key, n] of have) {
      if (!wanted.includes(key)) problems.push(`series ${key} is not expected`);
      if (n > 1) problems.push(`series ${key} appears ${n} times`);
    }
  }

  const declared = INDICATORS[indicator].lines.map((l) => l.key);
  const all = [];
  for (const s of chosen) {
    const label = seriesKey(s);
    for (const key of Object.keys(s.lines)) if (!declared.includes(key)) problems.push(`${label}: the reference has a line "${key}" that ${indicator} does not have`);
    const got = computeIndicator(indicator, dataset.candles, { period: s.period, mult: s.mult, start: s.seed }, s.source);
    for (const key of declared) {
      if (!s.lines[key]) { problems.push(`${label}: the reference has no line "${key}"`); continue; }
      if (!got[key]) { problems.push(`${label}: the app produced no line "${key}"`); continue; }
      const stats = compareLine(got[key], s.lines[key], times);
      if (stats.expected === 0) problems.push(`${label}/${key}: there is nothing to compare`);
      all.push({ ...stats, label: `${s.source}/${s.period}/${key}` });
    }
  }
  return { ...mergeStats(all), reference: chosen[0]?.reference ?? 'TA-Lib', problems };
}

/** Why a comparison cannot be called a success; null when every value of every line is identical and nothing is out of place. */
export function comparisonProblem(stats) {
  if (stats.problems.length) return `${stats.problems.length} problem(s) with the series, e.g. ${stats.problems[0]}`;
  if (stats.compared === 0) return 'nothing was compared';
  const odd = ['missing', 'extra', 'outside', 'duplicates', 'unordered'].filter((k) => stats[k]);
  if (odd.length) return odd.map((k) => `${stats[k]} ${k}`).join(', ');
  if (stats.compared !== stats.expected) return `${stats.compared} of ${stats.expected} reference values were compared`;
  if (stats.identical !== stats.compared) return `${stats.compared - stats.identical} of ${stats.compared} values differ, worst: ${JSON.stringify(stats.worst)}`;
  return null;
}
