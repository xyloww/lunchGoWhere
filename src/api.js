// The three core features, as HTTP: add a place, vote for a place, see the standing.

import { canEdit, clean, sameName, validatePerson, validatePlace, view } from './logic.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireMember(state, name) {
  const user = state.people.find((p) => sameName(p, name));
  if (!user) throw new HttpError(403, 'Pick who you are first.');
  return user;
}

function findPlace(state, id) {
  const place = state.places.find((p) => p.id === id);
  if (!place) throw new HttpError(404, 'That place is no longer on the list.');
  return place;
}

function requireOwner(state, id, user) {
  const place = findPlace(state, id);
  if (!canEdit(place, user)) {
    throw new HttpError(403, `Only ${place.addedBy} can change ${place.name}.`);
  }
  return place;
}

/** Join the group. Not authentication — just picking a name off the list. */
async function addPerson(store, body) {
  return store.update((state) => {
    const { value, error } = validatePerson(body.name, state.people);
    if (error) throw new HttpError(400, error);
    state.people.push(value);
    return { ...view(state), you: value };
  });
}

async function addPlace(store, body) {
  return store.update((state) => {
    const user = requireMember(state, body.user);
    const { value, error } = validatePlace(body, state.places);
    if (error) throw new HttpError(400, error);
    state.places.push({
      // Web Crypto, not node:crypto — the same call works in Node and on Workers.
      id: crypto.randomUUID(),
      name: value.name,
      note: value.note,
      addedBy: user,
      createdAt: state.places.length ? Math.max(...state.places.map((p) => p.createdAt)) + 1 : 1,
    });
    return view(state);
  });
}

async function editPlace(store, id, body) {
  return store.update((state) => {
    const user = requireMember(state, body.user);
    const place = requireOwner(state, id, user);
    const { value, error } = validatePlace(body, state.places, { ignoreId: id });
    if (error) throw new HttpError(400, error);
    place.name = value.name;
    place.note = value.note;
    return view(state);
  });
}

async function removePlace(store, id, body) {
  return store.update((state) => {
    const user = requireMember(state, body.user);
    const place = requireOwner(state, id, user);
    state.places = state.places.filter((p) => p.id !== id);
    // Votes for a place that no longer exists would otherwise linger as dead weight.
    for (const [person, placeId] of Object.entries(state.votes)) {
      if (placeId === place.id) delete state.votes[person];
    }
    return view(state);
  });
}

/**
 * One vote per person, changeable. That is what produces a decision: with
 * unlimited votes everything ties and the group is back in the group chat.
 * Voting for your current pick again withdraws it.
 */
async function castVote(store, body) {
  return store.update((state) => {
    const user = requireMember(state, body.user);
    const placeId = clean(body.placeId);
    if (!placeId || state.votes[user] === placeId) {
      delete state.votes[user];
      return view(state);
    }
    state.votes[user] = findPlace(state, placeId).id;
    return view(state);
  });
}

/** Tomorrow is a new lunch. Clears votes, keeps the suggestions. */
async function resetRound(store, body) {
  return store.update((state) => {
    requireMember(state, body.user);
    state.votes = {};
    return view(state);
  });
}

const PLACE_PATH = /^\/api\/places\/([\w-]+)$/;

/**
 * Dispatch an API call. Returns the JSON payload, or throws `HttpError`.
 *
 * `store` is injected rather than imported so the same routing serves both hosts:
 * the JSON file under `node server.js`, Durable Object storage on Cloudflare. It
 * only has to offer `read()` and `update(mutate)`.
 */
export async function routeApi(store, method, pathname, body = {}) {
  if (method === 'GET' && pathname === '/api/state') return view(await store.read());
  if (method === 'POST' && pathname === '/api/people') return addPerson(store, body);
  if (method === 'POST' && pathname === '/api/places') return addPlace(store, body);
  if (method === 'POST' && pathname === '/api/votes') return castVote(store, body);
  if (method === 'POST' && pathname === '/api/round') return resetRound(store, body);

  const match = PLACE_PATH.exec(pathname);
  if (match && method === 'PATCH') return editPlace(store, match[1], body);
  if (match && method === 'DELETE') return removePlace(store, match[1], body);

  throw new HttpError(404, 'Unknown endpoint.');
}
