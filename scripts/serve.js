// Tiny loopback-only static server (no dependencies): node scripts/serve.js [port]
import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HOST = '127.0.0.1';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
const PUBLIC_ROOT_FILES = new Set(['index.html', 'checks.html']);
const PUBLIC_DIRECTORIES = new Set(['src', 'checks', 'vendor', 'tests/fixtures']);
const PUBLIC_EXTENSIONS = new Set(Object.keys(types));

function isPublicRelativePath(path) {
  if (!path || path === '..' || isAbsolute(path)) return false;
  const parts = path.split(sep);
  if (parts.some((part) => !part || part.startsWith('.'))) return false;
  if (parts.length === 1) return PUBLIC_ROOT_FILES.has(parts[0]);
  const directory = parts.slice(0, -1).join(sep);
  const isFixtureDirectory = directory === ['tests', 'fixtures'].join(sep);
  const isPublicDirectory = (PUBLIC_DIRECTORIES.has(parts[0]) && parts[0] !== 'tests' && parts.length > 1)
    || isFixtureDirectory;
  const extensionAllowed = isFixtureDirectory
    ? extname(parts.at(-1)) === '.json'
    : PUBLIC_EXTENSIONS.has(extname(parts.at(-1)));
  return isPublicDirectory && extensionAllowed;
}

export async function resolvePublicFile(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new Error('forbidden');
  }
  if (typeof pathname !== 'string' || !decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0')) {
    throw new Error('forbidden');
  }
  if (decoded.split('/').includes('..')) throw new Error('forbidden');

  const resolvedRoot = resolve(root);
  const file = resolve(resolvedRoot, `.${decoded}`);
  const rel = relative(resolvedRoot, file);
  if (!isPublicRelativePath(rel)) throw new Error('forbidden');

  // Check the canonical target as well: a public-looking symlink must not expose private files.
  const [realRoot, realFile] = await Promise.all([realpath(resolvedRoot), realpath(file)]);
  const realRel = relative(realRoot, realFile);
  if (!isPublicRelativePath(realRel)) throw new Error('forbidden');
  return realFile;
}

export function createStaticServer(root = ROOT) {
  const resolvedRoot = resolve(root);
  return http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end();
        return;
      }
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const file = await resolvePublicFile(resolvedRoot, pathname.endsWith('/') ? `${pathname}index.html` : pathname);
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  const port = Number(process.argv[2] || process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  createStaticServer().listen(port, HOST, () => console.log(`http://localhost:${port}`));
}
