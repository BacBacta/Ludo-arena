/**
 * Minimal static server that GZIPS text assets — mirrors what production serves
 * (Vercel gzip/brotli). `python3 -m http.server` does NOT compress, which makes
 * any transfer-size / TTI measurement meaningless on a throttled profile (it
 * reports the raw bytes). Use this for e2e/ui-perf.mjs.
 *
 *   node e2e/lib/serve-gzip.mjs apps/web/dist 8899
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize } from 'node:path';

const ROOT = process.argv[2] || 'apps/web/dist';
const PORT = Number(process.argv[3] || 8899);

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.webmanifest': 'application/manifest+json',
};
const COMPRESS = new Set(['.html', '.js', '.css', '.json', '.svg', '.webmanifest']);

createServer(async (req, res) => {
  try {
    const url = (req.url || '/').split('?')[0];
    let p = normalize(join(ROOT, decodeURIComponent(url)));
    let body;
    try {
      body = await readFile(p);
    } catch {
      p = join(ROOT, 'index.html'); // SPA fallback
      body = await readFile(p);
    }
    const ext = extname(p);
    res.setHeader('content-type', TYPES[ext] || 'application/octet-stream');
    if (COMPRESS.has(ext) && (req.headers['accept-encoding'] || '').includes('gzip')) {
      body = gzipSync(body);
      res.setHeader('content-encoding', 'gzip');
    }
    res.setHeader('content-length', String(body.length));
    res.end(body);
  } catch {
    res.statusCode = 500;
    res.end('error');
  }
}).listen(PORT, () => console.log(`[serve-gzip] ${ROOT} on http://localhost:${PORT} (gzip enabled)`));
