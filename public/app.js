// Frontend. Plain DOM, no framework — the whole page redraws from one /api/state payload.

const $ = (id) => document.getElementById(id);
const ME_KEY = 'lgw.me';
const POLL_MS = 2000;

let state = null;
let me = localStorage.getItem(ME_KEY) ?? '';
let editingId = null; // While editing, polling holds off so the inputs are not wiped.
let msgTimer = null;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Request failed.');
  return data;
}

function say(text, ms = 4000) {
  clearTimeout(msgTimer);
  $('msg').textContent = text;
  if (text) msgTimer = setTimeout(() => ($('msg').textContent = ''), ms);
}

/** Every action funnels through here: run it, adopt the returned state, surface errors. */
async function act(fn) {
  try {
    state = await fn();
    say('');
    render();
  } catch (err) {
    say(err.message);
  }
}

function setMe(name) {
  me = name;
  localStorage.setItem(ME_KEY, name);
  render();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent, so names cannot inject markup
  return node;
}

function renderPeople() {
  const box = $('people');
  box.replaceChildren();
  for (const person of state.people) {
    const chip = el('button', 'chip', person);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(person === me));
    chip.onclick = () => setMe(person === me ? '' : person);
    box.append(chip);
  }

  const full = state.people.length >= state.maxPeople;
  $('joinForm').hidden = full;
  $('whoHint').textContent = me
    ? `You are voting as ${me}. Tap your name again to switch.`
    : full
      ? `The group is full (${state.maxPeople} people). Pick your name above.`
      : 'Pick your name, or add it if it is not there yet.';
}

function renderStanding() {
  const { standing } = state;
  const card = $('standingCard');
  card.hidden = state.places.length === 0;
  card.classList.toggle('tied', standing.tied);

  if (standing.votes === 0) {
    $('standingLabel').textContent = 'No votes yet';
    $('standingName').textContent = '—';
    $('standingNote').textContent = 'First vote sets the pace.';
    return;
  }

  const voted = Object.keys(state.votes).length;
  const plural = standing.votes === 1 ? 'vote' : 'votes';
  $('standingLabel').textContent = standing.tied ? 'Tied' : 'Leading';
  $('standingName').textContent = standing.leaders.join(' · ');
  $('standingNote').textContent = standing.tied
    ? `${standing.votes} ${plural} each — someone needs to break the tie.`
    : `${standing.votes} of ${voted} ${voted === 1 ? 'vote' : 'votes'} cast.`;
}

function editForm(place) {
  const form = el('form', 'edit-form');
  const row = el('div', 'row');
  const name = el('input');
  name.type = 'text';
  name.maxLength = state.limits.place;
  name.value = place.name;
  name.setAttribute('aria-label', 'Place name');

  const save = el('button', 'btn primary small', 'Save');
  save.type = 'submit';
  const cancel = el('button', 'btn ghost small', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = () => {
    editingId = null;
    render();
  };

  const note = el('input');
  note.type = 'text';
  note.maxLength = state.limits.note;
  note.value = place.note ?? '';
  note.placeholder = 'Note (optional)';
  note.setAttribute('aria-label', 'Note');

  row.append(name, save, cancel);
  form.append(row, note);
  form.onsubmit = (event) => {
    event.preventDefault();
    act(async () => {
      const next = await api(`/api/places/${place.id}`, {
        method: 'PATCH',
        body: { user: me, name: name.value, note: note.value },
      });
      editingId = null;
      return next;
    });
  };
  setTimeout(() => name.focus(), 0);
  return form;
}

function placeRow(place, leading) {
  const item = el('li', 'place');
  if (leading) item.classList.add('leading');
  const share = state.people.length ? (place.votes / state.people.length) * 100 : 0;
  item.style.setProperty('--share', `${Math.min(100, share)}%`);

  if (editingId === place.id) {
    item.append(editForm(place));
    return item;
  }

  const main = el('div', 'place-main');
  main.append(el('div', 'place-name', place.name));

  const bits = [`by ${place.addedBy}`];
  if (place.note) bits.push(place.note);
  if (place.voters.length) bits.push(`voted: ${place.voters.join(', ')}`);
  main.append(el('div', 'place-meta', bits.join(' · ')));

  const count = el('div', 'count', String(place.votes));
  count.title = `${place.votes} ${place.votes === 1 ? 'vote' : 'votes'}`;

  const actions = el('div', 'actions');
  const mine = state.votes[me] === place.id;
  const vote = el('button', mine ? 'btn small' : 'btn primary small', mine ? 'Voted ✓' : 'Vote');
  vote.type = 'button';
  vote.disabled = !me;
  vote.title = mine ? 'Click to take your vote back' : 'You get one vote — it moves when you change it';
  vote.onclick = () => act(() => api('/api/votes', { method: 'POST', body: { user: me, placeId: place.id } }));
  actions.append(vote);

  // Only the person who added a place gets edit and remove.
  if (place.addedBy === me) {
    const edit = el('button', 'icon-btn', 'Edit');
    edit.type = 'button';
    edit.onclick = () => {
      editingId = place.id;
      render();
    };

    const remove = el('button', 'icon-btn', 'Remove');
    remove.type = 'button';
    remove.onclick = () => {
      if (!confirm(`Remove ${place.name}?`)) return;
      act(() => api(`/api/places/${place.id}`, { method: 'DELETE', body: { user: me } }));
    };
    actions.append(edit, remove);
  }

  item.append(main, count, actions);
  return item;
}

function renderPlaces() {
  const list = $('places');
  list.replaceChildren();
  const { standing } = state;
  for (const place of state.places) {
    list.append(placeRow(place, standing.votes > 0 && standing.leaders.includes(place.name)));
  }
  $('placesEmpty').hidden = state.places.length > 0;
  $('resetBtn').hidden = !me || Object.keys(state.votes).length === 0;
}

function render() {
  if (!state) return;
  if (me && !state.people.includes(me)) {
    // Name vanished from the roster (different data file, or the file was reset).
    me = '';
    localStorage.removeItem(ME_KEY);
  }
  renderPeople();
  renderStanding();
  renderPlaces();
  $('joinName').maxLength = state.limits.person;
  $('placeName').maxLength = state.limits.place;
  $('placeNote').maxLength = state.limits.note;
  // The server enforces the cap too; this only stops offering what it would refuse.
  const full = state.places.length >= state.maxPlaces;
  const canAdd = Boolean(me) && !full;
  $('placeName').disabled = !canAdd;
  $('placeNote').disabled = !canAdd;
  $('addForm').querySelector('button').disabled = !canAdd;
  $('placeName').placeholder = !me
    ? 'Pick your name first'
    : full
      ? `The list is full (${state.maxPlaces} places)`
      : 'Place name';
}

$('joinForm').onsubmit = (event) => {
  event.preventDefault();
  const name = $('joinName').value;
  act(async () => {
    const next = await api('/api/people', { method: 'POST', body: { name } });
    $('joinName').value = '';
    me = next.you;
    localStorage.setItem(ME_KEY, me);
    return next;
  });
};

$('addForm').onsubmit = (event) => {
  event.preventDefault();
  act(async () => {
    const next = await api('/api/places', {
      method: 'POST',
      body: { user: me, name: $('placeName').value, note: $('placeNote').value },
    });
    $('placeName').value = '';
    $('placeNote').value = '';
    return next;
  });
};

$('resetBtn').onclick = () => {
  if (!confirm('Clear every vote and start a new round?')) return;
  act(() => api('/api/round', { method: 'POST', body: { user: me } }));
};

// Ten people on their phones: polling is plenty, and far less to go wrong than sockets.
async function poll() {
  if (editingId) return;
  try {
    state = await api('/api/state');
    render();
  } catch {
    say('Lost the connection — retrying.', POLL_MS);
  }
}

await poll();
setInterval(poll, POLL_MS);
