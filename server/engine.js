// ============================================================================
// Prosperity State — Game Engine
// Pure(ish) game logic. No networking, no I/O. Operates on a `state` object so
// it can be unit-tested and simulated headlessly.
//
// Phase machine:  contribute -> (resolve) -> [vote -> (resolveVote)] -> contribute ...
//                                         \-> ended  (Prosperity >= 100)
//                                         \-> collapsed (Prosperity <= 0 or all bankrupt)
// ============================================================================

import { CONFIG } from './constants.js';

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

/** Players still in contention for the win (wealth > 0). */
export function alivePlayers(state) {
  return Object.values(state.players).filter((p) => p.alive);
}

// ----------------------------------------------------------------------------
// Derived economic values
// ----------------------------------------------------------------------------

/** Base Income including Roads infrastructure bonus. */
export function effectiveBaseIncome(state) {
  return CONFIG.BASE_INCOME + CONFIG.ROADS_INCOME_PER_LEVEL * state.infrastructure.roads;
}

/** Prosperity Multiplier  M = 1 + (P / 40). */
export function prosperityMultiplier(prosperity) {
  return 1 + prosperity / CONFIG.PROSPERITY_DIVISOR;
}

/** Income = floor( BaseIncome * M ). */
export function computeIncome(state) {
  return Math.floor(effectiveBaseIncome(state) * prosperityMultiplier(state.prosperity));
}

/** Energy discount applied to infrastructure upgrade costs (capped at 40%). */
function energyDiscount(state) {
  return Math.min(0.4, CONFIG.ENERGY_DISCOUNT_PER_LEVEL * state.infrastructure.energy);
}

/** Cost (accumulated contribution) to raise `category` from its current level to the next. */
export function nextInfraCost(state, category) {
  const level = state.infrastructure[category];
  if (level >= CONFIG.INFRA_MAX_LEVEL) return Infinity;
  const nextLevel = level + 1;
  return Math.max(1, Math.floor(CONFIG.INFRA_BASE_COST * nextLevel * (1 - energyDiscount(state))));
}

/**
 * Minimum total Coins the nation must pool this round to build & avoid decay.
 * Scales with the number of living citizens and their income (so it stays
 * meaningful as the economy grows).
 */
export function roundThreshold(state) {
  const income = computeIncome(state);
  const n = alivePlayers(state).length || 1;
  return Math.ceil(income * n * CONFIG.MAINTENANCE_FRACTION);
}

/** Prosperity lost when the maintenance threshold is missed (grows late-game). */
export function neglectPenalty(state) {
  return CONFIG.NEGLECT_BASE + Math.floor(state.prosperity / CONFIG.NEGLECT_SCALE_DIV);
}

/** Living players whose cooperation reputation has fallen into free-rider territory. */
export function detectFreeRiders(state) {
  if (state.round <= CONFIG.FREERIDER_GRACE_ROUNDS) return [];
  return alivePlayers(state)
    .filter((p) => (p.coopScore ?? 0.5) < CONFIG.FREERIDER_THRESHOLD)
    .map((p) => ({ id: p.id, name: p.name }));
}

/** The category the focus would move to next (next un-maxed, wrapping). */
export function nextFocusCategory(state) {
  const cats = CONFIG.INFRA_CATEGORIES;
  for (let i = 1; i <= cats.length; i++) {
    const idx = (state.focusIndex + i) % cats.length;
    if (state.infrastructure[cats[idx]] < CONFIG.INFRA_MAX_LEVEL) return cats[idx];
  }
  return state.infraFocus; // everything maxed
}

/** Rotate the build focus to the next un-maxed category. */
function advanceFocus(state) {
  const next = nextFocusCategory(state);
  state.focusIndex = CONFIG.INFRA_CATEGORIES.indexOf(next);
  state.infraFocus = next;
}

// ----------------------------------------------------------------------------
// Game creation
// ----------------------------------------------------------------------------

/**
 * @param {Array<{id:string,name:string,isBot:boolean,archetype?:string}>} seats
 */
export function createGame(seats) {
  const players = {};
  for (const seat of seats) {
    players[seat.id] = {
      id: seat.id,
      name: seat.name,
      isBot: !!seat.isBot,
      archetype: seat.archetype || null,
      coins: CONFIG.START_COINS,
      income: 0,
      influence: CONFIG.MIN_INFLUENCE,
      contributedThisRound: null, // null = not submitted yet
      lastContribution: null,     // what they gave in the most recent resolved round
      coopScore: 0.5,             // rolling cooperation reputation (0..1); 0.5 = neutral start
      submitted: false,
      alive: true,
      bankrupt: false,
    };
  }

  return {
    phase: 'lobby',
    round: 0,
    prosperity: CONFIG.START_PROSPERITY,
    players,
    infrastructure: { roads: 0, education: 0, energy: 0, healthcare: 0, industry: 0 },
    infraProgress: { roads: 0, education: 0, energy: 0, healthcare: 0, industry: 0 },
    infraFocus: 'roads',
    focusIndex: 0,        // index into INFRA_CATEGORIES; advances each round
    roundIncome: 0,       // income paid this round (for the maintenance threshold)
    taxPolicy: 'flat',        // 'flat' | 'progressive'
    welfarePolicy: 'expansion', // 'expansion' | 'welfare'
    votesHeld: 0,
    pendingVote: null,        // { type, prompt, options:[{id,label}], votes:{playerId:optionId} }
    lastRoundResult: null,
    lastVoteResult: null,
    roundHistory: [],         // every resolved round result (for game records)
    voteHistory: [],          // every resolved vote (for game records)
    log: [],
    winners: null,            // ranking array when ended
  };
}

function logEvent(state, text) {
  state.log.push({ round: state.round, text });
  if (state.log.length > 200) state.log.shift();
}

// ----------------------------------------------------------------------------
// Round start: pay income, open the contribution phase
// ----------------------------------------------------------------------------
export function beginRound(state) {
  state.round += 1;
  state.phase = 'contribute';
  if (state.round > 1) advanceFocus(state); // rotate which project we build (round 1 stays on Roads)
  const income = computeIncome(state);
  state.roundIncome = income;
  for (const p of alivePlayers(state)) {
    p.income = income;
    p.coins += income;
    p.contributedThisRound = null;
    p.submitted = false;
  }
  logEvent(state, `Round ${state.round} begins. Income ${income} each. Build focus: ${capitalize(state.infraFocus)}. Minimum to build: ${roundThreshold(state)} Coins.`);
  return state;
}

/** Record a player's intended contribution (0..income). Idempotent until resolve. */
export function submitContribution(state, playerId, amount) {
  const p = state.players[playerId];
  if (!p || !p.alive || state.phase !== 'contribute') return false;
  const max = p.income; // may only contribute out of *this round's* income
  p.contributedThisRound = clamp(Math.floor(amount) || 0, 0, max);
  p.submitted = true;
  return true;
}

/** True once every living player has locked in a contribution. */
export function allContributionsIn(state) {
  return alivePlayers(state).every((p) => p.submitted);
}

// ----------------------------------------------------------------------------
// Round resolution — the core economic tick
// ----------------------------------------------------------------------------
export function resolveRound(state, rng = Math.random) {
  const living = alivePlayers(state);

  // Default any un-submitted living player to a 0 contribution.
  for (const p of living) {
    if (p.contributedThisRound == null) p.contributedThisRound = 0;
  }

  // 1) Collect voluntary contributions; deduct from personal Coins.
  const contributions = {}; // playerId -> voluntary amount (for influence & bonus)
  let pool = 0;
  for (const p of living) {
    const c = p.contributedThisRound;
    p.coins -= c;
    contributions[p.id] = c;
    p.lastContribution = c; // persisted so the UI can always show who gave what
    // Update cooperation reputation: share of income contributed, smoothed.
    const ratio = p.income > 0 ? clamp(c / p.income, 0, 1) : 0;
    p.coopScore = CONFIG.COOP_EMA * (p.coopScore ?? 0.5) + (1 - CONFIG.COOP_EMA) * ratio;
    pool += c;
  }

  // 2) Progressive tax levy (involuntary): the richest pay a wealth %.
  //    Ties are taxed equally, so a perfectly equal society stays equal.
  let taxLevy = 0;        // per-payer levy
  let taxPayers = [];
  if (state.taxPolicy === 'progressive' && living.length > 0) {
    const maxCoins = Math.max(...living.map((p) => p.coins));
    taxLevy = Math.floor(maxCoins * CONFIG.PROGRESSIVE_TAX_RATE);
    if (taxLevy > 0) {
      for (const p of living) {
        if (p.coins === maxCoins) { p.coins -= taxLevy; pool += taxLevy; taxPayers.push(p.name); }
      }
    }
  }

  // 3) Welfare redirection: a share of the pool is taken from prosperity growth
  //    and handed to the poorest player instead.
  let welfareAmount = 0;
  if (state.welfarePolicy === 'welfare') {
    welfareAmount = Math.floor(pool * CONFIG.WELFARE_SHARE);
  }
  const prosperityPool = pool - welfareAmount;

  // 4) Maintenance check + Prosperity growth.
  //    If the nation pools less than the minimum, NOTHING is built this round and
  //    Prosperity slips backwards from neglect. Otherwise it grows via K/ΔP and the
  //    pool accrues toward the round's focused project.
  const threshold = roundThreshold(state);
  const belowThreshold = pool < threshold;
  const prosperityBefore = state.prosperity;
  const upgrades = [];
  let K = 0;
  let deltaP;
  let neglect = 0;

  if (belowThreshold) {
    neglect = neglectPenalty(state);
    deltaP = -neglect;                  // construction halted; society decays
    state.prosperity += deltaP;
  } else {
    K = Math.max(CONFIG.K_FLOOR, CONFIG.K_BASE - Math.floor(prosperityPool / CONFIG.K_DIVISOR));
    const eduMult = 1 + CONFIG.EDUCATION_DP_BONUS_PER_LEVEL * state.infrastructure.education;
    deltaP = Math.floor((prosperityPool / K) * eduMult);
    state.prosperity += deltaP;

    // Whole pool accrues toward the current focus category; level up while affordable.
    const cat = state.infraFocus;
    state.infraProgress[cat] += pool;
    let safety = 0;
    while (
      state.infrastructure[cat] < CONFIG.INFRA_MAX_LEVEL &&
      state.infraProgress[cat] >= nextInfraCost(state, cat) &&
      safety++ < 10
    ) {
      const cost = nextInfraCost(state, cat);
      state.infraProgress[cat] -= cost;
      state.infrastructure[cat] += 1;
      upgrades.push({ category: cat, level: state.infrastructure[cat], cost });
    }
  }

  // 5) Negative event (after contributions, before win check).
  let event = null;
  if (
    state.round >= CONFIG.EVENT_START_ROUND &&
    rng() < CONFIG.EVENT_CHANCE
  ) {
    const raw = randInt(rng, CONFIG.EVENT_MIN_DAMAGE, CONFIG.EVENT_MAX_DAMAGE);
    const mitigation = Math.min(0.9, CONFIG.HEALTHCARE_MITIGATION_PER_LEVEL * state.infrastructure.healthcare);
    const damage = Math.floor(raw * (1 - mitigation));
    state.prosperity -= damage;
    event = { name: pickEvent(rng), rawDamage: raw, damage, mitigated: raw - damage };
  }

  state.prosperity = clamp(state.prosperity, -999, CONFIG.PROSPERITY_GOAL);

  // 6) Top Contributor Bonus — 20% refund to the highest voluntary giver(s).
  const maxContribution = Math.max(0, ...living.map((p) => contributions[p.id]));
  const topContributors = [];
  if (maxContribution > 0) {
    for (const p of living) {
      if (contributions[p.id] === maxContribution) {
        const refund = Math.floor(contributions[p.id] * CONFIG.TOP_CONTRIBUTOR_BONUS);
        p.coins += refund;
        topContributors.push({ id: p.id, name: p.name, refund });
      }
    }
  }

  // 7) Industry bonus — each contributor gets +level Coins.
  if (state.infrastructure.industry > 0) {
    const bonus = CONFIG.INDUSTRY_BONUS_PER_LEVEL * state.infrastructure.industry;
    for (const p of living) {
      if (contributions[p.id] > 0) p.coins += bonus;
    }
  }

  // 8) Welfare payout — the poorest receive the redirected funds, split equally
  //    among ties so a perfectly equal society shares it evenly.
  let welfareRecipients = [];
  if (welfareAmount > 0 && living.length > 0) {
    const minCoins = Math.min(...living.map((p) => p.coins));
    const poorest = living.filter((p) => p.coins === minCoins);
    const share = Math.floor(welfareAmount / poorest.length);
    if (share > 0) {
      for (const p of poorest) p.coins += share;
      welfareRecipients = poorest.map((p) => p.name);
    }
  }

  // 9) Influence update.  I = max(1, floor(prev*0.8) + contribution).
  for (const p of living) {
    p.influence = Math.max(
      CONFIG.MIN_INFLUENCE,
      Math.floor(p.influence * CONFIG.INFLUENCE_DECAY) + contributions[p.id]
    );
  }

  // (Infrastructure progress & upgrades are handled in the maintenance check above,
  //  so they only happen on rounds that meet the minimum contribution.)

  // 11) Bankruptcy — Coins can never go below 0; hitting 0 eliminates a player.
  const bankrupted = [];
  for (const p of living) {
    if (p.coins <= 0) {
      p.coins = 0;
      p.alive = false;
      p.bankrupt = true;
      bankrupted.push(p.name);
    }
  }

  // 12) Build the per-round result summary (reveals hidden contributions).
  const result = {
    round: state.round,
    prosperityBefore,
    deltaP,
    prosperityAfter: state.prosperity,
    K,
    pool,
    threshold,
    belowThreshold,
    neglect,
    focus: state.infraFocus,
    taxLevy,
    taxPayers,
    welfareAmount,
    welfareRecipients,
    event,
    contributions: living.map((p) => ({ id: p.id, name: p.name, amount: contributions[p.id] })),
    topContributors,
    upgrades,
    bankrupted,
    freeRiders: detectFreeRiders(state),
    // Per-player snapshot AFTER this round resolves (wealth/influence trajectory).
    players: living.map((p) => ({
      id: p.id, name: p.name, archetype: p.archetype, isBot: p.isBot,
      contribution: contributions[p.id], income: p.income,
      coins: p.coins, influence: p.influence, alive: p.alive, bankrupt: p.bankrupt,
    })),
    infrastructure: { ...state.infrastructure },
    taxPolicy: state.taxPolicy,
    welfarePolicy: state.welfarePolicy,
  };
  state.lastRoundResult = result;
  state.roundHistory.push(result);

  // Narrative log.
  if (belowThreshold) {
    const fr = result.freeRiders.map((f) => f.name).join(', ');
    if (fr) {
      logEvent(state, `Round ${state.round}: citizens withheld in protest — ${fr} won't contribute. Nothing built, −${neglect} Prosperity. Now ${state.prosperity}.`);
    } else {
      logEvent(state, `Round ${state.round}: only ${pool}/${threshold} Coins pooled — below minimum. Nothing built, −${neglect} Prosperity. Now ${state.prosperity}.`);
    }
  } else {
    logEvent(state, `Round ${state.round} resolved: pool ${pool} Coins → +${deltaP} Prosperity (cost K=${K}). Prosperity now ${state.prosperity}.`);
  }
  if (event) logEvent(state, `⚠ ${event.name}: -${event.damage} Prosperity${event.mitigated ? ` (healthcare absorbed ${event.mitigated})` : ''}.`);
  for (const u of upgrades) logEvent(state, `🏗 ${capitalize(u.category)} upgraded to level ${u.level}.`);
  for (const t of topContributors) logEvent(state, `⭐ ${t.name} was top contributor (+${t.refund} Coin refund).`);
  for (const name of bankrupted) logEvent(state, `💀 ${name} went bankrupt and is out of the ranking.`);

  // 13) Outcome checks.
  const stillAlive = alivePlayers(state);
  if (state.prosperity <= CONFIG.PROSPERITY_MIN) {
    state.phase = 'collapsed';
    logEvent(state, `💥 Society collapsed — Prosperity fell to ${state.prosperity}. Everyone loses.`);
  } else if (stillAlive.length === 0) {
    state.phase = 'collapsed';
    logEvent(state, `💥 Every citizen went bankrupt. Society collapses.`);
  } else if (state.prosperity >= CONFIG.PROSPERITY_GOAL) {
    state.phase = 'ended';
    state.winners = getRanking(state);
    logEvent(state, `🎉 Prosperity reached ${CONFIG.PROSPERITY_GOAL}! The game ends. Richest survivor wins.`);
  } else {
    state.phase = 'resolved';
  }

  return result;
}

/** Final ranking of surviving players by personal Coins (desc). */
export function getRanking(state) {
  return alivePlayers(state)
    .slice()
    .sort((a, b) => b.coins - a.coins)
    .map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, coins: p.coins, isBot: p.isBot }));
}

// ----------------------------------------------------------------------------
// Voting system
// ----------------------------------------------------------------------------

// The build focus now auto-rotates every round, so votes cover policy only.
const VOTE_CYCLE = ['taxPolicy', 'welfarePolicy'];

/** Whether a voting phase should trigger after the round that just resolved. */
export function shouldVote(state) {
  return state.phase === 'resolved' && state.round % CONFIG.VOTING_INTERVAL === 0;
}

export function startVote(state) {
  const type = VOTE_CYCLE[state.votesHeld % VOTE_CYCLE.length];
  let prompt, options;
  if (type === 'taxPolicy') {
    prompt = 'Set the tax policy for the coming rounds.';
    options = [
      { id: 'flat', label: 'Flat — no forced contributions; full personal freedom.' },
      { id: 'progressive', label: `Progressive — richest pays a ${pct(CONFIG.PROGRESSIVE_TAX_RATE)} wealth levy each round into the pool.` },
    ];
  } else {
    prompt = 'Welfare or expansion?';
    options = [
      { id: 'expansion', label: 'Expansion — every contributed Coin drives Prosperity & infrastructure.' },
      { id: 'welfare', label: `Welfare — ${pct(CONFIG.WELFARE_SHARE)} of the pool is given to the poorest citizen each round.` },
    ];
  }
  state.pendingVote = { type, prompt, options, votes: {} };
  state.phase = 'vote';
  logEvent(state, `🗳 Voting phase: ${prompt}`);
  return state.pendingVote;
}

export function submitVote(state, playerId, optionId) {
  if (state.phase !== 'vote' || !state.pendingVote) return false;
  const p = state.players[playerId];
  if (!p || !p.alive) return false;
  if (!state.pendingVote.options.some((o) => o.id === optionId)) return false;
  state.pendingVote.votes[playerId] = optionId;
  return true;
}

export function allVotesIn(state) {
  if (!state.pendingVote) return false;
  return alivePlayers(state).every((p) => state.pendingVote.votes[p.id] != null);
}

export function resolveVote(state) {
  const vote = state.pendingVote;
  if (!vote) return null;

  // Tally influence weight per option.
  const tally = {};
  for (const o of vote.options) tally[o.id] = 0;
  for (const p of alivePlayers(state)) {
    const choice = vote.votes[p.id];
    if (choice != null && tally[choice] != null) tally[choice] += p.influence;
  }

  // Winner = highest influence weight (ties broken by option order / current value).
  let winner = vote.options[0].id;
  let best = -1;
  for (const o of vote.options) {
    if (tally[o.id] > best) {
      best = tally[o.id];
      winner = o.id;
    }
  }

  // Apply outcome.
  if (vote.type === 'infraFocus') state.infraFocus = winner;
  else if (vote.type === 'taxPolicy') state.taxPolicy = winner;
  else if (vote.type === 'welfarePolicy') state.welfarePolicy = winner;

  const winLabel = vote.options.find((o) => o.id === winner)?.label || winner;
  state.lastVoteResult = { type: vote.type, winner, winLabel, tally };
  state.voteHistory.push({ round: state.round, type: vote.type, winner, winLabel });
  state.votesHeld += 1;
  state.pendingVote = null;
  state.phase = 'resolved';
  logEvent(state, `🗳 Vote passed: ${winLabel}`);
  return state.lastVoteResult;
}

// ----------------------------------------------------------------------------
// Flavour text
// ----------------------------------------------------------------------------
const INFRA_BLURB = {
  roads: 'raises Base Income for everyone',
  education: 'boosts Prosperity growth efficiency',
  energy: 'cuts the cost of future projects',
  healthcare: 'softens the blow of crises',
  industry: 'pays contributors a Coin bonus',
};

const EVENTS = [
  'Market crash', 'Drought', 'Energy shortage', 'Labour strike',
  'Border dispute', 'Disease outbreak', 'Corruption scandal', 'Natural disaster',
];
function pickEvent(rng) {
  return EVENTS[Math.floor(rng() * EVENTS.length)];
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function pct(x) {
  return `${Math.round(x * 100)}%`;
}
