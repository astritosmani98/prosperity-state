// End-to-end protocol test: connect as a human, fill with bots, play to the end.
import { WebSocket } from 'ws';

const ws = new WebSocket('ws://localhost:3000');
let lastSig = '';

ws.on('open', () => ws.send(JSON.stringify({ type: 'create', name: 'Tester' })));

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());

  if (m.type === 'joined') {
    console.log(`joined room ${m.code} as host=${m.isHost}`);
    // Want 4 total (3 bots), then start.
    ws.send(JSON.stringify({ type: 'config', targetPlayers: 4 }));
    setTimeout(() => ws.send(JSON.stringify({ type: 'start' })), 200);
  }

  if (m.type === 'lobby') {
    console.log(`lobby: ${m.players.length} human(s), ${m.botSeats} bot seat(s), target ${m.targetPlayers}`);
  }

  if (m.type === 'state') {
    const sig = `${m.round}-${m.phase}-${m.you.submitted}-${m.you.myVote}`;
    if (sig !== lastSig) {
      lastSig = sig;
      console.log(`R${m.round} [${m.phase}] P=${m.prosperity} coins=${m.you.coins} income=${m.you.income}`);
    }
    if (m.phase === 'contribute' && m.you.alive && !m.you.submitted) {
      ws.send(JSON.stringify({ type: 'contribute', amount: Math.floor(m.you.income * 0.6) }));
    }
    if (m.phase === 'vote' && m.you.alive && m.you.myVote == null) {
      ws.send(JSON.stringify({ type: 'vote', optionId: m.pendingVote.options[0].id }));
    }
    if (m.phase === 'ended' || m.phase === 'collapsed') {
      console.log(`\n=== ${m.phase.toUpperCase()} at round ${m.round}, Prosperity ${m.prosperity} ===`);
      if (m.winners) for (const w of m.winners) console.log(`  #${w.rank} ${w.name}: ${w.coins} coins`);
      ws.close();
      process.exit(0);
    }
  }

  if (m.type === 'error') console.error('ERROR:', m.message);
});

ws.on('error', (e) => { console.error('ws error', e.message); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT — game did not finish'); process.exit(1); }, 60000);
