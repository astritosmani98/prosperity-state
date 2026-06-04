# Prosperity State

A multiplayer economic & political strategy game. You are a citizen of a shared
nation. Everyone benefits when the country prospers — but the game only ends when
national **Prosperity** reaches **100**, and at that moment only the **richest
surviving citizen wins**.

Play online from any device with a 4-letter room code. Empty seats are filled by
AI citizens with 15 distinct personalities — builder, strategist, opportunist,
free-rider, reciprocator, conformist, guardian, egalitarian, philanthropist,
sprinter, miser, politician, contrarian, investor and grudger — assigned at
random each game, so every match plays differently.

## Quick start

```bash
npm install
npm start
```

Then open <http://localhost:3000>. Create a game, share the room code, and start
when ready — any empty seats become AI players. The layout is responsive and
works on mobile web browsers (phones/tablets) as well as desktop.

### Play with friends on other devices
The server must be reachable by the other players. On the same LAN they can use
your machine's IP (`http://<your-ip>:3000`). To play over the internet, deploy it
(it's a single `npm start` process).

### Deploy to Render (free)
A [`render.yaml`](render.yaml) blueprint is included, so:
1. Push this repo to GitHub (already done if you cloned it from there).
2. At <https://dashboard.render.com> → **New ▸ Blueprint**, connect the repo.
   Render reads `render.yaml` and creates the web service.
3. When prompted (or under the service's **Environment** tab), set `DATABASE_URL`
   to your Neon connection string so live games are recorded. (Skip it and the
   game still runs, just without persistence.)
4. Deploy → you get a public `https://<name>.onrender.com` URL. Share it (or the
   in-lobby invite link) and play from anywhere.

Notes: the free instance sleeps after ~15 min idle, so the first visit after a
quiet spell waits ~30–60 s to wake. WebSockets and HTTPS work out of the box, so
the client auto-uses `wss://`. To use a custom domain, add it under the service's
**Settings ▸ Custom Domains** and point a DNS record at Render.

## Game records (optional)

Every **finished** game (won or collapsed) can be saved to a Postgres database —
a summary row plus the full round-by-round history — so you can analyse the data
later. Each round also stores a **per-player snapshot** (coins, income,
influence, contribution, alive/bankrupt) and the infrastructure/policy state, so
you can reconstruct every citizen's wealth and influence trajectory. This is
entirely optional: with no database configured the game runs exactly the same
and nothing is stored.

**Setup (free, ~5 min) with [Neon](https://neon.tech):**
1. Create a free Neon project and copy its **connection string** (it ends with
   `?sslmode=require`).
2. Locally: `cp .env.example .env` and paste it as `DATABASE_URL`.
   When deployed: set `DATABASE_URL` as an environment variable in your host's
   dashboard.
3. Start the server — the `games` and `game_rounds` tables are created
   automatically. Verify the connection any time with `npm run db:check`.

Three tables are created automatically: **`games`** (one summary row per game),
**`game_players`** (one row per player per game — `name` and `is_bot` as real
columns, plus archetype and final standing), and **`game_rounds`** (one row per
round, with the per-player snapshot).

**Reading the data:**
- Browse/query/export directly in Neon's SQL editor, e.g.:
  ```sql
  SELECT name, is_bot, archetype, final_rank, final_coins FROM game_players WHERE game_id = 5 ORDER BY final_rank;
  SELECT name, count(*) AS games, avg(final_coins)::int AS avg_coins FROM game_players WHERE is_bot = false GROUP BY name;
  SELECT winner_archetype, count(*) FROM games WHERE outcome='ended' GROUP BY 1;
  ```
- Or use the built-in read-only JSON API:
  - `GET /api/stats` — totals, outcome breakdown, avg rounds to win, wins by archetype
  - `GET /api/games?limit=20` — recent games (summary)
  - `GET /api/games/:id` — one game with its players list and full round history

Player names are stored as typed. If you'd prefer anonymised records, say so and
the names can be dropped in favour of archetype + a random id.

## How a round works

1. **Income** — each citizen earns `floor(BaseIncome × (1 + Prosperity/40))`.
   Income rises as the nation prospers (and with the Roads project).
2. **Contribute** — secretly split your income between *keep* and *contribute*.
   Contributions are revealed only after everyone has locked in, and each
   citizen's last contribution stays visible in the roster.
3. **Resolve** — the nation must pool at least a **minimum** (≈35% of total
   income) or **nothing is built and Prosperity decays**. Above it, the shared
   pool raises Prosperity efficiently — `K = max(4, 16 − floor(C/3))`,
   `ΔP = floor(C/K)` (boosted by Education) — and funds the round's project. The
   single biggest giver gets a **20% Top Contributor refund**.
4. **Vote** — every 3 rounds, citizens vote on policy (tax, welfare), weighted by
   **Influence** (earned by contributing, decays 20%/round). The **build focus
   auto-rotates every round** through the five projects, so construction spreads
   across the whole nation.

Hit **0 Coins** and you go bankrupt — out of the final ranking. If Prosperity
ever falls to **0**, society collapses and everyone loses.

**Don't try to free-ride to victory.** Bots practice *conditional cooperation*:
if you persistently contribute almost nothing, they stop covering for you and
withhold too — so Prosperity slides downward until you start paying your fair
share. Refuse for too long and the nation collapses, and nobody wins.

## Systems implemented (GDD v1.1)

- Personal economy (income, keep/contribute, bankruptcy floor at 0)
- Prosperity growth with the efficiency curve `K`/`ΔP`
- **Minimum maintenance threshold** — miss it and nothing is built while
  Prosperity decays (penalty grows late-game)
- Top Contributor bonus (20% refund, ties share it)
- **Free-rider deterrence** — bots track each citizen's cooperation and withhold
  in protest of persistent free-riders, so refusing to contribute drags the
  nation down instead of letting you coast to a wealth win
- Influence with 20%/round decay and a permanent floor of 1
- Influence-weighted voting every 3 rounds — bots vote in their own
  self-interest (the leader blocks taxes; the poorest push welfare)
- All 5 infrastructure tracks (Roads, Education, Energy, Healthcare, Industry),
  levels 1–5, each with independent progress; the build focus **auto-rotates
  every round** so construction spreads across the nation
- Tax (flat / progressive) and welfare / expansion policies
- Random negative events, mitigated by Healthcare
- Win at Prosperity 100 → wealth ranking · collapse at Prosperity 0
- **Living cityscape** (centre of the board) — an SVG map of the nation that
  grows as you play: recognizable infrastructure appears and levels up
  (school, hospital, solar panels + wind turbine, factory), village houses,
  parks, people, cars, birds and a river fill in with Prosperity, a day/night
  cycle tracks the nation's health (bright day → starry night), Energy lights
  the windows and streetlamps, Industry puffs smoke, upgrades sparkle, kids play
  by a bridged river that glints with reflections, fireflies come out at dusk,
  and a free-rider decline brings a storm

All tuning constants live in [`server/constants.js`](server/constants.js).

## Project layout

```
server/
  constants.js   tuning parameters (single source of truth)
  engine.js      pure game logic — all formulas & the phase machine
  ai.js          bot decision-making (contributions + voting)
  rooms.js       lobby, sessions, timed simultaneous-turn orchestration
  db.js          optional Postgres game records (summary + round history)
  index.js       HTTP static server + WebSocket protocol + /api endpoints
  sim.js         headless all-bot simulation  (npm run sim [players])
  test-ws.js     end-to-end protocol test     (PS_FAST=1 npm start, then run)
public/
  index.html, styles.css, client.js   the web client
```

## Dev tools

```bash
npm run sim 6      # simulate a full 6-bot game in the terminal
PS_FAST=1 npm start  # collapse phase delays for fast local testing
```
