// ============================================================================
// Prosperity State — game records (Neon / Postgres)
// Persists every finished game (summary + full round history) so the data can
// be analysed later. Entirely optional: if DATABASE_URL is not set, all calls
// are no-ops and the game runs exactly as before.
// ============================================================================

import pg from 'pg';
import { getRanking } from './engine.js';

const { Pool } = pg;

let pool = null;
let ready = false;

export function dbEnabled() {
  return !!process.env.DATABASE_URL;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS games (
  id                BIGSERIAL PRIMARY KEY,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  room_code         TEXT,
  outcome           TEXT NOT NULL,          -- 'ended' | 'collapsed'
  rounds            INT  NOT NULL,
  final_prosperity  INT  NOT NULL,
  num_players       INT  NOT NULL,
  num_humans        INT  NOT NULL,
  num_bots          INT  NOT NULL,
  winner_name       TEXT,
  winner_coins      INT,
  winner_archetype  TEXT,
  winner_is_bot     BOOLEAN,
  players           JSONB NOT NULL,         -- [{name,archetype,isBot,coins,influence,alive,bankrupt}]
  ranking           JSONB,                  -- final wealth ranking
  infrastructure    JSONB NOT NULL,         -- final levels per category
  tax_policy        TEXT,
  welfare_policy    TEXT,
  votes             JSONB                   -- [{round,type,winner,winLabel}]
);

CREATE TABLE IF NOT EXISTS game_rounds (
  id                BIGSERIAL PRIMARY KEY,
  game_id           BIGINT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  round             INT NOT NULL,
  pool              INT,
  threshold         INT,
  below_threshold   BOOLEAN,
  neglect           INT,
  delta_p           INT,
  k                 INT,
  prosperity_before INT,
  prosperity_after  INT,
  focus             TEXT,
  event             JSONB,
  contributions     JSONB,                  -- [{id,name,amount}]
  top_contributors  JSONB,
  upgrades          JSONB,
  bankrupted        JSONB,
  free_riders       JSONB
);

CREATE INDEX IF NOT EXISTS idx_games_created  ON games(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_games_outcome  ON games(outcome);
CREATE INDEX IF NOT EXISTS idx_rounds_game    ON game_rounds(game_id);
`;

export async function initDb() {
  if (!dbEnabled()) {
    console.log('  Game records: disabled (no DATABASE_URL set)');
    return;
  }
  pool = new Pool({
    // Strip sslmode from the URL and enforce TLS via the explicit option instead
    // (avoids a pg deprecation warning while keeping the required Neon encryption).
    connectionString: process.env.DATABASE_URL.replace(/[?&]sslmode=[^&]*/i, ''),
    ssl: { rejectUnauthorized: false }, // Neon requires TLS
    max: 4,
    idleTimeoutMillis: 30_000,
  });
  try {
    await pool.query(SCHEMA_SQL);
    ready = true;
    console.log('  Game records: connected to Postgres ✓');
  } catch (e) {
    console.error('  Game records: connection/schema failed —', e.message);
    pool = null;
  }
}

/**
 * Persist one finished game. Fire-and-forget; never throws into game flow.
 */
export async function recordGame(state, roomCode) {
  if (!ready || !pool) return;

  const players = Object.values(state.players).map((p) => ({
    name: p.name, archetype: p.archetype, isBot: p.isBot,
    coins: p.coins, influence: p.influence, alive: p.alive, bankrupt: p.bankrupt,
  }));
  const ranking = getRanking(state);
  const numHumans = players.filter((p) => !p.isBot).length;

  // Winner = top of the ranking, but only when the nation actually succeeded.
  let winner = null;
  if (state.phase === 'ended' && ranking[0]) {
    const ep = state.players[ranking[0].id];
    winner = { name: ranking[0].name, coins: ranking[0].coins, archetype: ep?.archetype ?? null, isBot: ep?.isBot ?? null };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const g = await client.query(
      `INSERT INTO games
        (room_code, outcome, rounds, final_prosperity, num_players, num_humans, num_bots,
         winner_name, winner_coins, winner_archetype, winner_is_bot,
         players, ranking, infrastructure, tax_policy, welfare_policy, votes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id`,
      [
        roomCode, state.phase, state.round, state.prosperity,
        players.length, numHumans, players.length - numHumans,
        winner?.name ?? null, winner?.coins ?? null, winner?.archetype ?? null, winner?.isBot ?? null,
        JSON.stringify(players), JSON.stringify(ranking), JSON.stringify(state.infrastructure),
        state.taxPolicy, state.welfarePolicy, JSON.stringify(state.voteHistory || []),
      ]
    );
    const gameId = g.rows[0].id;

    for (const r of state.roundHistory || []) {
      await client.query(
        `INSERT INTO game_rounds
          (game_id, round, pool, threshold, below_threshold, neglect, delta_p, k,
           prosperity_before, prosperity_after, focus, event, contributions,
           top_contributors, upgrades, bankrupted, free_riders)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          gameId, r.round, r.pool, r.threshold ?? null, !!r.belowThreshold, r.neglect ?? 0,
          r.deltaP, r.K ?? null, r.prosperityBefore, r.prosperityAfter, r.focus ?? null,
          JSON.stringify(r.event || null), JSON.stringify(r.contributions || []),
          JSON.stringify(r.topContributors || []), JSON.stringify(r.upgrades || []),
          JSON.stringify(r.bankrupted || []), JSON.stringify(r.freeRiders || []),
        ]
      );
    }

    await client.query('COMMIT');
    console.log(`  Recorded game #${gameId} — ${state.phase}, ${state.round} rounds.`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('  recordGame failed:', e.message);
  } finally {
    client.release();
  }
}

// ----------------------------------------------------------------------------
// Read helpers (for the small /api endpoints)
// ----------------------------------------------------------------------------
export async function recentGames(limit = 20) {
  if (!ready) return [];
  const { rows } = await pool.query(
    `SELECT id, created_at, outcome, rounds, final_prosperity, num_players, num_humans,
            winner_name, winner_coins, winner_archetype, winner_is_bot
       FROM games ORDER BY created_at DESC LIMIT $1`,
    [Math.min(200, Math.max(1, limit))]
  );
  return rows;
}

export async function gameDetail(id) {
  if (!ready) return null;
  const g = await pool.query('SELECT * FROM games WHERE id = $1', [id]);
  if (!g.rows[0]) return null;
  const r = await pool.query('SELECT * FROM game_rounds WHERE game_id = $1 ORDER BY round', [id]);
  return { ...g.rows[0], rounds_detail: r.rows };
}

export async function stats() {
  if (!ready) return { enabled: false };
  const [tot, byOutcome, avg, byArch] = await Promise.all([
    pool.query('SELECT count(*)::int AS n FROM games'),
    pool.query('SELECT outcome, count(*)::int AS n FROM games GROUP BY outcome'),
    pool.query("SELECT round(avg(rounds),1) AS avg_rounds FROM games WHERE outcome='ended'"),
    pool.query("SELECT winner_archetype, count(*)::int AS wins FROM games WHERE outcome='ended' AND winner_archetype IS NOT NULL GROUP BY winner_archetype ORDER BY wins DESC"),
  ]);
  return {
    enabled: true,
    total_games: tot.rows[0].n,
    outcomes: byOutcome.rows,
    avg_rounds_to_win: avg.rows[0]?.avg_rounds ?? null,
    wins_by_archetype: byArch.rows,
  };
}
