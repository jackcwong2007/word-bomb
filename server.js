'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.resolve(__dirname, 'public');
const MAX_PLAYERS = 5;
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
const CURSES = ['spin', 'autocorrect', 'captcha', 'shuffle', 'mirror', 'stupid'];

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
const STUPID = new Set();
const STUPID_BY_SUB = new Map();
const STUPID_CANDIDATES = { 2: [], 3: [] };

function loadStupidWords() {
  const raw = fs.readFileSync(path.join(__dirname, 'data', 'stupid.txt'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const word = line.trim().toLowerCase();
    if (!/^[a-z]{3,15}$/.test(word) || STUPID.has(word)) continue;
    STUPID.add(word);
    const seen = new Set();
    for (let len = 2; len <= 3; len++) {
      for (let i = 0; i + len <= word.length; i++) {
        const sub = word.slice(i, i + len);
        if (seen.has(sub)) continue;
        seen.add(sub);
        let list = STUPID_BY_SUB.get(sub);
        if (!list) {
          list = [];
          STUPID_BY_SUB.set(sub, list);
        }
        list.push(word);
      }
    }
  }
  // Only use letter chunks that at least 3 stupid words contain,
  // so there's always more than one possible answer.
  for (const [sub, list] of STUPID_BY_SUB) {
    if (list.length >= 3 && STUPID_CANDIDATES[sub.length]) STUPID_CANDIDATES[sub.length].push(sub);
  }
  console.log(
    `Stupid words: ${STUPID.size} · slices ${STUPID_CANDIDATES[2].length} / ${STUPID_CANDIDATES[3].length}`
  );
}

loadStupidWords();

loadWords();

// Stupid words only = one of the wheel's curses.
function isStupid() {
  return game.curse === 'stupid';
}

// Spin the curse wheel for the next player.
// Early in the game you usually get no curse; later almost always.
function pickCurse() {
  if (process.env.FORCE_CURSE) return process.env.FORCE_CURSE;
  const noneChance = game.stage === 'skull' ? 0.1 : game.stage === 'red' ? 0.25 : 0.5;
  if (Math.random() < noneChance) return 'none';
  return CURSES[(Math.random() * CURSES.length) | 0];
}

// Pick letters that at least one unused stupid word contains.
function pickStupidPrompt() {
  const pool = STUPID_CANDIDATES[2].filter(
    (sub) => sub !== game.prompt && STUPID_BY_SUB.get(sub).some((w) => !game.used.has(w))
  );
  const list = pool.length ? pool : STUPID_CANDIDATES[2];
  return list[(Math.random() * list.length) | 0];
}

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
  curse: 'none',
  picked: false, // has the winner picked someone for the camera this round?
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

// Hand-picked prompts. Common ones show up in lots of everyday words;
// less common ones are still very doable but take a second of thought.
const COMMON_PROMPTS = [
  'an', 'ar', 'at', 'en', 'er', 'es', 'ed', 'in', 'on', 'or',
  're', 'st', 'te', 'th', 'ti', 'al', 'le', 'ra', 'ri', 'ro',
  'ic', 'it', 'is', 'ou', 'ng', 'nt', 'ea', 'll', 'ss', 'ch',
  'sh', 'un', 'ly', 'de', 'co', 'ma', 'ca', 'se', 'ce', 'ne',
  'li', 'la', 'lo', 'me', 'mi', 'pe', 'pa', 'po', 'ta', 'to',
  've', 'ur', 'ol', 'il', 'el', 'ac', 'ad', 'am', 'ab', 'ow',
  'ing', 'ent', 'ion', 'ter', 'est', 'ate', 'tio', 'and', 'ers', 'con',
  'pro', 'per', 'ver', 'all', 'res', 'ant', 'ine', 'ted', 'ous', 'men',
  'pre', 'com', 'ess', 'ati', 'tra', 'str', 'sta', 'int', 'ist', 'ive',
  'ble', 'age', 'ear', 'ore', 'und', 'out', 'one', 'art', 'ace', 'ish',
];
const RARE_PROMPTS = [
  'ck', 'gh', 'ph', 'wh', 'ght', 'oo', 'ee', 'ai', 'oa', 'ui',
  'ie', 'ue', 'ay', 'ey', 'oy', 'ex', 'ix', 'ox', 'ze', 'zi',
  'qu', 'ju', 'ka', 'ki', 'wa', 'wi', 'ug', 'ub', 'ump', 'ank',
  'unk', 'ink', 'ong', 'ick', 'ack', 'ock', 'uck', 'oom', 'ool', 'eep',
  'eat', 'oon', 'ift', 'rch', 'tch', 'dge', 'nch', 'fl', 'gr', 'sp',
];
const MIN_WORDS_PER_PROMPT = 40;

function vetPrompts(list, label) {
  const keep = list.filter((sub) => (BY_SUB.get(sub) || []).length >= MIN_WORDS_PER_PROMPT);
  const dropped = list.filter((sub) => !keep.includes(sub));
  if (dropped.length) console.log(`Dropped ${label} prompts (too few words): ${dropped.join(', ')}`);
  return keep;
}

const COMMON = vetPrompts(COMMON_PROMPTS, 'common');
const RARE = vetPrompts(RARE_PROMPTS, 'rare');
console.log(`Prompts: ${COMMON.length} common · ${RARE.length} less common`);

// Chance of a less common prompt, by bomb stage.
function rareChance(stage) {
  if (stage === 'skull') return 0.55;
  if (stage === 'red') return 0.25;
  return 0;
}

function pickFromList(list) {
  const pool = list.filter((sub) => sub !== game.prompt && unusedCount(sub) >= 3);
  return pool.length ? pool[(Math.random() * pool.length) | 0] : null;
}

function pickPrompt() {
  if (isStupid()) return pickStupidPrompt();
  const rare = Math.random() < rareChance(game.stage);
  const first = rare ? RARE : COMMON;
  const second = rare ? COMMON : RARE;
  const curated = pickFromList(first) || pickFromList(second);
  if (curated) return curated;
  return pickRandomSlice();
}

// Fallback: any slice from the dictionary (only if the curated lists run dry).
function pickRandomSlice() {
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
    curse: game.curse,
    stupid: isStupid(),
    picked: game.picked,
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
  game.curse = 'none';
  game.countdown = 0;
  game.winnerId = winner ? winner.id : null;
  game.picked = false;
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
  game.curse = pickCurse(); // 1. spin the wheel
  game.prompt = pickPrompt(); // 2. then letters that fit the curse
  armTurn();
  applyCurse(next);
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
  game.curse = 'none';
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
  game.curse = process.env.FORCE_CURSE || 'none'; // first turn is normal unless forced
  game.prompt = pickPrompt();
  armTurn();
  resetPopups();
  applyCurse(playerById(game.currentId));
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
      game.curse = pickCurse();
      game.prompt = pickPrompt();
      armTurn();
      applyCurse(next);
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
    url: publicUrl,
  });
}

function handleJoin(ws, msg) {
  if (ws.display) return;
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
  if (isStupid()) {
    if (!STUPID.has(word)) return nope(ws, 'not brainrot enough 🤓');
  } else if (!WORDS.has(word)) {
    return nope(ws, 'Not in the dictionary.');
  }
  if (game.used.has(word)) return nope(ws, 'Already used this round.');
  acceptWord(player, word);
}

// ---- Random popups. The server decides when each player gets one, so every
// alive player gets their own on their own random schedule, and it enforces
// each window's timer (running out costs a life).
const POPUP_MAX = 3;
const POPUP_GAP = (process.env.POPUP_GAP || '8000-20000').split('-').map(Number);
const CAP_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const POPUP_GRACE = 400; // ms of slack for network lag
let popupSeq = 0;

function rint(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function randCode(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += CAP_CHARS[rint(0, CAP_CHARS.length - 1)];
  return s;
}

function makeChallenge(kind) {
  const k = kind || ['code', 'math', 'captcha'][rint(0, 2)];
  if (k === 'code') {
    const code = randCode(6);
    return { kind: k, title: 'Security check', q: 'Enter this code:', code, answer: code, dur: 8000 };
  }
  if (k === 'math') {
    const op = ['+', '-', '×'][rint(0, 2)];
    let a; let b; let ans;
    if (op === '+') { a = rint(5, 60); b = rint(5, 60); ans = a + b; }
    else if (op === '-') { a = rint(20, 90); b = rint(1, a); ans = a - b; }
    else { a = rint(2, 12); b = rint(2, 12); ans = a * b; }
    return { kind: k, title: 'Quick maths', q: 'Solve to continue:', code: `${a} ${op} ${b}`, answer: String(ans), dur: 8000 };
  }
  const text = randCode(5);
  return { kind: 'captcha', title: 'Are you human?', q: 'Type the captcha:', captcha: text, answer: text, dur: 10000 };
}

function nextPopupDelay() {
  return rint(POPUP_GAP[0], POPUP_GAP[1] || POPUP_GAP[0]);
}

function resetPopups() {
  const now = Date.now();
  for (const player of game.players) {
    player.popups = new Map();
    player.nextPopupAt = now + nextPopupDelay();
  }
}

function openPopupFor(player, kind, forced) {
  if (!player.popups) player.popups = new Map();
  if (!forced && player.popups.size >= POPUP_MAX) return;
  const c = makeChallenge(kind);
  popupSeq += 1;
  const id = `pop${popupSeq}`;
  player.popups.set(id, { answer: c.answer, deadline: Date.now() + c.dur + POPUP_GRACE });
  send(player.ws, {
    t: 'popup',
    id,
    kind: c.kind,
    title: forced ? '🤖 CAPTCHA curse' : c.title,
    q: c.q,
    code: c.code || '',
    captcha: c.captcha || '',
    dur: c.dur,
    forced: !!forced,
  });
}

// Curse effects that need the server (the CAPTCHA curse pops a captcha window).
function applyCurse(player) {
  if (game.curse === 'captcha' && player) openPopupFor(player, 'captcha', true);
}

function handlePopAnswer(ws, msg) {
  if (game.phase !== 'playing') return;
  const player = playerById(ws.playerId);
  if (!player || !player.alive || !player.popups) return;
  const id = String(msg.id || '');
  const pop = player.popups.get(id);
  if (!pop) return;
  const guess = String(msg.answer || '').toUpperCase().replace(/\s+/g, '').slice(0, 12);
  if (guess && guess === pop.answer) {
    player.popups.delete(id);
    send(ws, { t: 'popclose', id, ok: true });
  } else {
    send(ws, { t: 'popwrong', id });
  }
}

setInterval(() => {
  if (game.phase !== 'playing') return;
  const now = Date.now();
  for (const player of [...game.players]) {
    if (!player.popups) player.popups = new Map();
    if (!player.alive) {
      player.popups.clear();
      continue;
    }
    for (const [id, pop] of player.popups) {
      if (now < pop.deadline) continue;
      player.popups.delete(id);
      if (!player.connected) continue; // no penalty while disconnected
      send(player.ws, { t: 'popclose', id, ok: false });
      popupFail(player);
      if (game.phase !== 'playing') return;
      if (!player.alive) break;
    }
    if (!player.alive || !player.connected) continue;
    if (!player.nextPopupAt) player.nextPopupAt = now + nextPopupDelay();
    if (now >= player.nextPopupAt) {
      openPopupFor(player);
      player.nextPopupAt = now + nextPopupDelay();
    }
  }
}, 200);

// A player ran out of time on one of their popups: costs a life.
function popupFail(player) {
  if (game.phase !== 'playing' || !player.alive) return;
  const now = Date.now();
  const wasCurrent = game.currentId === player.id;
  player.lives -= 1;
  game.boom = { id: player.id, at: now };
  pushLog(`${player.name} fumbled the popup`, 'boom');
  if (player.lives <= 0) {
    player.alive = false;
    player.lives = 0;
    pushLog(`${player.name} exploded`, 'out');
    const alive = game.players.filter((p) => p.alive);
    if (alive.length === 0) return endRound(null);
    if (game.startedCount > 1 && alive.length === 1) return endRound(alive[0]);
    if (wasCurrent) advanceFrom(player, false);
  }
  broadcast();
}

// The winner picks one loser; that player's own camera turns on
// (on their own screen) for the "open your mouth" meme.
function handlePick(ws, msg) {
  const player = playerById(ws.playerId);
  if (!player || game.phase !== 'ended' || game.winnerId !== player.id) return;
  if (game.picked) return nope(ws, 'You already picked someone this round.');
  const target = playerById(String(msg.id || ''));
  if (!target || target === player || !target.connected) return nope(ws, "They're not here anymore.");
  if (target.spectating) return nope(ws, "They didn't play this round.");
  game.picked = true;
  pushLog(`${player.name} picked ${target.name} for the camera 📸`, 'win');
  send(target.ws, { t: 'picked', by: player.name });
  broadcast();
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

// HTTPS so browsers on other devices are allowed to use the camera.
// A self-signed certificate is made on first run (and remade if this
// computer's network address changes). Set HTTPS=0 to use plain http.
// `npm run tunnel` (or --tunnel): a free Cloudflare quick tunnel gives the game a
// real, trusted https://….trycloudflare.com link, so no browser warning anywhere.
// Locally the game then runs on plain http (localhost is already camera-safe).
const TUNNEL = process.env.TUNNEL === '1' || process.argv.includes('--tunnel');
const USE_HTTPS = process.env.HTTPS !== '0' && !TUNNEL;
let publicUrl = '';

function findCloudflared() {
  const spots = [
    process.env.CLOUDFLARED,
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ].filter(Boolean);
  return spots.find((p) => fs.existsSync(p)) || 'cloudflared';
}

function startTunnel() {
  const { spawn } = require('child_process');
  console.log('  Starting Cloudflare tunnel…');
  const child = spawn(findCloudflared(), ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], {
    windowsHide: true,
  });
  const onData = (buf) => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (!m || publicUrl) return;
    publicUrl = m[0];
    console.log('');
    console.log(`  Invite link (works anywhere, no warning):  ${publicUrl}`);
    console.log('');
    for (const player of game.players) send(player.ws, { t: 'url', url: publicUrl });
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (err) => {
    console.error(`  Could not start cloudflared (${err.message}). Install it with: winget install Cloudflare.cloudflared`);
  });
  child.on('exit', (code) => {
    if (publicUrl) console.log(`  Cloudflare tunnel closed (code ${code}). The invite link no longer works.`);
    publicUrl = '';
  });
  const stop = () => {
    try { child.kill(); } catch { /* already gone */ }
  };
  process.on('exit', stop);
  process.on('SIGINT', () => { stop(); process.exit(0); });
}
const CERT_DIR = path.join(__dirname, 'certs');

function loadOrMakeCert() {
  const ips = lanAddresses();
  const want = ['localhost', '127.0.0.1', ...ips].join(',');
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');
  const forFile = path.join(CERT_DIR, 'for.txt');
  try {
    if (fs.readFileSync(forFile, 'utf8') === want) {
      return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
    }
  } catch { /* no cert yet */ }
  const selfsigned = require('selfsigned');
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'Word Bomb (local)' }], {
    days: 825,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(forFile, want);
  console.log('Made a new self-signed certificate for', want);
  return { key: pems.private, cert: pems.cert };
}

function handleRequest(req, res) {
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
  'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',        'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = USE_HTTPS
  ? https.createServer(loadOrMakeCert(), handleRequest)
  : http.createServer(handleRequest);
const SCHEME = USE_HTTPS ? 'https' : 'http';

const wss = new WebSocketServer({ server });
wss.on('error', () => {}); // listen errors are reported by server.on('error') below

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
    if (msg.t === 'popanswer') return handlePopAnswer(ws, msg);
    if (msg.t === 'pick') return handlePick(ws, msg);
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
  console.log(`  Laptop display: http://localhost:${PORT}/?display=1`);
  console.log(`  This computer:  http://localhost:${PORT}`);
  if (!ips.length) console.log('  No other network address found. Friends on Wi-Fi may not see this machine.');
  for (const ip of ips) console.log(`  Other devices:  ${SCHEME}://${ip}:${PORT}`);
  if (USE_HTTPS) {
    console.log('');
    console.log('  The certificate is self-signed, so browsers show a warning the first time.');
    console.log('  Click "Advanced" -> "Proceed" (Chrome/Edge) or "Accept the risk" (Firefox).');
    console.log('  Tip: run "npm run tunnel" instead for a link with no warning.');
  }
  console.log('');
  if (TUNNEL) startTunnel();
});
