// Persistence on Cloudflare: the same store contract as `store.js`, backed by
// Durable Object storage instead of a JSON file.
//
// The whole state goes in one key. That mirrors the single-file model exactly and
// is the right call at this size — ten people, a handful of places, far inside the
// per-value limit — and it keeps a write atomic without a transaction.

import { normalize } from './logic.js';

const KEY = 'state';

/**
 * Build a store over a `DurableObjectStorage`-shaped object (`get`/`put`).
 * Kept free of Cloudflare imports so it runs, and is tested, under plain Node.
 */
export function durableStore(storage) {
  let cache = null;
  // A Durable Object is single-threaded and every request for one group lands on
  // the same instance, so this queue is the only lock the app needs — the same
  // guarantee the file store's queue gives, now covering the whole deployment.
  let queue = Promise.resolve();

  async function load() {
    if (!cache) cache = normalize(await storage.get(KEY));
    return cache;
  }

  function update(mutate) {
    const run = async () => {
      const draft = structuredClone(await load());
      const result = await mutate(draft);
      await storage.put(KEY, draft);
      cache = draft;
      return result;
    };
    // Chain regardless of whether the previous write succeeded or was rejected;
    // a throw from `mutate` aborts before `put`, so storage is left untouched.
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  return { read: load, update };
}
