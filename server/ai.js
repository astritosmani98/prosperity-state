// ============================================================================
// Prosperity State — AI bots
// Bots fill empty seats. Each has an archetype (GDD section 6) that shapes how
// generous it is and how it votes. Decisions react to the live game state:
// collapse risk pushes everyone to give; an imminent win makes self-interested
// bots start hoarding to top the final wealth ranking.
// ============================================================================

import { CONFIG } from './constants.js';
import { alivePlayers, roundThreshold } from './engine.js';

// How far each archetype will keep cooperating while protesting a free-rider.
// Higher = holds out a little longer, but everyone still cuts enough that the
// round minimum is missed and Prosperity slides.
const PROTEST_LOYALTY = {
  builder: 1.6,
  strategist: 1.1,
  opportunist: 0.8,
  freerider: 0.5,
  reciprocator: 1.0,
};

// Base contribution fraction of income, per archetype.
const BASE_FRACTION = {
  builder: 0.85,
  strategist: 0.55,
  opportunist: 0.5,
  // Just above the free-rider line: gives the minimum needed to dodge punishment,
  // then hoards the rest. (Punishment threshold is FREERIDER_THRESHOLD = 25%.)
  freerider: 0.3,
  reciprocator: 0.55, // fallback only; its real giving is computed by mirroring (below)
};

// Endgame greed, per archetype. `start` = share of the goal where selfishness
// begins; `cut` = how much contribution is throttled by the time Prosperity hits
// the goal (0 = never hoards, 1 = stops giving entirely). Opportunists turn
// ruthless early and hard; builders stay loyal to the cause.
const ENDGAME = {
  builder:     { start: 1.0,  cut: 0.0 },
  strategist:  { start: 0.75, cut: 0.8 },
  opportunist: { start: 0.6,  cut: 1.0 },
  freerider:   { start: 0.7,  cut: 1.0 },
  reciprocator:{ start: 0.9,  cut: 0.3 }, // principled; only mildly tightens at the very end
};

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Decide how many Coins (0..income) a bot contributes this round.
 */
export function decideContribution(state, bot) {
  const income = bot.income;
  if (income <= 0) return 0;

  const P = state.prosperity;
  const goal = CONFIG.PROSPERITY_GOAL;
  const living = alivePlayers(state);
  const lateGame = P >= goal * 0.85;
  const fairShare = Math.ceil(roundThreshold(state) / Math.max(1, living.length));
  const fairShareFrac = clamp(fairShare / income, 0, 1);

  // Shared signals used by the personas below.
  const others = living.filter((p) => p.id !== bot.id);
  const prosperityFell = !!(state.lastRoundResult &&
    (state.lastRoundResult.belowThreshold || state.lastRoundResult.deltaP < 0));
  const lastFrac = (p) => (p.lastContribution == null ? 0.6 : clamp(p.lastContribution / Math.max(1, income), 0, 1));
  const avgCoins = living.reduce((s, p) => s + p.coins, 0) / Math.max(1, living.length);
  const maxCoins = Math.max(...living.map((p) => p.coins));
  const finalize = (frac) => clamp(Math.round(income * clamp(frac + (Math.random() - 0.5) * 0.06, 0, 1)), 0, income);

  let fraction = BASE_FRACTION[bot.archetype] ?? 0.5;

  // ===== Personas that fully govern their own giving (early return) =====
  switch (bot.archetype) {
    case 'reciprocator': {
      // Generous tit-for-tat: mirror last round's least-cooperative citizen.
      const laggard = others.length ? Math.min(...others.map(lastFrac)) : 0.6;
      let frac = clamp(0.1 + laggard, 0, 1);
      if (prosperityFell || P <= 12) frac = Math.max(frac, fairShareFrac);
      return finalize(frac);
    }
    case 'conformist': {
      // Match the crowd: give the average of what everyone gave last round.
      const fr = others.map(lastFrac);
      let frac = fr.length ? fr.reduce((a, b) => a + b, 0) / fr.length : 0.6;
      if (P <= 12) frac = Math.max(frac, fairShareFrac);
      return finalize(frac);
    }
    case 'guardian': {
      // Altruist: prevents collapse at the cost of its own ranking; never hoards.
      let frac = 0.6;
      if (P <= 45) frac = 0.85;
      if (P <= 22) frac = 1.0;
      if (prosperityFell) frac = Math.max(frac, 0.9);
      return finalize(frac);
    }
    case 'egalitarian': {
      // Keep wealth equal: give more when ahead, hold back when behind.
      let frac = bot.coins > avgCoins ? 0.8 : (bot.coins < avgCoins ? 0.3 : 0.55);
      if (P <= 12) frac = Math.max(frac, fairShareFrac);
      return finalize(frac);
    }
    case 'philanthropist': {
      // Competitive generosity: out-give last round's top giver to win the bonus.
      const topLast = Math.max(0, ...others.map((p) => p.lastContribution || 0));
      let frac = Math.max(0.6, Math.min(income, topLast + 2) / Math.max(1, income));
      return finalize(frac);
    }
    case 'sprinter': {
      // Coast early to build savings, then surge late to grab the bonus & finish it.
      let frac = P < goal * 0.5 ? 0.25 : (P < goal * 0.8 ? 0.5 : 0.95);
      if (P <= 12) frac = Math.max(frac, fairShareFrac);
      return finalize(frac);
    }
    case 'miser': {
      // Bare minimum to dodge free-rider punishment; hoard everything else.
      let frac = CONFIG.FREERIDER_THRESHOLD + 0.04;
      if (P <= 12) frac = Math.max(frac, fairShareFrac);
      return finalize(frac);
    }
    case 'politician': {
      // Chase Influence (especially right before a vote) to control policy.
      let frac = 0.6;
      if (state.round % CONFIG.VOTING_INTERVAL === 0) frac = 0.8; // a vote follows this round
      const maxInf = Math.max(...living.map((p) => p.influence));
      if (bot.influence < maxInf) frac = Math.max(frac, 0.75);
      if (P <= 12) frac = Math.max(frac, fairShareFrac);
      return finalize(frac);
    }
    case 'contrarian': {
      // Resentful under-contributor (its real flavour is voting against the grain).
      let frac = bot.coins < maxCoins ? 0.25 : 0.4;
      if (prosperityFell || P <= 10) frac = Math.max(frac, fairShareFrac);
      return finalize(frac);
    }
    case 'investor': {
      // Build infrastructure multipliers early, reap (and bank) later.
      let frac = P < goal * 0.6 ? 0.8 : 0.45;
      if (P <= 12) frac = Math.max(frac, fairShareFrac);
      return finalize(frac);
    }
    case 'grudger': {
      // Grim trigger: cooperate until ANY free-rider appears, then defect for good.
      if (others.some((p) => (p.coopScore ?? 0.5) < CONFIG.FREERIDER_THRESHOLD)) bot.grudged = true;
      let frac = bot.grudged ? 0.12 : 0.7;
      if (!bot.grudged && P <= 12) frac = Math.max(frac, fairShareFrac);
      else if (bot.grudged && P <= 8) frac = Math.max(frac, 0.35); // minimal self-preservation
      return finalize(frac);
    }
  }

  // ===== Conditional cooperation (builder / strategist / opportunist / freerider) =====
  // If someone is persistently free-riding, these bots stop subsidizing them and
  // pull their giving down to the offender's level, so the round minimum is missed
  // and Prosperity falls until the free-rider starts paying in again.
  const worstCoop = others.length ? Math.min(...others.map((p) => p.coopScore ?? 0.5)) : 1;
  const freeRiderPresent =
    state.round > CONFIG.FREERIDER_GRACE_ROUNDS && worstCoop < CONFIG.FREERIDER_THRESHOLD;

  if (freeRiderPresent) {
    const loyalty = PROTEST_LOYALTY[bot.archetype] ?? 1;
    fraction = Math.min(fraction, worstCoop * loyalty);
    if (bot.archetype === 'freerider' && (prosperityFell || P <= 12)) {
      fraction = Math.max(fraction, fairShareFrac);
    }
    fraction += (Math.random() - 0.5) * 0.05;
    return clamp(Math.round(income * clamp(fraction, 0, 1)), 0, income);
  }

  // ===== Normal cooperation (no free-rider) =====
  if (P <= 15) fraction = Math.max(fraction, 0.7);
  if (P <= 8) fraction = Math.max(fraction, 0.9);

  if (bot.archetype === 'opportunist' && P < goal * 0.6) {
    const othersLikelyLow = living.length <= 3 || P < 30;
    if (othersLikelyLow) fraction = Math.max(fraction, 0.65);
  }
  if (bot.archetype === 'freerider' && P > 25) {
    fraction = Math.min(fraction, 0.25);
  }

  // Endgame selfishness: self-interested archetypes keep more as the goal nears.
  const eg = ENDGAME[bot.archetype] || { start: 0.8, cut: 0.6 };
  if (eg.cut > 0 && P >= goal * eg.start) {
    const span = goal - goal * eg.start || 1;
    const nearness = clamp((P - goal * eg.start) / span, 0, 1);
    fraction *= 1 - eg.cut * nearness;
  }

  fraction += (Math.random() - 0.5) * 0.1;
  fraction = clamp(fraction, 0, 1);
  let amount = clamp(Math.round(income * fraction), 0, income);

  // Cover the maintenance minimum so the nation keeps building.
  const coversShare =
    P <= 15 ||
    bot.archetype === 'builder' ||
    bot.archetype === 'strategist' ||
    (bot.archetype === 'opportunist' && !lateGame) ||
    (bot.archetype === 'freerider' && prosperityFell);
  if (coversShare) {
    amount = Math.max(amount, Math.min(income, fairShare));
  }

  return clamp(amount, 0, income);
}

/**
 * Decide a bot's vote — purely in its own self-interest, based on its current
 * wealth position rather than its archetype's ideals.
 */
export function decideVote(state, bot) {
  const vote = state.pendingVote;
  if (!vote) return null;
  const optionIds = vote.options.map((o) => o.id);
  const pick = (...prefs) => prefs.find((id) => optionIds.includes(id)) || optionIds[0];

  const living = alivePlayers(state);
  const coins = living.map((p) => p.coins);
  const maxCoins = Math.max(...coins);
  const minCoins = Math.min(...coins);
  const amRichest = bot.coins >= maxCoins;
  const amPoorest = bot.coins <= minCoins;
  // Rank 0 = richest. Used to judge whether redistribution helps or hurts me.
  const richerThanMe = living.filter((p) => p.coins > bot.coins).length;
  const inBottomHalf = richerThanMe >= living.length / 2;

  // --- Persona-specific voting (overrides the wealth-based default) ---
  if (bot.archetype === 'egalitarian' || bot.archetype === 'politician') {
    // Pro-redistribution: tax the rich and fund welfare — the egalitarian on
    // principle, the politician to court the (poorer) majority.
    if (vote.type === 'taxPolicy') return pick('progressive', 'flat');
    if (vote.type === 'welfarePolicy') return pick('welfare', 'expansion');
  }
  if (bot.archetype === 'contrarian') {
    // Always push for change — vote against whatever policy is currently in force.
    if (vote.type === 'taxPolicy') return pick(state.taxPolicy === 'progressive' ? 'flat' : 'progressive');
    if (vote.type === 'welfarePolicy') return pick(state.welfarePolicy === 'welfare' ? 'expansion' : 'welfare');
  }

  if (vote.type === 'taxPolicy') {
    // The progressive levy only taxes the single richest citizen. So the leader
    // votes flat to protect their pile; everyone else is happy to tax the leader
    // (it grows the pool — and Prosperity — at someone else's expense).
    return pick(amRichest ? 'flat' : 'progressive', 'flat');
  }

  if (vote.type === 'welfarePolicy') {
    // Welfare skims the pool to the poorest citizen. If I'm at or near the bottom
    // (or at real bankruptcy risk) that's me — vote welfare. Otherwise I'd rather
    // every Coin drove growth I benefit from, so vote expansion.
    const struggling = amPoorest || inBottomHalf || bot.coins <= bot.income * 1.5;
    return pick(struggling ? 'welfare' : 'expansion', 'expansion');
  }

  // Fallback for any other vote type: keep the status quo / first option.
  return pick(optionIds[0]);
}
