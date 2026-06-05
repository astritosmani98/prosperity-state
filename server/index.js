// ============================================================================
// Prosperity State — server entry point
// Serves the static client and runs the WebSocket game protocol.
// ============================================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';
import { initDb, recentGames, gameDetail, stats } from './db.js';
import { CONFIG } from './constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

// Load a local .env for development (no-op if the file or feature is absent).
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* none */ }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---- Read-only JSON API for game records ------------------------------------
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function handleApi(req, res, urlPath, query) {
  try {
    if (urlPath === '/api/live') return sendJson(res, 200, manager.liveSummary());
    if (urlPath === '/api/stats') return sendJson(res, 200, await stats());
    if (urlPath === '/api/games') {
      const limit = parseInt(query.get('limit'), 10) || 20;
      return sendJson(res, 200, await recentGames(limit));
    }
    const m = urlPath.match(/^\/api\/games\/(\d+)$/);
    if (m) {
      const game = await gameDetail(parseInt(m[1], 10));
      return game ? sendJson(res, 200, game) : sendJson(res, 404, { error: 'not found' });
    }
    sendJson(res, 404, { error: 'unknown endpoint' });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

// ---- Static file server -----------------------------------------------------
const server = http.createServer((req, res) => {
  const parsed = new URL(req.url || '/', 'http://localhost');
  let urlPath = decodeURIComponent(parsed.pathname);

  if (urlPath.startsWith('/api/')) { handleApi(req, res, urlPath, parsed.searchParams); return; }
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { // path-traversal guard
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---- WebSocket game protocol ------------------------------------------------
const manager = new RoomManager();
const wss = new WebSocketServer({ server });

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function err(ws, message) { send(ws, { type: 'error', message }); }

wss.on('connection', (ws) => {
  ws.playerId = null;
  ws.roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try {
      handle(ws, msg);
    } catch (e) {
      console.error('handler error:', e);
      err(ws, 'Server error.');
    }
  });

  ws.on('close', () => {
    const room = manager.get(ws.roomCode);
    if (room && ws.playerId) room.handleDisconnect(ws.playerId);
  });
});

function handle(ws, msg) {
  switch (msg.type) {
    case 'create': {
      const { room, player } = manager.create(ws, msg.name);
      ws.playerId = player.id;
      ws.roomCode = room.code;
      send(ws, { type: 'joined', code: room.code, playerId: player.id, token: player.token, isHost: true });
      room.broadcastLobby();
      break;
    }

    case 'join': {
      const room = manager.get(msg.code);
      if (!room) return err(ws, 'No room with that code.');
      if (room.state) return err(ws, 'That game has already started.');
      if (room.humans().length >= CONFIG.MAX_PLAYERS) return err(ws, 'Room is full.');
      const player = room.addHuman(ws, msg.name);
      ws.playerId = player.id;
      ws.roomCode = room.code;
      send(ws, { type: 'joined', code: room.code, playerId: player.id, token: player.token, isHost: false });
      room.broadcastLobby();
      break;
    }

    case 'reconnect': {
      const room = manager.get(msg.code);
      if (!room) return err(ws, 'Game no longer exists.');
      const player = room.reconnect(ws, msg.playerId, msg.token);
      if (!player) return err(ws, 'Could not rejoin (seat lost).');
      ws.playerId = player.id;
      ws.roomCode = room.code;
      send(ws, { type: 'joined', code: room.code, playerId: player.id, token: player.token, isHost: room.hostId === player.id });
      if (room.state) room.broadcastState();
      else room.broadcastLobby();
      break;
    }

    case 'config': {
      const room = manager.get(ws.roomCode);
      if (!room || room.hostId !== ws.playerId || room.state) return;
      room.setTarget(parseInt(msg.targetPlayers, 10) || CONFIG.MIN_PLAYERS);
      room.broadcastLobby();
      break;
    }

    case 'start': {
      const room = manager.get(ws.roomCode);
      if (!room || room.hostId !== ws.playerId || room.state) return;
      const total = Math.max(room.targetPlayers, room.humans().length);
      if (total < CONFIG.MIN_PLAYERS) return err(ws, `Need at least ${CONFIG.MIN_PLAYERS} players.`);
      room.start();
      break;
    }

    case 'contribute': {
      const room = manager.get(ws.roomCode);
      if (room) room.handleContribution(ws.playerId, msg.amount);
      break;
    }

    case 'vote': {
      const room = manager.get(ws.roomCode);
      if (room) room.handleVote(ws.playerId, msg.optionId);
      break;
    }

    case 'ping':
      send(ws, { type: 'pong' });
      break;

    default:
      // ignore unknown
      break;
  }
}

server.listen(PORT, async () => {
  console.log(`\n  Prosperity State running → http://localhost:${PORT}`);
  await initDb();
  console.log('');
});
