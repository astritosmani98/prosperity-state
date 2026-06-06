# Prosperity State: Game-Theory Analysis Brief

A self-contained description of the game for formal analysis. It covers the
players, timing, information structure, exact payoff and transition functions,
all tuning parameters, the designed strategic properties, the reference (bot)
strategies, open questions, and how to pull real play data.

- **Play it:** https://theprosperitystate.com
- **Source of truth:** the engine is `server/engine.js` (pure functions, no I/O).
  Tuning constants are in `server/constants.js`.
- **Live data API (read-only, public):** `/api/stats`, `/api/games`,
  `/api/games/:id` (full per-round detail). See "Empirical data" below.

Numbers below reflect the current tuning; treat `server/constants.js` as
authoritative if anything drifts.

---

## 1. One-paragraph summary

Prosperity State is a finite-horizon, simultaneous-move **repeated public-goods
game** with an **endogenous stopping time** and a **rank-order terminal payoff**.
Each round, players receive income and privately choose how much to keep versus
contribute to a shared "Prosperity" stock. The game ends the instant Prosperity
reaches a target (100), at which point the **single richest surviving player
wins**; if Prosperity ever hits 0 the society **collapses and everyone loses**.
So collective success is a precondition for any individual win, but only one
player wins, layering a **relative-wealth tournament** on top of a **collective-
action / common-pool problem**. A per-round **provision-point threshold** (a
minimum total contribution, below which nothing is built and Prosperity decays)
adds a step-level public-good structure, and the endgame becomes a **war of
attrition / volunteer's dilemma** over who funds the last push to 100.

---

## 2. Players and setup

- **n players**, `2 ≤ n ≤ 6`. Humans; any empty seats are filled by heuristic
  bots (see §10). Bots are *not* optimizing agents; treat them as fixed
  reference strategies.
- All players start identical: **30 Coins**, **Influence 1**.
- Shared national state starts at **Prosperity P = 10**.
- The game is a single finite play (typically 8–15 rounds under cooperation;
  can run longer, or end early in collapse).

---

## 3. Timing, information, and the per-round action

Each round `t`:

1. **Income paid (public, deterministic).** Every living player receives the
   same income `y_t` (formula in §5), added to their Coins.
2. **Contribution (simultaneous, hidden).** Each player `i` chooses
   `c_i ∈ {0, 1, …, y_t}` — an integer between 0 and *this round's income*.
   Note the upper bound is the round's income, **not** total wealth: you cannot
   dump savings into a single round. Choices are made simultaneously and are
   **private until the round resolves**.
3. **Resolution (deterministic given choices, plus one random event).** The pool
   is formed, Prosperity updates, bonuses/levies/transfers apply, and infra and
   influence update (full order in §4).
4. **Voting subgame** every `VOTING_INTERVAL = 3` rounds (see §8).

**Information:** Coins and Influence are **public** at all times. Per-round
contributions are **hidden during the choice** and **revealed at resolution**,
so play is effectively simultaneous within a round with full history afterward
(a repeated game with observed past actions).

---

## 4. Round resolution order (exact)

Let `L` = set of living players, `C = Σ_{i∈L} c_i` the voluntary pool.

1. Deduct contributions: `coins_i -= c_i`. Form pool `C`.
2. **Progressive tax** (only if tax policy = progressive): every player tied at
   the max Coins pays a levy `floor(maxCoins · 0.05)`, added to the pool. (Levy is
   involuntary; it does **not** count toward influence or the top-contributor
   bonus.)
3. **Welfare split** (only if welfare policy = welfare): `W = floor(C · 0.15)` is
   set aside from growth; the prosperity pool becomes `C_P = C − W`.
   (If expansion policy, `W = 0`, `C_P = C`.)
4. **Provision-point check.** Threshold `T = ceil(y_t · |L| · 0.35)`.
   - If `C < T`: **nothing is built**; Prosperity *decays* by
     `neglect = 3 + floor(P/20)` (so `ΔP = −neglect`). No infrastructure progress.
   - If `C ≥ T`: `K = max(4, 16 − floor(C_P / 3))`,
     `ΔP = floor( (C_P / K) · (1 + 0.10·educationLevel) )`. Prosperity grows by
     `ΔP`, and the whole pool `C` accrues to the round's focused infrastructure
     category (see §7).
5. **Random event** (from round 3 on, prob `0.30`): raw damage `~ U{4,…,10}`,
   reduced by Healthcare: `damage = floor(raw · (1 − min(0.9, 0.15·healthcareLevel)))`,
   then `P −= damage`.
6. Clamp `P ≤ 100`.
7. **Top-contributor bonus.** Among living players, let `c* = max_i c_i`. Every
   player with `c_i = c* > 0` receives a refund `floor(c_i · 0.20)` (ties all get
   it).
8. **Industry bonus.** Each player with `c_i > 0` receives `+1 · industryLevel`
   Coins.
9. **Welfare payout.** If `W > 0`, the player(s) tied at the minimum Coins split
   `W` equally (`floor(W / k)` each).
10. **Influence update:** `I_i ← max(1, floor(0.8 · I_i) + c_i)`.
11. **Bankruptcy:** any player with `coins ≤ 0` is eliminated. (In practice
    unreachable under current rules; see §13.)
12. **Termination check** (see §6).

---

## 5. Income and the Prosperity multiplier

- Effective base income: `B = 10 + 2·roadsLevel`.
- Prosperity multiplier: `M(P) = 1 + P/40`.
- Income: `y_t = floor( B · M(P) )`, identical for all living players.

So income rises with the public stock `P` and with the Roads project — the
public good directly enlarges every player's future budget. At `P = 10`,
`y ≈ 12`; at `P = 100` with no roads, `y = 35`.

---

## 6. Termination and payoffs

Checked at the end of each round:

- **Collapse** if `P ≤ 0` (or all players eliminated): **everyone loses.**
- **Win** if `P ≥ 100`: the game ends immediately; surviving players are ranked
  by total Coins, and **rank 1 (most Coins) wins.**
- Otherwise the game continues.

**Payoff structure.** The natural payoff is ordinal and rank-based: a player most
prefers being the unique richest survivor at a successful termination; collapse
is the common worst outcome. A clean modeling choice is a binary win payoff
(1 if you are the unique richest at `P ≥ 100`, else 0; collapse = 0 for all),
or a rank-decreasing utility with collapse as the floor. There is no discounting
in the rules; the horizon is endogenous (it ends when `P` hits 100 or 0).

---

## 7. Infrastructure (state that reshapes the dynamics)

Five categories, each level `0…5`. The **build focus auto-rotates** to the next
un-maxed category every round (not chosen by players). When the round meets the
threshold, the whole pool `C` adds to the current focus's progress; a level is
gained when progress `≥ cost(nextLevel)`, where
`cost(ℓ) = floor( 40 · ℓ · (1 − min(0.4, 0.08·energyLevel)) )`.

Per-level effects:

| Project | Effect |
|---|---|
| Roads | `+2` base income for everyone (`B = 10 + 2·roads`) |
| Education | `+10%` Prosperity-growth efficiency (multiplies ΔP) |
| Energy | `−8%` infrastructure cost (capped −40%) |
| Healthcare | `−15%` event damage (capped −90%) |
| Industry | `+1` Coin per round to each contributor (`c_i>0`) |

Infrastructure is a compounding public investment: contributions both raise `P`
*and* build multipliers that change later income and growth.

---

## 8. The voting subgame (endogenous institutions)

Every 3 rounds the nation votes; each player's vote is **weighted by current
Influence** (which is itself a function of past contributions, §4.10). Votes
alternate between two binary policies that persist until changed:

- **Tax:** *flat* (no levy) vs *progressive* (the richest pay a 5%-of-wealth levy
  into the pool each round).
- **Welfare vs expansion:** *welfare* redirects 15% of each round's pool to the
  poorest player; *expansion* puts all of it toward growth.

This is a weighted-voting institutional-choice layer where contribution buys
political power.

---

## 9. Designed strategic properties (worth scrutinizing)

- **Symmetric cooperative tie.** If all players contribute the *same* amount
  every round, the dynamics are symmetric and everyone ends with *equal* Coins,
  so they tie and "share the win." (All individual transfers — top-contributor
  bonus, progressive tax, welfare — are implemented to apply symmetrically on
  ties.) This egalitarian profile is a natural focal point / coordination
  outcome, but it is **not** individually stable: a small unilateral underpayment
  ends you richer — provided the nation still reaches 100.
- **Provision point.** The per-round minimum `T` makes round growth a step
  function of total contributions (a threshold/step-level public good), with a
  decay penalty below the point.
- **Endgame war of attrition.** Near `P = 100`, the leader prefers to *bank* (a
  contributed Coin near the finish mostly helps rivals catch up or ends the game
  at lower personal wealth), while *someone* must keep funding the last push and
  keep the pool above `T`. This is a volunteer's-dilemma / brinkmanship subgame.
- **Relative-payoff tension.** Because only the richest wins, contributing is
  doubly costly: it lowers your Coins *and* (via shared income/infra) can lift
  rivals. Yet zero collective contribution means no win for anyone.
- **No real elimination.** With `c_i ≤ y_t`, contributions never reduce a
  player's Coins below their pre-income level, and the only wealth-reducing
  mechanic (the 5% levy) is a fraction of current wealth. So bankruptcy is
  effectively unreachable; the binding failure mode is societal **collapse**
  (see §13).

---

## 10. Reference strategies (the bots)

Empty seats are filled by bots drawn at random from 15 heuristic personas. They
are **hand-coded heuristics, not equilibrium strategies**, but they make a useful
strategy zoo and they drive most of the recorded data. Summaries:

- **builder** — contributes a high, near-constant share.
- **strategist** — moderate; tightens up late.
- **opportunist** — moderate; turns selfish from ~60% of the goal and hoards late.
- **freerider** — gives the minimum (~30% of income) needed to avoid punishment,
  hoards the rest; pitches in only when Prosperity is actually falling.
- **reciprocator** — generous tit-for-tat: mirrors the previous round's *least*
  cooperative player; gives little after a defector, ramps up as they return.
- **conformist** — contributes the *average* of what everyone gave last round
  (amplifies booms and busts).
- **guardian** — altruist; pours in to prevent collapse, never hoards.
- **egalitarian** — gives more when ahead, less when behind, to equalize wealth;
  votes for redistribution.
- **philanthropist** — tries to be the single top contributor each round.
- **sprinter** — coasts early, surges late.
- **miser** — bare minimum to dodge punishment; maximal hoarding.
- **politician** — chases Influence (esp. before votes); votes populist.
- **contrarian** — under-contributes; votes against the standing policy.
- **investor** — funds infrastructure heavily early, banks Coins later.
- **grudger** — grim trigger: cooperates until any free-rider appears, then
  defects permanently.

**Emergent enforcement.** The bots collectively implement *conditional
cooperation*: each tracks every player's rolling contribution ratio (an EMA), and
if anyone persistently contributes below ~25% of income, the bots withhold (pull
toward the offender's level), so the pool drops below `T` and Prosperity decays
until the offender pays in again. This is a decentralized punishment scheme
(tit-for-tat / grim-trigger flavor) that makes persistent free-riding unprofitable
*against this bot population*. It is a property of the strategies, not a hard rule
of the game — a useful distinction for analysis.

---

## 11. Parameters (current tuning)

| Symbol | Meaning | Value |
|---|---|---|
| n | players | 2–6 |
| — | starting Coins | 30 |
| — | starting / goal / floor Prosperity | 10 / 100 / 0 |
| B₀ | base income | 10 |
| — | income multiplier | `1 + P/40` |
| — | contribution range | `0 … y_t` (integer) |
| T | round minimum (provision point) | `ceil(y_t · n_alive · 0.35)` |
| — | neglect (decay below T) | `3 + floor(P/20)` |
| K | prosperity cost | `max(4, 16 − floor(C_P/3))` |
| ΔP | prosperity gain | `floor((C_P/K)·(1+0.1·edu))` |
| — | top-contributor refund | 20% of own contribution (ties share) |
| — | influence update | `max(1, floor(0.8·I) + c)` |
| — | voting interval | every 3 rounds |
| — | progressive tax levy | 5% of richest's Coins (ties all pay) |
| — | welfare share | 15% of pool to poorest (ties split) |
| — | event chance / damage | from round 3, p=0.30, damage `U{4..10}` |
| — | infra levels / next-level cost | 0–5 / `floor(40·ℓ·(1−min(0.4,0.08·energy)))` |
| — | roads/edu/energy/health/industry per level | +2 income / +10% ΔP / −8% cost / −15% event / +1 Coin |
| — | free-rider detection (bots only) | EMA weight 0.55, threshold 0.25, 2-round grace |

---

## 12. Questions a game-theoretic analysis might address

1. **Equilibria of the stage game and the repeated game.** What are the (Markov-
   perfect / subgame-perfect) equilibria? Is all-defect (everyone contributes 0)
   an equilibrium given that it yields collapse (payoff 0 for all)? Is the
   symmetric equal-contribution profile sustainable, and under what folk-theorem
   conditions, given the finite, endogenous horizon and no discounting?
2. **The rank-order twist.** How does a *relative* (winner-take-all) terminal
   payoff change incentives versus a standard absolute-payoff public-goods game?
   Does it push toward minimal-but-sufficient contribution and late hoarding?
3. **Provision point.** Effects of the threshold `T` and the decay penalty: does
   it create coordination equilibria (contribute exactly your `T/n` share) and a
   focal "fair share"? Behavior near the point.
4. **Endgame.** Characterize the war of attrition / volunteer's dilemma as
   `P → 100`. Who optimally funds the final push? Does brinkmanship risk collapse?
5. **Voting.** Influence is bought by contributing; analyze the
   contribution↔power feedback and which tax/welfare regimes are stable.
6. **Mechanism critique.** Do the top-contributor bonus (20%) and the symmetric
   tie meaningfully shift the equilibrium toward cooperation? Is the bonus large
   enough to matter? Is bankruptcy a dead mechanic (see §13) that should be
   re-tuned?
7. **Against the bot population.** Best response to the conditional-cooperator
   bot mix: is honest contribution near `T/n` optimal? When does exploiting
   rescuer personas (guardian/philanthropist) pay, and does universal punishment
   close that off?

---

## 13. Modeling notes and caveats

- **Bankruptcy is effectively unreachable.** Because `c_i ≤ y_t` (you only ever
  contribute out of the current round's income) and the only other wealth sink is
  a 5%-of-wealth levy, Coins never reach 0 in practice. So "ranked survivors" =
  "all players," and elimination/bankruptcy can be treated as inactive. The real
  failure state is collapse (`P ≤ 0`).
- **Bots are heuristics, not solvers.** For pure theory they are fixed reference
  strategies; for empirical work they generate most of the data.
- **One stochastic element:** the per-round negative event (§4.5). Everything
  else is deterministic given the contribution profile and policies.
- **Integer rounding** (floors throughout) matters at the margins and can break
  exact symmetry if contributions differ by a Coin.
- **Auto-rotating build focus** is a fixed, exogenous schedule (players don't
  choose it), which simplifies the infrastructure dimension.

---

## 14. Empirical data

Every *finished* game is recorded to Postgres and exposed read-only via the live
API, so the analyst can pull real plays without any access setup:

- `GET https://theprosperitystate.com/api/stats` — totals, outcome split
  (won/collapsed), average rounds-to-win, wins by persona.
- `GET https://theprosperitystate.com/api/games?limit=100` — game summaries.
- `GET https://theprosperitystate.com/api/games/:id` — one game with its
  **players** and **full round-by-round detail**, including each player's
  per-round contribution, Coins, Influence, the pool, ΔP, the threshold and
  whether it was missed, events, upgrades, votes, and final ranking.

Stored tables (if given direct DB access): `games` (summary), `game_players`
(one row per player per game, incl. `is_bot`, archetype, final rank/coins), and
`game_rounds` (per-round detail incl. a per-player snapshot). This supports
analysis of contribution trajectories, persona win rates, collapse conditions,
endgame behavior, and the effect of policies.

> Note: these endpoints are currently public. If you would rather not expose raw
> play data, restrict them before sharing the link widely.
