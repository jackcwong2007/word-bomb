'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.resolve(__dirname, 'public');
const MAX_PLAYERS = 5;
const ROOM_CODE = (process.env.ROOM_CODE || crypto.randomBytes(3).toString('hex')).toUpperCase();
const displays = new Set();
const BRAINROT = new Set();
const MAX_LIVES = 2;
const COLORS = [
  '#ff5a6a', '#ffb703', '#52b788', '#4cc9f0', '#c77dff', '#f4a261',
  '#80ffdb', '#ff8fab', '#90be6d', '#f72585', '#48bfe3', '#fee440',
];

const WORDS = new Set();
const BY_SUB = new Map();
const CANDIDATES = { 2: [], 3: [] };

function loadWords() {
  const slang = fs.readFileSync(path.join(__dirname, 'data', 'stupid.txt'), 'utf8');
  for (const line of slang.split(/\r?\n/)) {
    const word = line.trim().toLowerCase();
    if (/^[a-z]{3,15}$/.test(word)) BRAINROT.add(word);
  }
  const raw = fs.readFileSync(path.join(__dirname, 'data', 'words.txt'), 'utf8') + '\n' + slang;
  for (const line of raw.split(/\r?\n/)) {
    const word = line.trim().toLowerCase();
    if (!/^[a-z]{3,15}$/.test(word) || !/[aeiouy]/.test(word) || WORDS.has(word)) continue;
    WORDS.add(word);
    const seen = new Set();
    for (let len = 2; len <= 3; len++) {
      for (let i = 0; i + len <= word.length; i++) {
        const sub = word.slice(i, i + len);
        if (seen.has(sub)) continue;
        seen.add(sub);
        let list = BY_SUB.get(sub);
        if (!list) {
          list = [];
          BY_SUB.set(sub, list);
        }
        list.push(word);
      }
    }
  }
  for (const [sub, list] of BY_SUB) {
    if (list.length >= 3 && CANDIDATES[sub.length]) CANDIDATES[sub.length].push(sub);
  }
  console.log(
    `Dictionary: ${WORDS.size} words · slices ${CANDIDATES[2].length} / ${CANDIDATES[3].length}`
  );
  if (WORDS.size < 200) throw new Error('Dictionary is too small to start a round.');
}

loadWords();

const game = {
  phase: 'lobby',
  countdown: 0,
  players: [],
  currentId: null,
  prompt: '',
  stage: 'black',
  fuse: 11,
  deadline: 0,
  used: new Set(),
  log: [],
  passes: 0,
  round: 0,
  winnerId: null,
  boom: null,
  startedCount: 0,
  timer: null,
};

let seq = 1;

function uid() {
  seq += 1;
  return `p${seq.toString(36)}`;
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      const v4 = net.family === 'IPv4' || net.family === 4;
      if (v4 && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function playerById(id) {
  return game.players.find((p) => p.id === id) || null;
}

function cleanName(value) {
  const name = String(value || '')
    .replace(/[^\p{L}\p{N} '\-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
  return name || 'Player';
}

function takeColor() {
  const used = new Set(game.players.map((p) => p.color));
  return COLORS.find((c) => !used.has(c)) || COLORS[game.players.length % COLORS.length];
}

function pushLog(text, kind, prompt) {
  game.log.push({ text, kind, at: Date.now(), prompt: prompt || '' });
  if (game.log.length > 40) game.log.shift();
}

function clearTimer() {
  if (game.timer) clearTimeout(game.timer);
  game.timer = null;
}

function stageForPasses(passes) {
  if (passes >= 14) return 'skull';
  if (passes >= 6) return 'red';
  return 'black';
}

function baseFuse(stage) {
  if (stage === 'skull') return 6.5;
  if (stage === 'red') return 8.5;
  return 11;
}

function fuseAfter(stage, prev, ok) {
  if (!ok) {
    const cap = stage === 'skull' ? 8 : stage === 'red' ? 10 : 12;
    return Math.min(cap, prev + 1.8);
  }
  const floor = stage === 'skull' ? 2.4 : stage === 'red' ? 3.2 : 4;
  return Math.max(floor, Math.round(prev * 0.9 * 100) / 100);
}

function unusedCount(sub) {
  const list = BY_SUB.get(sub);
  if (!list) return 0;
  let n = 0;
  for (const word of list) if (!game.used.has(word)) n += 1;
  return n;
}

function rollLength(stage) {
  const r = Math.random() * 100;
  if (stage === 'skull') return r < 72 ? 3 : 2;
  if (stage === 'red') return r < 40 ? 3 : 2;
  return r < 85 ? 2 : 3;
}

function pickFrom(len, minLeft, hard) {
  const pool = [];
  for (const sub of CANDIDATES[len]) {
    if (sub === game.prompt) continue;
    const left = unusedCount(sub);
    if (left >= minLeft) pool.push({ sub, left });
  }
  if (!pool.length) return null;
  pool.sort((a, b) => a.left - b.left);
  if (hard) {
    const cut = pool.slice(0, Math.max(8, Math.ceil(pool.length * 0.28)));
    return cut[(Math.random() * cut.length) | 0].sub;
  }
  const friendly = pool.slice(Math.floor(pool.length * 0.45));
  const cut = friendly.length ? friendly : pool;
  return cut[(Math.random() * cut.length) | 0].sub;
}

function pickPrompt() {
  const order = [rollLength(game.stage)];
  for (const len of [2, 3]) if (!order.includes(len)) order.push(len);
  const hard = game.stage === 'skull';
  for (const len of order) {
    const min = len === 2 ? 4 : 3;
    const found = pickFrom(len, min, hard) || pickFrom(len, 1, hard);
    if (found) return found;
  }
  return CANDIDATES[2][0] || 'th';
}

function nextAlive(fromIndex) {
  const n = game.players.length;
  if (!n) return null;
  let fallback = null;
  for (let i = 1; i <= n; i++) {
    const player = game.players[(fromIndex + i + n) % n];
    if (!player.alive) continue;
    if (player.connected) return player;
    if (!fallback) fallback = player;
  }
  return fallback;
}

function ensureHost() {
  const current = game.players.find((p) => p.host && p.connected);
  if (current) {
    for (const player of game.players) if (player !== current) player.host = false;
    return;
  }
  for (const player of game.players) player.host = false;
  const next = game.players.find((p) => p.connected);
  if (next) next.host = true;
}

function snapshot() {
  return {
    t: 'state',
    roomCode: ROOM_CODE,
    phase: game.phase,
    countdown: game.countdown,
    players: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      lives: p.lives,
      aura: p.aura || 0,
      alive: p.alive,
      host: p.host,
      spectating: p.spectating,
      connected: p.connected,
    })),
    currentId: game.currentId,
    prompt: game.prompt,
    stage: game.stage,
    fuse: game.fuse,
    deadline: game.deadline,
    serverNow: Date.now(),
    used: [...game.used],
    passes: game.passes,
    round: game.round,
    winnerId: game.winnerId,
    boom: game.boom,
    maxLives: MAX_LIVES,
    log: game.log.slice(-16),
  };
}

function send(ws, payload) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function sendState(ws) {
  const snap = snapshot();
  for (const player of snap.players) player.you = player.id === ws.playerId;
  send(ws, snap);
}

function broadcast() {
  for (const ws of displays) sendState(ws);
  for (const player of game.players) {
    if (player.connected && player.ws) sendState(player.ws);
  }
}

function nope(ws, message) {
  send(ws, { t: 'nope', message });
}

function armTurn() {
  clearTimer();
  const ms = Math.max(400, Math.round(game.fuse * 1000));
  game.deadline = Date.now() + ms;
  game.timer = setTimeout(() => {
    if (game.phase !== 'playing') return;
    const player = playerById(game.currentId);
    if (!player || !player.alive) return;
    pushLog(`${player.name} ran out of time`, 'boom');
    loseLife(player);
  }, ms);
}

function endRound(winner) {
  clearTimer();
  game.phase = 'ended';
  game.currentId = null;
  game.prompt = '';
  game.countdown = 0;
  game.winnerId = winner ? winner.id : null;
  if (winner && game.startedCount > 1) pushLog(`${winner.name} wins the round`, 'win');
  else if (winner) pushLog(`Practice over · ${game.passes} words`, 'win');
  else pushLog(`The bomb wins · ${game.passes} words defused`, 'boom');
  broadcast();
}

function advanceFrom(player, success) {
  game.fuse = fuseAfter(game.stage, game.fuse, success);
  const index = game.players.findIndex((p) => p.id === player.id);
  const next = nextAlive(index < 0 ? 0 : index);
  if (!next) return endRound(null);
  game.currentId = next.id;
  game.prompt = pickPrompt();
  armTurn();
  return true;
}

function loseLife(player) {
  if (game.phase !== 'playing' || !player.alive) return;
  player.lives -= 1;
  player.aura = (player.aura || 0) - 100;
  game.boom = { id: player.id, at: Date.now() };
  if (player.lives <= 0) {
    player.alive = false;
    player.lives = 0;
    pushLog(`${player.name} exploded`, 'out');
    const alive = game.players.filter((p) => p.alive);
    if (alive.length === 0) return endRound(null);
    if (game.startedCount > 1 && alive.length === 1) return endRound(alive[0]);
    advanceFrom(player, false);
    broadcast();
    return;
  }
  pushLog(`${player.name} lost a life`, 'boom');
  advanceFrom(player, false);
  broadcast();
}

function acceptWord(player, word) {
  const earned = BRAINROT.has(word) ? 67 : 10;
  player.aura = (player.aura || 0) + earned;
  pushLog(`${player.name} +${earned} aura`, 'aura');
  game.used.add(word);
  game.passes += 1;
  pushLog(`${player.name} · ${word}`, 'word', game.prompt);
  const nextStage = stageForPasses(game.passes);
  if (nextStage !== game.stage) {
    game.stage = nextStage;
    game.fuse = Math.min(game.fuse, baseFuse(nextStage));
    pushLog(nextStage === 'red' ? 'The bomb turns red' : 'Skull bomb. The letters get meaner.', 'stage');
  }
  advanceFrom(player, true);
  broadcast();
}

function beginRound() {
  clearTimer();
  game.round += 1;
  game.phase = 'countdown';
  game.used = new Set();
  game.passes = 0;
  game.stage = 'black';
  game.fuse = baseFuse('black');
  game.prompt = '';
  game.currentId = null;
  game.winnerId = null;
  game.boom = null;
  game.startedCount = 0;
  game.log = [];
  for (const player of game.players) {
    player.aura = 0;
    if (!player.connected) {
      player.alive = false;
      player.spectating = true;
      player.lives = 0;
      continue;
    }
    player.spectating = false;
    player.alive = true;
    player.lives = MAX_LIVES;
    game.startedCount += 1;
  }
  if (!game.startedCount) {
    game.phase = 'lobby';
    broadcast();
    return;
  }
  pushLog(game.startedCount === 1 ? 'Practice round' : `Round ${game.round}`, 'system');
  let left = 3;
  const tick = () => {
    if (game.phase !== 'countdown') return;
    if (!game.players.some((p) => p.alive)) {
      game.phase = 'lobby';
      broadcast();
      return;
    }
    if (left <= 0) {
      startPlaying();
      return;
    }
    game.countdown = left;
    broadcast();
    left -= 1;
    game.timer = setTimeout(tick, 1000);
  };
  tick();
}

function startPlaying() {
  const living = game.players.filter((p) => p.alive);
  if (!living.length) {
    game.phase = 'lobby';
    broadcast();
    return;
  }
  game.phase = 'playing';
  game.countdown = 0;
  game.currentId = (living.find((p) => p.connected) || living[0]).id;
  game.prompt = pickPrompt();
  armTurn();
  broadcast();
}

function dropPlayer(player, reason) {
  const wasCurrent = game.currentId === player.id;
  const wasAlive = player.alive;
  const phase = game.phase;
  if (wasAlive && phase === 'playing') pushLog(reason, 'out');
  else pushLog(`${player.name} left`, 'system');
  game.players = game.players.filter((p) => p !== player);
  ensureHost();
  if (phase === 'playing' && wasAlive) {
    const alive = game.players.filter((p) => p.alive);
    if (alive.length === 0) return endRound(null);
    if (game.startedCount > 1 && alive.length === 1) return endRound(alive[0]);
    if (wasCurrent) {
      const next = alive.find((p) => p.connected) || alive[0];
      game.currentId = next.id;
      game.fuse = fuseAfter(game.stage, game.fuse, false);
      game.prompt = pickPrompt();
      armTurn();
    }
  }
  if (phase === 'countdown' && !game.players.some((p) => p.alive)) {
    clearTimer();
    game.phase = 'lobby';
  }
  if (!game.players.some((p) => p.connected)) {
    clearTimer();
    game.phase = 'lobby';
    game.players = [];
    game.currentId = null;
  }
  broadcast();
}

function sendHello(ws, player) {
  send(ws, {
    t: 'hello',
    id: player.id,
    token: player.token,
    ips: lanAddresses(),
    port: PORT,
  });
}

function handleJoin(ws, msg) {
  if (ws.display) return;
  if (String(msg.room || '').trim().toUpperCase() !== ROOM_CODE) {
    return send(ws, { t: 'error', message: 'Wrong room code. Check the laptop display.' });
  }
  if (ws.playerId) {
    const seated = playerById(ws.playerId);
    if (seated && seated.ws === ws) {
      seated.name = cleanName(msg.name);
      sendHello(ws, seated);
      broadcast();
      return;
    }
  }
  const name = cleanName(msg.name);
  const token = typeof msg.token === 'string' ? msg.token.slice(0, 64) : '';
  const existing = token ? game.players.find((p) => p.token === token) : null;

  if (existing) {
    if (existing.ws && existing.ws !== ws && existing.ws.readyState === 1) {
      const old = existing.ws;
      existing.ws = ws;
      existing.connected = true;
      existing.disconnectedAt = 0;
      existing.name = name;
      ws.playerId = existing.id;
      try { old.close(4001, 'replaced'); } catch { /* already gone */ }
    } else {
      existing.ws = ws;
      existing.connected = true;
      existing.disconnectedAt = 0;
      existing.name = name;
      ws.playerId = existing.id;
    }
    sendHello(ws, existing);
    ensureHost();
    broadcast();
    return;
  }

  if (game.players.length >= MAX_PLAYERS) {
    send(ws, { t: 'error', message: 'The table is full (5 players).' });
    return;
  }

  const inRound = game.phase === 'playing' || game.phase === 'countdown';
  const player = {
    id: uid(),
    token: crypto.randomBytes(18).toString('hex'),
    name,
    color: takeColor(),
    lives: inRound ? 0 : MAX_LIVES,
    alive: false,
    host: !game.players.some((p) => p.connected),
    spectating: inRound,
    connected: true,
    disconnectedAt: 0,
    ws,
    lastWordAt: 0,
    aura: 0,
  };
  game.players.push(player);
  ws.playerId = player.id;
  sendHello(ws, player);
  pushLog(`${player.name} sat down`, 'system');
  ensureHost();
  broadcast();
}

function handleStart(ws) {
  const player = playerById(ws.playerId);
  if (!player || !player.host) return nope(ws, 'Only the host can start.');
  if (game.phase === 'playing' || game.phase === 'countdown') return;
  if (!game.players.some((p) => p.connected)) return;
  beginRound();
}

function handleWord(ws, msg) {
  if (game.phase !== 'playing') return;
  const player = playerById(ws.playerId);
  if (!player || player.id !== game.currentId || !player.alive) return;
  const now = Date.now();
  if (now >= game.deadline) return loseLife(player);
  if (now - player.lastWordAt < 70) return;
  player.lastWordAt = now;
  const word = String(msg.word || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 20);
  if (!word) return;
  if (!word.includes(game.prompt)) return nope(ws, `Needs the letters ${game.prompt.toUpperCase()}.`);
  if (word.length < 3) return nope(ws, 'Too short.');
  if (!WORDS.has(word)) return nope(ws, 'Not in the dictionary.');
  if (game.used.has(word)) return nope(ws, 'Already used this round.');
  acceptWord(player, word);
}

function handleLeave(ws) {
  const player = playerById(ws.playerId);
  if (!player) return;
  ws.playerId = null;
  player.ws = null;
  dropPlayer(player, `${player.name} left`);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let pathname = '/index.html';
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const rel = pathname.replace(/^[/\\]+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('error', () => {});
  ws.on('message', (buf) => {
    if (buf.length > 2000) return;
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    if (msg.t === 'watch') {
      if (ws.playerId) return;
      ws.display = true;
      displays.add(ws);
      sendState(ws);
      return;
    }
    if (msg.t === 'join') return handleJoin(ws, msg);
    if (!ws.playerId) return;
    if (msg.t === 'start') return handleStart(ws);
    if (msg.t === 'word') return handleWord(ws, msg);
    if (msg.t === 'leave') return handleLeave(ws);
  });
  ws.on('close', () => {
    displays.delete(ws);
    const player = playerById(ws.playerId);
    if (!player || player.ws !== ws) return;
    player.connected = false;
    player.ws = null;
    player.disconnectedAt = Date.now();
    ensureHost();
    broadcast();
  });
});

setInterval(() => {
  const now = Date.now();
  for (const player of [...game.players]) {
    if (!player.connected && player.disconnectedAt && now - player.disconnectedAt > 20000) {
      dropPlayer(player, `${player.name} left`);
    }
  }
}, 1000);

setInterval(() => {
  for (const player of game.players) {
    if (player.ws && player.ws.readyState === 1) {
      try { player.ws.ping(); } catch { /* ignore */ }
    }
  }
}, 15000);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Close the other copy, or run with PORT set to a free port.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanAddresses();
  console.log('');
  console.log('Word Bomb is on the table.');
  console.log(`  Room code: ${ROOM_CODE}`);
  console.log(`  Laptop display: http://localhost:${PORT}/?display=1`);
  console.log(`  This computer:  http://localhost:${PORT}`);
  if (!ips.length) console.log('  No other network address found. Friends on Wi-Fi may not see this machine.');
  for (const ip of ips) console.log(`  Other devices:  http://${ip}:${PORT}`);
  console.log('');
});
