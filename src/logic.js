// Pure rules for Lunch Go Where. No I/O here so it stays easy to reason about and test.

export const MAX_PEOPLE = 10;
export const MAX_PERSON_NAME = 30;
export const MAX_PLACE_NAME = 60;
export const MAX_NOTE = 120;

/** Collapse whitespace so " Tian  Tian " and "Tian Tian" are the same place. */
export function clean(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** Names are compared case-insensitively: "alice" must not join twice as "Alice". */
export function sameName(a, b) {
  return clean(a).toLowerCase() === clean(b).toLowerCase();
}

export function emptyState() {
  return { people: [], places: [], votes: {} };
}

/**
 * Coerce whatever a store handed back into a usable state. Anything malformed is
 * dropped rather than thrown on, so a hand-edited file or a half-migrated record
 * degrades instead of breaking startup.
 */
export function normalize(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object') return state;
  if (Array.isArray(raw.people)) state.people = raw.people.filter((p) => typeof p === 'string');
  if (Array.isArray(raw.places)) {
    state.places = raw.places.filter((p) => p && typeof p.id === 'string');
  }
  if (raw.votes && typeof raw.votes === 'object') {
    for (const [person, placeId] of Object.entries(raw.votes)) {
      if (typeof placeId === 'string') state.votes[person] = placeId;
    }
  }
  return state;
}

export function validatePerson(name, people) {
  const value = clean(name);
  if (!value) return { error: 'Enter a name.' };
  if (value.length > MAX_PERSON_NAME) {
    return { error: `Names are limited to ${MAX_PERSON_NAME} characters.` };
  }
  if (people.some((p) => sameName(p, value))) return { error: `${value} is already on the list.` };
  if (people.length >= MAX_PEOPLE) return { error: `This group is full (${MAX_PEOPLE} people).` };
  return { value };
}

export function validatePlace({ name, note }, places, { ignoreId } = {}) {
  const cleanName = clean(name);
  const cleanNote = clean(note);
  if (!cleanName) return { error: 'Enter a place name.' };
  if (cleanName.length > MAX_PLACE_NAME) {
    return { error: `Place names are limited to ${MAX_PLACE_NAME} characters.` };
  }
  if (cleanNote.length > MAX_NOTE) {
    return { error: `Notes are limited to ${MAX_NOTE} characters.` };
  }
  const clash = places.some((p) => p.id !== ignoreId && sameName(p.name, cleanName));
  if (clash) return { error: `${cleanName} has already been suggested.` };
  return { value: { name: cleanName, note: cleanNote } };
}

/**
 * Only the person who added a place may change or remove it. There is no login,
 * so this is an honest-group rule rather than a security boundary — but the server
 * still enforces it so the UI cannot be the only thing holding the line.
 */
export function canEdit(place, user) {
  return Boolean(place) && sameName(place.addedBy, user);
}

/**
 * Rank places by votes, then by the order they were suggested so the list never
 * shuffles randomly between refreshes.
 */
export function tally(state) {
  const counts = new Map(state.places.map((p) => [p.id, []]));
  for (const [person, placeId] of Object.entries(state.votes)) {
    if (counts.has(placeId)) counts.get(placeId).push(person);
  }
  return state.places
    .map((place) => ({
      ...place,
      votes: counts.get(place.id).length,
      voters: counts.get(place.id).slice().sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => b.votes - a.votes || a.createdAt - b.createdAt);
}

/**
 * The current standing. `tied` is what actually matters to the group: it means
 * they still have a decision to make.
 */
export function standing(ranked) {
  const top = ranked[0];
  if (!top || top.votes === 0) return { votes: 0, leaders: [], tied: false };
  const leaders = ranked.filter((p) => p.votes === top.votes);
  return { votes: top.votes, leaders: leaders.map((p) => p.name), tied: leaders.length > 1 };
}

/** The shape the browser gets: everything needed to draw the page in one response. */
export function view(state) {
  const ranked = tally(state);
  return {
    people: state.people,
    places: ranked,
    votes: state.votes,
    standing: standing(ranked),
    maxPeople: MAX_PEOPLE,
    // Published so the inputs enforce the same limits the server does, from one source.
    limits: { person: MAX_PERSON_NAME, place: MAX_PLACE_NAME, note: MAX_NOTE },
  };
}
