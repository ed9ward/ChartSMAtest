// Drives the real page (index.html in an iframe) the way a user would: sets controls, reads what the chart holds.
import { assert } from './assert.js';

export function createUiDriver(frame) {
  const errors = [];
  const win = () => frame.contentWindow;
  const driver = {
    errors,
    app: () => win().__app,
    el: (id) => win().document.getElementById(id),
    text: (id) => driver.el(id).textContent,
    async load(query = '') {
      await new Promise((resolve) => { frame.onload = resolve; frame.src = `index.html${query}`; });
      for (let i = 0; i < 100 && !win().__app; i++) await new Promise((r) => setTimeout(r, 20));
      assert(win().__app, 'the page did not start');
      win().addEventListener('error', (e) => errors.push(e.message));
      return driver;
    },
    select(id, value) {
      const el = driver.el(id);
      el.value = value;
      assert(el.value === String(value), `"${value}" is not an option of #${id}`);
      el.dispatchEvent(new (win().Event)('change'));
    },
    type(id, value) {
      driver.el(id).value = String(value);
      driver.el(id).dispatchEvent(new (win().Event)('input'));
    },
    // Waits until the chart has repainted (two animation frames), so a canvas snapshot shows the current state.
    settle() {
      return new Promise((resolve) => {
        const w = win();
        const fallback = setTimeout(resolve, 200); // frames are paused in a hidden tab
        w.requestAnimationFrame(() => w.requestAnimationFrame(() => { clearTimeout(fallback); resolve(); }));
      });
    },
    // Repeats `attempt` (returns null when fine, or a problem text) until it is fine or the time is up, like a poll.
    async until(attempt, timeoutMs = 1500) {
      const deadline = performance.now() + timeoutMs;
      let problem = attempt();
      while (problem && performance.now() < deadline) {
        await driver.settle();
        problem = attempt();
      }
      assert(!problem, problem);
    },
    // Fresh state: demo data set (resets the feed), then indicator (sets its default period), then source.
    setup({ indicator = 'sma', source = 'close', scenario = 'normal' } = {}) {
      driver.select('scenario', scenario);
      driver.select('indicator', indicator);
      driver.select('source', source);
    },
  };
  return driver;
}
