// ============================================================================
// Prosperity State — AI bots
// Bots fill empty seats. Each has an archetype (GDD section 6) that shapes how
// generous it is and how it votes. Decisions react to the live game state:
// collapse risk pushes everyone to give; an imminent win makes self-interested
// bots start hoarding to top the final wealth ranking.
// ============================================================================

import { CONFIG } from './constants.js';
import { alivePlayers, roundThreshold } from './engine.js';

// Base contribution fraction of income, per archetype.
const BASE_FRACTION = {
  builder: 0.85,
  strategist: 0.55,
  opportunist: 0.5,
  freerider: 0.2,
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
};

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Decide how many Coins (0..income) a bot contributes this round.
 */
export function decideContribution(state, bot) {
  const income = bot.income;
  if (income <= 0) return 0;

  let fraction = BASE_FRACTION[bot.archetype] ?? 0.5;

  const P = state.prosperity;
  const goal = CONFIG.PROSPERITY_GOAL;
  const living = alivePlayers(state);

  const lateGame = P >= goal * 0.85;

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
  // in the late game when their greed takes over; free-riders never (until collapse).
  const fairShare = Math.ceil(roundThreshold(state) / Math.max(1, living.length));
  const coversShare =
    P <= 15 ||
    bot.archetype === 'builder' ||
    bot.archetype === 'strategist' ||
    (bot.archetype === 'opportunist' && !lateGame);
  if (coversShare) {
    amount = Math.max(amount, Math.min(income, fairShare));
  }

  return clamp(amount, 0, income);
}

/**
 * Decide a bot's vote for the current pending vote, returning an option id.
 */
export function decideVote(state, bot) {
  const vote = state.pendingVote;
  if (!vote) return null;
  const optionIds = vote.options.map((o) => o.id);
  const pick = (...prefs) => prefs.find((id) => optionIds.includes(id)) || optionIds[0];

  const living = alivePlayers(state);
  const richest = living.reduce((a, b) => (b.coins > a.coins ? b : a), living[0]);
  const poorest = living.reduce((a, b) => (b.coins < a.coins ? b : a), living[0]);
  const amRichest = richest && richest.id === bot.id;
  const amPoorest = poorest && poorest.id === bot.id;

  if (vote.type === 'infraFocus') {
    switch (bot.archetype) {
      case 'builder':     return pick('education', 'roads', 'energy');
      case 'strategist':  return pick('energy', 'education', 'roads');
      case 'opportunist': return pick('industry', 'roads', 'education');
      case 'freerider':   return pick('industry', 'roads', 'healthcare');
      default:            return pick('roads');
    }
  }

  if (vote.type === 'taxPolicy') {
    switch (bot.archetype) {
      case 'builder':     return pick('progressive', 'flat');
      case 'strategist':  return pick(amRichest ? 'flat' : 'progressive', 'flat');
      case 'opportunist': return pick(amRichest ? 'flat' : 'progressive', 'flat');
      case 'freerider':   return pick('flat', 'progressive');
      default:            return pick('flat');
    }
  }

  // welfarePolicy
  switch (bot.archetype) {
    case 'builder':     return pick('expansion', 'welfare');
    case 'strategist':  return pick('expansion', 'welfare');
    case 'opportunist': return pick(amPoorest ? 'welfare' : 'expansion', 'expansion');
    case 'freerider':   return pick(amPoorest ? 'welfare' : 'expansion', 'welfare');
    default:            return pick('expansion');
  }
}
