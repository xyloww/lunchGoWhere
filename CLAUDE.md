# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Lunch place voting for a small group (max 10 people). Suggest a place, cast one vote, see the standing.

## Commands

```bash
npm start                 # node server.js -> http://localhost:3000
PORT=4000 npm start       # override the port
npm test                  # node --test "test/**/*.test.js"
node --test test/api.test.js                      # one test file
node --test --test-name-pattern "withdraws" test/ # one test by name

npm run cf:dev            # the Cloudflare build on local workerd, port 8787
npm run cf:deploy         # wrangler deploy
npm run cf:tail           # live logs from the deployed Worker
```

No build step and no bundler — Node >= 20 built-ins only, ESM throughout (`"type":
"module"`). Wrangler is the single devDependency and is only needed to deploy; nothing
ships in the runtime. No linter or formatter is configured; match the surrounding style.

## Architecture

The app is `api.js` + `logic.js` + `public/`. Everything else is one of **two hosts** it
runs on, and each host brings its own HTTP layer and its own store:

| | Local (`npm start`) | Cloudflare (`wrangler deploy`) |
| --- | --- | --- |
| HTTP | `server.js` | `src/worker.js` + `src/group.js` |
| Store | `src/store.js` (JSON file) | `src/store-durable.js` (object storage) |
| Static | `server.js` reads `public/` | Workers Static Assets, before the Worker runs |

Layers, each depending only on the one below it:

| File | Responsibility |
| --- | --- |
| `server.js` / `src/worker.js` | HTTP: static files, body reading (16 KB cap), `HttpError` -> JSON |
| `src/api.js` | Endpoint dispatch, identity/ownership checks, the mutation bodies |
| `src/logic.js` | Pure rules: validation, name comparison, tally, standing, `normalize`, the `view` shape. No I/O |
| `src/store.js`, `src/store-durable.js` | Persistence: serialized writes behind `{read, update}` |

**The store is injected, not imported.** `routeApi(store, method, pathname, body)` takes it
as its first argument, and that seam is the only reason one set of rules serves both hosts —
`api.js` must never import a store, or the Cloudflare bundle pulls in `node:fs`. For the same
reason nothing under `src/` may import `node:*` except `store.js` itself (that is why place
ids use the global `crypto.randomUUID()`), and `src/group.js` deliberately avoids the
`cloudflare:workers` base class so the whole tree still loads under plain Node.

### The API contract

`routeApi` in `src/api.js` is the whole surface; `public/app.js` is its only caller.

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/state` | — |
| POST | `/api/people` | `{ name }` |
| POST | `/api/places` | `{ user, name, note }` |
| PATCH / DELETE | `/api/places/:id` | `{ user, ... }` |
| POST | `/api/votes` | `{ user, placeId }` |
| POST | `/api/round` | `{ user }` |

Every mutating call carries the caller's name as `user` in the body — that is the entire identity
mechanism, and there are no headers or cookies. `POST /api/people` is the exception: it is how a name
gets onto the roster, so it takes `name` and returns `you` alongside the usual view.

`public/` is the whole frontend: `index.html` (static markup, all the ids `app.js` reaches for),
`app.js` (plain DOM, no framework), `styles.css`.

### Invariants worth knowing before editing

- **Every mutation goes through `update(mutate)`.** Both stores serialize all writes on a promise
  chain and hand `mutate` a `structuredClone` of the state, so concurrent clicks cannot interleave a
  read-modify-write. Throwing from inside `mutate` aborts before the write lands and leaves storage
  untouched — that is the rollback mechanism. Never write to the state file or object storage
  directly. On Cloudflare the queue is enough on its own because a Durable Object is single-threaded
  and every request for one group lands on the same instance; that property is why the app is a
  Durable Object and not KV.
- **Every endpoint returns `view(state)`** — the complete snapshot the browser needs to redraw in one
  response. There are no partial patches; surfacing a new field in the UI means adding it to `view()`.
- **Errors are `throw new HttpError(status, message)`** from `src/api.js`. Both HTTP layers turn those
  into `{ error: message }` at that status; anything else becomes a generic 500. Those messages are shown
  verbatim to the user by `app.js`, so write them as user-facing prose.
- **Identity is a name picked off a list, not auth.** `requireMember` only checks the name exists.
  Ownership (`canEdit`: only `addedBy` may edit or delete a place) is an honest-group rule, but it is
  enforced server-side so the UI is not the only thing holding the line — `app.js` mirrors the same
  rule to hide buttons, and both sides have to change together.
- **Names and place names are compared through `clean`/`sameName`** (whitespace collapsed,
  case-insensitive). Use those rather than `===` anywhere user text is matched.
- **`place.createdAt` is a monotonic counter (`max + 1`), not a timestamp.** It exists solely as the
  stable tiebreaker in `tally`, so equal-vote places do not reshuffle between refreshes.
- **One vote per person, changeable; voting for your current pick withdraws it.** Deleting a place
  also deletes votes pointing at it. `standing.tied` is the signal the group still has to decide.
- **The limits live only in `src/logic.js`** (`MAX_PEOPLE`, `MAX_PERSON_NAME`, `MAX_PLACE_NAME`,
  `MAX_NOTE`) and reach the browser on the view as `maxPeople` and `limits`. `render()` applies them as
  `maxLength` on the inputs, so `public/index.html` carries no `maxlength` attributes — change the
  constant and both sides follow. Do not reintroduce a hard-coded limit in the markup.
- `read()` returns the live cached object — treat it as read-only and mutate only inside `update`.
- **In `src/group.js`, always read the request body to the end before responding — even to reject it.**
  Returning a response while the request stream is still unread is fatal in workerd (`Can't read from
  request stream after response has been sent`), and it takes the isolate down on a *later* request,
  so it does not look like the code that caused it. An early bail on `content-length`, or abandoning a
  half-drained stream reader, both trip it; `await request.text()` first is the working shape.

### Frontend

- One module-level `state`, and `render()` redraws everything from it. Every action funnels through
  `act(fn)`, which adopts the returned view as the new state and routes thrown messages to the status
  line — so handlers return the API response rather than touching the DOM.
- A 2 s `setInterval` poll keeps the group in sync (no sockets). Polling holds off while `editingId`
  is set, otherwise a refresh would wipe the open edit inputs.
- "Who you are" lives in `localStorage` under `lgw.me`. If that name is missing from the roster on
  render, it is dropped — a reset data file logs you out rather than leaving a phantom identity.
- `el()` sets `textContent`, never `innerHTML`; user-supplied names must stay un-parsed.

### Data

Locally: `data/data.json` by default, overridable with `LGW_DATA_FILE` (resolved against the CWD).
Written tmp-file-then-rename so a crash cannot leave a half-written file.

On Cloudflare: the whole state under one key in Durable Object storage, which mirrors the single-file
model and makes a write atomic without a transaction. One deployment is one board; `GROUP_NAME` in
`wrangler.jsonc` picks which object id it uses.

Both run what they load through `normalize()` in `logic.js`, which drops anything malformed rather
than throwing, so a hand-edited file or a stale record degrades instead of breaking startup.

### Tests

`test/api.test.js` drives `routeApi` against the file store and `test/store-durable.test.js` drives it
against the Durable Object store, using a `Map`-backed fake for `DurableObjectStorage` — enough to
cover the Cloudflare storage path without booting workerd. No HTTP server is started in either, so
`server.js` and `src/worker.js` are untested.

`api.test.js` has two constraints that follow from how the file store works:

- **`LGW_DATA_FILE` must be set before `src/store.js` is loaded**, because it resolves the path once at
  module scope. That is why the test assigns the env var and then uses `await import(...)` rather than
  a static import; a static import would bind the real `data/data.json`.
- **The file's tests share one data file and run in order**, accumulating state (`before` seeds three
  people; later tests reference places added by earlier ones). Adding a test in the middle can break
  the ones after it. `resetCacheForTests()` drops the in-memory cache only — it is used to prove the
  state reloads from disk, not to reset between cases.

## Known gaps

- Neither HTTP layer has automated coverage — static-file serving, path-traversal rejection, and
  body-limit handling have only been smoke-tested by hand (`server.js` locally, `src/worker.js`
  against `wrangler dev`). Tests exercise `routeApi` directly.
- Deployed at a `workers.dev` URL the board is world-writable, since identity is a name off a list.
  Cloudflare Access in front of it is the intended answer; the app does not grow a login.
- Votes are anonymous to nobody: `view()` exposes `voters` per place, and the UI shows those names. That
  is deliberate for a small group, but it is not a private ballot.
