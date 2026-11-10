// Page logic for checks.html: runs the checks and shows progress and timing.
import { buildGroups } from './definitions.js';
import { runChecks } from './runner.js';
import { createUiDriver } from './ui.js';
import { parseKline } from '../src/live.js';

const $ = (id) => document.getElementById(id);
const bug = new URLSearchParams(location.search).get('bug'); // passed on to the chart so the checks can be shown to fail

const fmtTime = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);
const text = (el, value) => { el.textContent = String(value); };

let rowsPromise;
const realRows = () => (rowsPromise ??= fetch('tests/fixtures/btcusdt-1m.json').then((r) => {
  if (!r.ok) throw new Error(`could not load the real-data sample: HTTP ${r.status}`);
  return r.json();
}));

let talibPromise;
const talibReference = () => (talibPromise ??= fetch('tests/fixtures/talib-reference.json').then((r) => {
  if (!r.ok) throw new Error(`could not load the TA-Lib reference: HTTP ${r.status}`);
  return r.json();
}));

const pct = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(part === whole ? 0 : 2)}%` : '–');
const diffText = (x) => (x === 0 ? '0' : x < 1e-6 ? x.toExponential(1) : x.toFixed(6));

function addStatsRow(stats) {
  $('stats').hidden = false;
  const tr = document.createElement('tr');
  tr.dataset.testid = `stat-${stats.datasetId}-${stats.key}`;
  const ok = stats.identical === stats.compared && stats.cents === stats.compared;
  tr.innerHTML = `<td></td><td></td><td class="reference"></td><td class="num compared"></td><td class="num identical${ok ? ' ok' : ''}"></td>
    <td class="num cents${ok ? ' ok' : ''}"></td><td class="num max"></td><td class="num mean"></td>`;
  const cells = tr.children;
  cells[0].textContent = stats.dataset;
  cells[1].textContent = `${stats.indicator} (${stats.series} series)`;
  cells[2].textContent = stats.reference;
  cells[3].textContent = stats.compared;
  cells[4].textContent = `${stats.identical} (${pct(stats.identical, stats.compared)})`;
  cells[5].textContent = `${stats.cents} (${pct(stats.cents, stats.compared)})`;
  cells[6].textContent = diffText(stats.maxDiff);
  cells[7].textContent = diffText(stats.meanDiff);
  $('stats-body').append(tr);
}

const rowFor = (g) => {
  const tr = document.createElement('tr');
  tr.dataset.testid = `group-${g.id}`;
  tr.innerHTML = `<td>${g.title}</td><td class="num total">${g.checks.length}</td><td class="num passed">0</td>
    <td class="num failed">0</td><td class="num time">–</td><td><progress max="${g.checks.length}" value="0"></progress></td>`;
  return tr;
};

async function run() {
  const button = $('run');
  button.disabled = true;
  $('include-ui').disabled = true;
  $('watch').disabled = true;
  const withUi = $('include-ui').checked;
  text($('state'), 'running');
  $('verdict').textContent = '';
  $('verdict').className = '';
  $('groups').replaceChildren();
  $('details').replaceChildren();
  $('stats-body').replaceChildren();
  $('stats').hidden = true;
  for (const id of ['passed', 'failed']) text($(id), 0);

  const startedAt = performance.now();
  const timer = setInterval(() => text($('elapsed'), fmtTime(performance.now() - startedAt)), 100);
  const rows = new Map();
  const lists = new Map();
  let passed = 0;
  let failed = 0;

  try {
    const ctx = { realRows, talibReference, realCandles: async () => (await realRows()).map((row) => parseKline(row)) };
    if (withUi) ctx.ui = await createUiDriver($('app')).load(bug ? `?bug=${encodeURIComponent(bug)}` : '');

    const summary = await runChecks(buildGroups(ctx), {
      include: (check) => withUi || !check.ui,
      pauseMs: $('watch').checked ? 25 : 0,
      onStart({ total, groups }) {
        $('bar').max = total;
        $('bar').value = 0;
        text($('counter'), `0 / ${total}`);
        for (const g of groups) {
          const tr = rowFor(g);
          rows.set(g.id, { tr, passed: 0, failed: 0, ms: 0 });
          $('groups').append(tr);
          const details = document.createElement('details');
          details.dataset.testid = `details-${g.id}`;
          details.innerHTML = `<summary>${g.title}</summary><ul class="list"></ul>`;
          lists.set(g.id, details.querySelector('ul'));
          $('details').append(details);
        }
      },
      onCheck(r) {
        if (r.detail?.stats) addStatsRow(r.detail.stats);
        r.ok ? passed++ : failed++;
        $('bar').value = r.index;
        text($('counter'), `${r.index} / ${r.total}`);
        text($('passed'), passed);
        text($('failed'), failed);
        text($('current'), `${r.groupTitle} › ${r.name}`);
        const row = rows.get(r.group);
        row.ms += r.ms;
        r.ok ? row.passed++ : row.failed++;
        const cells = row.tr;
        text(cells.querySelector('.passed'), row.passed);
        text(cells.querySelector('.failed'), row.failed);
        cells.querySelector('.failed').classList.toggle('some', row.failed > 0);
        text(cells.querySelector('.time'), fmtTime(row.ms));
        cells.querySelector('progress').value = row.passed + row.failed;
        const li = document.createElement('li');
        li.className = r.ok ? 'ok' : 'fail';
        li.dataset.testid = r.ok ? 'check-ok' : 'check-fail';
        li.innerHTML = '<span class="name"></span><span class="ms"></span>';
        li.querySelector('.name').textContent = r.name;
        li.querySelector('.ms').textContent = fmtTime(r.ms);
        if (!r.ok) {
          const err = document.createElement('span');
          err.className = 'err';
          err.textContent = r.error;
          li.querySelector('.name').append(err);
          lists.get(r.group).closest('details').open = true;
        }
        lists.get(r.group).append(li);
      },
      onGroupDone(g) {
        rows.get(g.id).tr.classList.add(g.failed ? 'done-bad' : 'done-ok');
      },
    });

    if (ctx.ui) ctx.ui.setup(); // leave the chart in its normal state
    text($('elapsed'), fmtTime(summary.ms));
    const verdict = $('verdict');
    verdict.classList.add(summary.failed ? 'bad' : 'ok');
    const timing = $('watch').checked ? `${fmtTime(summary.ms)}, of which the checks themselves took ${fmtTime(summary.checkMs)}` : fmtTime(summary.ms);
    text(verdict, summary.failed
      ? `${summary.failed} of ${summary.total} checks failed (${timing})`
      : `All ${summary.total} checks passed in ${timing}`);
    text($('state'), 'finished');
    text($('current'), '');
  } catch (e) {
    text($('verdict'), `The checks could not run: ${e.message}`);
    $('verdict').className = 'bad';
    text($('state'), 'error');
  } finally {
    clearInterval(timer);
    button.disabled = false;
    $('include-ui').disabled = false;
    $('watch').disabled = false;
  }
}

$('run').addEventListener('click', run);
