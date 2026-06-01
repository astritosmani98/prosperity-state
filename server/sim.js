// Headless simulation: run a full all-bot game and print the trajectory.
// Usage: npm run sim  [numPlayers]  [seed]
import {
  createGame, beginRound, submitContribution, resolveRound,
  shouldVote, startVote, submitVote, resolveVote, getRanking, alivePlayers,
} from './engine.js';
import { decideContribution, decideVote } from './ai.js';
import { BOT_ARCHETYPES, BOT_NAMES } from './constants.js';

const n = parseInt(process.argv[2] || '4', 10);

const seats = Array.from({ length: n }, (_, i) => ({
  id: `bot${i}`,
  name: BOT_NAMES[i],
  isBot: true,
  archetype: BOT_ARCHETYPES[i % BOT_ARCHETYPES.length],
}));

const state = createGame(seats);
console.log(`Starting game with ${n} bots:`, seats.map((s) => `${s.name}(${s.archetype})`).join(', '));
console.log('='.repeat(70));

const MAX_ROUNDS = 40;
while (state.phase !== 'ended' && state.phase !== 'collapsed' && state.round < MAX_ROUNDS) {
  beginRound(state);

  for (const p of alivePlayers(state)) {
    submitContribution(state, p.id, decideContribution(state, p));
  }
  const r = resolveRound(state);

  const contribStr = r.contributions.map((c) => `${c.name}:${c.amount}`).join(' ');
  console.log(
    `R${String(r.round).padStart(2)} | P ${String(r.prosperityBefore).padStart(3)}→${String(r.prosperityAfter).padStart(3)} (+${r.deltaP}, K=${r.K}) | pool ${r.pool} | ${contribStr}` +
    (r.event ? ` | ⚠${r.event.name} -${r.event.damage}` : '') +
    (r.upgrades.length ? ` | 🏗${r.upgrades.map((u) => u.category + ' L' + u.level).join(',')}` : '')
  );

  if (shouldVote(state)) {
    startVote(state);
    for (const p of alivePlayers(state)) submitVote(state, p.id, decideVote(state, p));
    const v = resolveVote(state);
    console.log(`     🗳 ${v.type} → ${v.winner}`);
  }
}

console.log('='.repeat(70));
console.log(`Outcome: ${state.phase} after ${state.round} rounds. Final Prosperity ${state.prosperity}.`);
console.log('Infrastructure:', state.infrastructure);
if (state.phase === 'ended') {
  console.log('Final ranking:');
  for (const w of getRanking(state)) {
    console.log(`  #${w.rank} ${w.name} — ${w.coins} Coins`);
  }
} else {
  console.log('Coins at collapse:', Object.values(state.players).map((p) => `${p.name}:${p.coins}${p.bankrupt ? '(bankrupt)' : ''}`).join(' '));
}
