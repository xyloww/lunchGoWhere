// What `normalize` promises: whatever a store hands back, the state the rest of the
// app sees is one it can trust. These are the cases a hand-edited file or a stale
// record actually produces — the ones that used to survive into the live view.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalize, view } from '../src/logic.js';

test('a vote from someone not on the list is dropped, not counted', () => {
  const state = normalize({
    people: ['Alice'],
    places: [{ id: 'p1', name: 'Cafe', addedBy: 'Alice', createdAt: 1 }],
    votes: { Alice: 'p1', Zombie: 'p1' },
  });
  assert.deepEqual(state.votes, { Alice: 'p1' });

  const place = view(state).places[0];
  assert.equal(place.votes, 1); // never more votes than there are members
  assert.deepEqual(place.voters, ['Alice']);
});

test('a vote for a place that is gone is dropped too', () => {
  const state = normalize({
    people: ['Alice'],
    places: [{ id: 'p1', name: 'Cafe', addedBy: 'Alice', createdAt: 1 }],
    votes: { Alice: 'deleted-long-ago' },
  });
  assert.deepEqual(state.votes, {});
  assert.equal(view(state).standing.votes, 0);
});

test('one member cannot hold two votes under two spellings of their name', () => {
  const state = normalize({
    people: ['Alice'],
    places: [
      { id: 'p1', name: 'Cafe', addedBy: 'Alice', createdAt: 1 },
      { id: 'p2', name: 'Kopitiam', addedBy: 'Alice', createdAt: 2 },
    ],
    votes: { alice: 'p1', '  Alice ': 'p2' },
  });
  assert.deepEqual(Object.keys(state.votes), ['Alice']);
  assert.equal(view(state).standing.votes, 1);
});

test('a place with no usable createdAt still sorts', () => {
  const state = normalize({
    people: ['Alice'],
    places: [
      { id: 'p1', name: 'First', addedBy: 'Alice' },
      { id: 'p2', name: 'Second', addedBy: 'Alice', createdAt: 'soon' },
      { id: 'p3', name: 'Third', addedBy: 'Alice', createdAt: 9 },
    ],
    votes: {},
  });
  assert.deepEqual(
    state.places.map((p) => p.createdAt),
    [1, 2, 9],
  );
  // With no votes, the tie is broken by createdAt alone — which is the whole point of
  // the field, and what a NaN comparator quietly stopped doing.
  assert.deepEqual(
    view(state).places.map((p) => p.name),
    ['First', 'Second', 'Third'],
  );
});

test('a place is reduced to the fields the app reads, or dropped', () => {
  const state = normalize({
    people: ['Alice'],
    places: [
      { id: 'p1', name: '  Tian  Tian ', note: '  5 min walk ', addedBy: 'Alice', createdAt: 1, junk: true },
      { id: 'p2', addedBy: 'Alice', createdAt: 2 }, // nothing to show: no name
      { id: 'p3', name: '   ', addedBy: 'Alice', createdAt: 3 }, // same, once cleaned
      { name: 'No id', addedBy: 'Alice', createdAt: 4 },
      'not a place',
      null,
    ],
    votes: {},
  });
  assert.deepEqual(state.places, [
    { id: 'p1', name: 'Tian Tian', note: '5 min walk', addedBy: 'Alice', createdAt: 1 },
  ]);
});

test('a record missing note or addedBy degrades to empty strings, not undefined', () => {
  const [place] = normalize({
    people: [],
    places: [{ id: 'p1', name: 'Cafe', createdAt: 1 }],
    votes: {},
  }).places;
  assert.equal(place.note, '');
  assert.equal(place.addedBy, '');
});
