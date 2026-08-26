// Persistence for `node server.js`: one JSON file. A group of ten deciding on lunch
// does not need a database. (On Cloudflare the equivalent is `store-durable.js`.)

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { emptyState, normalize } from './logic.js';

const FILE = resolve(process.env.LGW_DATA_FILE ?? 'data/data.json');

let cache = null;
// Every write goes through this chain, so two people clicking at the same moment
// can never interleave a read-modify-write and lose one of the votes.
let queue = Promise.resolve();

async function load() {
  if (cache) return cache;
  try {
    cache = normalize(JSON.parse(await readFile(FILE, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    cache = emptyState();
  }
  return cache;
}

async function persist(state) {
  await mkdir(dirname(FILE), { recursive: true });
  // Write beside the real file and rename over it, so a crash mid-write cannot
  // leave a half-written data.json behind.
  const tmp = `${FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, FILE);
}

/** Read-only snapshot of the current state. */
export function read() {
  return load();
}

/**
 * Run `mutate(state)` with exclusive access. Return a value to send back to the
 * caller; throw an `HttpError` to reject the change and leave the file untouched.
 */
export function update(mutate) {
  const run = async () => {
    const state = await load();
    const draft = structuredClone(state);
    const result = await mutate(draft);
    await persist(draft);
    cache = draft;
    return result;
  };
  // Chain regardless of whether the previous write succeeded or was rejected.
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

/** The shape `routeApi` wants: everything it knows about persistence. */
export const store = { read, update };

/** Test hook: drop the in-memory cache so a fresh data file is picked up. */
export function resetCacheForTests() {
  cache = null;
}
