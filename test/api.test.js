// Exercises the API through routeApi against a throwaway data file.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

const dir = await mkdtemp(join(tmpdir(), 'lgw-'));
process.env.LGW_DATA_FILE = join(dir, 'data.json');

const { routeApi } = await import('../src/api.js');
const { store, resetCacheForTests } = await import('../src/store.js');

const call = (method, path, body) => routeApi(store, method, path, body);
const idOf = (view, name) => view.places.find((p) => p.name === name).id;

async function rejects(promise, status, match) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.status, status);
    if (match) assert.match(err.message, match);
    return true;
  });
}

before(async () => {
  await call('POST', '/api/people', { name: 'Alice' });
  await call('POST', '/api/people', { name: 'Bob' });
  await call('POST', '/api/people', { name: 'Cara' });
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
  resetCacheForTests();
});

test('the group is a name list, with no duplicates and a cap of 10', async () => {
  await rejects(call('POST', '/api/people', { name: '  alice ' }), 400, /already on the list/);
  await rejects(call('POST', '/api/people', { name: '   ' }), 400, /Enter a name/);

  for (const name of ['D', 'E', 'F', 'G', 'H', 'I', 'J']) {
    await call('POST', '/api/people', { name });
  }
  const full = await call('GET', '/api/state');
  assert.equal(full.people.length, 10);
  await rejects(call('POST', '/api/people', { name: 'Kay' }), 400, /full/);
});

test('only people on the list can suggest a place', async () => {
  await rejects(call('POST', '/api/places', { user: 'Stranger', name: 'X' }), 403, /who you are/);
});

test('adding a place records who suggested it, and rejects repeats', async () => {
  const view = await call('POST', '/api/places', {
    user: 'Alice',
    name: '  Tian  Tian ',
    note: '5 min walk',
  });
  assert.equal(view.places[0].name, 'Tian Tian'); // whitespace collapsed
  assert.equal(view.places[0].addedBy, 'Alice');
  assert.equal(view.places[0].votes, 0);

  await rejects(call('POST', '/api/places', { user: 'Bob', name: 'tian tian' }), 400, /already/);
  await rejects(call('POST', '/api/places', { user: 'Bob', name: '' }), 400, /Enter a place/);
});

test('each person holds exactly one vote, and moving it does not duplicate', async () => {
  await call('POST', '/api/places', { user: 'Bob', name: 'Maxwell' });
  let view = await call('GET', '/api/state');
  const tian = idOf(view, 'Tian Tian');
  const maxwell = idOf(view, 'Maxwell');

  view = await call('POST', '/api/votes', { user: 'Alice', placeId: tian });
  assert.equal(view.places.find((p) => p.id === tian).votes, 1);

  view = await call('POST', '/api/votes', { user: 'Alice', placeId: maxwell });
  assert.equal(view.places.find((p) => p.id === tian).votes, 0);
  assert.equal(view.places.find((p) => p.id === maxwell).votes, 1);
  assert.deepEqual(view.votes, { Alice: maxwell });

  // Voting for your current pick again withdraws it.
  view = await call('POST', '/api/votes', { user: 'Alice', placeId: maxwell });
  assert.deepEqual(view.votes, {});

  await rejects(call('POST', '/api/votes', { user: 'Alice', placeId: 'nope' }), 404, /no longer/);
  await rejects(call('POST', '/api/votes', { user: 'Ghost', placeId: tian }), 403);
});

test('the standing names the leader, and says so when it is tied', async () => {
  const start = await call('GET', '/api/state');
  const tian = idOf(start, 'Tian Tian');
  const maxwell = idOf(start, 'Maxwell');

  let view = await call('POST', '/api/votes', { user: 'Alice', placeId: tian });
  assert.deepEqual(view.standing, { votes: 1, leaders: ['Tian Tian'], tied: false });

  view = await call('POST', '/api/votes', { user: 'Bob', placeId: maxwell });
  assert.equal(view.standing.tied, true);
  assert.deepEqual(view.standing.leaders.slice().sort(), ['Maxwell', 'Tian Tian']);

  view = await call('POST', '/api/votes', { user: 'Cara', placeId: tian });
  assert.deepEqual(view.standing, { votes: 2, leaders: ['Tian Tian'], tied: false });
  assert.equal(view.places[0].name, 'Tian Tian'); // ranked highest first
  assert.deepEqual(view.places[0].voters, ['Alice', 'Cara']);
});

test('only the person who added a place can edit it', async () => {
  const view = await call('GET', '/api/state');
  const tian = idOf(view, 'Tian Tian'); // added by Alice

  await rejects(
    call('PATCH', `/api/places/${tian}`, { user: 'Bob', name: 'Bob was here' }),
    403,
    /Only Alice/,
  );
  const edited = await call('PATCH', `/api/places/${tian}`, {
    user: 'Alice',
    name: 'Tian Tian Chicken Rice',
    note: 'queue is long',
  });
  const place = edited.places.find((p) => p.id === tian);
  assert.equal(place.name, 'Tian Tian Chicken Rice');
  assert.equal(place.note, 'queue is long');
  assert.equal(place.votes, 2, 'renaming keeps the votes');
});

test('only the person who added a place can remove it, and its votes go with it', async () => {
  const view = await call('GET', '/api/state');
  const tian = idOf(view, 'Tian Tian Chicken Rice');

  await rejects(call('DELETE', `/api/places/${tian}`, { user: 'Cara' }), 403, /Only Alice/);

  const after = await call('DELETE', `/api/places/${tian}`, { user: 'Alice' });
  assert.equal(after.places.some((p) => p.id === tian), false);
  // Alice and Cara had voted for it; those votes are released, Bob's remains.
  assert.deepEqual(Object.keys(after.votes), ['Bob']);
  assert.deepEqual(after.standing.leaders, ['Maxwell']);

  await rejects(call('DELETE', `/api/places/${tian}`, { user: 'Alice' }), 404);
});

test('a new round clears the votes but keeps the suggestions', async () => {
  const view = await call('POST', '/api/round', { user: 'Bob' });
  assert.deepEqual(view.votes, {});
  assert.equal(view.standing.votes, 0);
  assert.ok(view.places.length > 0);
  await rejects(call('POST', '/api/round', { user: 'Ghost' }), 403);
});

test('concurrent votes are serialized, not lost', async () => {
  const view = await call('GET', '/api/state');
  const maxwell = idOf(view, 'Maxwell');
  await Promise.all(
    ['Alice', 'Bob', 'Cara'].map((user) => call('POST', '/api/votes', { user, placeId: maxwell })),
  );
  const final = await call('GET', '/api/state');
  assert.equal(final.places.find((p) => p.id === maxwell).votes, 3);
});

test('state survives a restart', async () => {
  resetCacheForTests();
  const reloaded = await call('GET', '/api/state');
  assert.equal(reloaded.people.length, 10);
  assert.equal(reloaded.places.find((p) => p.name === 'Maxwell').votes, 3);
});

test('unknown endpoints are rejected', async () => {
  await rejects(call('GET', '/api/nope'), 404);
  await rejects(call('PUT', '/api/places/abc'), 404);
});
