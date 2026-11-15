'use strict';

(() => {
  const displayOnly = new URLSearchParams(location.search).get('display') === '1';
  const banner = document.createElement('div');
  banner.className = 'room-banner';
  document.querySelector('.brand').appendChild(banner);
  const popup = document.createElement('div');
  popup.className = 'meme-popup';
  popup.hidden = true;
  popup.setAttribute('role', 'status');
  document.body.appendChild(popup);
  const timer = document.createElement('p');
  timer.className = 'brainrot-timer';
  document.querySelector('.core').appendChild(timer);
  const reactions = ['CERTIFIED YAPPER 🗣️', 'THE RIZZLER HAS SPOKEN 😭', 'ABSOLUTE CINEMA 🎬', 'AURA FARMING DETECTED ✨', 'LET THEM COOK 🔥', 'CHAT, IS THIS REAL? 💀'];
  let previous, latest, popupTimer;
  let clockOffset = 0;

  function showPopup(text) {
    clearTimeout(popupTimer);
    popup.textContent = text;
    popup.hidden = false;
    popupTimer = setTimeout(() => { popup.hidden = true; }, 1400);
  }

  if (displayOnly) {
    document.querySelector('footer').hidden = true;
    document.getElementById('rename').hidden = true;
    document.querySelector('body > header').insertAdjacentHTML('beforeend', '<p class="display-help">Phones: open the laptop’s network address shown in its terminal. First player controls Start.</p>');
  }

  window.addEventListener('brainrot-state', ({ detail: state }) => {
    latest = state;
    clockOffset = state.serverNow - Date.now();
    banner.textContent = `ROOM ${state.roomCode} · 5 seats`;
    if (displayOnly && state.phase === 'lobby') {
      document.getElementById('sub').textContent = 'Join from your phone. First player controls Start.';
    }
    const leaderboard = document.getElementById('leaderboard');
    leaderboard.replaceChildren();
    for (const player of [...state.players].sort((a, b) => b.aura - a.aura)) {
      const row = document.createElement('li');
      row.textContent = `${player.name}: ${player.aura} aura`;
      leaderboard.appendChild(row);
    }
    if (previous && previous.round === state.round) {
      if (state.boom && state.boom.at !== previous.boom?.at) showPopup('−100 AURA. BRO IS COOKED 💀');
      else if (state.passes > previous.passes) showPopup(reactions[Math.floor(Math.random() * reactions.length)]);
    }
    previous = state;
  });

  setInterval(() => {
    timer.textContent = latest?.phase === 'playing'
      ? `${Math.max(0, (latest.deadline - Date.now() - clockOffset) / 1000).toFixed(1)}s`
      : '';
  }, 100);
})();
