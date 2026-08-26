// The cap on how many places the board holds.
//
// Driven through the Durable Object store because that is where an uncapped list
// actually bites: the whole board is one stored value with a hard size ceiling. The
// same `Map`-backed fake the Cloudflare store test uses lets a full board be seeded
// directly, without adding fifty places one call at a time.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeApi } from '../src/api.js';
import { durableStore } from '../src/store-durable.js';
import { MAX_PLACES, emptyState, view } from '../src/logic.js';

function fakeStorage(initial) {
  const data = new Map([['state', structuredClone(initial)]]);
  return {
    async get(key) {
      return structuredClone(data.get(key));
    },
    async put(key, value) {
      data.set(key, structuredClone(value));
    },
  };
}

/** A board with one member and `count` places they suggested. */
function board(count) {
  return {
    people: ['Alice'],
    places: Array.from({ length: count }, (_, i) => ({
      id: `p${i}`,
      name: `Place ${i}`,
      note: '',
      addedBy: 'Alice',
      createdAt: i + 1,
    })),
    votes: {},
  };
}

const seeded = (count) => durableStore(fakeStorage(board(count)));

test('a full list refuses another suggestion and stays put', async () => {
  const store = seeded(MAX_PLACES);
  await assert.rejects(
    routeApi(store, 'POST', '/api/places', { user: 'Alice', name: 'One more' }),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /full/);
      return true;
    },
  );
  const after = await routeApi(store, 'GET', '/api/state');
  assert.equal(after.places.length, MAX_PLACES);
});

test('the last free slot is still usable, and the next call is not', async () => {
  const store = seeded(MAX_PLACES - 1);
  const added = await routeApi(store, 'POST', '/api/places', { user: 'Alice', name: 'The last one' });
  assert.equal(added.places.length, MAX_PLACES);
  // The tiebreaker keeps counting up from the highest id in use, not from the length.
  assert.equal(added.places.find((p) => p.name === 'The last one').createdAt, MAX_PLACES);
  await assert.rejects(routeApi(store, 'POST', '/api/places', { user: 'Alice', name: 'One too many' }));
});

test('a full list can still be edited, voted on, and removed from', async () => {
  const store = seeded(MAX_PLACES);
  const edited = await routeApi(store, 'PATCH', '/api/places/p0', {
    user: 'Alice',
    name: 'Renamed',
    note: 'an edit is not another place',
  });
  assert.equal(edited.places.find((p) => p.id === 'p0').name, 'Renamed');

  const voted = await routeApi(store, 'POST', '/api/votes', { user: 'Alice', placeId: 'p0' });
  assert.deepEqual(voted.standing.leaders, ['Renamed']);

  const removed = await routeApi(store, 'DELETE', '/api/places/p1', { user: 'Alice' });
  assert.equal(removed.places.length, MAX_PLACES - 1);
  // ...and that frees the slot back up.
  const refilled = await routeApi(store, 'POST', '/api/places', { user: 'Alice', name: 'Back to full' });
  assert.equal(refilled.places.length, MAX_PLACES);
});

test('the cap reaches the browser on the view, like every other limit', () => {
  assert.equal(view(emptyState()).maxPlaces, MAX_PLACES);
});
