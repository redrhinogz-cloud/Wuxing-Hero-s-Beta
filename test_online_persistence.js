'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PORT = 18081 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxing-v051-'));

let child = null;
function startServer() {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', WUXING_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', d => process.stderr.write(d));
  return child;
}
async function waitHealth() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 75));
  }
  throw new Error('server did not start');
}
async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const p = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([p, new Promise(r => setTimeout(r, 2500))]);
}
async function req(url, options = {}, auth = null) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (auth) { headers['X-Profile-Id'] = auth.id; headers['X-Profile-Token'] = auth.token; }
  const r = await fetch(`${BASE}${url}`, { ...options, headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status}: ${data.error || 'request failed'}`);
  return data;
}
async function create(name, progress = {}) {
  const data = await req('/api/profile/create', { method: 'POST', body: JSON.stringify({ name, progress }) });
  return { id: data.profile.id, token: data.token, recoveryCode: data.recoveryCode, profile: data.profile };
}

(async () => {
  try {
    startServer(); await waitHealth();
    const a = await create('WukongMain', { wuxing_story_wukong_completed: '1', wuxing_story_unknown_completed: '1' });
    const b = await create('NezhaGuest', { wuxing_story_nezha_completed: '1' });
    assert.equal(a.profile.progress.wuxing_story_wukong_completed, '1');

    const created = await req('/api/rooms', { method: 'POST', body: JSON.stringify({ side: 'UNKNOWN' }) }, a);
    const code = created.code;
    await req(`/api/rooms/${code}/join`, { method: 'POST', body: JSON.stringify({ side: 'FIRE' }) }, b);
    await req(`/api/rooms/${code}/ready`, { method: 'POST', body: JSON.stringify({ ready: true, side: 'UNKNOWN' }) }, a);
    await req(`/api/rooms/${code}/ready`, { method: 'POST', body: JSON.stringify({ ready: true, side: 'FIRE' }) }, b);
    let av = await req(`/api/rooms/${code}/state`, {}, a);
    assert.equal(av.status, 'GAME');
    assert.equal(av.state.phase, 'MULLIGAN');
    assert.equal(av.state.players[0].side, 'UNKNOWN');
    assert.equal(av.state.players[1].side, 'FIRE');
    assert.ok(av.state.players[0].hand.length > 0);
    assert.equal(av.state.players[1].hand.length, 0, 'opponent hand must remain hidden');

    await req(`/api/rooms/${code}/mulligan`, { method: 'POST', body: JSON.stringify({ cardUids: [] }) }, a);
    await req(`/api/rooms/${code}/mulligan`, { method: 'POST', body: JSON.stringify({ cardUids: [] }) }, b);
    av = await req(`/api/rooms/${code}/state`, {}, a);
    assert.notEqual(av.state.phase, 'MULLIGAN');

    await req('/api/profile/progress', { method: 'PUT', body: JSON.stringify({ progress: { wuxing_story_nezha_secret_completed: '1' } }) }, a);
    await stopServer();

    startServer(); await waitHealth();
    const pa = await req('/api/profile', {}, a);
    assert.equal(pa.profile.progress.wuxing_story_wukong_completed, '1');
    assert.equal(pa.profile.progress.wuxing_story_nezha_secret_completed, '1');
    assert.equal(pa.profile.activeRoom, code);
    const resumed = await req(`/api/rooms/${code}/state`, {}, a);
    assert.equal(resumed.status, 'GAME');
    assert.equal(resumed.state.players[0].side, 'UNKNOWN');
    assert.ok(['SUMMON', 'ATTACK'].includes(resumed.state.phase));

    const restored = await req('/api/profile/restore', { method: 'POST', body: JSON.stringify({ profileId: a.id, recoveryCode: a.recoveryCode }) });
    assert.equal(restored.profile.id, a.id);
    assert.ok(restored.token && restored.token !== a.token);

    console.log('v0.51 online persistence tests passed');
  } finally {
    await stopServer().catch(() => {});
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
