// Runs groups of checks one after another, times each of them and reports progress.
// A check is { name, ui?: boolean, run(): any | Promise<any> }; throwing means "failed", a returned value is kept as `detail`.

export async function runChecks(groups, { include = () => true, pauseMs = 0, onStart, onCheck, onGroupDone } = {}) {
  const selected = groups
    .map((g) => ({ ...g, checks: g.checks.filter(include) }))
    .filter((g) => g.checks.length > 0);
  const total = selected.reduce((n, g) => n + g.checks.length, 0);
  onStart?.({ total, groups: selected });

  const started = performance.now();
  let lastYield = started;
  let index = 0;
  const results = [];
  const summaries = [];
  let checkMs = 0;

  for (const group of selected) {
    const summary = { id: group.id, title: group.title, total: group.checks.length, passed: 0, failed: 0, ms: 0 };
    for (const check of group.checks) {
      const t0 = performance.now();
      let error = null;
      let detail;
      try {
        detail = await check.run();
      } catch (e) {
        error = e?.message ?? String(e);
        detail = e?.detail; // a failing check may still report its numbers
      }
      const ms = performance.now() - t0;
      summary.ms += ms;
      checkMs += ms;
      if (error) summary.failed++; else summary.passed++;
      const result = { group: group.id, name: check.name, ui: !!check.ui, ok: !error, error, ms, detail };
      results.push(result);
      onCheck?.({ ...result, groupTitle: group.title, index: ++index, total });
      if (pauseMs > 0 || performance.now() - lastYield > 30) { // let the page repaint now and then
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
        lastYield = performance.now();
      }
    }
    summaries.push(summary);
    onGroupDone?.(summary);
  }

  const failed = summaries.reduce((n, g) => n + g.failed, 0);
  // ms: wall time (includes pauses); checkMs: time spent inside the checks themselves
  return { total, passed: total - failed, failed, ms: performance.now() - started, checkMs, groups: summaries, results };
}
