// Static files + the JSON API, for local runs. No framework, no build step:
// `node server.js` and open it. The Cloudflare equivalent is `src/worker.js`.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { HttpError, routeApi } from './src/api.js';
import { store } from './src/store.js';

const PUBLIC_DIR = resolve(import.meta.dirname, 'public');
const BODY_LIMIT = 16 * 1024;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new HttpError(413, 'That is too much text.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new HttpError(400, 'Could not read that request.');
  }
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
  const target = resolve(join(PUBLIC_DIR, normalize(rel)));
  // Anything that escapes public/ is treated as missing rather than served.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const file = await readFile(target);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
      'content-length': file.length,
      'cache-control': 'no-store',
    });
    res.end(file);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname.startsWith('/api/')) {
      const body = req.method === 'GET' ? {} : await readBody(req);
      sendJson(res, 200, await routeApi(store, req.method, pathname, body));
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(res, pathname);
      return;
    }
    res.writeHead(405).end('Method not allowed');
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message });
      return;
    }
    console.error(err);
    sendJson(res, 500, { error: 'Something went wrong on the server.' });
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => {
  console.log(`Lunch Go Where -> http://localhost:${server.address().port}`);
});
