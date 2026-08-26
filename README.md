# Lunch Go Where

A voting board for a group of up to 10 people to pick a lunch place, so the decision
happens in one glance instead of a scroll-back through a group chat.

**The problem it solves:** suggestions and preferences get scattered across chat
messages, so they are hard to compare and the group stalls. Here every suggestion sits
in one list with a live vote count, and the leader is always at the top.

## Run it

```sh
npm start          # then open http://localhost:3000
```

No runtime dependencies and no build step — just Node 20+. To let the group reach it from
their phones on the office Wi-Fi, share your machine's LAN address (e.g.
`http://192.168.1.42:3000`). Set `PORT` to use a different port.

```sh
npm test           # 23 tests over the API rules, on both storage backends
```

## Deploy it (Cloudflare)

```sh
npm install        # wrangler, the only dependency, and only for deploying
npx wrangler login
npm run cf:deploy  # -> https://lunchgowhere.<your-subdomain>.workers.dev
```

`npm run cf:dev` runs the same thing locally on workerd first, and `npm run cf:tail`
streams live logs. The first deploy creates the Durable Object; there is nothing else to
provision, and the free plan covers a group this size comfortably.

`public/` is served from Cloudflare's edge, and `/api/*` is the only thing that reaches the
Worker. State lives in one Durable Object — see [Where the state lives](#where-the-state-lives).

**Before you share the URL:** a `workers.dev` address is public, and this app has no login
(see below). Anyone who finds it can join the group and vote. For an office tool, put
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) in
front of it — that is the piece this app deliberately does not try to be.

## How it works

1. **Pick your name** from the list, or add it if it is not there yet (max 10 people).
   There is no login — the name is just how the group tells votes apart, remembered in
   your browser so you only pick it once.
2. **Add a place.** Name, plus an optional note like "5 min walk".
3. **Vote.** One vote each. Voting for something else moves your vote; voting for your
   current pick again takes it back. One vote per person is what forces a decision —
   with unlimited votes everything ties.
4. **Read the standing** at the top: the leader, or an explicit "Tied" when the group
   still has a call to make. "New round" clears the votes and keeps the suggestions,
   ready for tomorrow.

Everyone can see every place and every vote, including who voted for what. Only the
person who added a place can edit or remove it; removing a place releases the votes
that were on it. Since there are no accounts, that ownership rule is enforced by name —
it keeps people out of each other's suggestions, but it is a courtesy rule among
colleagues, not a security boundary.

The page polls `/api/state` every 2 seconds, so votes from other people appear on their
own without a refresh.

## Layout

| Path | What it holds |
| --- | --- |
| [src/api.js](src/api.js) | The endpoints — add, edit, remove, vote, new round |
| [src/logic.js](src/logic.js) | Pure rules: validation, ownership, tally, standing |
| [public/](public/) | The page — vanilla HTML, CSS, and DOM |
| [server.js](server.js) | Local host: static files, JSON bodies, error responses |
| [src/store.js](src/store.js) | Local storage: one JSON file, atomic writes |
| [src/worker.js](src/worker.js) | Cloudflare host: assets at the edge, `/api/*` to the object |
| [src/group.js](src/group.js) | The Durable Object holding one group |
| [src/store-durable.js](src/store-durable.js) | Cloudflare storage: the same contract, on object storage |
| [wrangler.jsonc](wrangler.jsonc) | The deploy: asset directory, object binding, migration |

The top three files are the app; everything under them is a host it runs on. `routeApi`
takes its store as an argument rather than importing one, which is the whole seam: the
rules never learn whether they are talking to a file or to Cloudflare.

### Where the state lives

Running locally, it is a single JSON file (`data/data.json`, git-ignored, overridable with
`LGW_DATA_FILE`). Writes are serialized through one queue and land via a temp-file rename,
so two people voting at the same instant cannot lose each other's vote or leave a
half-written file behind.

On Cloudflare it is one Durable Object. That is what keeps the same guarantee once there is
no single process to rely on: every request for the group is routed to one instance and run
single-threaded, so a read-modify-write of the whole board stays safe without a database
transaction. One deployment is one board; set `GROUP_NAME` in `wrangler.jsonc` to run a
second, separate one.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/state` | Everything needed to draw the page: people, ranked places, votes, standing |
| `POST /api/people` | `{name}` — join the group |
| `POST /api/places` | `{user, name, note}` — suggest a place |
| `PATCH /api/places/:id` | `{user, name, note}` — edit; 403 unless `user` added it |
| `DELETE /api/places/:id` | `{user}` — remove; 403 unless `user` added it |
| `POST /api/votes` | `{user, placeId}` — cast, move, or withdraw your one vote |
| `POST /api/round` | `{user}` — clear all votes, keep the places |

Every mutating call returns the same payload as `GET /api/state`, so the page updates
from the response without a follow-up request.

## Deliberately not included

No restaurant discovery, maps, menus, reservations, payments, delivery, reviews, chat,
or accounts. It decides where to eat, and nothing else.
