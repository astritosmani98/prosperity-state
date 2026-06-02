// ============================================================================
// Prosperity State — browser client
// Talks to the server over a single WebSocket. The server is authoritative;
// the client only renders state and sends the player's actions.
// ============================================================================

const $ = (id) => document.getElementById(id);
const SCREENS = ['home', 'lobby', 'game', 'over'];
function showScreen(name) {
  for (const s of SCREENS) $(`screen-${s}`).classList.toggle('active', s === name);
}

const SESSION_KEY = 'prosperity-session';
let ws = null;
let me = { id: null, isHost: false };
let lastState = null;
let pendingContribution = 0;

// ----------------------------------------------------------------------------
// WebSocket
// ----------------------------------------------------------------------------
function connect(onOpen) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => onOpen && onOpen();
  ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data));
  ws.onclose = () => {
    // Try to resume after a short delay if we were in a game.
    setTimeout(tryReconnect, 1500);
  };
}

function sendMsg(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function saveSession(code, playerId, token) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ code, playerId, token }));
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function clearSession() { localStorage.removeItem(SESSION_KEY); }

function tryReconnect() {
  const s = loadSession();
  if (!s) return;
  connect(() => sendMsg({ type: 'reconnect', code: s.code, playerId: s.playerId, token: s.token }));
}

// ----------------------------------------------------------------------------
// Inbound messages
// ----------------------------------------------------------------------------
function handleMessage(msg) {
  switch (msg.type) {
    case 'joined':
      me.id = msg.playerId;
      me.isHost = msg.isHost;
      saveSession(msg.code, msg.playerId, msg.token);
      break;
    case 'lobby':
      renderLobby(msg);
      showScreen('lobby');
      break;
    case 'state':
      lastState = msg;
      me.id = msg.you.id;
      me.isHost = msg.you.isHost;
      if (msg.phase === 'ended' || msg.phase === 'collapsed') {
        renderGame(msg);    // final state behind the overlay
        renderGameOver(msg);
        showScreen('over');
      } else {
        renderGame(msg);
        showScreen('game');
      }
      break;
    case 'error':
      $('home-error').textContent = msg.message;
      // If a stale session is rejected, drop it so the menu works.
      if (/rejoin|exist|started/i.test(msg.message)) clearSession();
      break;
  }
}

// ----------------------------------------------------------------------------
// Home actions
// ----------------------------------------------------------------------------
$('btn-create').onclick = () => {
  const name = $('create-name').value.trim() || 'Citizen';
  $('home-error').textContent = '';
  connect(() => sendMsg({ type: 'create', name }));
};
$('btn-join').onclick = () => {
  const name = $('join-name').value.trim() || 'Citizen';
  const code = $('join-code').value.trim().toUpperCase();
  if (code.length !== 4) { $('home-error').textContent = 'Enter a 4-letter room code.'; return; }
  $('home-error').textContent = '';
  connect(() => sendMsg({ type: 'join', code, name }));
};
$('join-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });

// ----------------------------------------------------------------------------
// Lobby
// ----------------------------------------------------------------------------
function renderLobby(msg) {
  $('lobby-code').textContent = msg.code;
  const ul = $('lobby-players');
  ul.innerHTML = '';
  for (const p of msg.players) {
    const li = document.createElement('li');
    li.textContent = p.name + (p.id === me.id ? ' (you)' : '');
    if (p.id === msg.hostId) li.classList.add('host');
    ul.appendChild(li);
  }

  const isHost = msg.hostId === me.id;
  $('host-controls').classList.toggle('hidden', !isHost);
  $('lobby-waiting').classList.toggle('hidden', isHost);

  if (isHost) {
    const range = $('target-range');
    range.min = Math.max(msg.minPlayers, msg.players.length);
    range.max = msg.maxPlayers;
    range.value = msg.targetPlayers;
    $('target-label').textContent = msg.targetPlayers;
    $('bot-note').textContent = msg.botSeats > 0
      ? `${msg.botSeats} empty seat${msg.botSeats > 1 ? 's' : ''} will be filled by AI citizens.`
      : 'All seats are human.';
  }
}

$('btn-copy').onclick = () => {
  navigator.clipboard?.writeText($('lobby-code').textContent);
  $('btn-copy').textContent = 'Copied!';
  setTimeout(() => ($('btn-copy').textContent = 'Copy'), 1200);
};
$('target-range').oninput = (e) => {
  $('target-label').textContent = e.target.value;
  sendMsg({ type: 'config', targetPlayers: parseInt(e.target.value, 10) });
};
$('btn-start').onclick = () => sendMsg({ type: 'start' });

// ----------------------------------------------------------------------------
// Game rendering
// ----------------------------------------------------------------------------
function renderGame(s) {
  // Top bar
  const pct = Math.max(0, Math.min(100, (s.prosperity / s.goal) * 100));
  $('prosperity-fill').style.width = pct + '%';
  $('prosperity-num').textContent = `${s.prosperity} / ${s.goal}`;
  $('round-num').textContent = s.round;
  const badge = $('phase-badge');
  const phaseText = { contribute: 'Contribute', vote: 'Voting', resolved: 'Resolving' }[s.phase] || s.phase;
  badge.textContent = phaseText;
  badge.className = 'phase-badge ' + s.phase;

  // You
  $('you-coins').textContent = s.you.coins;
  $('you-income').textContent = s.you.income;
  const meRow = s.players.find((p) => p.id === me.id);
  $('you-influence').textContent = meRow ? meRow.influence : 1;

  renderCity(s);
  renderFreeRiderBanner(s);
  renderPlayers(s);
  renderInfra(s);
  renderPolicies(s);
  renderLastRound(s);
  renderLog(s);
  renderAction(s);
}

// ----------------------------------------------------------------------------
// Cityscape — the society map that visibly grows with Prosperity & infrastructure
// ----------------------------------------------------------------------------
let cityPrev = null;  // last-seen infrastructure levels, to detect upgrades
let rainBuilt = false;

const clampNum = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const lerp = (a, b, t) => a + (b - a) * t;
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function lerpColor(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  const c = A.map((v, i) => Math.round(lerp(v, B[i], t)).toString(16).padStart(2, '0'));
  return '#' + c.join('');
}
function setStop(id, color) { const el = $(id); if (el) el.setAttribute('stop-color', color); }

function renderCity(s) {
  const svg = $('city-svg');
  if (!svg) return;
  buildStars();
  const infra = s.infrastructure || {};
  const p = clampNum(s.prosperity, 0, 100);
  const declining =
    (s.freeRiders && s.freeRiders.length > 0) ||
    (s.lastRoundResult && s.lastRoundResult.deltaP < 0);

  // Day/night: bright by day at high Prosperity; a decline forces a dark storm.
  const t = declining ? Math.min(p / 100, 0.18) : p / 100;
  const night = 1 - t;

  // Sky (soft 3-stop Ghibli gradient) + celestial bodies.
  setStop('skyTop', lerpColor('#0d1430', '#79b7e6', t));
  setStop('skyMid', lerpColor('#1f2740', '#bfe0ef', t));
  setStop('skyBot', lerpColor('#2a2336', '#eef3e0', t));
  const sunY = String(lerp(112, 60, t));
  $('sun').setAttribute('cy', sunY);
  $('sunGlowC').setAttribute('cy', sunY);
  $('sun').setAttribute('fill', lerpColor('#e0915a', '#fff3c4', t));
  $('sunwrap').style.opacity = clampNum(t * 1.5 - 0.15, 0, 1).toFixed(2);
  $('moon').style.opacity = clampNum(night * 1.3 - 0.15, 0, 1).toFixed(2);
  $('stars').style.opacity = clampNum(night * 1.4 - 0.3, 0, 1).toFixed(2);
  $('clouds').style.opacity = clampNum(t * 1.3 - 0.15, 0, 1).toFixed(2);
  $('birds').style.opacity = (!declining && p >= 12 ? clampNum(0.45 + t, 0, 1) : 0).toFixed(2);
  svg.classList.toggle('night', night > 0.55);

  // Infrastructure objects: appear at level ≥ 1, reveal level-gated pieces,
  // show a level badge, and flash + sparkle on each upgrade.
  for (const cat of ['education', 'healthcare', 'energy', 'industry']) {
    const el = $('b-' + cat);
    if (!el) continue;
    const lvl = infra[cat] || 0;
    el.classList.toggle('shown', lvl >= 1);
    el.querySelectorAll('.lvl-item').forEach((it) => {
      it.classList.toggle('on', lvl >= parseInt(it.dataset.min, 10));
    });
    if (cityPrev && (cityPrev[cat] || 0) < lvl && lvl >= 1) flashBuilding(el, cat);
  }

  // Village houses, trees and people grow in as Prosperity rises.
  svg.querySelectorAll('.grow').forEach((el) => {
    const thr = parseFloat(el.dataset.threshold);
    el.style.transform = p >= thr ? 'scaleY(1)' : 'scaleY(0)';
  });

  // Energy lights the windows (and streetlights at night).
  const energy = infra.energy || 0;
  svg.classList.toggle('powered', energy > 0);
  svg.style.setProperty('--energy', (energy / 5).toFixed(2));

  // Industry smokes; Healthcare cleans the air a little.
  const industry = infra.industry || 0;
  $('smoke').style.opacity = (industry > 0
    ? clampNum(industry / 5, 0, 1) * (1 - 0.12 * (infra.healthcare || 0))
    : 0).toFixed(2);

  // Roads put cars on the street.
  const roads = infra.roads || 0;
  const cars = svg.querySelectorAll('#cars .car');
  cars.forEach((c, i) => { c.style.display = i < Math.min(cars.length, 1 + roads) ? '' : 'none'; });

  // Decline brings a storm; deep night dims the meadow a touch.
  const dim = declining ? 0.42 : (night > 0.6 ? (night - 0.6) * 0.7 : 0);
  svg.classList.toggle('storm', !!declining);
  $('storm-overlay').setAttribute('opacity', dim.toFixed(2));
  if (declining) buildRain(svg);

  // Status chip.
  let label;
  if (s.phase === 'ended') label = 'Prosperous! 🎉';
  else if (declining) label = 'In decline ⛈';
  else if (p < 25) label = 'Struggling';
  else if (p < 55) label = 'Developing';
  else if (p < 85) label = 'Thriving';
  else label = 'Flourishing ✨';
  $('city-status').textContent = label;

  cityPrev = { ...infra };
}

let starsBuilt = false;
function buildStars() {
  if (starsBuilt) return;
  const g = $('stars');
  if (!g) return;
  for (let i = 0; i < 24; i++) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', (Math.random() * 800).toFixed(1));
    c.setAttribute('cy', (Math.random() * 150).toFixed(1));
    c.setAttribute('r', (Math.random() * 1.3 + 0.6).toFixed(1));
    c.setAttribute('fill', '#fff');
    c.style.animationDelay = (-Math.random() * 3).toFixed(2) + 's';
    g.appendChild(c);
  }
  starsBuilt = true;
}

function flashBuilding(el, cat) {
  el.classList.remove('flash');
  requestAnimationFrame(() => el.classList.add('flash'));
  setTimeout(() => el.classList.remove('flash'), 850);
  const spark = $('spark-' + cat);
  if (spark) {
    spark.classList.remove('go');
    requestAnimationFrame(() => spark.classList.add('go'));
    setTimeout(() => spark.classList.remove('go'), 1000);
  }
}

function buildRain(svg) {
  if (rainBuilt) return;
  const rain = $('rain');
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * 800;
    const y = -10 - Math.random() * 60;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x.toFixed(1)); line.setAttribute('y1', y.toFixed(1));
    line.setAttribute('x2', (x - 6).toFixed(1)); line.setAttribute('y2', (y + 14).toFixed(1));
    line.setAttribute('class', 'raindrop');
    line.style.animationDelay = (-Math.random() * 0.6).toFixed(2) + 's';
    rain.appendChild(line);
  }
  rainBuilt = true;
}

function renderFreeRiderBanner(s) {
  const banner = $('freerider-banner');
  const fr = s.freeRiders || [];
  if (!fr.length) { banner.classList.add('hidden'); return; }
  banner.classList.remove('hidden');
  const meIsFr = fr.some((f) => f.id === me.id);
  if (meIsFr) {
    banner.innerHTML = `⚠ <b>You're being treated as a free-rider.</b> The other citizens have stopped
      pulling your weight, so Prosperity is <b>falling</b>. Start contributing your fair share to restore cooperation.`;
  } else {
    const names = fr.map((f) => escapeHtml(f.name)).join(', ');
    banner.innerHTML = `⚠ <b>${names}</b> ${fr.length > 1 ? 'are' : 'is'} free-riding. Citizens are withholding
      in protest — Prosperity will keep <b>falling</b> until they contribute.`;
  }
}

function renderPlayers(s) {
  const body = $('players-body');
  body.innerHTML = '';
  const sorted = [...s.players].sort((a, b) => b.coins - a.coins);

  // Highest last contribution → mark with a star so the top giver is obvious.
  const topGave = Math.max(0, ...s.players.map((p) => p.lastContribution || 0));

  for (const p of sorted) {
    const tr = document.createElement('tr');
    if (p.id === me.id) tr.classList.add('me');
    if (!p.alive) tr.classList.add('dead');

    let tags = '';
    if (p.isBot) tags += '<span class="tag bot">AI</span>';
    if (p.isHost) tags += '<span class="tag host">host</span>';
    if (p.freeRider) tags += '<span class="tag freerider">free-rider</span>';

    // "Gave" persists across rounds. During the contribute phase, also show whether
    // THIS round's contribution is locked in (amount stays hidden until resolve).
    let gave;
    if (p.lastContribution == null) gave = '<span class="muted">—</span>';
    else {
      const star = p.lastContribution === topGave && topGave > 0 ? ' <span title="Top contributor">⭐</span>' : '';
      gave = `<b class="coins-cell">${p.lastContribution}</b>${star}`;
    }

    // Status depends on phase.
    let status = '';
    if (!p.alive) status = '<span class="tag waiting">bankrupt</span>';
    else if (s.phase === 'contribute') status = p.submitted
      ? '<span class="tag locked">ready</span>' : '<span class="tag waiting">deciding…</span>';
    else if (s.phase === 'vote') status = p.voted
      ? '<span class="tag locked">voted</span>' : '<span class="tag waiting">deciding…</span>';

    tr.innerHTML = `
      <td>${escapeHtml(p.name)}${p.id === me.id ? ' (you)' : ''}${tags}</td>
      <td class="coins-cell">${p.coins}</td>
      <td>${p.influence}</td>
      <td>${gave}</td>
      <td>${status}</td>`;
    body.appendChild(tr);
  }
}

const INFRA_ORDER = ['roads', 'education', 'energy', 'healthcare', 'industry'];
function renderInfra(s) {
  // Meta line: current focus, what's next, and this round's minimum-to-build.
  $('infra-meta').innerHTML =
    `Building now: <b>${cap(s.infraFocus)}</b> · next: ${cap(s.infraNextFocus)}<br>` +
    `Min to build this round: <b class="lr-gold">${s.roundThreshold}</b> Coins ` +
    `<span class="muted">(below it → no build, −${s.neglectPenalty} Prosperity)</span>`;

  const wrap = $('infra-list');
  wrap.innerHTML = '';
  for (const cat of INFRA_ORDER) {
    const level = s.infrastructure[cat];
    const row = document.createElement('div');
    row.className = 'infra-row' + (cat === s.infraFocus ? ' focus' : '');
    let pips = '';
    for (let i = 0; i < s.infraMaxLevel; i++) pips += `<span class="pip ${i < level ? 'on' : ''}"></span>`;
    // Every category shows its own accumulated progress now (they build independently).
    const progress = level >= s.infraMaxLevel
      ? '<span class="infra-progress">MAX</span>'
      : `<span class="infra-progress">${s.infraProgress[cat]}/${s.infraCosts[cat]}</span>`;
    row.innerHTML = `<span class="iname">${cat}</span><span class="pips">${pips}</span>${progress}`;
    wrap.appendChild(row);
  }
}

function renderPolicies(s) {
  $('policy-tax').textContent = 'Tax: ' + s.taxPolicy;
  $('policy-welfare').textContent = s.welfarePolicy === 'welfare' ? 'Welfare' : 'Expansion';
}

function renderLastRound(s) {
  const el = $('last-round');
  const r = s.lastRoundResult;
  if (!r) { el.innerHTML = '<span class="muted">The first round hasn\'t resolved yet.</span>'; return; }
  const lines = [];
  if (r.belowThreshold) {
    lines.push(`<div class="lr-line lr-bad">⛔ Pooled only <b>${r.pool}</b> / ${r.threshold} needed — nothing built, <b>−${r.neglect}</b> Prosperity (neglect).</div>`);
  } else {
    lines.push(`<div class="lr-line">Citizens pooled <b class="lr-gold">${r.pool}</b> Coins <span class="muted">(min ${r.threshold})</span> → <b class="lr-good">+${r.deltaP}</b> Prosperity <span class="muted">(K=${r.K})</span></div>`);
    lines.push(`<div class="lr-line muted">Built toward: ${cap(r.focus)}</div>`);
  }
  if (r.taxLevy > 0) lines.push(`<div class="lr-line">Progressive levy: ${r.taxPayer} paid <b>${r.taxLevy}</b></div>`);
  if (r.welfareAmount > 0) lines.push(`<div class="lr-line">Welfare: <b>${r.welfareAmount}</b> Coins to ${r.welfareRecipient}</div>`);
  if (r.topContributors.length) {
    const names = r.topContributors.map((t) => `${t.name} (+${t.refund})`).join(', ');
    lines.push(`<div class="lr-line lr-gold">⭐ Top contributor: ${names}</div>`);
  }
  if (r.event) lines.push(`<div class="lr-line lr-bad">⚠ ${r.event.name}: −${r.event.damage} Prosperity${r.event.mitigated ? ` <span class="muted">(healthcare absorbed ${r.event.mitigated})</span>` : ''}</div>`);
  for (const u of r.upgrades) lines.push(`<div class="lr-line lr-good">🏗 ${u.category} upgraded to level ${u.level}</div>`);
  for (const n of r.bankrupted) lines.push(`<div class="lr-line lr-bad">💀 ${n} went bankrupt</div>`);
  el.innerHTML = lines.join('');
}

function renderLog(s) {
  const log = $('log');
  log.innerHTML = '';
  for (const entry of s.log) {
    const d = document.createElement('div');
    d.textContent = `R${entry.round}: ${entry.text}`;
    log.appendChild(d);
  }
}

// ----------------------------------------------------------------------------
// Action panel (phase-dependent)
// ----------------------------------------------------------------------------
function renderAction(s) {
  const card = $('action-card');

  if (!s.you.alive) {
    card.innerHTML = `<h3>Spectating</h3><p class="eliminated-note">You went bankrupt. You watch as a citizen, but you're out of the ranking.</p>`;
    return;
  }

  if (s.phase === 'contribute') {
    if (s.you.submitted) {
      card.innerHTML = `<h3>Contribution locked</h3>` + waitingHtml(s, 'submitted');
      return;
    }
    renderContributeUI(s, card);
    return;
  }

  if (s.phase === 'vote') {
    if (s.you.myVote != null) {
      const chosen = s.pendingVote.options.find((o) => o.id === s.you.myVote);
      card.innerHTML = `<h3>Vote cast</h3><p class="muted">You chose: <b>${escapeHtml(chosen?.label || s.you.myVote)}</b></p>` + waitingHtml(s, 'voted');
      return;
    }
    renderVoteUI(s, card);
    return;
  }

  // resolved / transitional
  card.innerHTML = `<h3>Round resolved</h3><div class="waiting"><div class="dots">• • •</div><p class="muted">Preparing the next phase…</p></div>`;
}

function renderContributeUI(s, card) {
  const income = s.you.income;
  // Equal share = each citizen's slice of the round minimum. If everyone gives
  // this, the nation exactly meets the requirement. Capped at your income.
  const aliveCount = Math.max(1, s.players.filter((p) => p.alive).length);
  const fairShare = Math.min(income, Math.ceil(s.roundThreshold / aliveCount));

  pendingContribution = Math.min(pendingContribution, income);
  card.innerHTML = `
    <h3>Your move — Round ${s.round}</h3>
    <p class="muted">You earned <b style="color:var(--gold)">${income}</b> income. How much do you give to the nation?</p>
    <div class="threshold-note">🏗 Citizens must pool <b>${s.roundThreshold}</b> Coins together this round to build
      <b>${cap(s.infraFocus)}</b> — fall short and Prosperity drops <b>${s.neglectPenalty}</b> with no construction.</div>
    <button id="btn-fairshare" class="btn fairshare" data-amount="${fairShare}">⚖ Donate equal share (${fairShare}) to meet the minimum</button>
    <div class="contribute-ui">
      <div class="split"><span>Keep <b id="keep-amt">${income - pendingContribution}</b></span><span>Contribute <b id="give-amt">${pendingContribution}</b></span></div>
      <input id="contrib-range" type="range" min="0" max="${income}" value="${pendingContribution}" />
      <div class="quick-btns">
        <button class="btn" data-frac="0">Keep all</button>
        <button class="btn" data-frac="0.5">Half</button>
        <button class="btn" data-frac="1">Give all</button>
      </div>
      <button id="btn-contribute" class="btn primary">Lock in contribution</button>
    </div>`;

  const range = $('contrib-range');
  const update = (v) => {
    pendingContribution = Math.max(0, Math.min(income, parseInt(v, 10) || 0));
    range.value = pendingContribution;
    $('keep-amt').textContent = income - pendingContribution;
    $('give-amt').textContent = pendingContribution;
  };
  range.oninput = (e) => update(e.target.value);
  card.querySelectorAll('[data-frac]').forEach((b) => {
    b.onclick = () => update(Math.round(income * parseFloat(b.dataset.frac)));
  });
  card.querySelectorAll('[data-amount]').forEach((b) => {
    b.onclick = () => update(parseInt(b.dataset.amount, 10));
  });
  $('btn-contribute').onclick = () => sendMsg({ type: 'contribute', amount: pendingContribution });
}

function renderVoteUI(s, card) {
  const v = s.pendingVote;
  let html = `<h3>National vote</h3><p>${escapeHtml(v.prompt)}</p><p class="muted">Your vote is weighted by your Influence.</p>`;
  for (const o of v.options) html += `<button class="btn vote-option" data-opt="${o.id}">${escapeHtml(o.label)}</button>`;
  card.innerHTML = html;
  card.querySelectorAll('[data-opt]').forEach((b) => {
    b.onclick = () => sendMsg({ type: 'vote', optionId: b.dataset.opt });
  });
}

function waitingHtml(s, mode) {
  const waitingFor = s.players.filter((p) => p.alive && (mode === 'submitted' ? !p.submitted : !p.voted));
  const names = waitingFor.map((p) => escapeHtml(p.name)).join(', ');
  return `<div class="waiting"><div class="dots">• • •</div><p class="muted">${
    waitingFor.length ? `Waiting for: ${names}` : 'Resolving…'
  }</p></div>`;
}

// ----------------------------------------------------------------------------
// Game over
// ----------------------------------------------------------------------------
function renderGameOver(s) {
  clearSession();
  const ranking = $('ranking');
  ranking.innerHTML = '';
  if (s.phase === 'collapsed') {
    $('over-title').textContent = '💥 Society Collapsed';
    $('over-sub').textContent = `Prosperity fell to ${s.prosperity}. There are no winners.`;
  } else {
    $('over-title').textContent = '🎉 Prosperity Achieved!';
    $('over-sub').textContent = 'The nation reached 100 Prosperity. Final wealth ranking:';
    for (const w of (s.winners || [])) {
      const li = document.createElement('li');
      li.innerHTML = `<span><span class="rk">#${w.rank}</span>${escapeHtml(w.name)}${w.isBot ? ' <span class="tag bot">AI</span>' : ''}${w.id === me.id ? ' (you)' : ''}</span><span class="rc">${w.coins} Coins</span>`;
      ranking.appendChild(li);
    }
  }
}
$('btn-again').onclick = () => { clearSession(); location.reload(); };

// ----------------------------------------------------------------------------
// Utils
// ----------------------------------------------------------------------------
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function cap(s) { return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1); }

// On load, attempt to resume an in-progress game.
tryReconnect();
