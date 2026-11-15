'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const WebSocket = require('ws');
const port = 3197;
const server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), ROOM_CODE: 'TEST67' } });
const sockets = [];
let output = '';
server.stdout.on('data', data => { output += data; });
server.stderr.on('data', data => { output += data; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (fn()) return; await delay(20); }
  throw new Error('Timed out: ' + output);
}
async function client(message) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  sockets.push(ws);
  ws.messages = [];
  ws.on('message', data => {
    const msg = JSON.parse(data);
    ws.messages.push(msg);
    if (msg.t === 'state') ws.state = msg;
    if (msg.t === 'hello') ws.hello = msg;
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify(message));
  return ws;
}
(async () => {
  await until(() => output.includes('Room code: TEST67'));
  const page = await fetch(`http://localhost:${port}/?display=1`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /brainrot.js/);
  const display = await client({ t: 'watch' });
  await until(() => display.state);
  assert.equal(display.state.players.length, 0);
  const wrong = await client({ t: 'join', name: 'Wrong', room: 'BAD' });
  await until(() => wrong.messages.some(m => m.t === 'error'));
  const players = [];
  for (let i = 0; i < 5; i++) {
    const ws = await client({ t: 'join', name: `Player ${i}`, room: 'TEST67' });
    await until(() => ws.hello);
    players.push(ws);
  }
  await until(() => display.state.players.length === 5);
  const extra = await client({ t: 'join', name: 'Sixth', room: 'TEST67' });
  await until(() => extra.messages.some(m => m.t === 'error' && m.message.includes('full')));
  const token = players[4].hello.token;
  const id = players[4].hello.id;
  players[4].close();
  await until(() => display.state.players.find(p => p.id === id)?.connected === false);
  players[4] = await client({ t: 'join', name: 'Reconnected', room: 'TEST67', token });
  await until(() => players[4].hello);
  assert.equal(players[4].hello.id, id);
  assert.equal(display.state.players.length, 5);
  players[0].send(JSON.stringify({ t: 'join', name: 'Host', room: 'TEST67' }));
  await delay(80);
  assert.equal(display.state.players.length, 5);
  players[0].send(JSON.stringify({ t: 'start' }));
  await until(() => display.state.phase === 'playing');
  const words = fs.readFileSync('data/words.txt', 'utf8').split(/\r?\n/).map(w => w.trim().toLowerCase());
  const slang = new Set(fs.readFileSync('data/stupid.txt', 'utf8').split(/\r?\n/).map(w => w.trim().toLowerCase()));
  let checkedSlang = false;
  // Sample turns until a brainrot word matches a prompt; normal answers keep the round moving.
  for (let turn = 0; turn < 50 && !checkedSlang; turn++) {
    const state = display.state;
    const active = players.find(ws => ws.hello.id === state.currentId);
    const word = [...slang].find(w => w.length >= 3 && w.length <= 15 && w.includes(state.prompt) && !state.used.includes(w)) || words.find(w => /^[a-z]{3,15}$/.test(w) && /[aeiouy]/.test(w) && w.includes(state.prompt) && !state.used.includes(w));
    assert.ok(word);
    const prior = state.players.find(p => p.id === state.currentId).aura;
    active.send(JSON.stringify({ t: 'word', word }));
    await until(() => display.state.passes > state.passes);
    const earned = slang.has(word) ? 67 : 10;
    assert.equal(display.state.players.find(p => p.id === state.currentId).aura, prior + earned);
    if (slang.has(word)) checkedSlang = true;
    await delay(80);
  }
  assert.ok(checkedSlang, 'Brainrot answer was accepted and earned 67 aura');
  const current = display.state;
  await until(() => display.state.boom?.id === current.currentId, 15000);
  assert.equal(display.state.players.find(p => p.id === current.currentId).aura, current.players.find(p => p.id === current.currentId).aura - 100);
  console.log('PASS: HTTP, spectator, room code, five players, sixth rejected, reconnect, repeated join, dictionary answers, brainrot bonus, timeout penalty');
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => {
  for (const ws of sockets) ws.terminate();
  server.kill();
});
