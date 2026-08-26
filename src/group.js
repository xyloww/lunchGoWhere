// The Durable Object that holds one group's state.
//
// Cloudflare routes every request for a given object id to a single instance, and
// runs that instance single-threaded. That is what replaces the one-process
// assumption `node server.js` got for free: the API layer below can keep doing
// read-modify-write on a whole state object without a database transaction.
//
// Deliberately written against no `cloudflare:workers` imports, so everything under
// `src/` still loads in plain Node.

import { HttpError, routeApi } from './api.js';
import { durableStore } from './store-durable.js';

const BODY_LIMIT = 16 * 1024;

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * Read a JSON body, same 16 KB ceiling as `server.js`.
 *
 * The body is always read to the end before anything is returned, even when the
 * answer is already 413. Responding while the request stream is still unread is
 * fatal in workerd — "Can't read from request stream after response has been
 * sent" — and it kills the isolate on a *later* request, so an early bail on the
 * `content-length` header would be a self-inflicted outage. Buffering first is
 * safe here: Cloudflare caps the request size long before this is reached.
 */
async function readBody(request) {
  const text = await request.text();
  if (!text) return {};
  if (new TextEncoder().encode(text).byteLength > BODY_LIMIT) {
    throw new HttpError(413, 'That is too much text.');
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new HttpError(400, 'Could not read that request.');
  }
}

export class Group {
  constructor(ctx) {
    this.store = durableStore(ctx.storage);
  }

  /** Same contract as `server.js`: JSON in, `view(state)` out, `HttpError` to JSON. */
  async fetch(request) {
    const { pathname } = new URL(request.url);
    try {
      const body = request.method === 'GET' ? {} : await readBody(request);
      return json(200, await routeApi(this.store, request.method, pathname, body));
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      console.error(err);
      return json(500, { error: 'Something went wrong on the server.' });
    }
  }
}
