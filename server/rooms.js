// ============================================================================
// Prosperity State — Room / session orchestration
// A Room owns one game: the lobby, the connected players, the authoritative
// engine state, and the timed phase machine that drives simultaneous turns and
// drives the AI bots. The server (index.js) just routes WebSocket messages here.
// ============================================================================

import crypto from 'node:crypto';
import {
  createGame, beginRound, submitContribution, allContributionsIn, resolveRound,
  shouldVote, startVote, submitVote, allVotesIn, resolveVote,
  alivePlayers, computeIncome, nextInfraCost, roundThreshold, neglectPenalty, nextFocusCategory,
  detectFreeRiders,
} from './engine.js';
import { decideContribution, decideVote } from './ai.js';
import { CONFIG, BOT_ARCHETYPES, BOT_NAMES } from './constants.js';

// Pacing (ms). Overridable via env (PS_FAST=1 collapses delays for tests).
const FAST = process.env.PS_FAST === '1';
const TIMERS = {
  CONTRIBUTE_TIMEOUT: num('PS_CONTRIBUTE_TIMEOUT', 90_000), // humans act within this, else auto-submit
  VOTE_TIMEOUT: num('PS_VOTE_TIMEOUT', 60_000),
  REVIEW_DELAY: num('PS_REVIEW_DELAY', FAST ? 150 : 6_000), // pause so players can read results
  BOT_MIN_DELAY: num('PS_BOT_MIN_DELAY', FAST ? 20 : 700),
  BOT_MAX_DELAY: num('PS_BOT_MAX_DELAY', FAST ? 80 : 2_600),
};
function num(key, def) { const v = parseInt(process.env[key], 10); return Number.isFinite(v) ? v : def; }

const genCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
};
const genId = () => crypto.randomBytes(8).toString('hex');

export class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> Room
  }
  create(hostWs, hostName) {
    let code;
    do { code = genCode(); } while (this.rooms.has(code));
    const room = new Room(code, this);
    this.rooms.set(code, room);
    const player = room.addHuman(hostWs, hostName);
    room.hostId = player.id;
    room.broadcastLobby();
    return { room, player };
  }
  get(code) { return this.rooms.get((code || '').toUpperCase()); }
  remove(code) { this.rooms.delete(code); }
}

export class Room {
  constructor(code, manager) {
    this.code = code;
    this.manager = manager;
    this.hostId = null;
    this.players = new Map();   // playerId -> player record (incl. ws, token)
    this.state = null;          // engine state once started
    this.targetPlayers = CONFIG.MIN_PLAYERS;
    this.timers = { phase: null, review: null, bots: [] };
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------
  addHuman(ws, name) {
    const id = genId();
    const player = {
      id, name: (name || 'Citizen').slice(0, 16), isBot: false,
      ws, connected: true, token: genId(), archetype: null,
    };
    this.players.set(id, player);
    if (this.players.size > this.targetPlayers) this.targetPlayers = this.players.size;
    return player;
  }

  reconnect(ws, playerId, token) {
    const p = this.players.get(playerId);
    if (!p || p.isBot || p.token !== token) return null;
    p.ws = ws;
    p.connected = true;
    return p;
  }

  humans() { return [...this.players.values()].filter((p) => !p.isBot); }

  setTarget(n) {
    this.targetPlayers = Math.max(this.humans().length, Math.min(CONFIG.MAX_PLAYERS, Math.max(CONFIG.MIN_PLAYERS, n)));
  }

  // -------------------------------------------------------------------------
  // Start: fill empty seats with bots and kick off round 1
  // -------------------------------------------------------------------------
  start() {
    if (this.state) return;
    const humans = this.humans();
    const total = Math.max(this.targetPlayers, humans.length);
    const botCount = Math.max(0, total - humans.length);

    const usedNames = new Set(humans.map((p) => p.name));
    let nameIdx = 0;
    for (let i = 0; i < botCount; i++) {
      const id = genId();
      let name;
      do { name = BOT_NAMES[nameIdx++ % BOT_NAMES.length]; } while (usedNames.has(name) && nameIdx < 100);
      usedNames.add(name);
      this.players.set(id, {
        id, name, isBot: true, ws: null, connected: false,
        token: null, archetype: BOT_ARCHETYPES[i % BOT_ARCHETYPES.length],
      });
    }

    const seats = [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, isBot: p.isBot, archetype: p.archetype,
    }));
    this.state = createGame(seats);
    // Carry archetype onto engine player records (engine already copies it).
    this.enterContributePhase();
  }

  // -------------------------------------------------------------------------
  // Phase machine
  // -------------------------------------------------------------------------
  enterContributePhase() {
    this.clearTimers();
    beginRound(this.state);
    this.broadcastState();

    // Schedule bots (and disconnected humans) to act after a natural delay.
    for (const p of alivePlayers(this.state)) {
      const rec = this.players.get(p.id);
      if (rec.isBot || !rec.connected) {
        this.timers.bots.push(setTimeout(() => {
          if (this.state.phase !== 'contribute') return;
          submitContribution(this.state, p.id, decideContribution(this.state, p));
          this.broadcastState();
          this.maybeResolveContribute();
        }, randDelay()));
      }
    }

    this.timers.phase = setTimeout(() => this.forceResolveContribute(), TIMERS.CONTRIBUTE_TIMEOUT);
    this.maybeResolveContribute();
  }

  handleContribution(playerId, amount) {
    if (!this.state || this.state.phase !== 'contribute') return;
    if (submitContribution(this.state, playerId, amount)) {
      this.broadcastState();
      this.maybeResolveContribute();
    }
  }

  maybeResolveContribute() {
    if (this.state.phase === 'contribute' && allContributionsIn(this.state)) {
      this.resolveAndAdvance();
    }
  }

  forceResolveContribute() {
    if (this.state.phase !== 'contribute') return;
    // Idle connected humans default to contributing 0.
    for (const p of alivePlayers(this.state)) {
      if (!p.submitted) submitContribution(this.state, p.id, 0);
    }
    this.resolveAndAdvance();
  }

  resolveAndAdvance() {
    this.clearTimers();
    resolveRound(this.state);
    this.broadcastState();

    if (this.state.phase === 'ended' || this.state.phase === 'collapsed') {
      this.scheduleCleanup();
      return;
    }
    // Pause on the results, then go to a vote or the next round.
    this.timers.review = setTimeout(() => {
      if (shouldVote(this.state)) this.enterVotePhase();
      else this.enterContributePhase();
    }, TIMERS.REVIEW_DELAY);
  }

  enterVotePhase() {
    this.clearTimers();
    startVote(this.state);
    this.broadcastState();

    for (const p of alivePlayers(this.state)) {
      const rec = this.players.get(p.id);
      if (rec.isBot || !rec.connected) {
        this.timers.bots.push(setTimeout(() => {
          if (this.state.phase !== 'vote') return;
          submitVote(this.state, p.id, decideVote(this.state, p));
          this.broadcastState();
          this.maybeResolveVote();
        }, randDelay()));
      }
    }
    this.timers.phase = setTimeout(() => this.forceResolveVote(), TIMERS.VOTE_TIMEOUT);
  }

  handleVote(playerId, optionId) {
    if (!this.state || this.state.phase !== 'vote') return;
    if (submitVote(this.state, playerId, optionId)) {
      this.broadcastState();
      this.maybeResolveVote();
    }
  }

  maybeResolveVote() {
    if (this.state.phase === 'vote' && allVotesIn(this.state)) {
      this.finishVote();
    }
  }

  forceResolveVote() {
    if (this.state.phase !== 'vote') return;
    // Idle players keep the status quo (default option = current/first).
    const vote = this.state.pendingVote;
    const fallback = defaultVoteOption(this.state, vote);
    for (const p of alivePlayers(this.state)) {
      if (vote.votes[p.id] == null) submitVote(this.state, p.id, fallback);
    }
    this.finishVote();
  }

  finishVote() {
    this.clearTimers();
    resolveVote(this.state);
    this.broadcastState();
    this.timers.review = setTimeout(() => this.enterContributePhase(), TIMERS.REVIEW_DELAY);
  }

  // -------------------------------------------------------------------------
  // Disconnect handling — a dropped human keeps their seat; AI covers them.
  // -------------------------------------------------------------------------
  handleDisconnect(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connected = false;
    p.ws = null;

    if (!this.state) {
      // Lobby: remove the seat entirely.
      this.players.delete(playerId);
      if (this.players.size === 0) { this.scheduleCleanup(0); return; }
      if (this.hostId === playerId) this.hostId = this.humans()[0]?.id ?? null;
      this.broadcastLobby();
      return;
    }
    // In-game: if it's their turn and we're waiting, let AI act for them.
    this.broadcastState();
    if (this.state.phase === 'contribute') this.maybeResolveContribute();
    if (this.state.phase === 'vote') this.maybeResolveVote();
  }

  // -------------------------------------------------------------------------
  // Serialization & broadcast
  // -------------------------------------------------------------------------
  broadcastLobby() {
    const payload = {
      type: 'lobby',
      code: this.code,
      hostId: this.hostId,
      targetPlayers: this.targetPlayers,
      maxPlayers: CONFIG.MAX_PLAYERS,
      minPlayers: CONFIG.MIN_PLAYERS,
      players: this.humans().map((p) => ({ id: p.id, name: p.name, connected: p.connected })),
      botSeats: Math.max(0, this.targetPlayers - this.humans().length),
    };
    for (const p of this.humans()) this.send(p, payload);
  }

  serializeState(forId) {
    const s = this.state;
    const reveal = s.phase !== 'contribute'; // hide contribution amounts until resolved
    const freeRiders = detectFreeRiders(s);
    const freeRiderIds = new Set(freeRiders.map((f) => f.id));
    const players = [...this.players.values()]
      .map((rec) => {
        const ep = s.players[rec.id];
        return {
          id: ep.id, name: ep.name, isBot: ep.isBot, archetype: ep.archetype,
          connected: rec.connected, isHost: rec.id === this.hostId,
          coins: ep.coins, influence: ep.influence,
          alive: ep.alive, bankrupt: ep.bankrupt,
          submitted: ep.submitted,
          voted: s.pendingVote ? s.pendingVote.votes[ep.id] != null : false,
          contribution: reveal ? ep.contributedThisRound : null,
          lastContribution: ep.lastContribution, // persists across rounds for display
          freeRider: ep.alive && freeRiderIds.has(ep.id),
        };
      });

    const me = s.players[forId];
    return {
      type: 'state',
      code: this.code,
      phase: s.phase,
      round: s.round,
      prosperity: s.prosperity,
      goal: CONFIG.PROSPERITY_GOAL,
      income: me && me.alive ? me.income : computeIncome(s),
      infrastructure: s.infrastructure,
      infraFocus: s.infraFocus,
      infraNextFocus: nextFocusCategory(s),
      infraProgress: s.infraProgress, // per-category object
      infraCosts: Object.fromEntries(CONFIG.INFRA_CATEGORIES.map((c) => [c, nextInfraCost(s, c)])),
      infraMaxLevel: CONFIG.INFRA_MAX_LEVEL,
      roundThreshold: roundThreshold(s),
      neglectPenalty: neglectPenalty(s),
      freeRiders, // [{id,name}] currently dragging the nation down
      taxPolicy: s.taxPolicy,
      welfarePolicy: s.welfarePolicy,
      players,
      pendingVote: s.pendingVote
        ? { type: s.pendingVote.type, prompt: s.pendingVote.prompt, options: s.pendingVote.options }
        : null,
      lastRoundResult: s.lastRoundResult,
      lastVoteResult: s.lastVoteResult,
      log: s.log.slice(-30),
      winners: s.winners,
      you: {
        id: forId,
        isHost: forId === this.hostId,
        income: me ? me.income : 0,
        coins: me ? me.coins : 0,
        alive: me ? me.alive : false,
        myContribution: me ? me.contributedThisRound : null,
        submitted: me ? me.submitted : false,
        myVote: s.pendingVote ? s.pendingVote.votes[forId] ?? null : null,
        archetype: me ? me.archetype : null,
      },
    };
  }

  broadcastState() {
    if (!this.state) return;
    for (const p of this.humans()) {
      if (p.connected) this.send(p, this.serializeState(p.id));
    }
  }

  send(player, obj) {
    if (player.ws && player.ws.readyState === 1) {
      try { player.ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  clearTimers() {
    if (this.timers.phase) clearTimeout(this.timers.phase);
    if (this.timers.review) clearTimeout(this.timers.review);
    for (const t of this.timers.bots) clearTimeout(t);
    this.timers = { phase: null, review: null, bots: [] };
  }

  scheduleCleanup(delay = 10 * 60_000) {
    this.clearTimers();
    setTimeout(() => {
      // Only drop the room if everyone has gone.
      if ([...this.players.values()].every((p) => p.isBot || !p.connected)) {
        this.manager.remove(this.code);
      }
    }, delay);
  }
}

function randDelay() {
  return TIMERS.BOT_MIN_DELAY + Math.floor(Math.random() * (TIMERS.BOT_MAX_DELAY - TIMERS.BOT_MIN_DELAY));
}

function defaultVoteOption(state, vote) {
  if (!vote) return null;
  if (vote.type === 'infraFocus') return state.infraFocus;
  if (vote.type === 'taxPolicy') return state.taxPolicy;
  if (vote.type === 'welfarePolicy') return state.welfarePolicy;
  return vote.options[0].id;
}
