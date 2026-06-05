// ============================================================================
// Prosperity State — Core Tuning Parameters (GDD v1.1, section 10)
// All values here are the single source of truth for game balance.
// ============================================================================

export const CONFIG = {
  // --- Personal economy ---
  START_COINS: 30,            // Starting personal Coins
  BASE_INCOME: 10,            // Base Income (B), before Roads infrastructure
  // Prosperity Multiplier M = 1 + (P / PROSPERITY_DIVISOR)
  PROSPERITY_DIVISOR: 40,

  // --- Prosperity (society health) ---
  START_PROSPERITY: 10,
  PROSPERITY_GOAL: 100,
  PROSPERITY_MIN: 0,          // <= this => societal collapse
  // K = max(K_FLOOR, K_BASE - floor(C / K_DIVISOR))
  K_FLOOR: 4,
  K_BASE: 16,
  K_DIVISOR: 3,

  // --- Top Contributor Bonus ---
  TOP_CONTRIBUTOR_BONUS: 0.20, // 20% of own contribution refunded to top giver

  // --- Influence ---
  INFLUENCE_DECAY: 0.8,        // multiply previous influence, then floor
  MIN_INFLUENCE: 1,            // every living player always has >= 1

  // --- Voting ---
  VOTING_INTERVAL: 3,          // a voting phase occurs every N rounds

  // --- Free-rider deterrence (conditional cooperation) ---
  // Each player carries a rolling "cooperation score" (0..1) = how much of their
  // income they've been contributing. Bots refuse to subsidize anyone who lets it
  // fall too low, so a persistent free-rider drags Prosperity down instead of up.
  COOP_EMA: 0.55,             // weight on prior reputation vs this round's behaviour
  FREERIDER_THRESHOLD: 0.25,  // contributing under ~25% of income = treated as a free-rider
  FREERIDER_GRACE_ROUNDS: 2,  // no detection until more than this many rounds resolved

  // --- Minimum collective contribution (maintenance) ---
  // Each round the nation must pool at least this fraction of total potential
  // income, or nothing is built and Prosperity decays from neglect.
  MAINTENANCE_FRACTION: 0.35,  // threshold = ceil(income * livingPlayers * fraction)
  NEGLECT_BASE: 3,             // Prosperity lost when the threshold is missed ...
  NEGLECT_SCALE_DIV: 20,       // ... plus floor(Prosperity / this) so neglect bites harder later

  // --- Infrastructure ---
  INFRA_MAX_LEVEL: 5,
  // Cost (in accumulated contribution progress) to reach the *next* level L.
  INFRA_BASE_COST: 40,         // cost(nextLevel) = INFRA_BASE_COST * nextLevel * (1 - energyDiscount)
  INFRA_CATEGORIES: ['roads', 'education', 'energy', 'healthcare', 'industry'],
  // The build focus auto-rotates to the next un-maxed category every round, so
  // construction spreads across all national projects over the game.

  // Per-level infrastructure effects (level 0..5)
  ROADS_INCOME_PER_LEVEL: 2,        // +2 Base Income per Roads level
  EDUCATION_DP_BONUS_PER_LEVEL: 0.10, // +10% ΔP efficiency per Education level
  ENERGY_DISCOUNT_PER_LEVEL: 0.08,  // -8% infra upgrade cost per Energy level (max 40%)
  HEALTHCARE_MITIGATION_PER_LEVEL: 0.15, // -15% event damage per Healthcare level
  INDUSTRY_BONUS_PER_LEVEL: 1,      // +1 Coin per Industry level to each contributor

  // --- Policies (set by votes) ---
  PROGRESSIVE_TAX_RATE: 0.05,  // progressive tax: richest alive pays 5% of wealth as levy
  WELFARE_SHARE: 0.15,         // welfare: 15% of the pool is redirected to the poorest player

  // --- Negative events ---
  EVENT_START_ROUND: 3,        // events can occur from this round onward
  EVENT_CHANCE: 0.30,          // probability of a negative event each eligible round
  EVENT_MIN_DAMAGE: 4,         // base prosperity damage range (before healthcare mitigation)
  EVENT_MAX_DAMAGE: 10,

  // --- Lobby / session ---
  MIN_PLAYERS: 2,              // minimum seats (humans + bots) to start
  MAX_PLAYERS: 6,
};

// Bot personality archetypes (section 6: emergent roles).
export const BOT_ARCHETYPES = [
  'builder', 'strategist', 'opportunist', 'freerider', 'reciprocator',
  'conformist', 'guardian', 'egalitarian', 'philanthropist', 'sprinter',
  'miser', 'politician', 'contrarian', 'investor', 'grudger',
];

// Friendly names pool for bots.
export const BOT_NAMES = [
  'Arben', 'Lira', 'Dren', 'Besa', 'Luan', 'Kaltrina',
  'Ilir', 'Era', 'Fisnik', 'Jon', 'Nora', 'Valon',
  'Alex', 'Sofia', 'Maya', 'Liam', 'Noah', 'Emma',
  'Lucas', 'Nina', 'Daniel', 'Blin'
];
