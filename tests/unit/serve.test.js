import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolvePublicFile } from '../../scripts/serve.js';

let root;
let outside;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'chart-static-root-'));
  outside = await mkdtemp(join(tmpdir(), 'chart-static-outside-'));
  await Promise.all([
    mkdir(join(root, 'src')),
    mkdir(join(root, 'checks')),
    mkdir(join(root, 'vendor')),
    mkdir(join(root, '.git')),
    mkdir(join(root, 'tests', 'fixtures'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, 'index.html'), 'app'),
    writeFile(join(root, 'checks.html'), 'checks'),
    writeFile(join(root, 'README.md'), 'private documentation'),
    writeFile(join(root, '.env'), 'secret'),
    writeFile(join(root, '.git', 'config'), 'git config'),
    writeFile(join(root, 'tests', 'test.js'), 'test code'),
    writeFile(join(root, 'tests', 'fixtures', 'reference.json'), '{}'),
    writeFile(join(root, 'tests', 'fixtures', 'private.js'), 'private test code'),
    writeFile(join(root, 'src', 'app.js'), 'app source'),
    writeFile(join(root, 'checks', 'page.mjs'), 'checks page'),
    writeFile(join(root, 'vendor', 'chart.js'), 'vendor code'),
    writeFile(join(outside, 'secret.js'), 'outside secret'),
  ]);
});

afterEach(async () => {
  await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
});

describe('static server public file resolution', () => {
  it('resolves only the app entry points and public asset directories', async () => {
    expect(await resolvePublicFile(root, '/index.html')).toBe(resolve(root, 'index.html'));
    expect(await resolvePublicFile(root, '/checks.html')).toBe(resolve(root, 'checks.html'));
    expect(await resolvePublicFile(root, '/src/app.js')).toBe(resolve(root, 'src/app.js'));
    expect(await resolvePublicFile(root, '/checks/page.mjs')).toBe(resolve(root, 'checks/page.mjs'));
    expect(await resolvePublicFile(root, '/vendor/chart.js')).toBe(resolve(root, 'vendor/chart.js'));
    expect(await resolvePublicFile(root, '/tests/fixtures/reference.json')).toBe(resolve(root, 'tests/fixtures/reference.json'));
  });

  it.each([
    '/../secret.txt',
    '/../../etc/passwd',
    '/..%2f..%2fetc%2fpasswd',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/nested/../../../secret.txt',
    '/src/../checks.html',
  ])('rejects traversal path %s', async (pathname) => {
    await expect(resolvePublicFile(root, pathname)).rejects.toThrow('forbidden');
  });

  it.each([
    '/README.md',
    '/.env',
    '/.git/config',
    '/package.json',
    '/tests/test.js',
    '/tests/fixtures/private.js',
    '/tests/fixtures/README.md',
    '/scripts/serve.js',
    '/src/.private.js',
    '/src/data.txt',
  ])('does not expose non-public project files: %s', async (pathname) => {
    await expect(resolvePublicFile(root, pathname)).rejects.toThrow('forbidden');
  });

  it('rejects malformed percent-encoding and backslash paths', async () => {
    await expect(resolvePublicFile(root, '/%E0%A4%A')).rejects.toThrow('forbidden');
    await expect(resolvePublicFile(root, '/src%5c..%5cREADME.md')).rejects.toThrow('forbidden');
  });

  it('rejects a public-looking symlink that points outside the root', async () => {
    await symlink(join(outside, 'secret.js'), join(root, 'src', 'leak.js'));
    await expect(resolvePublicFile(root, '/src/leak.js')).rejects.toThrow('forbidden');
  });

  it('rejects a symlink to a private file elsewhere inside the root', async () => {
    await symlink(join(root, 'README.md'), join(root, 'src', 'readme.js'));
    await expect(resolvePublicFile(root, '/src/readme.js')).rejects.toThrow('forbidden');
  });
});
