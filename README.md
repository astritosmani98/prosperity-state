# Prosperity State

A multiplayer economic & political strategy game. You are a citizen of a shared
nation. Everyone benefits when the country prospers — but the game only ends when
national **Prosperity** reaches **100**, and at that moment only the **richest
surviving citizen wins**.

Play online from any device with a 4-letter room code. Empty seats are filled by
AI citizens with distinct personalities (builders, strategists, opportunists,
free-riders).

## Quick start

```bash
npm install
npm start
```

Then open <http://localhost:3000>. Create a game, share the room code, and start
when ready — any empty seats become AI players.

### Play with friends on other devices
The server must be reachable by the other players. On the same LAN they can use
your machine's IP (`http://<your-ip>:3000`). To play over the internet, deploy to
any Node host (Render / Railway / Fly.io / a VPS) — it's a single `npm start`
process with no database.

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
  the windows and streetlamps, Industry puffs smoke, upgrades sparkle, and a
  free-rider decline brings a storm

All tuning constants live in [`server/constants.js`](server/constants.js).

## Project layout

```
server/
  constants.js   tuning parameters (single source of truth)
  engine.js      pure game logic — all formulas & the phase machine
  ai.js          bot decision-making (contributions + voting)
  rooms.js       lobby, sessions, timed simultaneous-turn orchestration
  index.js       HTTP static server + WebSocket protocol
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
