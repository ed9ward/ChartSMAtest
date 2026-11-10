// Mutation testing: break the code in one place at a time and check that the tests notice.
//
//   npm run mutate                    every mutant (unit tests first, browser tests only for the ones that need them)
//   npm run mutate -- --only=coinbase only mutants whose id or file contains the text
//   npm run mutate -- --unit-only     skip the browser tests
//   npm run mutate -- --list          show the mutants
//   npm run mutate:check              only check that every mutant still applies to the code (fast)
//
// (tests/unit/mutants.test.js is left out of these runs: it fails by design when a mutant is applied.)
// The file that is being broken is always put back, also after Ctrl+C. If a run is killed hard, the next run restores the
// files from .mutation-backup/ before it starts. Exit code 1 when a mutant survives or no longer applies.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTANTS } from './mutants.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const backupDir = join(root, '.mutation-backup');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const only = args.find((a) => a.startsWith('--only='))?.slice(7);

const encode = (file) => file.replaceAll('/', '__');
const decode = (name) => name.replaceAll('__', '/');

function restoreBackups() {
  if (!existsSync(backupDir)) return [];
  const restored = [];
  for (const name of readdirSync(backupDir)) {
    writeFileSync(join(root, decode(name)), readFileSync(join(backupDir, name)));
    restored.push(decode(name));
  }
  rmSync(backupDir, { recursive: true, force: true });
  return restored;
}

const run = (command) => spawnSync(command, { cwd: root, shell: true, stdio: 'ignore', env: process.env }).status;
const occurrences = (text, part) => (part ? text.split(part).length - 1 : 0);

const left = restoreBackups();
if (left.length) console.log(`Restored from an interrupted run: ${left.join(', ')}\n`);

const selected = MUTANTS.filter((m) => !only || m.id.includes(only) || m.file.includes(only));
if (flag('list')) {
  for (const m of selected) console.log(`${m.id.padEnd(46)} ${m.file}${m.ui ? '   (+ browser tests)' : ''}${m.equivalent ? '   (equivalent)' : ''}`);
  process.exit(0);
}

const results = [];
let current = null; // { file, original }
const putBack = () => { if (current) { writeFileSync(join(root, current.file), current.original); current = null; } rmSync(backupDir, { recursive: true, force: true }); };
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { putBack(); process.exit(130); });

for (const [i, m] of selected.entries()) {
  const label = `[${String(i + 1).padStart(2)}/${selected.length}] ${m.id}`;
  const path = join(root, m.file);
  const original = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const found = original === null ? 0 : occurrences(original, m.from);
  if (found !== 1 || m.from === m.to) {
    results.push({ m, status: 'STALE', note: original === null ? 'file is missing' : found === 0 ? 'the code to change is not there any more' : found > 1 ? `the code to change occurs ${found} times` : 'from and to are the same' });
    console.log(`${label}: STALE (${results.at(-1).note})`);
    continue;
  }
  if (flag('check')) { results.push({ m, status: 'OK' }); continue; }

  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, encode(m.file)), original);
  current = { file: m.file, original };
  try {
    writeFileSync(path, original.replace(m.from, () => m.to));
    let status;
    if (run('npx vitest run --bail 1 --exclude tests/unit/mutants.test.js') !== 0) status = 'KILLED by the unit tests';
    else if (m.ui && !flag('unit-only')) {
      const files = m.ui.files.join(' ');
      status = run(`npx playwright test ${files} -g "${m.ui.grep}" --max-failures=1`) !== 0 ? 'KILLED by the browser tests' : 'SURVIVED';
    } else status = flag('unit-only') && m.ui ? 'not checked (needs the browser tests)' : 'SURVIVED';
    if (status === 'SURVIVED' && m.equivalent) status = 'EQUIVALENT';
    results.push({ m, status });
    console.log(`${label}: ${status}`);
  } finally {
    putBack();
  }
}

const count = (s) => results.filter((r) => r.status === s).length;
const killed = results.filter((r) => r.status.startsWith('KILLED')).length;
const survived = results.filter((r) => r.status === 'SURVIVED');
const stale = results.filter((r) => r.status === 'STALE');
if (flag('check')) console.log(`${selected.length - stale.length} of ${selected.length} mutants still apply to the code.`);
else console.log(`\n${killed} killed, ${survived.length} survived, ${count('EQUIVALENT')} equivalent, ${stale.length} stale, ${count('not checked (needs the browser tests)')} not checked.`);
for (const r of results.filter((x) => x.status === 'EQUIVALENT')) console.log(`  equivalent: ${r.m.id}: ${r.m.equivalent}`);
for (const r of survived) console.log(`  SURVIVED: ${r.m.id} (${r.m.file}) - a bug like this would not be noticed`);
for (const r of stale) console.log(`  STALE: ${r.m.id} - ${r.note}`);
process.exit(survived.length || stale.length ? 1 : 0);
