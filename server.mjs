// PokéBonk — local server.
// Serves the mirrored client, proxies+caches any asset the mirror is missing,
// and implements the client's HTTP API against a local JSON store.
import http from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  now, token, newProfile, newAccount, hashPassword, checkPassword,
  SEASON, EVENTS, seasonPayload, boardFor, json, body,
} from './firebase/shared.mjs';

const PORT = Number(process.env.PORT || 8080);
const UPSTREAM = 'https://pokebonk.com';
const ROOT = path.resolve(import.meta.dirname, 'public');
const DATA = path.resolve(import.meta.dirname, 'data');
const NET_ROOT = path.resolve(import.meta.dirname, 'net');
const FIREBASE_ROOT = path.resolve(import.meta.dirname, 'firebase');
const API_BASE_FROM = 'https://api.pokebonk.com';

// --firebase (or FIREBASE=true) routes /api through the stateless Firebase
// backend (Firebase Auth + Firestore + RTDB) instead of the JSON store.
const USE_FIREBASE = process.argv.includes('--firebase') || process.env.FIREBASE === 'true';

let firebaseMatch = null; // set when USE_FIREBASE; has .match(method, pathname)
if (USE_FIREBASE) {
  try {
    const fb = await import('./firebase/backend.mjs');
    const backend = await fb.initFirebaseBackend();
    firebaseMatch = backend.match;
    console.log(`PokéBonk → Firebase backend${process.env.FIREBASE_PROJECT_ID ? ` (project: ${process.env.FIREBASE_PROJECT_ID})` : ''}`);
  } catch (e) {
    console.error('Failed to start Firebase backend:', e.message);
    console.error('Install the SDK (npm install firebase-admin) and set FIREBASE_SERVICE_ACCOUNT / FIREBASE_PROJECT_ID / FIREBASE_DATABASE_URL, or run without --firebase for the local JSON store.');
    process.exit(1);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// ---------------------------------------------------------------- store ----

const STORE = path.join(DATA, 'store.json');
let store = { accounts: {}, runs: {}, nextRun: 1 };
try { store = JSON.parse(await readFile(STORE, 'utf8')); } catch { /* first boot */ }
let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    mkdir(DATA, { recursive: true })
      .then(() => writeFile(STORE, JSON.stringify(store)))
      .catch((e) => console.error('store write failed', e));
  }, 150);
}

function accountByToken(req) {
  const auth = req.headers.authorization || '';
  const t = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!t) return null;
  return Object.values(store.accounts).find((a) => a.token === t) || null;
}

function accountByName(name) {
  const k = String(name || '').toLowerCase();
  return Object.values(store.accounts).find((a) => a.name.toLowerCase() === k) || null;
}

// ------------------------------------------------------------ season cfg ---
// (SEASON, EVENTS, seasonPayload are imported from ./firebase/shared.mjs)

// ------------------------------------------------------------------ api ----
// (json, body are imported from ./firebase/shared.mjs)

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

// --- status / meta
route('GET', '/status', () => ({
  maintenance: { on: false, title: '', message: '', eta: 0 },
  bypass: false, season: seasonPayload(), events: EVENTS,
  registration: { inviteOnly: false },
}));

route('GET', '/news', () => []);
route('GET', '/version.json', () => ({ build: 'local', version: '0.0.0' }));

// --- auth
route('POST', '/auth/guest', async (req, res) => {
  const acc = newAccount(`Invitado ${crypto.randomBytes(2).toString('hex').toUpperCase()}`, true);
  store.accounts[acc.id] = acc;
  persist();
  json(res, 200, { id: acc.id, name: acc.name, token: acc.token, guest: true });
});

route('GET', '/auth/me', (req, res) => {
  const acc = accountByToken(req);
  if (!acc) return json(res, 401, { error: 'Sesión no válida.' });
  acc.lastSeen = now();
  json(res, 200, { id: acc.id, name: acc.name, guest: acc.guest, created: acc.created });
});

route('GET', '/auth/name', (req, res, url) => {
  const name = url.searchParams.get('name') || '';
  json(res, 200, { ok: name.length >= 3 && name.length <= 16 && !accountByName(name), name });
});

route('POST', '/auth/register', async (req, res) => {
  const b = await body(req) || {};
  if (!b.name || !b.password) return json(res, 400, { error: 'Faltan datos.' });
  if (accountByName(b.name)) return json(res, 409, { error: 'Ese nombre ya está en uso.' });
  const acc = newAccount(b.name, false);
  acc.password = await hashPassword(b.password);
  store.accounts[acc.id] = acc;
  persist();
  json(res, 200, { id: acc.id, name: acc.name, token: acc.token, guest: false });
});

route('POST', '/auth/login', async (req, res) => {
  const b = await body(req) || {};
  const acc = accountByName(b.name);
  if (!acc || !(await checkPassword(b.password, acc.password))) {
    return json(res, 401, { error: 'Nombre o contraseña incorrectos.' });
  }
  acc.token = token();
  acc.lastSeen = now();
  persist();
  json(res, 200, { id: acc.id, name: acc.name, token: acc.token, guest: false });
});

route('POST', '/auth/logout', (req, res) => json(res, 204, undefined));

route('POST', '/auth/upgrade', async (req, res) => {
  const acc = accountByToken(req);
  if (!acc) return json(res, 401, { error: 'Sesión no válida.' });
  const b = await body(req) || {};
  if (accountByName(b.name)) return json(res, 409, { error: 'Ese nombre ya está en uso.' });
  acc.name = b.name;
  acc.guest = false;
  acc.password = await hashPassword(b.password);
  acc.profile.name = b.name;
  persist();
  json(res, 200, { id: acc.id, name: acc.name, token: acc.token, guest: false });
});

// --- profile
const requireAccount = (req, res) => {
  const acc = accountByToken(req);
  if (!acc) json(res, 401, { error: 'Sesión no válida.' });
  return acc;
};

route('GET', '/profile', (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  json(res, 200, { profile: acc.profile, now: now() });
});

route('PUT', '/profile/prefs', async (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  const b = await body(req) || {};
  const p = acc.profile;
  if (b.settings && typeof b.settings === 'object') p.settings = { ...p.settings, ...b.settings };
  for (const k of ['lastSpecies', 'lastBiome', 'avatar', 'frame', 'title', 'skins']) {
    if (b[k] !== undefined) p[k] = b[k];
  }
  persist();
  json(res, 204, undefined);
});

route('POST', '/profile/starter', async (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  const b = await body(req) || {};
  const p = acc.profile;
  const id = Number(b.id);
  if (![1, 4, 7].includes(id)) return json(res, 400, { error: 'Inicial no válido.' });
  p.starter = id;
  p.lastSpecies = id;
  if (!p.league.includes(id)) p.league.push(id);
  if (!p.unlocked.includes(id)) p.unlocked.push(id);
  persist();
  json(res, 200, { profile: p });
});

route('POST', '/lab/buy', async (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  const b = await body(req) || {};
  const p = acc.profile;
  const lv = p.lab[b.id] ?? 0;
  p.lab[b.id] = lv + 1;
  persist();
  json(res, 200, { profile: p });
});

route('POST', '/items/buy', async (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  const b = await body(req) || {};
  const p = acc.profile;
  if (b.key && !p.itemsOwned.includes(b.key)) p.itemsOwned.push(b.key);
  persist();
  json(res, 200, { profile: p });
});

route('POST', '/items/archive', async (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  const b = await body(req) || {};
  const p = acc.profile;
  if (b.key) {
    p.itemsOff = b.off
      ? [...new Set([...p.itemsOff, b.key])]
      : p.itemsOff.filter((k) => k !== b.key);
  }
  persist();
  json(res, 200, { profile: p });
});

route('POST', '/quests/claim', async (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  const b = await body(req) || {};
  const p = acc.profile;
  if (b.id) p.quests[b.id] = 1;
  persist();
  json(res, 200, { profile: p });
});

route('POST', '/tasks/claim', async (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  const b = await body(req) || {};
  const p = acc.profile;
  const t = p[b.period];
  if (t && Number.isInteger(b.slot) && b.slot >= 0 && b.slot < 4) t.claimed[b.slot] = 1;
  persist();
  json(res, 200, { profile: p });
});

route('POST', '/tasks/reroll', async (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  json(res, 200, { profile: acc.profile });
});

route('GET', '/records', (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  json(res, 200, []);
});
route('GET', '/records/endless', (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  json(res, 200, []);
});

// --- boards
route('GET', '/leaderboard', (req, res, url) => {
  json(res, 200, boardFor(
    Object.values(store.accounts),
    url.searchParams.get('mode') || 'kills',
    url.searchParams.get('season') || 'week',
    Number(url.searchParams.get('limit') || 50),
    url,
    accountByToken(req),
  ));
});
route('GET', '/leaderboard/pokemon', () => ({ entries: [] }));
route('GET', '/seasons/awards', (req, res) => json(res, 200, []));
route('POST', '/seasons/claim', (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  json(res, 200, { profile: acc.profile });
});

// --- events
route('GET', '/events/:id', (req, res, url, params) => {
  const ev = EVENTS.find((e) => e.id === params.id);
  if (!ev) return json(res, 404, { error: 'Evento no encontrado.' });
  json(res, 200, { event: ev, track: [], quests: [], points: 0, claimed: [] });
});
route('POST', '/events/:id/track', (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  json(res, 200, { profile: acc.profile });
});
route('POST', '/events/:id/quest', (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  json(res, 200, { profile: acc.profile });
});

// --- players
route('GET', '/players', (req, res, url) => {
  const id = url.searchParams.get('id');
  const name = url.searchParams.get('name');
  const acc = id ? store.accounts[id] : accountByName(name);
  if (!acc) return json(res, 404, { error: 'Jugador no encontrado.' });
  json(res, 200, {
    id: acc.id, name: acc.name, created: acc.created,
    species: acc.profile.lastSpecies, avatar: acc.profile.avatar,
    frame: acc.profile.frame, title: acc.profile.title, skins: acc.profile.skins,
    league: acc.profile.league, kills: {}, records: [], runs: [],
  });
});
route('GET', '/players/search', (req, res, url) => {
  const q = (url.searchParams.get('q') || '').toLowerCase();
  const out = Object.values(store.accounts)
    .filter((a) => a.name.toLowerCase().includes(q))
    .slice(0, 20)
    .map((a) => ({ id: a.id, name: a.name, species: a.profile.lastSpecies, avatar: a.profile.avatar }));
  json(res, 200, { players: out });
});
route('POST', '/players/:id/report', (req, res) => json(res, 204, undefined));

// --- runs
route('POST', '/runs', async (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  const b = await body(req) || {};
  const id = `run-${store.nextRun++}`;
  store.runs[id] = { id, account: acc.id, cfg: b, seed: b.seed ?? crypto.randomInt(1, 2 ** 31), started: now() };
  persist();
  json(res, 200, { id, seed: store.runs[id].seed, ranked: true, boosts: [] });
});

route('GET', '/runs/:id/build', (req, res, url, params) => {
  const run = store.runs[params.id];
  if (!run) return json(res, 404, { error: 'Partida no encontrada.' });
  json(res, 200, { run: run.cfg, seed: run.seed });
});

route('POST', '/runs/:id/checkpoint', async (req, res, url, params) => {
  const run = store.runs[params.id];
  if (!run) return json(res, 404, { error: 'Partida no encontrada.' });
  const b = await body(req) || {};
  run.cps = (run.cps || []).concat(b.cps || []).slice(-600);
  json(res, 204, undefined);
});

route('POST', '/runs/:id/finish', async (req, res, url, params) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  const b = await body(req) || {};
  const result = b.result || {};
  const p = acc.profile;
  const run = store.runs[params.id];
  if (run) run.finished = now();

  const entry = {
    ...result, id: params.id, date: now(), season: SEASON.n,
    score: result.kills || 0, ranked: true,
  };
  p.runs = [entry, ...(p.runs || [])].slice(0, 50);
  p.counters.runs = (p.counters.runs || 0) + 1;
  p.counters.kills = (p.counters.kills || 0) + (result.kills || 0);
  for (const sp of result.progress?.seen || []) if (!p.seen.includes(sp)) p.seen.push(sp);
  for (const sp of result.progress?.league || []) if (!p.league.includes(sp)) p.league.push(sp);
  for (const sp of result.progress?.shinies || []) if (!p.shinies.includes(sp)) p.shinies.push(sp);
  const stardust = Math.max(1, Math.round((result.kills || 0) / 100));
  p.stardust += stardust;
  p.totalStardust += stardust;
  persist();

  json(res, 200, {
    profile: p,
    record: entry,
    ranked: true,
    guest: !!acc.guest,
    review: false,
    stardust,
    ends: SEASON.end,
    rewards: { stardust },
    kills: {
      season: SEASON.n, week: 1, all: 1, playersWeek: 1, playersAll: 1,
      ranked: true, live: true, dust: 1, cutoff: 0, ends: SEASON.end,
    },
    pb: false,
    prevBest: null,
    prevKills: null,
    weekPb: false,
    killsPb: false,
    medal: 0,
    mon: null,
  });
});

// --- social (single-player stubs that still satisfy the client contract)
route('GET', '/mail', (req, res) => json(res, 200, []));
route('POST', '/mail/read', (req, res) => json(res, 204, undefined));
route('POST', '/mail/:id/answer', (req, res) => json(res, 204, undefined));
route('POST', '/mail/:id/claim', (req, res) => json(res, 204, undefined));

route('GET', '/clans/status', (req, res) => json(res, 200, { clan: null, mail: 0, requests: 0, friends: 0, rewards: 0, board: 0 }));
route('GET', '/clans/board', (req, res) => json(res, 200, { entries: [], info: seasonPayload() }));
route('GET', '/clans/search', (req, res) => json(res, 200, { clans: [] }));
route('GET', '/clans/:id', (req, res) => json(res, 404, { error: 'Clan no encontrado.' }));
route('GET', '/clans/:id/activity', (req, res) => json(res, 200, []));
route('GET', '/clans/:id/chat', (req, res) => json(res, 200, []));
route('POST', '/clans', (req, res) => json(res, 400, { error: 'Los clanes no están disponibles en local.' }));
route('POST', '/clans/chat', (req, res) => json(res, 400, { error: 'Los clanes no están disponibles en local.' }));
route('POST', '/clans/react', (req, res) => json(res, 204, undefined));
route('POST', '/clans/claim', (req, res) => json(res, 400, { error: 'Los clanes no están disponibles en local.' }));
route('POST', '/clans/expand', (req, res) => json(res, 400, { error: 'Los clanes no están disponibles en local.' }));

route('GET', '/friends', (req, res) => json(res, 200, { friends: [], incoming: [], outgoing: [], max: 100 }));
route('POST', '/friends', (req, res) => json(res, 400, { error: 'Los amigos no están disponibles en local.' }));
route('POST', '/friends/remove', (req, res) => json(res, 204, undefined));
route('POST', '/friends/requests/:id/cancel', (req, res) => json(res, 204, undefined));

route('POST', '/feedback', (req, res) => json(res, 204, undefined));

route('POST', '/account/rename', async (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  const b = await body(req) || {};
  if (accountByName(b.name)) return json(res, 409, { error: 'Ese nombre ya está en uso.' });
  acc.name = b.name;
  acc.profile.name = b.name;
  persist();
  json(res, 200, { name: acc.name });
});
route('GET', '/account/rename', (req, res) => json(res, 200, { wait: 0 }));
route('POST', '/account/reset', async (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  acc.profile = newProfile(acc.name);
  persist();
  json(res, 200, { ok: true });
});
route('POST', '/account/delete', (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  delete store.accounts[acc.id];
  persist();
  json(res, 200, { ok: true });
});

function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    if (r.pattern === pathname) return { handler: r.handler, params: {} };
    if (!r.pattern.includes(':')) continue;
    const a = r.pattern.split('/');
    const b = pathname.split('/');
    if (a.length !== b.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < a.length; i++) {
      if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
      else if (a[i] !== b[i]) { ok = false; break; }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

// --------------------------------------------------------------- static ----

const PATCHED = new Map();

async function sendFile(res, file, patch) {
  const st = await stat(file);
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'content-length': patch ? patch.length : st.size,
    'cache-control': 'no-cache',
  });
  if (patch) res.end(patch);
  else createReadStream(file).pipe(res);
}

async function fetchUpstream(rel) {
  const target = `${UPSTREAM}/${rel}`;
  const upstream = await fetch(target, { redirect: 'follow' });
  if (!upstream.ok) return null;
  const buf = Buffer.from(await upstream.arrayBuffer());
  const out = path.join(ROOT, rel);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, buf).catch(() => {});
  return buf;
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  rel = rel.replace(/^(?:assets\/)+assets\//, 'assets/').replace(/^(?:data\/)+data\//, 'data/');
  if (rel === '') rel = 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';

  const file = path.join(ROOT, rel);
  const inside = path.resolve(file).startsWith(ROOT);
  let buf = null;

  if (inside && existsSync(file)) {
    const ext = path.extname(file);
    if (ext === '.html' && rel === 'index.html') {
      let src = await readFile(file, 'utf8');
      const before = src;
      src = src.replace(/<script[^>]*static\.cloudflareinsights\.com[\s\S]*?<\/script>/g, '');
      if (src !== before) return sendFile(res, file, Buffer.from(src));
    }
    if (ext === '.js' && rel.includes('main-D5OUVqGK')) {
      buf = PATCHED.get(file);
      if (!buf) {
        let src = await readFile(file, 'utf8');
        src = src.split(API_BASE_FROM).join('/api');
        // Turnstile cannot be reached offline: point the loader at a no-op stub.
        src = src.split('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit')
          .join('/turnstile-stub.js');
        buf = Buffer.from(src);
        PATCHED.set(file, buf);
      }
    }
    if (!buf) return sendFile(res, file);
    return sendFile(res, file, buf);
  }

  // SPA routes -> index.html
  if (!path.extname(rel)) {
    const index = path.join(ROOT, 'index.html');
    if (existsSync(index)) return sendFile(res, index);
  }

  const fetched = await fetchUpstream(rel).catch(() => null);
  if (!fetched) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(rel)] || 'application/octet-stream',
    'content-length': fetched.length,
    'cache-control': 'no-cache',
  });
  res.end(fetched);
}

// ------------------------------------------------------------ signaling ----
// Dependency-free in-memory room relay for co-op (no Firebase, no 'ws').
//   SSE  GET  /signaling/stream?room=X&uid=Y   server -> client push
//   POST      /signaling/send  { room, to, from, data }  client -> server
// This is the "relay fallback" channel AND the WebRTC signaling transport that
// net/signaling-local.mjs maps net.mjs's rtdb.ref(...).push/.on onto.

const signalRooms = new Map(); // room -> Map(toUid -> Set<res>)

function signalSubscribe(room, uid, res) {
  let m = signalRooms.get(room);
  if (!m) signalRooms.set(room, (m = new Map()));
  let set = m.get(uid);
  if (!set) m.set(uid, (set = new Set()));
  set.add(res);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    'access-control-allow-origin': '*',
  });
  res.write(':ok\n\n');
  const hb = setInterval(() => res.write(':hb\n\n'), 25000);
  res.on('close', () => {
    clearInterval(hb);
    set.delete(res);
    if (!set.size) m.delete(uid);
  });
}

function signalSend(room, to, data) {
  const set = signalRooms.get(room)?.get(to);
  if (!set) return;
  const payload = `data: ${data}\n\n`;
  for (const res of set) res.write(payload);
}

async function handleSignaling(req, res, url) {
  try {
    if (req.method === 'GET' && url.pathname === '/signaling/stream') {
      const room = url.searchParams.get('room') || '';
      const uid = url.searchParams.get('uid') || '';
      if (!room || !uid) { res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('bad params'); }
      signalSubscribe(room, uid, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/signaling/send') {
      const b = (await body(req)) || {};
      if (!b.room || !b.to || b.data == null) { res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('bad params'); }
      signalSend(b.room, b.to, b.data);
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (e) {
    console.error('signaling', e);
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('error');
  }
}

// --------------------------------------------------------------- server ----

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    });
    return res.end();
  }

  if (url.pathname.startsWith('/signaling/')) {
    return handleSignaling(req, res, url);
  }

  if (url.pathname.startsWith('/net/')) {
    const rel = url.pathname.slice(5).replace(/\.\./g, '');
    const file = path.join(NET_ROOT, rel);
    if (path.resolve(file).startsWith(NET_ROOT) && existsSync(file)) {
      return sendFile(res, file);
    }
    // Co-op UI modules live under public/net/ (alongside the served bundle).
    const pub = path.join(ROOT, 'net', rel);
    if (path.resolve(pub).startsWith(ROOT) && existsSync(pub)) {
      return sendFile(res, pub);
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }

  // Serve the browser-side Firebase web config (firebase/firebase-config.js) and
  // any other static Firebase client assets. Mirrors the /net/ route.
  if (url.pathname.startsWith('/firebase/')) {
    const rel = url.pathname.slice(10).replace(/\.\./g, '');
    const file = path.join(FIREBASE_ROOT, rel);
    if (path.resolve(file).startsWith(FIREBASE_ROOT) && existsSync(file)) {
      return sendFile(res, file);
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }

  if (url.pathname.startsWith('/api/')) {
    const apiPath = url.pathname.slice(4) || '/';
    const m = firebaseMatch ? firebaseMatch(req.method, apiPath) : matchRoute(req.method, apiPath);
    if (!m) return json(res, 404, { error: 'No encontrado.' });
    try {
      const out = await m.handler(req, res, url, m.params);
      if (out !== undefined && !res.writableEnded) json(res, 200, out);
      return;
    } catch (e) {
      console.error(`${req.method} ${url.pathname}`, e);
      return json(res, 500, { error: 'Error interno del servidor local.' });
    }
  }

  try {
    return await serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error('static', url.pathname, e);
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Internal error');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`PokéBonk local → http://127.0.0.1:${PORT}/`);
});
