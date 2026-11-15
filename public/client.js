'use strict';

const displayOnly = new URLSearchParams(location.search).get('display') === '1';
const roomInput = document.getElementById('room');
roomInput.value = new URLSearchParams(location.search).get('room') || localStorage.getItem('wb-room') || '';

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
  stageEl.textContent = STAGE_LABEL[state.stage] || '';
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
    entry.focus();
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
  renderSeats();
  renderLog();
  renderUsed();
  renderCenter();
  renderForm();
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
  window.dispatchEvent(new CustomEvent('brainrot-state', { detail: next }));
}

function connect() {
  if (!wantConnect || replaced) return;
  if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const mine = new WebSocket(`${proto}://${location.host}`);
  socket = mine;
  joinNote.textContent = 'Connecting…';
  mine.addEventListener('open', () => {
    if (displayOnly) {
      joinOverlay.classList.add('hidden');
      send({ t: 'watch' });
      return;
    }
    joinNote.textContent = '';
    send({
      t: 'join',
      room: roomInput.value.trim().toUpperCase(),
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
  localStorage.setItem('wb-room', roomInput.value.trim().toUpperCase());
  localStorage.setItem('wb-name', name);
  replaced = false;
  wantConnect = true;
  if (socket && socket.readyState === 1) {
    send({ t: 'join', name, room: roomInput.value.trim().toUpperCase(), token: localStorage.getItem('wb-token') || '' });
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

if (displayOnly || (localStorage.getItem('wb-name') && roomInput.value.trim())) {
  wantConnect = true;
  connect();
} else {
  nameInput.focus();
}
