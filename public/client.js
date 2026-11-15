'use strict';


const joinOverlay = document.getElementById('join');
const joinForm = document.getElementById('join-form');
const joinNote = document.getElementById('join-note');
const nameInput = document.getElementById('name');
const netEl = document.getElementById('net');
const seatsEl = document.getElementById('seats');
const tilesEl = document.getElementById('tiles');
const stageEl = document.getElementById('stage');
const subEl = document.getElementById('sub');
const bombEl = document.getElementById('bomb');
const ringEl = document.getElementById('ring');
const arrowEl = document.getElementById('arrow');
const ribbonEl = document.getElementById('ribbon');
const startBtn = document.getElementById('start');
const form = document.getElementById('form');
const entry = document.getElementById('entry');
const previewEl = document.getElementById('preview');
const hintEl = document.getElementById('hint');
const logEl = document.getElementById('log');
const usedEl = document.getElementById('used');
const usedCountEl = document.getElementById('used-count');
const soundBtn = document.getElementById('sound');
const renameBtn = document.getElementById('rename');

const STAGE_LABEL = {
  black: 'Black bomb',
  red: 'Red bomb',
  skull: 'Skull bomb',
};
const CURSE_LABEL = {
  spin: '🌀 SCREEN SPIN',
  autocorrect: '✨ AUTOCORRECT',
  captcha: '🤖 CAPTCHA',
  shuffle: '🔀 KEYBOARD SHUFFLE',
  mirror: '🪞 MIRROR MODE',
  stupid: '🧠 STUPID WORDS ONLY',
};

let socket = null;
let wantConnect = false;
let state = null;
let clockOffset = 0;
let soundOn = true;
let lastPasses = 0;
let lastBoom = 0;
let lastTick = null;
let primed = false;
let replaced = false;
let audioCtx = null;
let usedSet = new Set();

nameInput.value = localStorage.getItem('wb-name') || '';

function ctx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function tone(freq, dur, type, gain) {
  if (!soundOn) return;
  const c = ctx();
  const osc = c.createOscillator();
  const amp = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  amp.gain.value = gain;
  osc.connect(amp);
  amp.connect(c.destination);
  osc.start();
  amp.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
  osc.stop(c.currentTime + dur);
}

function successSound() {
  tone(520, 0.08, 'triangle', 0.05);
  setTimeout(() => tone(780, 0.12, 'triangle', 0.05), 70);
}

function boomSound() {
  tone(140, 0.28, 'sawtooth', 0.06);
  tone(70, 0.4, 'square', 0.04);
}

function send(payload) {
  if (socket && socket.readyState === 1) socket.send(JSON.stringify(payload));
}

function you() {
  return state && state.players.find((p) => p.you);
}

function current() {
  return state && state.players.find((p) => p.id === state.currentId);
}

function remaining() {
  if (!state || state.phase !== 'playing') return 0;
  const serverNow = Date.now() + clockOffset;
  return Math.max(0, (state.deadline - serverNow) / 1000);
}

function setTiles(chars, countdown) {
  tilesEl.classList.toggle('count', countdown);
  tilesEl.replaceChildren();
  for (const ch of chars) {
    const span = document.createElement('span');
    span.textContent = ch;
    tilesEl.appendChild(span);
  }
}

function highlight(word, prompt) {
  const frag = document.createDocumentFragment();
  const at = prompt ? word.toLowerCase().indexOf(prompt) : -1;
  if (!prompt || at < 0) {
    const span = document.createElement('span');
    span.textContent = word;
    frag.appendChild(span);
    return frag;
  }
  const before = document.createElement('span');
  before.textContent = word.slice(0, at);
  const hit = document.createElement('span');
  hit.className = 'hit';
  hit.textContent = word.slice(at, at + prompt.length);
  const after = document.createElement('span');
  after.textContent = word.slice(at + prompt.length);
  frag.append(before, hit, after);
  return frag;
}

function renderNet(ips, port) {
  netEl.replaceChildren();
  const here = document.createElement('div');
  here.textContent = `This computer: http://localhost:${port}`;
  netEl.appendChild(here);
  const links = (ips || []).map((ip) => `http://${ip}:${port}`);
  for (const link of links) {
    const row = document.createElement('div');
    row.textContent = `Join from another device: ${link}`;
    netEl.appendChild(row);
  }
  if (links.length) {
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copy';
    copy.textContent = 'Copy invite link';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(links[0]);
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy invite link'; }, 1200);
      } catch {
        copy.textContent = links[0];
      }
    });
    netEl.appendChild(copy);
  }
}

function renderSeats() {
  seatsEl.replaceChildren();
  arrowEl.hidden = true;
  const players = state.players;
  const n = players.length || 1;
  const hot = state.currentId;
  players.forEach((p, i) => {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    const seat = document.createElement('div');
    seat.className = 'seat';
    if (p.id === hot && state.phase === 'playing') seat.classList.add('hot');
    if (!p.connected) seat.classList.add('away');
    else if (!p.alive && !p.spectating && (state.phase === 'playing' || state.phase === 'ended')) seat.classList.add('out');
    if (state.boom && state.boom.id === p.id && Date.now() + clockOffset - state.boom.at < 1200) {
      seat.classList.add('boom');
    }
    seat.style.left = `${50 + Math.cos(ang) * 40}%`;
    seat.style.top = `${50 + Math.sin(ang) * 38}%`;

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.style.background = p.color;
    avatar.textContent = (p.name || '?').slice(0, 1).toUpperCase();

    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = p.you ? `${p.name} (you)` : p.name;

    const meta = document.createElement('div');
    meta.className = 'meta';
    if (p.spectating) meta.textContent = 'next round';
    else if (!p.connected) meta.textContent = 'away';
    else if (!p.alive && (state.phase === 'playing' || state.phase === 'ended' || state.phase === 'countdown')) {
      meta.textContent = 'out';
    } else {
      let hearts = '';
      for (let h = 0; h < state.maxLives; h += 1) hearts += h < p.lives ? '♥' : '♡';
      meta.textContent = hearts;
    }

    seat.append(avatar, who, meta);
    if (p.host) {
      const tag = document.createElement('div');
      tag.className = 'tag';
      tag.textContent = 'host';
      seat.appendChild(tag);
    }
    seatsEl.appendChild(seat);

    if (p.id === hot && state.phase === 'playing') {
      arrowEl.hidden = false;
      arrowEl.style.transform = `rotate(${(ang * 180) / Math.PI}deg)`;
    }
  });
  if (state.phase !== 'playing') arrowEl.hidden = true;
}

function renderLog() {
  logEl.replaceChildren();
  if (!state.log.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'The fuse has not been lit.';
    logEl.appendChild(li);
    return;
  }
  for (const item of state.log) {
    const li = document.createElement('li');
    li.className = item.kind || '';
    if (item.kind === 'word') {
      const parts = item.text.split(' · ');
      li.append(document.createTextNode(`${parts[0]} · `));
      const word = document.createElement('b');
      word.append(highlight(parts.slice(1).join(' · '), item.prompt || ''));
      li.append(word);
    } else {
      li.textContent = item.text;
    }
    logEl.appendChild(li);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function renderUsed() {
  usedEl.replaceChildren();
  usedCountEl.textContent = state.used.length ? `(${state.used.length})` : '';
  if (!state.used.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'None yet.';
    usedEl.appendChild(li);
    return;
  }
  for (const word of [...state.used].reverse()) {
    const li = document.createElement('li');
    li.textContent = word;
    usedEl.appendChild(li);
  }
}

function renderCenter() {
  const self = you();
  const turn = current();
  bombEl.classList.remove('black', 'red', 'skull');
  bombEl.classList.add(state.stage || 'black');
  const yourTurn = state.phase === 'playing' && self && turn && self.id === turn.id;

  ribbonEl.hidden = !yourTurn;
  startBtn.hidden = true;
  document.title = yourTurn ? 'YOUR TURN — Word Bomb' : 'Word Bomb';

  if (state.phase === 'lobby') {
    setTiles([]);
    stageEl.textContent = '';
    ringEl.style.setProperty('--p', '1');
    const seated = state.players.filter((p) => p.connected).length;
    subEl.textContent = seated < 2
      ? 'Share the invite link, or practice alone.'
      : `${seated} players at the table.`;
    if (self && self.host) {
      startBtn.hidden = false;
      startBtn.textContent = 'Start round';
    } else {
      const host = state.players.find((p) => p.host);
      subEl.textContent = host ? `Waiting for ${host.name} to light the fuse.` : 'Waiting for a host.';
    }
    return;
  }

  if (state.phase === 'countdown') {
    setTiles(String(state.countdown), true);
    stageEl.textContent = 'Get ready';
    subEl.textContent = 'Hands over the keyboard.';
    ringEl.style.setProperty('--p', '1');
    return;
  }

  if (state.phase === 'ended') {
    const winner = state.players.find((p) => p.id === state.winnerId);
    setTiles(winner ? winner.name.slice(0, 8).toUpperCase().split('') : ['B', 'O', 'O', 'M'], false);
    stageEl.textContent = winner ? 'Winner' : 'Boom';
    if (winner && state.players.filter((p) => !p.spectating).length < 2) {
      subEl.textContent = `${state.passes} words defused.`;
    } else if (winner) {
      subEl.textContent = `${winner.name} is the last one sitting.`;
    } else {
      subEl.textContent = `${state.passes} words made it out.`;
    }
    if (self && self.host) {
      startBtn.hidden = false;
      startBtn.textContent = 'Play again';
    } else if (self) {
      subEl.textContent += ' Waiting for the host.';
    }
    return;
  }

  setTiles((state.prompt || '').toUpperCase().split(''), false);
  const curse = CURSE_LABEL[state.curse];
  if (curse && turn) {
    const who = yourTurn ? 'YOU got' : `${turn.name} got`;
    stageEl.textContent = `${who} ${curse}`;
    stageEl.classList.add('cursed');
  } else {
    stageEl.textContent = STAGE_LABEL[state.stage] || '';
    stageEl.classList.remove('cursed');
  }  
  if (self && self.spectating) subEl.textContent = 'You join when the next round starts.';
  else if (yourTurn) subEl.textContent = 'Type a word with those letters.';
  else if (turn) subEl.textContent = `${turn.name} is holding the bomb.`;
  else subEl.textContent = '';
}

function renderForm() {
  const self = you();
  const yourTurn = !!(state && state.phase === 'playing' && self && self.id === state.currentId && self.alive);
  entry.disabled = !yourTurn;
  if (!yourTurn) {
    entry.value = '';
    previewEl.replaceChildren();
    const turn = current();
    entry.placeholder = state && state.phase === 'playing' && turn
      ? `Waiting for ${turn.name}`
      : 'Type a word';
  } else if (document.activeElement !== entry) {
    entry.placeholder = state.prompt ? `Contains ${state.prompt.toUpperCase()}` : 'Type a word';
    if (!inPopup(document.activeElement)) entry.focus();
  }
  paintPreview();
}

function paintPreview() {
  previewEl.replaceChildren();
  const word = entry.value.toLowerCase().replace(/[^a-z]/g, '');
  if (!word || !state || state.phase !== 'playing') return;
  const prompt = state.prompt || '';
  if (!word.includes(prompt)) {
    const span = document.createElement('span');
    span.className = 'bad';
    span.textContent = `Needs ${prompt.toUpperCase()}`;
    previewEl.appendChild(span);
    return;
  }
  if (usedSet.has(word)) {
    const span = document.createElement('span');
    span.className = 'bad';
    span.textContent = 'Already used this round';
    previewEl.appendChild(span);
    return;
  }
  previewEl.append(highlight(word, prompt));
}

function render() {
  if (!state) return;
  document.body.dataset.curse = state.phase === 'playing' ? (state.curse || 'none') : 'none';
  const me = you();
  document.body.classList.toggle('my-turn', !!(me && state.phase === 'playing' && state.currentId === me.id));
  renderSeats();
  renderLog();
  renderUsed();
  renderCenter();
  renderForm();
  checkCaptcha();
}

// ---- Stupid sound: slide-whistle up, wobbly "wah wah wah", then a cartoon bonk.
function slide(from, to, dur, type, gain, delay) {
  if (!soundOn) return;
  const c = ctx();
  const t0 = c.currentTime + (delay || 0);
  const osc = c.createOscillator();
  const amp = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t0);
  osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  amp.gain.setValueAtTime(gain, t0);
  amp.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(amp);
  amp.connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur);
}

function stupidSound() {
  slide(300, 1800, 0.35, 'sine', 0.12, 0);
  slide(520, 380, 0.22, 'sawtooth', 0.07, 0.4);
  slide(440, 320, 0.22, 'sawtooth', 0.07, 0.65);
  slide(360, 140, 0.45, 'sawtooth', 0.07, 0.9);
  slide(220, 60, 0.18, 'square', 0.1, 1.4);
}

// ---- End-of-round popup: press Enter to close it and play the stupid sound.
const winOverlay = document.getElementById('win');
const winNameEl = document.getElementById('win-name');
const winSubEl = document.getElementById('win-sub');
const winOkBtn = document.getElementById('win-ok');
const winTitleEl = document.getElementById('win-title');
const winCrownEl = document.querySelector('#win .win-crown');

function winOpen() {
  return !winOverlay.classList.contains('hidden');
}

function showWin(next) {
  const winner = next.players.find((p) => p.id === next.winnerId);
  const solo = next.players.filter((p) => !p.spectating).length < 2;
  if (winner) {
    winTitleEl.textContent = 'Winner';
    winCrownEl.textContent = '👑';
    winNameEl.textContent = winner.you ? `${winner.name} (you)` : winner.name;
    winSubEl.textContent = solo ? `${next.passes} words defused.` : 'Last one sitting.';
  } else {
    winTitleEl.textContent = 'Game over';
    winCrownEl.textContent = '💥';
    winNameEl.textContent = 'The bomb wins';
    winSubEl.textContent = `${next.passes} words defused.`;
  }
  winOverlay.classList.remove('hidden');
  winOkBtn.focus();
}

function hideWin() {
  winOverlay.classList.add('hidden');
}

function dismissWin() {
  if (!winOpen()) return;
  hideWin();
  stupidSound();
}

winOkBtn.addEventListener('click', dismissWin);

// ---- Random popups: small fake browser windows at random spots on screen.
// The server decides when each player gets one and enforces each window's
// own timer; this just draws them and sends answers back.
const popupsEl = document.getElementById('popups');

const URLS = [
  'totally-not-a-virus.biz', 'free-robux.ru', 'download-more-ram.com',
  'verify-ur-brain.gov', 'skibidi-security.io', 'hot-bombs-in-ur-area.net',
  'definitely-a-bank.co', 'ohio-captcha.org',
];
const popups = new Map(); // id -> { el, input, dur, deadline, timeEl, barEl }
let chaosLooping = false;

function randInt(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function pick(list) {
  return list[randInt(0, list.length - 1)];
}

function drawCaptcha(canvas, text) {
  const g = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  g.fillStyle = '#f3e9d8';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 80; i++) {
    g.fillStyle = `hsla(${randInt(0, 360)}, 50%, 45%, 0.35)`;
    g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }
  const step = (w - 28) / text.length;
  for (let i = 0; i < text.length; i++) {
    g.save();
    g.translate(18 + i * step + randInt(-3, 3), h / 2 + randInt(-5, 5));
    g.rotate((Math.random() - 0.5) * 0.9);
    g.font = `bold ${randInt(24, 30)}px "Comic Sans MS", cursive, sans-serif`;
    g.fillStyle = `hsl(${randInt(0, 360)}, 60%, 30%)`;
    g.textBaseline = 'middle';
    g.fillText(text[i], 0, 0);
    g.restore();
  }
  for (let i = 0; i < 4; i++) {
    g.strokeStyle = `hsla(${randInt(0, 360)}, 60%, 35%, 0.7)`;
    g.lineWidth = randInt(1, 2);
    g.beginPath();
    g.moveTo(0, Math.random() * h);
    g.bezierCurveTo(w / 3, Math.random() * h, (2 * w) / 3, Math.random() * h, w, Math.random() * h);
    g.stroke();
  }
}

function inPopup(el) {
  return Boolean(el && el.closest && el.closest('.popup'));
}

function chaosSync() {
  const self = you();
  const alive = Boolean(state && state.phase === 'playing' && self && self.alive && !self.spectating);
  if (!alive) for (const id of [...popups.keys()]) closePopup(id);
}

function overlaps(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

// Drop the window somewhere random on screen, trying not to stack on others.
function placeRandomly(el) {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const maxX = Math.max(8, window.innerWidth - w - 8);
  const maxY = Math.max(8, window.innerHeight - h - 8);
  const others = [...popups.values()].map((p) => p.el.getBoundingClientRect());
  let x = 8;
  let y = 8;
  for (let tries = 0; tries < 20; tries++) {
    x = randInt(8, maxX);
    y = randInt(8, maxY);
    const box = { left: x - 6, top: y - 6, right: x + w + 6, bottom: y + h + 6 };
    if (!others.some((o) => overlaps(box, o))) break;
  }
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

function wiggle(el) {
  el.classList.remove('wrong');
  void el.offsetWidth;
  el.classList.add('wrong');
}

function openPopup(msg) {
  if (popups.has(msg.id)) return;
  const el = document.createElement('form');
  el.className = 'popup';
  el.autocomplete = 'off';
  el.innerHTML = `
    <div class="pop-bar">
      <span class="pop-dots"><i></i><i></i><i></i></span>
      <span class="pop-title"></span>
      <span class="pop-time"></span>
      <button type="button" class="pop-x" aria-label="Close">×</button>
    </div>
    <div class="pop-url"></div>
    <div class="pop-body">
      <p class="pop-q"></p>
      <input maxlength="12" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Answer" />
    </div>
    <div class="pop-timer"><div></div></div>`;
  el.querySelector('.pop-title').textContent = msg.title;
  el.querySelector('.pop-url').textContent = `🔒 https://${pick(URLS)}`;
  el.querySelector('.pop-q').textContent = msg.q;
  const input = el.querySelector('input');
  input.inputMode = msg.kind === 'math' ? 'numeric' : 'text';
  if (msg.code) {
    const code = document.createElement('p');
    code.className = 'pop-code';
    code.textContent = msg.code;
    input.before(code);
  }
  if (msg.captcha) {
    const canvas = document.createElement('canvas');
    canvas.width = 180;
    canvas.height = 58;
    drawCaptcha(canvas, msg.captcha);
    input.before(canvas);
  }

  el.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const answer = input.value.trim();
    if (!answer) return;
    send({ t: 'popanswer', id: msg.id, answer });
  });
  input.addEventListener('paste', (ev) => ev.preventDefault());
  el.querySelector('.pop-x').addEventListener('click', () => {
    el.querySelector('.pop-title').textContent = 'Nice try';
    wiggle(el);
    input.focus();
  });

  el.style.visibility = 'hidden';
  popupsEl.appendChild(el);
  placeRandomly(el);
  el.style.visibility = '';
  popups.set(msg.id, {
    el,
    input,
    dur: msg.dur,
    deadline: performance.now() + msg.dur,
    timeEl: el.querySelector('.pop-time'),
    barEl: el.querySelector('.pop-timer div'),
  });

  // A curse captcha always grabs focus; random ones don't interrupt you mid-word.
  if (msg.forced || document.activeElement !== entry || entry.disabled) input.focus();
  tone(880, 0.09, 'square', 0.05);
  setTimeout(() => tone(1175, 0.12, 'square', 0.05), 110);
  if (!chaosLooping) {
    chaosLooping = true;
    requestAnimationFrame(chaosFrame);
  }
}

function closePopup(id) {
  const p = popups.get(id);
  if (!p) return;
  const hadFocus = p.el.contains(document.activeElement);
  p.el.remove();
  popups.delete(id);
  if (!hadFocus) return;
  const rest = [...popups.values()];
  if (rest.length) rest[rest.length - 1].input.focus();
  else if (!entry.disabled) entry.focus();
}

function onPopupMessage(msg) {
  if (msg.t === 'popup') return openPopup(msg);
  const p = popups.get(msg.id);
  if (!p) return;
  if (msg.t === 'popwrong') {
    wiggle(p.el);
    p.input.value = '';
    tone(160, 0.15, 'square', 0.05);
    return;
  }
  if (msg.t === 'popclose') {
    if (msg.ok) successSound();
    closePopup(msg.id);
  }
}

// Each window's own countdown. The server closes it when time is really up.
function chaosFrame() {
  const now = performance.now();
  for (const p of popups.values()) {
    const left = p.deadline - now;
    const portion = Math.max(0, left / p.dur);
    const low = portion < 0.35;
    p.timeEl.textContent = `${Math.max(0, left / 1000).toFixed(1)}s`;
    p.timeEl.classList.toggle('low', low);
    p.barEl.style.width = `${portion * 100}%`;
    p.barEl.classList.toggle('low', low);
  }
  if (popups.size) requestAnimationFrame(chaosFrame);
  else chaosLooping = false;
}

function onState(next) {
  const first = !primed;
  primed = true;
  clockOffset = next.serverNow - Date.now();
  if (!first && next.passes > lastPasses) successSound();
  lastPasses = next.passes;
  if (!first && next.boom && next.boom.at !== lastBoom) {
    boomSound();
    document.body.classList.add('shake');
    setTimeout(() => document.body.classList.remove('shake'), 420);
  }
  if (next.boom) lastBoom = next.boom.at;
  if (next.phase !== 'playing') lastTick = null;
  if (next.phase !== 'ended') hideWin();
  else if (state && state.phase !== 'ended') showWin(next);
  const turnMoved = state && (next.currentId !== state.currentId || next.passes !== state.passes || next.phase !== state.phase);
  state = next;
  usedSet = new Set(next.used || []);
  if (turnMoved) {
    entry.value = '';
    entry.classList.remove('bad');
    hintEl.textContent = '';
    hintEl.classList.remove('warn');
  } else if (next.phase !== 'playing') {
    hintEl.textContent = '';
  }
  render();
  chaosSync();
}

function connect() {
  if (!wantConnect || replaced) return;
  if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const mine = new WebSocket(`${proto}://${location.host}`);
  socket = mine;
  joinNote.textContent = 'Connecting…';
  mine.addEventListener('open', () => {
    joinNote.textContent = '';
    send({
      t: 'join',
      name: localStorage.getItem('wb-name') || nameInput.value,
      token: localStorage.getItem('wb-token') || '',
    });
  });
  mine.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.t === 'hello') {
      localStorage.setItem('wb-token', msg.token);
      localStorage.setItem('wb-name', localStorage.getItem('wb-name') || nameInput.value);
      joinOverlay.classList.add('hidden');
      renderNet(msg.ips, msg.port);
      return;
    }
    if (msg.t === 'state') return onState(msg);
    if (msg.t === 'popup' || msg.t === 'popclose' || msg.t === 'popwrong') return onPopupMessage(msg);
    if (msg.t === 'nope') {
      hintEl.textContent = msg.message;
      hintEl.classList.add('warn');
      entry.classList.add('bad');
      return;
    }
    if (msg.t === 'error') {
      joinOverlay.classList.remove('hidden');
      joinNote.textContent = msg.message;
    }
  });
  mine.addEventListener('close', (ev) => {
    if (socket !== mine) return;
    socket = null;
    if (ev.code === 4001) {
      replaced = true;
      wantConnect = false;
      joinOverlay.classList.remove('hidden');
      joinNote.textContent = 'This seat is open in another tab. Change your name to sit as someone new.';
      return;
    }
    if (!wantConnect) return;
    if (state) hintEl.textContent = 'Reconnecting…';
    else {
      joinOverlay.classList.remove('hidden');
      joinNote.textContent = 'Reconnecting…';
    }
    setTimeout(connect, 800);
  });
}

joinForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const name = nameInput.value.trim().slice(0, 16);
  if (!name) return;
  ctx();
  localStorage.setItem('wb-name', name);
  replaced = false;
  wantConnect = true;
  if (socket && socket.readyState === 1) {
    send({ t: 'join', name, token: localStorage.getItem('wb-token') || '' });
    return;
  }
  connect();
});

renameBtn.addEventListener('click', () => {
  wantConnect = false;
  replaced = false;
  localStorage.removeItem('wb-token');
  send({ t: 'leave' });
  if (socket) socket.close();
  socket = null;
  state = null;
  joinOverlay.classList.remove('hidden');
  nameInput.focus();
});

soundBtn.addEventListener('click', () => {
  soundOn = !soundOn;
  soundBtn.textContent = soundOn ? 'Sound on' : 'Sound off';
  soundBtn.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
  if (soundOn) ctx();
});

startBtn.addEventListener('click', () => {
  ctx();
  send({ t: 'start' });
});

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (!state || state.phase !== 'playing') return;
  const self = you();
  if (!self || self.id !== state.currentId) return;
  const word = entry.value;
  const clean = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!clean) return;
  if (state.prompt && !clean.includes(state.prompt)) {
    hintEl.textContent = `Needs the letters ${state.prompt.toUpperCase()}.`;
    hintEl.classList.add('warn');
    entry.classList.add('bad');
    return;
  }
  if (usedSet.has(clean)) {
    hintEl.textContent = 'Already used this round.';
    hintEl.classList.add('warn');
    entry.classList.add('bad');
    return;
  }
  hintEl.textContent = '';
  hintEl.classList.remove('warn');
  entry.classList.remove('bad');
  send({ t: 'word', word });
});

entry.addEventListener('input', () => {
  entry.classList.remove('bad');
  hintEl.classList.remove('warn');
  hintEl.textContent = '';
  paintPreview();
});

document.addEventListener('keydown', (ev) => {
  if (inPopup(ev.target)) return;
  if (winOpen()) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (!ev.repeat) dismissWin();
    }
    return;
  }
  if (ev.target === entry || ev.target === nameInput) return;
  if (ev.key === 'Enter' && state && (state.phase === 'lobby' || state.phase === 'ended')) {
    const self = you();
    if (self && self.host) send({ t: 'start' });
  }
  if (/^[a-z]$/i.test(ev.key) && !entry.disabled) {
    entry.focus();
  }
});

function frame() {
  requestAnimationFrame(frame);
  if (!state || state.phase !== 'playing') return;
  const left = remaining();
  const portion = state.fuse ? Math.max(0, Math.min(1, left / state.fuse)) : 0;
  ringEl.style.setProperty('--p', String(portion));
  bombEl.classList.toggle('critical', portion < 0.3 && left > 0);
  if (!soundOn) return;
  const bucket = left < 3 ? Math.floor(left * 2) : Math.floor(left);
  if (lastTick === null) {
    lastTick = bucket;
    return;
  }
  if (bucket !== lastTick) {
    lastTick = bucket;
    tone(left < 3 ? 680 : 360, 0.05, 'square', 0.035);
  }
}

requestAnimationFrame(frame);

if (localStorage.getItem('wb-name')) {
  wantConnect = true;
  connect();
} else {
  nameInput.focus();
}
// ✨ AUTOCORRECT CURSE — randomly "fixes" letters as you type
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

document.addEventListener('keydown', (ev) => {
  if (!state || state.curse !== 'autocorrect') return;
  if (!document.body.classList.contains('my-turn')) return;
  if (entry.disabled || ev.ctrlKey || ev.metaKey) return;
  if (inPopup(ev.target)) return;                // leave popup answers alone
  if (!/^[a-z]$/i.test(ev.key)) return;          // only letters
  if (Math.random() > 0.3) return;               // 70% of the time: type normally

  ev.preventDefault();                           // cancel the real letter...
  const wrong = ALPHABET[(Math.random() * 26) | 0];
  entry.focus();
  entry.value += wrong;                          // ...and type a random one
  entry.dispatchEvent(new Event('input'));       // refresh the preview
  hintEl.textContent = `✨ autocorrected ${ev.key.toUpperCase()} → ${wrong.toUpperCase()} ✨`;
}, true);

// 🤖 CAPTCHA CURSE — fake "reCRAPTCHA" that blocks typing until solved
let captchaOpen = false;
let lastTurnKey = '';
const captchaEl = document.createElement('div');
captchaEl.className = 'captcha-overlay';
captchaEl.hidden = true;
document.body.appendChild(captchaEl);

// Each photo is split into a 4×4 grid. Squares are numbered:
//    0  1  2  3
//    4  5  6  7
//    8  9 10 11
//   12 13 14 15
// "answer" = the square numbers that contain the thing.
const CAPTCHA_PHOTOS = [
  { pic: 'captcha/street1.jpg', name: 'buses',          answer: [13, 14] },
  { pic: 'captcha/street1.jpg', name: 'traffic lights', answer: [9] },
  { pic: 'captcha/street2.jpg', name: 'traffic lights', answer: [5, 7] },
  { pic: 'captcha/street2.jpg', name: 'cars',           answer: [12] },
  { pic: 'captcha/street3.jpg', name: 'cars',           answer: [13, 14, 15] },
  { pic: 'captcha/street4.jpg', name: 'street lamps',   answer: [9, 13] },
  { pic: 'captcha/street5.jpg', name: 'bridges',        answer: [4, 5, 6, 7, 8, 9, 10, 11] },
];
const SHOW_NUMBERS = false;     // true = show square numbers (for checking answers)
const MISTAKES_ALLOWED = 2;     // real captchas are a bit forgiving too
const EXTRA_ROUND_CHANCE = 0.4; // "please also verify this one" even when right

// Step 1: the "I'm not a robot" checkbox
function openCaptcha() {
  captchaOpen = true;
  entry.readOnly = true;
  captchaEl.innerHTML = `
    <div class="rc-box">
      <button type="button" class="rc-check" aria-label="I'm not a robot"></button>
      <span class="rc-label">I'm not a robot</span>
      <div class="rc-brand">🔄<b>reCRAPTCHA</b><small>Privacy - Terms</small></div>
    </div>`;
  const check = captchaEl.querySelector('.rc-check');
  check.onclick = () => {
    check.classList.add('spinning');
    setTimeout(() => { if (captchaOpen) showChallenge(); }, 900);
  };
  captchaEl.hidden = false;
}

// Step 2: the 4×4 photo challenge
function showChallenge(errorText) {
  const photo = CAPTCHA_PHOTOS[(Math.random() * CAPTCHA_PHOTOS.length) | 0];
  const picked = new Set();

  captchaEl.innerHTML = `
    <div class="rc-challenge">
      <div class="rc-head">
        Select all squares with
        <b>${photo.name}</b>
        <small>If there are none, click skip</small>
      </div>
      <div class="rc-grid rc-grid-4"></div>
      <div class="rc-error">${errorText || ''}</div>
      <div class="rc-foot">
        <span class="rc-icons">↻ 🎧 ⓘ</span>
        <button type="button" class="rc-verify">VERIFY</button>
      </div>
    </div>`;

  const grid = captchaEl.querySelector('.rc-grid');
  for (let i = 0; i < 16; i++) {
    const row = Math.floor(i / 4);
    const col = i % 4;
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'rc-cell';
    cell.style.backgroundImage = `url('${photo.pic}')`;
    cell.style.backgroundPosition = `${(col * 100) / 3}% ${(row * 100) / 3}%`;
    if (SHOW_NUMBERS) cell.textContent = i;
    cell.onclick = () => {
      if (picked.has(i)) picked.delete(i); else picked.add(i);
      cell.classList.toggle('on', picked.has(i));
    };
    grid.appendChild(cell);
  }

  captchaEl.querySelector('.rc-verify').onclick = () => {
    let mistakes = 0;
    for (let i = 0; i < 16; i++) {
      if (photo.answer.includes(i) !== picked.has(i)) mistakes += 1;
    }
    if (mistakes > MISTAKES_ALLOWED) return showChallenge('Please try again.');
    if (Math.random() < EXTRA_ROUND_CHANCE) return showChallenge('Please also verify this one.');
    closeCaptcha();
  };
}

function closeCaptcha() {
  captchaOpen = false;
  entry.readOnly = false;
  captchaEl.hidden = true;
  captchaEl.replaceChildren();
  if (!entry.disabled) entry.focus();
}

// Called on every render: opens the captcha when YOUR cursed turn starts
function checkCaptcha() {
  const me = you();
  const myTurn = !!(state && state.phase === 'playing' && me && state.currentId === me.id);
  const key = state ? `${state.round}:${state.passes}:${state.currentId}:${state.phase}` : '';
  if (key === lastTurnKey) return;
  lastTurnKey = key;
  if (captchaOpen) closeCaptcha();
  if (myTurn && state.curse === 'captcha') openCaptcha();
}

// Block keyboard typing while the captcha is open
document.addEventListener('keydown', (ev) => {
  if (!captchaOpen || ev.target === nameInput) return;
  if (ev.key.length === 1 || ev.key === 'Enter' || ev.key === 'Backspace') {
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }
}, true);