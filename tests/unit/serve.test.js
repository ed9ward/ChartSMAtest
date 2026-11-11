import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { resolvePublicFile } from '../../scripts/serve.js';

const root = resolve('/tmp/chart-static-root');

describe('static server path resolution', () => {
  it('resolves files inside the configured root', () => {
    expect(resolvePublicFile(root, '/index.html')).toBe(resolve(root, 'index.html'));
    expect(resolvePublicFile(root, '/src/app.js')).toBe(resolve(root, 'src/app.js'));
  });

  it.each([
    '/../secret.txt',
    '/../../etc/passwd',
    '/..%2f..%2fetc%2fpasswd',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/nested/../../../secret.txt',
  ])('rejects traversal path %s', (pathname) => {
    expect(() => resolvePublicFile(root, pathname)).toThrow('forbidden');
  });

  it('rejects malformed percent-encoding', () => {
    expect(() => resolvePublicFile(root, '/%E0%A4%A')).toThrow();
  });
});
