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

let lastNet = { ips: [], port: 0, url: '' };

function renderNet(ips, port, url) {
  lastNet = { ips, port, url: url || '' };
  netEl.replaceChildren();
  let links;
  if (url) {
    // Cloudflare tunnel link: works from anywhere with no browser warning.
    const row = document.createElement('div');
    row.textContent = `Invite link: ${url}`;
    netEl.appendChild(row);
    links = [url];
  } else {
    const here = document.createElement('div');
    const scheme = location.protocol === 'https:' ? 'https' : 'http';
    here.textContent = `This computer: ${scheme}://localhost:${port}`;
    netEl.appendChild(here);
    links = (ips || []).map((ip) => `${scheme}://${ip}:${port}`);
    for (const link of links) {
      const row = document.createElement('div');
      row.textContent = `Join from another device: ${link}`;
      netEl.appendChild(row);
    }
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
  const self = you();
  if (state && self && state.winnerId === self.id) openWinnerPicker(); // winner picks a loser; no camera for them
}

// ---- Reaction cam: after the win popup, show the player their own face.
// The video stays in this browser; nothing is sent to the server.
const camOverlay = document.getElementById('cam');
const camVideo = document.getElementById('cam-video');
const camCaption = document.getElementById('cam-caption');
const camNote = document.getElementById('cam-note');
const camClose = document.getElementById('cam-close');
let camStream = null;

function camOpen() {
  return !camOverlay.classList.contains('hidden');
}

const camMeter = document.getElementById('cam-meter');

// Face detection: Google MediaPipe Face Landmarker, loaded from a CDN the
// first time it's needed (needs internet on the winner's computer).
const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const JAW_OPEN = 0.5; // 0 = closed, 1 = wide open
let faceLandmarker = null;
let faceLoading = null;
let camLoop = 0;
let camSession = 0;

function loadFaceLandmarker() {
  if (faceLandmarker) return Promise.resolve(faceLandmarker);
  if (!faceLoading) {
    faceLoading = (async () => {
      const vision = await import(`${MP_BASE}/vision_bundle.mjs`);
      const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
      const make = (delegate) => vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
      });
      try {
        faceLandmarker = await make('GPU');
      } catch {
        faceLandmarker = await make('CPU');
      }
      return faceLandmarker;
    })().catch((err) => {
      faceLoading = null;
      throw err;
    });
  }
  return faceLoading;
}

const camPickEl = document.getElementById('cam-pick');
const camMeterWrap = document.querySelector('#cam .cam-meter');

// Winner's window: pick a loser to turn on THEIR camera (it opens on the
// loser's own screen for the mouth meme). The winner's camera stays off.
function openWinnerPicker() {
  camSession += 1;
  camCaption.textContent = 'Pick a loser 😈';
  camNote.textContent = 'Their camera turns on and they have to open their mouth.';
  camVideo.hidden = true;
  camMeterWrap.hidden = true;
  renderPicker(camPickEl);
  camOverlay.classList.remove('hidden');
  const first = camPickEl.querySelector('button');
  (first || camClose).focus();
}

function renderPicker(container) {
  container.replaceChildren();
  container.hidden = false;
  const title = document.createElement('p');
  title.className = 'pick-title';
  title.textContent = 'Who is getting cooked?';
  container.appendChild(title);
  // Losers = people who played this round and aren't you (the winner).
  const others = state ? state.players.filter((p) => !p.you && p.connected && !p.spectating) : [];
  if (state && state.picked) {
    title.textContent = 'Loser already picked 📸';
    return;
  }
  if (!others.length) {
    const none = document.createElement('p');
    none.className = 'pick-none';
    none.textContent = 'No losers here to pick 😢';
    container.appendChild(none);
    return;
  }
  const row = document.createElement('div');
  row.className = 'pick-row';
  for (const p of others) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pick-btn';
    const dot = document.createElement('span');
    dot.className = 'pick-dot';
    dot.style.background = p.color;
    dot.textContent = (p.name || '?').slice(0, 1).toUpperCase();
    btn.append(dot, document.createTextNode(p.name));
    btn.addEventListener('click', () => {
      send({ t: 'pick', id: p.id });
      for (const b of row.querySelectorAll('button')) b.disabled = true;
      title.textContent = `📸 Turning on ${p.name}'s camera…`;
      tone(1320, 0.08, 'square', 0.05);
      const session = camSession;
      setTimeout(() => {
        if (session === camSession && camOpen()) closeCam();
      }, 1600);
    });
    row.appendChild(btn);
  }
  container.appendChild(row);
}

async function openCam(opts) {
  const session = ++camSession;
  camCaption.textContent = (opts && opts.caption) || 'Open your mouth';
  camNote.textContent = '';
  camPickEl.hidden = true;
  camMeterWrap.hidden = false;
  camMeter.style.width = '0%';
  camVideo.hidden = false;
  camOverlay.classList.remove('hidden');
  camClose.focus();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    camVideo.hidden = true;
    camNote.textContent = 'This browser blocks the camera here. Open the game with its https:// link.';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    if (session !== camSession || !camOpen()) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    camStream = stream;
    camVideo.srcObject = stream;
    await camVideo.play().catch(() => {});
  } catch {
    camVideo.hidden = true;
    camNote.textContent = 'No camera, or camera permission was denied. Lucky you.';
    return;
  }
  camNote.textContent = 'Loading face AI…';
  let detector = null;
  try {
    detector = await loadFaceLandmarker();
  } catch {
    detector = null;
  }
  if (session !== camSession || !camOpen()) return;
  if (!detector) {
    snapCountdown(session, 'Face AI failed to load (no internet?). Snapping anyway in');
    return;
  }
  camNote.textContent = 'Waiting for that mouth…';
  watchMouth(detector, session);
}

function snapCountdown(session, text) {
  let n = 3;
  const tick = () => {
    if (session !== camSession || !camOpen()) return;
    if (n === 0) return snapMeme(null);
    camNote.textContent = `${text} ${n}…`;
    n -= 1;
    setTimeout(tick, 1000);
  };
  tick();
}

function watchMouth(detector, session) {
  let streak = 0;
  let lastTs = -1;
  const started = performance.now();
  const step = () => {
    if (session !== camSession || !camOpen()) return;
    const now = performance.now();
    if (camVideo.readyState >= 2 && now > lastTs) {
      lastTs = now;
      let res = null;
      try {
        res = detector.detectForVideo(camVideo, now);
      } catch {
        res = null;
      }
      const face = res && res.faceLandmarks && res.faceLandmarks[0];
      const shapes = res && res.faceBlendshapes && res.faceBlendshapes[0];
      const jawCat = shapes && shapes.categories.find((c) => c.categoryName === 'jawOpen');
      const jaw = jawCat ? jawCat.score : 0;
      camMeter.style.width = `${Math.min(1, jaw / JAW_OPEN) * 100}%`;
      if (!face) camNote.textContent = 'Where is your face? 🤨';
      else if (jaw > JAW_OPEN * 0.4) camNote.textContent = 'WIDER 😮';
      else camNote.textContent = 'Waiting for that mouth…';
      streak = face && jaw >= JAW_OPEN ? streak + 1 : 0;
      if (streak >= 4) {
        snapMeme(face);
        return;
      }
    }
    if (now - started > 20000) {
      snapMeme(null); // too shy: snap anyway
      return;
    }
    camLoop = requestAnimationFrame(step);
  };
  camLoop = requestAnimationFrame(step);
}

function closeCam() {
  camSession += 1;
  cancelAnimationFrame(camLoop);
  if (camStream) camStream.getTracks().forEach((t) => t.stop());
  camStream = null;
  camVideo.srcObject = null;
  camOverlay.classList.add('hidden');
}

camClose.addEventListener('click', closeCam);

// ---- The meme: grab the frame, deep-fry it, pop it up with chaos flying around.
const memeOverlay = document.getElementById('meme');
const memeImg = document.getElementById('meme-img');
const memeClose = document.getElementById('meme-close');
const flyersEl = document.getElementById('flyers');
const MEME_TOP = ['WHEN YOU WIN WORD BOMB', 'CERTIFIED BRAINROT CHAMPION', 'SKIBIDI WINNER', 'THE GOAT HAS SPOKEN', 'POV: YOU WON'];
const MEME_BOTTOM = ['AND OPEN YOUR MOUTH', 'SHEESH', '+1000 AURA', 'NO CAP 🧢', 'BUSSIN FR', 'OHIO FINAL BOSS'];
const STICKERS = ['😂', '🔥', '💯', '👌', '😳', '💀', '🤣', '🗿', '🚨', '‼️', '🥶', '👑'];
const FLY_TEXT = ['+1000 AURA', 'SHEESH', 'WOW', 'MLG', 'GG EZ', 'SIGMA', 'RIZZ', 'OHIO', 'W', 'NO CAP', 'BUSSIN', '360 NOSCOPE', 'GOATED', 'SKIBIDI'];
let flyTimer = null;

function memeOpen() {
  return !memeOverlay.classList.contains('hidden');
}

function snapMeme(face) {
  const w = camVideo.videoWidth || 640;
  const h = camVideo.videoHeight || 480;
  const shot = document.createElement('canvas');
  shot.width = w;
  shot.height = h;
  const g = shot.getContext('2d');
  g.translate(w, 0);
  g.scale(-1, 1); // mirror, to match what they saw
  g.drawImage(camVideo, 0, 0, w, h);
  const pt = (i) => (face && face[i] ? { x: (1 - face[i].x) * w, y: face[i].y * h } : null);
  const avg = (a, b) => (a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null);
  const marks = face ? {
    mouth: avg(pt(13), pt(14)),
    mouthWidth: pt(61) && pt(291) ? Math.hypot(pt(61).x - pt(291).x, pt(61).y - pt(291).y) : w * 0.15,
    eyes: face.length > 473 ? [pt(468), pt(473)] : [avg(pt(33), pt(133)), avg(pt(362), pt(263))],
  } : null;
  closeCam();
  airhorn();
  deepFry(shot, marks).then(showMeme);
}

function bulge(g, cx, cy, r, power) {
  const x0 = Math.max(0, Math.floor(cx - r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const bw = Math.min(g.canvas.width, Math.ceil(cx + r)) - x0;
  const bh = Math.min(g.canvas.height, Math.ceil(cy + r)) - y0;
  if (bw <= 0 || bh <= 0) return;
  const img = g.getImageData(x0, y0, bw, bh);
  const src = new Uint8ClampedArray(img.data);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const dx = x + x0 - cx;
      const dy = y + y0 - cy;
      const d = Math.hypot(dx, dy);
      if (d >= r) continue;
      const f = Math.pow(d / r, power - 1); // sample closer to the middle = magnify
      const sx = Math.min(bw - 1, Math.max(0, Math.round(cx + dx * f - x0)));
      const sy = Math.min(bh - 1, Math.max(0, Math.round(cy + dy * f - y0)));
      const di = (y * bw + x) * 4;
      const si = (sy * bw + sx) * 4;
      img.data[di] = src[si];
      img.data[di + 1] = src[si + 1];
      img.data[di + 2] = src[si + 2];
    }
  }
  g.putImageData(img, x0, y0);
}

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.src = url;
  });
}

function memeText(g, text, y, size) {
  g.font = `900 ${size}px Impact, "Arial Black", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = Math.max(4, size / 8);
  g.strokeStyle = '#000';
  g.fillStyle = '#fff';
  g.strokeText(text, g.canvas.width / 2, y, g.canvas.width * 0.94);
  g.fillText(text, g.canvas.width / 2, y, g.canvas.width * 0.94);
}

async function deepFry(shot, marks) {
  const w = shot.width;
  const h = shot.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const g = out.getContext('2d', { willReadFrequently: true });

  // 1. Oversaturate everything.
  g.filter = 'saturate(380%) contrast(190%) brightness(108%)';
  g.drawImage(shot, 0, 0);
  g.filter = 'none';

  // 2. Big mouth bulge (or the middle of the frame if no face was found).
  const mouth = marks && marks.mouth ? marks.mouth : { x: w / 2, y: h * 0.62 };
  const mr = marks ? marks.mouthWidth * 1.6 : w * 0.2;
  bulge(g, mouth.x, mouth.y, mr, 1.9);

  // 3. Grain + red push.
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 70;
    d[i] = d[i] * 1.12 + n + 10;
    d[i + 1] = d[i + 1] + n;
    d[i + 2] = d[i + 2] * 0.85 + n;
  }
  g.putImageData(img, 0, 0);

  // 4. Laser eyes.
  const eyes = marks ? marks.eyes.filter(Boolean) : [];
  for (const eye of eyes) {
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.shadowColor = '#ff0000';
    g.shadowBlur = 30;
    g.strokeStyle = 'rgba(255, 40, 20, 0.9)';
    g.lineCap = 'round';
    for (let k = 0; k < 2; k++) {
      const ang = (Math.random() - 0.5) * 1.2 + (eye.x < w / 2 ? Math.PI : 0);
      g.lineWidth = 10 + k * 8;
      g.beginPath();
      g.moveTo(eye.x, eye.y);
      g.lineTo(eye.x + Math.cos(ang) * w * 1.5, eye.y + Math.sin(ang) * w * 1.5);
      g.stroke();
    }
    const glow = g.createRadialGradient(eye.x, eye.y, 0, eye.x, eye.y, w * 0.07);
    glow.addColorStop(0, 'rgba(255,255,255,1)');
    glow.addColorStop(0.3, 'rgba(255,60,30,0.95)');
    glow.addColorStop(1, 'rgba(255,0,0,0)');
    g.fillStyle = glow;
    g.beginPath();
    g.arc(eye.x, eye.y, w * 0.07, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  // 5. Emoji stickers.
  for (let i = 0; i < 9; i++) {
    g.save();
    g.translate(randInt(0, w), randInt(0, h));
    g.rotate((Math.random() - 0.5) * 1.4);
    g.font = `${randInt(Math.round(w * 0.06), Math.round(w * 0.13))}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(pick(STICKERS), 0, 0);
    g.restore();
  }

  // 6. Impact font captions.
  const size = Math.round(h * 0.11);
  memeText(g, pick(MEME_TOP), size * 0.75, size);
  memeText(g, pick(MEME_BOTTOM), h - size * 0.75, size);

  // 7. Crush it with awful JPEG quality, twice.
  for (let k = 0; k < 2; k++) {
    const crushed = await loadImage(out.toDataURL('image/jpeg', 0.1));
    g.drawImage(crushed, 0, 0);
  }
  return out;
}

function showMeme(canvas) {
  memeImg.src = canvas.toDataURL('image/jpeg', 0.7);
  memeOverlay.classList.remove('hidden');
  memeClose.focus();
  document.body.classList.add('flash');
  setTimeout(() => document.body.classList.remove('flash'), 300);
  clearInterval(flyTimer);
  flyTimer = setInterval(spawnFlyer, 90);
  for (let i = 0; i < 25; i++) spawnFlyer();
}

function spawnFlyer() {
  if (flyersEl.childElementCount > 120) return;
  const el = document.createElement('span');
  const isText = Math.random() < 0.35;
  el.className = isText ? 'flyer flyer-text' : 'flyer';
  el.textContent = isText ? pick(FLY_TEXT) : pick(STICKERS);
  if (isText) el.style.color = `hsl(${randInt(0, 360)}, 100%, 60%)`;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Start off one edge, fly through the screen to somewhere random.
  const side = randInt(0, 3);
  const sx = side === 0 ? -80 : side === 1 ? vw + 80 : randInt(0, vw);
  const sy = side === 2 ? -80 : side === 3 ? vh + 80 : randInt(0, vh);
  el.style.left = `${sx}px`;
  el.style.top = `${sy}px`;
  el.style.fontSize = `${randInt(isText ? 18 : 28, isText ? 44 : 72)}px`;
  el.style.setProperty('--dx', `${randInt(0, vw) - sx}px`);
  el.style.setProperty('--dy', `${randInt(0, vh) - sy}px`);
  el.style.setProperty('--rot', `${randInt(-720, 720)}deg`);
  el.style.animationDuration = `${(1.4 + Math.random() * 2).toFixed(2)}s`;
  el.addEventListener('animationend', () => el.remove());
  flyersEl.appendChild(el);
}

function closeMeme() {
  clearInterval(flyTimer);
  flyTimer = null;
  flyersEl.replaceChildren();
  memeOverlay.classList.add('hidden');
  memeImg.removeAttribute('src');
}

memeClose.addEventListener('click', closeMeme);

function airhorn() {
  if (!soundOn) return;
  const c = ctx();
  const blasts = [[0, 0.22], [0.3, 0.22], [0.6, 0.7]];
  for (const [delay, dur] of blasts) {
    const t0 = c.currentTime + delay;
    for (const freq of [415, 420, 622, 830]) {
      const osc = c.createOscillator();
      const amp = c.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq * 0.92, t0);
      osc.frequency.linearRampToValueAtTime(freq, t0 + 0.05);
      amp.gain.setValueAtTime(0.0001, t0);
      amp.gain.linearRampToValueAtTime(0.035, t0 + 0.03);
      amp.gain.setValueAtTime(0.035, t0 + dur - 0.05);
      amp.gain.linearRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(amp);
      amp.connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    }
  }
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
  if (next.phase !== 'ended') {
    hideWin();
    if (camOpen()) closeCam();
    if (memeOpen()) closeMeme();
  }
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
      renderNet(msg.ips, msg.port, msg.url);
      return;
    }
    if (msg.t === 'url') {
      renderNet(lastNet.ips, lastNet.port, msg.url);
      return;
    }
    if (msg.t === 'state') return onState(msg);
    if (msg.t === 'popup' || msg.t === 'popclose' || msg.t === 'popwrong') return onPopupMessage(msg);
    if (msg.t === 'picked') {
      // The winner picked you: your own camera opens, on your screen.
      hideWin();
      if (memeOpen()) closeMeme();
      if (camOpen()) closeCam();
      openCam({ caption: `${msg.by} picked you 😈 Open your mouth`, canPick: false });
      return;
    }
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
  if (memeOpen()) {
    if (ev.key === 'Enter' || ev.key === 'Escape') {
      ev.preventDefault();
      if (!ev.repeat) closeMeme();
    }
    return;
  }
  if (camOpen()) {
    if (ev.key === 'Enter' || ev.key === 'Escape') {
      ev.preventDefault();
      if (!ev.repeat) closeCam();
    }
    return;
  }
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