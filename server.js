'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JsonStore } = require('./storage');
const DATA = require('./public/data.js');
const { WuxingGame } = require('./public/engine.js');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.WUXING_DATA_DIR || path.join(__dirname, 'server-data');
const STORE_FILE = path.join(DATA_DIR, 'wuxing-online-state.json');
const ROOM_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const COMPLETE_ROOM_MS = 24 * 60 * 60 * 1000;

const store = new JsonStore(STORE_FILE);
const rooms = new Map();
let db = null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => Date.now();
const hashSecret = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

function profileId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = 'WH-';
  for (let i = 0; i < 10; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}
function recoveryCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const chunks = [];
  for (let c = 0; c < 4; c++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += alphabet[crypto.randomInt(alphabet.length)];
    chunks.push(s);
  }
  return chunks.join('-');
}
function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return code;
}
function sanitizeName(name, fallback = 'Player') {
  const s = String(name || '').trim().replace(/[<>]/g, '').slice(0, 24);
  return s || fallback;
}
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
async function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function requestProfileCredentials(req, url) {
  return {
    id: req.headers['x-profile-id'] || url.searchParams.get('profile') || '',
    token: req.headers['x-profile-token'] || url.searchParams.get('token') || ''
  };
}
function authorizeProfile(req, url) {
  const cred = requestProfileCredentials(req, url);
  const p = db.profiles[cred.id];
  if (!p || !cred.token || p.tokenHash !== hashSecret(cred.token)) return null;
  p.lastSeenAt = now();
  return p;
}
function publicProfile(p) {
  return {
    id: p.id,
    name: p.name,
    progress: { ...(p.progress || {}) },
    activeRoom: p.activeRoom || null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    lastSeenAt: p.lastSeenAt
  };
}

function isProgressKey(key) {
  return /^wuxing_(?:story_.+_(?:completed|secret_completed|secret_alt_completed)|story_playmat_unlocked|all_main_stories_playmat_unlocked|unknown_story_unlocked|sovereign_playmat_unlocked|mystery_o_alt_unlocked|.+_mystery_o_defeated)$/.test(String(key || ''));
}
function normalizeProgress(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!isProgressKey(key)) continue;
    if (value === '1' || value === 1 || value === true) out[key] = '1';
  }
  return out;
}
function mergeProgress(serverProgress, clientProgress) {
  return { ...normalizeProgress(serverProgress), ...normalizeProgress(clientProgress) };
}
function unknownDeckUnlocked(profile) {
  return profile?.progress?.wuxing_story_unknown_completed === '1';
}
function validSide(side, profile) {
  const s = String(side || '').toUpperCase();
  if (['EARTH', 'FIRE', 'WOOD', 'METAL', 'WATER'].includes(s)) return s;
  if (s === 'UNKNOWN' && unknownDeckUnlocked(profile)) return s;
  return 'EARTH';
}

function maxInstanceNumber(value, current = 0) {
  if (!value) return current;
  if (Array.isArray(value)) {
    for (const v of value) current = maxInstanceNumber(v, current);
    return current;
  }
  if (typeof value !== 'object') return current;
  if (typeof value.uid === 'string') {
    const m = value.uid.match(/^c(\d+)$/);
    if (m) current = Math.max(current, Number(m[1]));
  }
  for (const v of Object.values(value)) current = maxInstanceNumber(v, current);
  return current;
}

function decisionOptionCards(cards, game) {
  return (cards || []).map(c => cardView(c, game));
}
function createDecision(room, type, prompt, playerId, options, mapper, allowPass = false, meta = null) {
  return new Promise(resolve => {
    const id = crypto.randomUUID();
    room.pendingDecision = { id, type, prompt, playerId, options, allowPass, meta, createdAt: now() };
    room.decisionResolver = value => {
      const pending = room.pendingDecision;
      if (!pending || pending.id !== id) return false;
      let mapped;
      try { mapped = mapper(value); } catch { return false; }
      room.pendingDecision = null;
      room.decisionResolver = null;
      notify(room);
      resolve(mapped);
      return true;
    };
    notify(room);
  });
}
function decisionProvider(room) {
  return {
    yesNo: async (prompt, _game, playerId) => createDecision(room, 'YES_NO', prompt, playerId, [], value => value === true || value === 'yes'),
    chooseCard: async (prompt, cards, game, playerId) => createDecision(room, 'CHOOSE_CARD', prompt, playerId, decisionOptionCards(cards, game), value => cards.find(c => c.uid === value) || null),
    chooseSlot: async (prompt, slots, _game, playerId) => createDecision(room, 'CHOOSE_SLOT', prompt, playerId, slots.map(s => ({ slot: s, label: `Creature ${s + 1}` })), value => {
      const n = Number(value); return slots.includes(n) ? n : null;
    }),
    chooseCreature: async (prompt, cards, game, playerId) => createDecision(room, 'CHOOSE_CREATURE', prompt, playerId, decisionOptionCards(cards, game), value => cards.find(c => c.uid === value) || null),
    chooseAmbush: async (prompt, cards, game, playerId, meta) => createDecision(room, 'CHOOSE_AMBUSH', prompt, playerId, decisionOptionCards(cards, game), value => {
      if (value === null || value === '' || value === 'PASS') return null;
      return cards.find(c => c.uid === value) || null;
    }, true, meta),
    viewCards: async (prompt, cards, game, playerId) => createDecision(room, 'VIEW_CARDS', prompt, playerId, decisionOptionCards(cards, game), () => true, false, { reveal: true }),
    attackDeclared: async () => { notify(room); await sleep(700); }
  };
}

function attachGame(room, state) {
  const game = new WuxingGame(DATA, decisionProvider(room));
  game.state = state;
  game.instanceCounter = maxInstanceNumber(state, 0) + 1;
  game.onLog(() => notify(room));
  game.onAttack(() => notify(room));
  game.onEvent(() => notify(room));
  room.game = game;
  return game;
}

function serializeRoom(room) {
  return {
    code: room.code,
    players: room.players.map(p => p ? ({
      playerId: p.playerId,
      profileId: p.profileId,
      name: p.name,
      side: p.side,
      ready: !!p.ready,
      closed: !!p.closed,
      lastSeenAt: p.lastSeenAt || null
    }) : null),
    status: room.status,
    stableState: room.stableState || (room.game ? room.game.snapshot() : null),
    error: room.error || null,
    revision: room.revision || 1,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt
  };
}
function reviveRoom(saved) {
  const room = {
    code: saved.code,
    players: (saved.players || [null, null]).map(p => p ? ({ ...p, connected: false }) : null),
    status: saved.status || 'LOBBY',
    game: null,
    stableState: saved.stableState || null,
    pendingDecision: null,
    decisionResolver: null,
    busy: false,
    error: saved.error || null,
    revision: Number(saved.revision || 1),
    streams: new Map(),
    createdAt: saved.createdAt || now(),
    updatedAt: saved.updatedAt || now()
  };
  if (room.stableState && ['GAME', 'COMPLETE'].includes(room.status)) attachGame(room, JSON.parse(JSON.stringify(room.stableState)));
  return room;
}
function persistWorld() {
  db.rooms = {};
  for (const [code, room] of rooms) db.rooms[code] = serializeRoom(room);
  return store.flush();
}
function touchProfile(profile) {
  profile.updatedAt = now();
}
function getRoom(code) { return rooms.get(String(code || '').toUpperCase()); }
function getPlayer(room, profileId) { return room.players.find(p => p && p.profileId === profileId) || null; }
function notify(room) {
  room.revision += 1;
  room.updatedAt = now();
  const data = `event: change\ndata: ${JSON.stringify({ revision: room.revision })}\n\n`;
  for (const [key, stream] of [...room.streams]) {
    try { stream.res.write(data); }
    catch { room.streams.delete(key); }
  }
}

function createRoom(profile, side) {
  let code;
  do { code = roomCode(); } while (rooms.has(code));
  const host = { playerId: 0, profileId: profile.id, name: profile.name, side: validSide(side, profile), ready: false, closed: false, connected: false, lastSeenAt: now() };
  const room = {
    code,
    players: [host, null],
    status: 'LOBBY',
    game: null,
    stableState: null,
    pendingDecision: null,
    decisionResolver: null,
    busy: false,
    error: null,
    revision: 1,
    streams: new Map(),
    createdAt: now(),
    updatedAt: now()
  };
  rooms.set(code, room);
  profile.activeRoom = code;
  touchProfile(profile);
  return room;
}
function startGame(room) {
  if (room.status !== 'LOBBY') return false;
  if (!room.players[0] || !room.players[1] || !room.players.every(p => p.ready)) return false;
  room.status = 'GAME';
  room.pendingDecision = null;
  room.decisionResolver = null;
  room.error = null;
  const game = new WuxingGame(DATA, decisionProvider(room));
  game.onLog(() => notify(room));
  game.onAttack(() => notify(room));
  game.onEvent(() => notify(room));
  game.newGame({
    mode: 'HOTSEAT',
    playerSide: room.players[0].side,
    opponentSide: room.players[1].side,
    playerName: room.players[0].name,
    opponentName: room.players[1].name,
    deferFirstTurn: true
  });
  room.game = game;
  room.stableState = game.snapshot();
  notify(room);
  return true;
}

function cardView(inst, game, extra = {}) {
  if (!inst) return null;
  let currentStrength = null;
  try { if (game && game.isCreatureCard(inst)) currentStrength = game.strength(inst, { attacking: false }); } catch {}
  return {
    uid: inst.uid,
    cardId: inst.cardId,
    owner: inst.owner,
    controller: inst.controller,
    zone: inst.zone,
    damage: inst.damage || 0,
    currentStrength,
    tempStrength: Array.isArray(inst.tempStrength) ? inst.tempStrength.map(x => ({ ...x })) : [],
    attackedThisTurn: !!inst.attackedThisTurn,
    attacksUsed: inst.attacksUsed || 0,
    bonusAttacks: inst.bonusAttacks || 0,
    cannotAttackTurn: inst.cannotAttackTurn,
    suppressedTurn: inst.suppressedTurn,
    directAttackTurn: inst.directAttackTurn,
    isHero: !!inst.isHero,
    restrainedUntilTurnSerial: inst.restrainedUntilTurnSerial,
    banishTurnsRemaining: inst.banishTurnsRemaining,
    banishUntilStartPlayerId: inst.banishUntilStartPlayerId,
    equipment: (inst.equipment || []).map(e => cardView(e, game)),
    ...extra
  };
}
function lobbyView(room, profile) {
  const self = getPlayer(room, profile.id);
  return {
    code: room.code,
    status: room.status,
    revision: room.revision,
    you: self ? { playerId: self.playerId, profileId: self.profileId, name: self.name, side: self.side, ready: self.ready } : null,
    players: room.players.map(p => p ? ({ playerId: p.playerId, name: p.name, side: p.side, ready: !!p.ready, connected: !!p.connected }) : null)
  };
}
function gameView(room, profile) {
  const self = getPlayer(room, profile.id);
  if (!self || !room.game) return lobbyView(room, profile);
  const game = room.game;
  const state = game.state;
  const players = state.players.map((p, i) => {
    const mine = i === self.playerId;
    return {
      id: p.id,
      name: p.name,
      side: p.side,
      life: p.life,
      mastery: p.mastery,
      hero: mine ? cardView(p.hero, game, { playable: game.canPlayHero(i) }) : (p.hero ? { hidden: true, side: p.side } : null),
      environment: cardView(p.environment, game),
      creatures: p.creatures.map(c => c ? cardView(c, game, {
        canAttack: mine ? game.canAttack(c) : false,
        canDirectAttack: mine ? game.canDirectAttack(c) : false,
        canUseAbility: mine ? game.canUseCreatureAbility(i, c) : false
      }) : null),
      hand: mine ? p.hand.map(c => cardView(c, game, { playable: game.canPlayFromHand(i, c) })) : [],
      handCount: p.hand.length,
      deckCount: p.deck.length,
      underworld: p.underworld.map(c => cardView(c, game)),
      banish: p.banish.map(c => cardView(c, game)),
      connected: !!room.players[i]?.connected
    };
  });
  let pendingDecision = null;
  if (room.pendingDecision) {
    if (room.pendingDecision.playerId === self.playerId) {
      pendingDecision = {
        id: room.pendingDecision.id,
        type: room.pendingDecision.type,
        prompt: room.pendingDecision.prompt,
        options: room.pendingDecision.options,
        allowPass: room.pendingDecision.allowPass,
        meta: room.pendingDecision.meta
      };
    } else pendingDecision = { waitingForOpponent: true };
  }
  return {
    code: room.code,
    status: room.status,
    revision: room.revision,
    you: { playerId: self.playerId, profileId: self.profileId, name: self.name, side: self.side },
    players: room.players.map(p => p ? ({ playerId: p.playerId, name: p.name, side: p.side, ready: !!p.ready, connected: !!p.connected }) : null),
    busy: room.busy,
    error: room.error,
    pendingDecision,
    state: {
      activePlayer: state.activePlayer,
      phase: state.phase,
      turnNumber: state.turnNumber,
      turnSerial: state.turnSerial,
      winner: state.winner,
      dice: state.dice,
      currentAttack: state.currentAttack,
      mulliganDone: state.mulliganDone || [true, true],
      setupComplete: !!state.setupComplete,
      log: state.log.slice(-180),
      players
    }
  };
}
function stateView(room, profile) {
  return ['GAME', 'COMPLETE'].includes(room.status) ? gameView(room, profile) : lobbyView(room, profile);
}

function finalizeIfWinner(room) {
  if (!room.game || room.game.state.winner === null) return;
  room.status = 'COMPLETE';
  room.stableState = room.game.snapshot();
}
function runTask(room, fn) {
  if (room.busy) return false;
  room.busy = true;
  room.error = null;
  notify(room);
  Promise.resolve()
    .then(fn)
    .then(() => {
      if (room.game) room.stableState = room.game.snapshot();
      finalizeIfWinner(room);
    })
    .catch(err => {
      console.error(`[${room.code}] task error`, err);
      room.error = err && err.message ? err.message : String(err);
      if (room.stableState && room.game) attachGame(room, JSON.parse(JSON.stringify(room.stableState)));
    })
    .finally(async () => {
      room.busy = false;
      notify(room);
      await persistWorld();
    });
  return true;
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
    '.json':'application/json; charset=utf-8', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.webp':'image/webp',
    '.svg':'image/svg+xml', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.txt':'text/plain; charset=utf-8', '.md':'text/markdown; charset=utf-8'
  })[ext] || 'application/octet-stream';
}
function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const requested = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!requested.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(requested, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': contentType(requested),
      'Cache-Control': requested.endsWith('.html') || requested.endsWith('.js') ? 'no-store' : 'public, max-age=3600'
    });
    fs.createReadStream(requested).pipe(res);
  });
}

async function handleProfileApi(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/profile/create') {
    const body = await readJson(req);
    let id;
    do { id = profileId(); } while (db.profiles[id]);
    const token = randomToken();
    const recovery = recoveryCode();
    const p = {
      id,
      name: sanitizeName(body.name, 'Player'),
      tokenHash: hashSecret(token),
      recoveryHash: hashSecret(recovery.toUpperCase()),
      progress: normalizeProgress(body.progress),
      activeRoom: null,
      createdAt: now(), updatedAt: now(), lastSeenAt: now()
    };
    db.profiles[id] = p;
    await persistWorld();
    return json(res, 201, { profile: publicProfile(p), token, recoveryCode: recovery });
  }

  if (req.method === 'POST' && url.pathname === '/api/profile/restore') {
    const body = await readJson(req);
    const id = String(body.profileId || '').trim().toUpperCase();
    const p = db.profiles[id];
    if (!p || p.recoveryHash !== hashSecret(String(body.recoveryCode || '').trim().toUpperCase())) return json(res, 401, { error: 'Profile ID or recovery code is incorrect.' });
    const token = randomToken();
    p.tokenHash = hashSecret(token);
    p.name = sanitizeName(body.name || p.name, p.name);
    p.lastSeenAt = now();
    touchProfile(p);
    await persistWorld();
    return json(res, 200, { profile: publicProfile(p), token });
  }

  const profile = authorizeProfile(req, url);
  if (!profile) return json(res, 401, { error: 'Online profile authentication failed.' });

  if (req.method === 'GET' && url.pathname === '/api/profile') return json(res, 200, { profile: publicProfile(profile) });

  if (req.method === 'PUT' && url.pathname === '/api/profile/progress') {
    const body = await readJson(req);
    profile.progress = mergeProgress(profile.progress, body.progress);
    touchProfile(profile);
    await persistWorld();
    return json(res, 200, { profile: publicProfile(profile) });
  }

  if (req.method === 'PUT' && url.pathname === '/api/profile/name') {
    const body = await readJson(req);
    profile.name = sanitizeName(body.name, profile.name);
    touchProfile(profile);
    for (const room of rooms.values()) {
      const rp = getPlayer(room, profile.id);
      if (rp) rp.name = profile.name;
      if (room.game && rp) room.game.state.players[rp.playerId].name = profile.name;
    }
    await persistWorld();
    return json(res, 200, { profile: publicProfile(profile) });
  }

  return json(res, 404, { error: 'Not found' });
}

async function handleRoomApi(req, res, url) {
  const profile = authorizeProfile(req, url);
  if (!profile) return json(res, 401, { error: 'Online profile authentication failed.' });
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    if (profile.activeRoom) {
      const existing = getRoom(profile.activeRoom);
      if (existing && existing.status !== 'COMPLETE') return json(res, 409, { error: `You already have an active match in room ${existing.code}. Resume or leave that room first.`, activeRoom: existing.code });
      profile.activeRoom = null;
    }
    const body = await readJson(req);
    const room = createRoom(profile, body.side);
    await persistWorld();
    return json(res, 201, { code: room.code, playerId: 0 });
  }

  if (parts[0] !== 'api' || parts[1] !== 'rooms' || !parts[2]) return json(res, 404, { error: 'Not found' });
  const code = parts[2].toUpperCase();
  const room = getRoom(code);
  if (!room) return json(res, 404, { error: 'Room not found or expired.' });
  const op = parts[3] || '';

  if (req.method === 'POST' && op === 'join') {
    let self = getPlayer(room, profile.id);
    if (self) {
      profile.activeRoom = room.code; touchProfile(profile); await persistWorld();
      return json(res, 200, { code: room.code, playerId: self.playerId, resumed: true });
    }
    if (room.status !== 'LOBBY') return json(res, 409, { error: 'Match already started.' });
    if (room.players[1]) return json(res, 409, { error: 'Room is full.' });
    if (profile.activeRoom && profile.activeRoom !== room.code) {
      const other = getRoom(profile.activeRoom);
      if (other && other.status !== 'COMPLETE') return json(res, 409, { error: `You already have an active match in room ${other.code}.` });
    }
    const body = await readJson(req);
    const guest = { playerId: 1, profileId: profile.id, name: profile.name, side: validSide(body.side, profile), ready: false, closed: false, connected: false, lastSeenAt: now() };
    room.players[1] = guest;
    profile.activeRoom = room.code; touchProfile(profile);
    notify(room);
    await persistWorld();
    return json(res, 200, { code: room.code, playerId: 1 });
  }

  const self = getPlayer(room, profile.id);
  if (!self) return json(res, 403, { error: 'You are not a player in this room.' });
  self.lastSeenAt = now();

  if (req.method === 'GET' && op === 'state') return json(res, 200, stateView(room, profile));

  if (req.method === 'GET' && op === 'events') {
    const streamKey = `${profile.id}:${crypto.randomUUID()}`;
    self.connected = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`event: change\ndata: ${JSON.stringify({ revision: room.revision })}\n\n`);
    room.streams.set(streamKey, { res, profileId: profile.id });
    notify(room);
    const keepAlive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 20000);
    req.on('close', () => {
      clearInterval(keepAlive);
      room.streams.delete(streamKey);
      const stillConnected = [...room.streams.values()].some(s => s.profileId === profile.id);
      self.connected = stillConnected;
      notify(room);
    });
    return;
  }

  if (req.method === 'POST' && op === 'ready') {
    if (room.status !== 'LOBBY') return json(res, 409, { error: 'Match already started.' });
    const body = await readJson(req);
    self.side = validSide(body.side || self.side, profile);
    self.ready = body.ready !== false;
    notify(room);
    startGame(room);
    await persistWorld();
    return json(res, 200, { ok: true, started: room.status === 'GAME' });
  }

  if (req.method === 'POST' && op === 'mulligan') {
    if (room.status !== 'GAME' || !room.game) return json(res, 409, { error: 'Match has not started.' });
    if (room.game.state.phase !== 'MULLIGAN') return json(res, 409, { error: 'The mulligan is already complete.' });
    const body = await readJson(req);
    const ok = room.game.mulligan(self.playerId, Array.isArray(body.cardUids) ? body.cardUids : []);
    if (!ok) return json(res, 400, { error: 'Invalid mulligan selection.' });
    if (room.game.state.mulliganDone.every(Boolean)) room.game.beginAfterMulligans();
    room.stableState = room.game.snapshot();
    notify(room);
    await persistWorld();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && op === 'decision') {
    if (!room.pendingDecision || !room.decisionResolver) return json(res, 409, { error: 'No decision is pending.' });
    if (room.pendingDecision.playerId !== self.playerId) return json(res, 403, { error: 'That decision belongs to the other player.' });
    const body = await readJson(req);
    if (body.decisionId !== room.pendingDecision.id) return json(res, 409, { error: 'Decision is no longer current.' });
    const ok = room.decisionResolver(body.value);
    if (!ok) return json(res, 400, { error: 'Invalid decision value.' });
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && op === 'action') {
    if (room.status !== 'GAME' || !room.game) return json(res, 409, { error: 'Match has not started.' });
    if (room.game.state.phase === 'MULLIGAN') return json(res, 409, { error: 'Finish the mulligan first.' });
    if (room.pendingDecision) return json(res, 409, { error: 'A response decision is pending.' });
    if (room.busy) return json(res, 409, { error: 'The game is resolving another action.' });
    const body = await readJson(req);
    const game = room.game;
    const pid = self.playerId;
    let task;
    switch (body.type) {
      case 'PLAY_CARD': task = () => game.playCard(pid, String(body.uid || '')); break;
      case 'PLAY_HERO': task = () => game.playHero(pid); break;
      case 'USE_ABILITY': task = () => game.useCreatureAbility(pid, String(body.uid || '')); break;
      case 'NEXT_PHASE':
        if (pid !== game.state.activePlayer) return json(res, 403, { error: 'It is not your turn.' });
        task = () => game.nextPhase(); break;
      case 'ATTACK':
        if (pid !== game.state.activePlayer) return json(res, 403, { error: 'It is not your turn.' });
        task = () => game.attack(Number(body.attackerSlot), body.targetSlot === null || body.targetSlot === undefined ? null : Number(body.targetSlot), !!body.direct); break;
      default: return json(res, 400, { error: 'Unknown action.' });
    }
    if (!runTask(room, task)) return json(res, 409, { error: 'Game is busy.' });
    return json(res, 202, { ok: true });
  }

  if (req.method === 'POST' && op === 'forfeit') {
    if (!room.game || room.game.state.winner !== null) return json(res, 409, { error: 'This match is already complete.' });
    room.game.state.winner = self.playerId === 0 ? 1 : 0;
    room.game.log(`${room.game.state.players[self.playerId].name} forfeits the match. ${room.game.state.players[room.game.state.winner].name} wins.`);
    room.status = 'COMPLETE';
    room.stableState = room.game.snapshot();
    notify(room);
    await persistWorld();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && op === 'close') {
    self.closed = true;
    profile.activeRoom = null;
    touchProfile(profile);
    if (room.status === 'LOBBY') {
      room.players[self.playerId] = null;
      if (!room.players[0] && room.players[1]) {
        room.players[0] = { ...room.players[1], playerId: 0 };
        room.players[1] = null;
      }
      if (!room.players[0] && !room.players[1]) rooms.delete(room.code);
      else notify(room);
    } else notify(room);
    await persistWorld();
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Not found' });
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') return json(res, 200, { ok: true, rooms: rooms.size, version: '0.51' });
  if (url.pathname.startsWith('/api/profile')) return handleProfileApi(req, res, url);
  if (url.pathname.startsWith('/api/rooms')) return handleRoomApi(req, res, url);
  return json(res, 404, { error: 'Not found' });
}

async function cleanupRooms() {
  const t = now();
  let changed = false;
  for (const [code, room] of [...rooms]) {
    const limit = room.status === 'COMPLETE' ? COMPLETE_ROOM_MS : ROOM_IDLE_MS;
    if (t - room.updatedAt <= limit) continue;
    rooms.delete(code);
    for (const p of room.players) {
      if (!p) continue;
      const profile = db.profiles[p.profileId];
      if (profile && profile.activeRoom === code) { profile.activeRoom = null; touchProfile(profile); }
    }
    changed = true;
  }
  if (changed) await persistWorld();
}

async function main() {
  db = await store.init();
  for (const [code, saved] of Object.entries(db.rooms || {})) {
    try {
      const room = reviveRoom(saved);
      const limit = room.status === 'COMPLETE' ? COMPLETE_ROOM_MS : ROOM_IDLE_MS;
      if (now() - room.updatedAt <= limit) rooms.set(code, room);
    } catch (err) {
      console.warn(`Could not restore room ${code}:`, err.message);
    }
  }
  await cleanupRooms();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else serveStatic(req, res, url);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) json(res, 500, { error: err.message || 'Server error' });
      else res.end();
    }
  });

  setInterval(() => cleanupRooms().catch(console.error), 30 * 60 * 1000).unref();
  process.on('SIGINT', async () => { try { await persistWorld(); } finally { process.exit(0); } });
  process.on('SIGTERM', async () => { try { await persistWorld(); } finally { process.exit(0); } });

  server.listen(PORT, HOST, () => {
    console.log(`Wuxing Heroes Online v0.51 running on http://${HOST}:${PORT}`);
    console.log(`Persistent state: ${STORE_FILE}`);
  });
}

main().catch(err => { console.error(err); process.exit(1); });
