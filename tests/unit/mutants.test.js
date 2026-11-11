import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { MUTANTS } from '../../scripts/mutation/mutants.mjs';

// The list of deliberate faults must keep applying to the code, otherwise "all mutants killed" would mean nothing.
describe('the mutation suite', () => {
  it('has a good number of mutants with unique ids', () => {
    expect(MUTANTS.length).toBeGreaterThanOrEqual(75);
    expect(new Set(MUTANTS.map((m) => m.id)).size).toBe(MUTANTS.length);
  });

  it('covers every module that holds logic', () => {
    const files = new Set(MUTANTS.map((m) => m.file));
    for (const f of ['src/sma.js', 'src/indicators.js', 'src/sanitize.js', 'src/coinbase.js', 'src/live.js', 'src/app.js', 'src/format.js', 'src/limit.js', 'src/feed.js', 'checks/compare.js', 'checks/runner.js']) {
      expect([...files], f).toContain(f);
    }
  });

  for (const m of MUTANTS) {
    it(`${m.id}: the code to change is there exactly once, and the change is a change`, () => {
      expect(existsSync(new URL(`../../${m.file}`, import.meta.url)), m.file).toBe(true);
      const text = readFileSync(new URL(`../../${m.file}`, import.meta.url), 'utf8');
      expect(text.split(m.from).length - 1).toBe(1);
      expect(m.to).not.toBe(m.from);
    });
  }

  it('every mutant that needs the browser tests names which', () => {
    for (const m of MUTANTS.filter((x) => x.ui)) {
      expect(m.ui.files.length).toBeGreaterThan(0);
      expect(m.ui.grep.length).toBeGreaterThan(0);
      for (const f of m.ui.files) expect(existsSync(new URL(`../../${f}`, import.meta.url)), f).toBe(true);
    }
  });
});
