import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url));
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

describe('the chart library that the page loads', () => {
  it('is exactly the one npm installed (nothing was edited or left over from another version)', () => {
    expect(sha(read('vendor/lightweight-charts.standalone.production.js')))
      .toBe(sha(read('node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js')));
  });
  it('is the version that package.json pins, with no range', () => {
    const wanted = pkg.devDependencies['lightweight-charts'];
    expect(wanted).toMatch(/^\d+\.\d+\.\d+$/);
    expect(JSON.parse(read('node_modules/lightweight-charts/package.json')).version).toBe(wanted);
    expect(lock.packages['node_modules/lightweight-charts'].version).toBe(wanted);
    expect(read('vendor/lightweight-charts.standalone.production.js').toString()).toContain(wanted);
  });
});

describe('every dependency is pinned', () => {
  it('to an exact version in package.json, and the lock file agrees', () => {
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(lock.packages[`node_modules/${name}`].version, name).toBe(version);
    }
  });
});

describe('what the page may talk to', () => {
  const sources = (dir) => readdirSync(new URL(`../../${dir}`, import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => [`${dir}/${f}`, read(`${dir}/${f}`).toString()]);
  const urls = (text) => [...text.matchAll(/https?:\/\/[^\s'"`)]+|wss?:\/\/[^\s'"`)]+/g)].map((m) => new URL(m[0].replace(/\$\{.*$/, '')).host);

  it('the pages load nothing from outside: no external script, stylesheet, image or font', () => {
    for (const page of ['index.html', 'checks.html']) {
      const html = read(page).toString();
      expect([...html.matchAll(/(?:src|href)="(https?:)?\/\/[^"]+"/g)].map((m) => m[0]), page).toEqual([]);
      expect(html, page).not.toMatch(/@import|url\(\s*['"]?https?:/);
    }
  });

  it('the code reaches only the two exchanges, on their public market-data hosts', () => {
    const hosts = new Set();
    for (const [, text] of [...sources('src'), ...sources('checks')]) for (const h of urls(text)) hosts.add(h);
    // example.com-style hosts are not expected; anything new must be a conscious decision (and a change of this list)
    expect([...hosts].filter((h) => !h.includes('localhost')).sort()).toEqual([
      'api.binance.com', 'api.exchange.coinbase.com', 'stream.binance.com:9443', 'ws-feed.exchange.coinbase.com',
    ]);
  });

  it('nothing is sent to anyone: no POST, no beacon, no analytics, no storage of keys', () => {
    for (const [file, text] of [...sources('src'), ...sources('checks')]) {
      expect(text, file).not.toMatch(/method:\s*['"]POST['"]|sendBeacon|XMLHttpRequest|localStorage|sessionStorage|document\.cookie|eval\(|new Function\(/);
    }
  });
});
