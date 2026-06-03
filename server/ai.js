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

  let fraction = BASE_FRACTION[bot.archetype] ?? 0.5;

  // ===== Reciprocator — generous tit-for-tat =====
  // Mirrors LAST round's least-cooperative citizen: gives only a little after
  // someone free-rode, then ramps its share back up as that citizen starts
  // contributing again. Begins cooperatively and still helps avert a collapse.
  if (bot.archetype === 'reciprocator') {
    const others = living.filter((p) => p.id !== bot.id);
    const lastFracs = others.map((p) =>
      p.lastContribution == null ? 0.6 : clamp(p.lastContribution / Math.max(1, income), 0, 1)
    );
    const laggard = lastFracs.length ? Math.min(...lastFracs) : 0.6;
    let frac = clamp(0.1 + laggard, 0, 1); // a little, plus mirror (slightly more generous than the laggard)
    const fell = state.lastRoundResult && (state.lastRoundResult.belowThreshold || state.lastRoundResult.deltaP < 0);
    if (fell || P <= 12) frac = Math.max(frac, fairShareFrac); // pitch in to reverse a decline
    frac += (Math.random() - 0.5) * 0.05;
    return clamp(Math.round(income * clamp(frac, 0, 1)), 0, income);
  }

  // ===== Conditional cooperation =====
  // Look at the LEAST cooperative other citizen. If someone is persistently
  // free-riding, cooperative bots refuse to keep subsidizing them: they pull
  // their own giving down toward the offender's level, so the round minimum is
  // missed and Prosperity falls — pressure that only lifts once the free-rider
  // starts paying in (which raises their cooperation score back up).
  const others = living.filter((p) => p.id !== bot.id);
  const worstCoop = others.length ? Math.min(...others.map((p) => p.coopScore ?? 0.5)) : 1;
  const freeRiderPresent =
    state.round > CONFIG.FREERIDER_GRACE_ROUNDS && worstCoop < CONFIG.FREERIDER_THRESHOLD;

  if (freeRiderPresent) {
    const loyalty = PROTEST_LOYALTY[bot.archetype] ?? 1;
    fraction = Math.min(fraction, worstCoop * loyalty);
    // A free-rider bot only relents once the decline is actually hurting the nation.
    if (bot.archetype === 'freerider') {
      const last = state.lastRoundResult;
      const hurting = last && (last.belowThreshold || last.deltaP < 0);
      if (hurting || P <= 12) fraction = Math.max(fraction, fairShareFrac);
    }
    fraction += (Math.random() - 0.5) * 0.05;
    return clamp(Math.round(income * clamp(fraction, 0, 1)), 0, income);
  }

  // ===== Normal cooperation (no free-rider) =====

  // --- Collapse avoidance: if society is fragile, everyone chips in more. ---
  if (P <= 15) fraction = Math.max(fraction, 0.7);
  if (P <= 8) fraction = Math.max(fraction, 0.9);

  // --- Opportunist: snipe the Top Contributor bonus when others hold back (early/mid only). ---
  if (bot.archetype === 'opportunist' && P < goal * 0.6) {
    const othersLikelyLow = living.length <= 3 || P < 30;
    if (othersLikelyLow) fraction = Math.max(fraction, 0.65);
  }

  // --- Freerider: self-preserves near collapse, otherwise coasts. ---
  if (bot.archetype === 'freerider' && P > 25) {
    fraction = Math.min(fraction, 0.25);
  }

  // --- Endgame selfishness: as the goal nears, self-interested archetypes keep
  //     more of their income to climb the final wealth ranking. Builders never
  //     hoard — they care about reaching 100. `start` = fraction of the goal at
  //     which greed kicks in; `cut` = how hard contribution is throttled by P=100.
  const eg = ENDGAME[bot.archetype] || { start: 0.8, cut: 0.6 };
  if (eg.cut > 0 && P >= goal * eg.start) {
    const span = goal - goal * eg.start || 1;
    const nearness = clamp((P - goal * eg.start) / span, 0, 1);
    fraction *= 1 - eg.cut * nearness;
  }

  // Add a little noise so bots don't move in lockstep.
  fraction += (Math.random() - 0.5) * 0.1;
  fraction = clamp(fraction, 0, 1);

  let amount = clamp(Math.round(income * fraction), 0, income);

  // Pull their weight toward the maintenance minimum so the nation keeps building.
  // Builders & strategists always cover their share; opportunists do too, EXCEPT
  // in the late game when their greed takes over. Free-riders normally don't —
  // but they snap out of it and pitch in the moment Prosperity actually falls
  // (a missed minimum or a damaging event last round).
  const prosperityFell = !!(state.lastRoundResult &&
    (state.lastRoundResult.belowThreshold || state.lastRoundResult.deltaP < 0));
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
