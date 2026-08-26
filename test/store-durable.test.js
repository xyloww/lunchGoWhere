// The Cloudflare path: the same API rules driven through the Durable Object store.
//
// Durable Object storage is a get/put key-value store that structured-clones what it
// holds, so a Map plus a clone on the way in and out is a faithful stand-in — enough
// to prove the store contract without booting workerd.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeApi } from '../src/api.js';
import { durableStore } from '../src/store-durable.js';

/** A `DurableObjectStorage`-shaped fake. `writes` shows a rejected change wrote nothing. */
function fakeStorage(initial) {
  const data = new Map(initial ? [['state', structuredClone(initial)]] : []);
  return {
    writes: 0,
    async get(key) {
      return structuredClone(data.get(key));
    },
    async put(key, value) {
      this.writes += 1;
      data.set(key, structuredClone(value));
    },
  };
}

const caller = (store) => (method, path, body) => routeApi(store, method, path, body);

test('an empty object starts an empty board', async () => {
  const call = caller(durableStore(fakeStorage()));
  const view = await call('GET', '/api/state');
  assert.deepEqual(view.people, []);
  assert.deepEqual(view.places, []);
  assert.equal(view.standing.votes, 0);
});

test('a full round survives against Durable Object storage', async () => {
  const call = caller(durableStore(fakeStorage()));
  await call('POST', '/api/people', { name: 'Alice' });
  await call('POST', '/api/people', { name: 'Bob' });
  await call('POST', '/api/places', { user: 'Alice', name: 'Tian Tian', note: '5 min walk' });
  const added = await call('POST', '/api/places', { user: 'Bob', name: 'Maxwell' });

  const tian = added.places.find((p) => p.name === 'Tian Tian').id;
  await call('POST', '/api/votes', { user: 'Alice', placeId: tian });
  const view = await call('POST', '/api/votes', { user: 'Bob', placeId: tian });

  assert.deepEqual(view.standing, { votes: 2, leaders: ['Tian Tian'], tied: false });
  assert.deepEqual(view.places[0].voters, ['Alice', 'Bob']);
});

test('a rejected change leaves storage untouched', async () => {
  const storage = fakeStorage();
  const call = caller(durableStore(storage));
  await call('POST', '/api/people', { name: 'Alice' });
  const writes = storage.writes;

  await assert.rejects(call('POST', '/api/places', { user: 'Stranger', name: 'X' }));
  assert.equal(storage.writes, writes, 'the failed mutation never reached put()');
  assert.deepEqual((await call('GET', '/api/state')).places, []);
});

test('concurrent votes are serialized, not lost', async () => {
  const call = caller(durableStore(fakeStorage()));
  for (const name of ['Alice', 'Bob', 'Cara']) await call('POST', '/api/people', { name });
  const added = await call('POST', '/api/places', { user: 'Alice', name: 'Maxwell' });
  const maxwell = added.places[0].id;

  await Promise.all(
    ['Alice', 'Bob', 'Cara'].map((user) => call('POST', '/api/votes', { user, placeId: maxwell })),
  );
  const final = await call('GET', '/api/state');
  assert.equal(final.places[0].votes, 3);
});

test('a new instance reads the state the previous one left behind', async () => {
  const storage = fakeStorage();
  await caller(durableStore(storage))('POST', '/api/people', { name: 'Alice' });

  // A fresh store over the same storage is what an evicted-and-revived object sees.
  const revived = await caller(durableStore(storage))('GET', '/api/state');
  assert.deepEqual(revived.people, ['Alice']);
});

test('a malformed stored record degrades instead of throwing', async () => {
  const storage = fakeStorage({ people: ['Alice', 42], places: 'nope', votes: { Alice: 7 } });
  const view = await caller(durableStore(storage))('GET', '/api/state');
  assert.deepEqual(view.people, ['Alice']);
  assert.deepEqual(view.places, []);
  assert.deepEqual(view.votes, {});
});
