import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const root = resolve('.');
const roots = ['src', 'checks', 'scripts', 'tests'];

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await collect(path));
    else if (entry.isFile() && path.endsWith('.js') && !path.includes('/vendor/')) found.push(path);
  }
  return found;
}

const targets = (await Promise.all(roots.map((dir) => collect(join(root, dir))))).flat();
targets.push('playwright.config.js', 'vitest.config.js');
const uniqueTargets = [...new Set(targets)].sort();
let failed = false;
for (const file of uniqueTargets) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(`${file}\n${result.stderr}`);
  }
}
if (failed) process.exitCode = 1;
else console.log(`JavaScript syntax OK (${uniqueTargets.length} files)`);
