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
import { socialRoutes, edgeKey } from './firebase/social.mjs';

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
// Social collections (friends/presence/rooms/invites). Created lazily so old
// store files keep loading; persisted with the rest of the store.
store.friends ||= {};   // key `uidA_uidB` -> edge
store.pres ||= {};      // uid -> { at, room, play }
store.rooms ||= {};     // code -> room
store.invites ||= {};   // `${to}|${from}` -> invite
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
  const acc = newAccount(`Guest ${crypto.randomBytes(2).toString('hex').toUpperCase()}`, true);
  store.accounts[acc.id] = acc;
  persist();
  json(res, 200, { id: acc.id, name: acc.name, token: acc.token, guest: true });
});

route('GET', '/auth/me', (req, res) => {
  const acc = accountByToken(req);
  if (!acc) return json(res, 401, { error: 'Invalid session.' });
  acc.lastSeen = now();
  json(res, 200, { id: acc.id, name: acc.name, guest: acc.guest, created: acc.created });
});

route('GET', '/auth/name', (req, res, url) => {
  const name = url.searchParams.get('name') || '';
  json(res, 200, { ok: name.length >= 3 && name.length <= 16 && !accountByName(name), name });
});

route('POST', '/auth/register', async (req, res) => {
  const b = await body(req) || {};
  if (!b.name || !b.password) return json(res, 400, { error: 'Missing data.' });
  if (accountByName(b.name)) return json(res, 409, { error: 'That name is already in use.' });
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
    return json(res, 401, { error: 'Incorrect username or password.' });
  }
  acc.token = token();
  acc.lastSeen = now();
  persist();
  json(res, 200, { id: acc.id, name: acc.name, token: acc.token, guest: false });
});

route('POST', '/auth/logout', (req, res) => json(res, 204, undefined));

route('POST', '/auth/upgrade', async (req, res) => {
  const acc = accountByToken(req);
  if (!acc) return json(res, 401, { error: 'Invalid session.' });
  const b = await body(req) || {};
  if (accountByName(b.name)) return json(res, 409, { error: 'That name is already in use.' });
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
  if (!acc) json(res, 401, { error: 'Invalid session.' });
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
  if (![1, 4, 7].includes(id)) return json(res, 400, { error: 'Invalid starter.' });
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
  if (!ev) return json(res, 404, { error: 'Event not found.' });
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
  if (!acc) return json(res, 404, { error: 'Player not found.' });
  json(res, 200, {
    id: acc.id, name: acc.name, created: acc.created,
    species: acc.profile.lastSpecies, avatar: acc.profile.avatar,
    frame: acc.profile.frame, title: acc.profile.title, skins: acc.profile.skins,
    league: acc.profile.league, kills: {}, records: [], runs: [],
  });
});
// `/players/search` (name search, excluding yourself) is registered by the shared
// social route table below, so both backends answer identically.
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
  if (!run) return json(res, 404, { error: 'Run not found.' });
  json(res, 200, { run: run.cfg, seed: run.seed });
});

route('POST', '/runs/:id/checkpoint', async (req, res, url, params) => {
  const run = store.runs[params.id];
  if (!run) return json(res, 404, { error: 'Run not found.' });
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
route('GET', '/clans/:id', (req, res) => json(res, 404, { error: 'Clan not found.' }));
route('GET', '/clans/:id/activity', (req, res) => json(res, 200, []));
route('GET', '/clans/:id/chat', (req, res) => json(res, 200, []));
route('POST', '/clans', (req, res) => json(res, 400, { error: 'Clans are not available in local mode.' }));
route('POST', '/clans/chat', (req, res) => json(res, 400, { error: 'Clans are not available in local mode.' }));
route('POST', '/clans/react', (req, res) => json(res, 204, undefined));
route('POST', '/clans/claim', (req, res) => json(res, 400, { error: 'Clans are not available in local mode.' }));
route('POST', '/clans/expand', (req, res) => json(res, 400, { error: 'Clans are not available in local mode.' }));

// --- social (friends, presence, rooms, invites). The handlers live in
// firebase/social.mjs so `--firebase` mode answers identically; this adapter is
// the JSON-store side of that contract.
const socialApi = {
  me: (req, res) => {
    const acc = accountByToken(req);
    if (!acc) json(res, 401, { error: 'Invalid session.' });
    return acc;
  },
  byId: async (id) => store.accounts[id] || null,
  byName: async (name) => accountByName(name),
  search: async (q, limit) => {
    const ql = String(q || '').toLowerCase();
    return Object.values(store.accounts).filter((a) => a.name.toLowerCase().includes(ql)).slice(0, limit);
  },
  edges: async (uid) => Object.values(store.friends).filter((e) => e && e.users && e.users.includes(uid)),
  saveEdge: async (e) => { store.friends[edgeKey(e.users[0], e.users[1])] = e; },
  delEdge: async (k) => { delete store.friends[k]; },
  pres: async (ids) => {
    const out = {};
    for (const id of ids) if (store.pres[id]) out[id] = store.pres[id];
    return out;
  },
  setPres: async (id, v) => { store.pres[id] = v; },
  room: async (code) => store.rooms[code] || null,
  myRoom: async (uid) => Object.values(store.rooms).find((r) => r && r.m && r.m[uid]) || null,
  saveRoom: async (r) => { store.rooms[r.code] = r; },
  delRoom: async (code) => { delete store.rooms[code]; },
  invites: async (uid) => Object.values(store.invites).filter((i) => i && i.to === uid),
  saveInvite: async (i) => { store.invites[`${i.to}|${i.from}`] = i; },
  delInvite: async (from, to) => { delete store.invites[`${to}|${from}`]; },
  flush: persist,
};
for (const r of socialRoutes(socialApi).routes) routes.push(r);

route('POST', '/feedback', (req, res) => json(res, 204, undefined));

route('POST', '/account/rename', async (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  const b = await body(req) || {};
  if (accountByName(b.name)) return json(res, 409, { error: 'That name is already in use.' });
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

// ------------------------------------------------------ bundle patches ----

// The served game bundle is a single self-contained ES module
// (`assets/main-D5OUVqGK-mvilprw2.js`, loaded by the small `main-BcyzVqXo` entry
// chunk — that entry only does `import('./main-D5OUVqGK-mvilprw2.js')`, so this
// file IS the game). Co-op needs a few hooks the upstream build does not have,
// so they are injected here as string patches while serving. Nothing is ever
// written back to disk.
//
// Every patch is `[anchor, replacement]`, applied at most once per bundle. A
// missing anchor is a loud console warning (`[pb-patch] anchor not found`)
// because that means the mirror changed and co-op silently stopped working.
//
// The file is CRLF, so multi-line anchors must use `\r\n`.

const BUNDLE = 'main-D5OUVqGK-mvilprw2.js';

/** Patched bundle cache: file path -> Buffer. */
const PATCHED = new Map();

/** Bridge entry point used by the injected `DC.buildStage` hook. */
const BUILD_PUPPETS_HOOK = '__pbBuildPuppets';

const BUNDLE_PATCHES = [
  // -- redirect the backend + Turnstile (existing behaviour) ---------------
  ['https://api.pokebonk.com', '/api'],
  ['https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', '/turnstile-stub.js'],

  // -- A1: puppet factory must tolerate a member with no species ------------
  // `__pbMakePuppets` (bundle tail) does `new Yg(run, m.dex ?? run.startSpecies
  // ?? 1, ...)`. A member whose `dex` is 0 — the room placeholder written before
  // that player picked a starter, and the value coop-ui's myDex() sends when
  // `pb.save` is absent — is NOT nullish, so `??` keeps the 0 and Yg's
  // constructor dies in `O.get(0)` (`Cannot read properties of undefined
  // (reading 'types')`). The throw escapes beginCoop()'s factory loop, leaving
  // `coop.mates[*].pl` as the placeholder stubs from Coop.begin() — objects with
  // no `pos`/`render`/`net`, which renderCoopPlayers skips. That is why
  // teammates are invisible. Fall back on any falsy/non-species value.
  [
    'const p = new Yg(run, m.dex ?? run.startSpecies ?? 1, run.meta.labStats());',
    'const p = new Yg(run, (m.dex | 0) || run.startSpecies || 1, run.meta.labStats());',
  ],

  // -- A2: build the puppets as part of buildStage --------------------------
  // INTEGRATION.md §7. `DC.buildStage` creates the local player; right after it
  // the run asks the bridge for one puppet per remote teammate. Doing it here
  // (not only in beginCoop) covers every path that creates a run, and a guest
  // that reseeds via buildStage(true) gets its puppets rebuilt instead of lost.
  // `__pbBuildPuppets` is idempotent and a no-op until a co-op session exists.
  [
    'this.player = new Yg(this, this.startSpecies, this.meta.labStats()), this.allies = new mp(this)',
    'this.player = new Yg(this, this.startSpecies, this.meta.labStats()), '
    + `${BUILD_PUPPETS_HOOK}(this), this.allies = new mp(this)`,
  ],

  // -- A3: the renderer must not draw a puppet twice / from a stale stub ----
  // `renderCoopPlayers` iterates `coop.puppets()` (mate.pl). If a mate's entry
  // was replaced by a real `Yg` while another entry still points at the old
  // placeholder, the same uid would be drawn twice. Keep one entry per uid and
  // skip anything that is not a renderable puppet.
  [
    'renderCoopPlayers(e) {\r\n   let c = this.coop;\r\n   if (!c) return;\r\n   let list = c.puppets();',
    'renderCoopPlayers(e) {\r\n   let c = this.coop;\r\n   if (!c) return;\r\n   let list = c.puppets();\r\n   if (list && list.length) { const seen = new Set; list = list.filter(p => p && p.uid && !seen.has(p.uid) && (seen.add(p.uid), typeof p.render === `function`)) }',
  ],

  // -- A4: copy puppet positions every frame, deterministically -------------
  // `renderCoopPlayers` interpolated with a per-puppet clock seeded from
  // `performance.now()` on first sight, so the first sample after a wire change
  // had `a = (now - s.t)/66 = 0` and the puppet stayed exactly on its old point.
  // Because the guest only renders once per host frame (3-15 Hz) and a fresh
  // puppet is created right after the run starts, that stale point could be the
  // spawn point forever — observed: guest's puppet `pos` (0,0) while `net` was
  // (14,6). Copying `net -> pos` here (before renderWorld, every frame, all
  // states) makes the position a pure function of the latest frame.
  [
    'this.renderWorld(i ? r : 0), this.vfx.update(',
    '__pbSyncPuppets(this), this.renderWorld(i ? r : 0), this.vfx.update(',
  ],

  // -- A5: drop the render-time interpolation (it now fights A4) ------------
  [
    'let a = Math.min(1, (now - s.t) / 66),\r\n     x = s.px + (s.x - s.px) * a,\r\n     z = s.pz + (s.z - s.pz) * a,',
    'let x = s.x,\r\n     z = s.z,',
  ],

  // -- A6: level-up card tells the session the local player chose ----------
  // Every way out of the card (pick, skip, banish, reroll-exhausted) funnels
  // through this `n(...)` helper in DC.doLevelUp, so one hook covers them all.
  // Host: coop.picked(me); guest: sends ['lp'] and closes the host's wait set.
  // Without it the host's `waiting` set never empties and the run deadlocks.
  [
    'n = (e = !0) => {\r\n     this.pendingLevels = Math.max(0, this.pendingLevels - 1), this.noResumeGrace = !e, this.ui.hideModal(), this.pendingLevels > 0 ? this.state = `play` : this.resume()\r\n    },',
    'n = (e = !0) => {\r\n     this.pendingLevels = Math.max(0, this.pendingLevels - 1), this.noResumeGrace = !e, this.ui.hideModal(), '
    + 'this.coop && this.coop.localPicked(), '
    + 'this.pendingLevels > 0 ? this.state = `play` : this.resume()\r\n    },',
  ],

  // -- A7: guest-side kill guard -------------------------------------------
  // A guest's enemies are remote copies; `credit` must never run for them (it
  // bumps stats.kills, research, egg progress and drop tables). kh.strike already
  // returns before damage for remote rows, so this is defence in depth for any
  // other caller (status ticks, ally hits, ult).
  // NOTE: the guard goes BEFORE `let r = …` so the original declaration list
  // (`let r = …, i = …, a = …;`) stays intact. Splicing a `;` into that list
  // turns `a = i.flags[e]` into a bare assignment and throws.
  [
    'credit(e, t, n) {\r\n   let r = this.run,\r\n    i = r.enemies,',
    'credit(e, t, n) {\r\n   if (this.run.enemies.remote[e] && this.run.coop && !this.run.coop.isHost) return;\r\n   let r = this.run,\r\n    i = r.enemies,',
  ],

  // -- A8: separate overlapping sprites AT DRAW TIME ONLY -------------------
  // `pl.pos` must stay the true wire position (interpolation, hit tests and the
  // `net` round-trip all read it). When both players stand on the same spot —
  // same starter, same spawn point — the sprites stack and look like one
  // Pokémon, so a screenshot cannot show two players. Shift the sprite (and its
  // shadow) by a stable per-uid offset while drawing; nothing else sees it.
  // `__pbDrawOffset(this)` returns 0 for the local player and a fixed lateral
  // offset for a remote puppet.
  [
    '  render() {\r\n   let e = this.run,\r\n    t = e.sprites.get(this.speciesId),',
    '  render() {\r\n   let e = this.run,\r\n    _dx = 0, _dz = 0;\r\n'
    + '   if (this.remote) { const _o = globalThis.__pbDrawOffset ? globalThis.__pbDrawOffset(this) : null; if (_o) { _dx = _o[0]; _dz = _o[1] } }\r\n'
    + '   let t = e.sprites.get(this.speciesId),',
  ],
  [
    't.push(this.pos.x, this.pos.y, this.pos.z, n, r, l, this.renderScale,',
    't.push(this.pos.x + _dx, this.pos.y, this.pos.z + _dz, n, r, l, this.renderScale,',
  ],
  [
    'e.sprites.shadows.push(this.pos.x, p, this.pos.z, 1.4)',
    'e.sprites.shadows.push(this.pos.x + _dx, p, this.pos.z + _dz, 1.4)',
  ],

  // -- A9: minimap party indicators ----------------------------------------
  // `drawMinimap(e)` translates and rotates the 2D context for world rendering.
  // Right before restoring the canvas state to draw the local player's arrow,
  // invoke `__pbDrawMinimap(e, t, a, f, h)` so remote teammates' dots are drawn
  // with member colors, dark rings, hollow/pulsing dead states, and circle rim
  // clamping, while preserving the local player's existing marker.
  [
    '   t.fillStyle = `#7aff9a`, t.strokeStyle = `#1d1236`, t.lineWidth = 2;\r\n   for (let n of e.allies.list) {\r\n    let [e, r] = a(n.x, n.z);\r\n    t.beginPath(), t.arc(e, r, 6 * h, 0, 7), t.fill(), t.stroke()\r\n   }',
    '   t.fillStyle = `#7aff9a`, t.strokeStyle = `#1d1236`, t.lineWidth = 2;\r\n   for (let n of e.allies.list) {\r\n    let [e, r] = a(n.x, n.z);\r\n    t.beginPath(), t.arc(e, r, 6 * h, 0, 7), t.fill(), t.stroke()\r\n   }\r\n   globalThis.__pbDrawMinimap && globalThis.__pbDrawMinimap(e, t, a, f, h);',
  ],

  // -- A10: pass real shiny flag to enemyAdded -----------------------------
  // `Sd.spawn` previously hardcoded `shiny: 0` when notifying co-op sessions of
  // a new enemy. Wire the real `L.Shiny` flag (`2048`) from spawn parameter `a` (held in `x`).
  [
    '   let x = a;\r\n   this.run.coop && this.run.coop.enemyAdded({ slot: o, species: this.species[o], x: this.x[o], z: this.z[o], boss: !!(x & 4), shiny: 0, maxHp: this.maxHp[o], dmg: this.dmg[o], behavior: x });',
    '   let x = a;\r\n   this.run.coop && this.run.coop.enemyAdded({ slot: o, species: this.species[o], x: this.x[o], z: this.z[o], boss: !!(x & 4), shiny: !!(x & 2048), maxHp: this.maxHp[o], dmg: this.dmg[o], behavior: x });',
  ],
];

/** Apply one patch table to `src`; returns the new source. */
function applyPatches(src, patches, label) {
  for (const [anchor, replacement] of patches) {
    const at = src.indexOf(anchor);
    if (at < 0) {
      console.warn(`[pb-patch] anchor not found: ${JSON.stringify(anchor.slice(0, 90))} (${label})`);
      continue;
    }
    if (src.indexOf(anchor, at + anchor.length) >= 0) {
      console.warn(`[pb-patch] anchor not unique: ${JSON.stringify(anchor.slice(0, 90))} (${label})`);
    }
    src = src.slice(0, at) + replacement + src.slice(at + anchor.length);
  }
  return src;
}

/** Assert the hooks that must already exist in the mirrored bundle. */
function assertMirrorHooks(src) {
  const required = [
    // per-frame coop tick, inside DC.update (runs in every state, incl. modal)
    'this.coop && this.coop.tick(this.realDt)',
    // host enemy lifecycle -> guests
    'this.run.coop && this.run.coop.enemyAdded(',
    'this.run.coop && this.run.coop.enemyGone({ slot: e }, !1)',
    'n.coop && n.coop.enemyGone({ slot: e }, !0)',
    // guest: remote enemy rows are interpolated, never simulated
    'coopRemoteUpdate(l, e) {',
    'if (this.remote[l]) {',
    // guest: hits on a remote row are forwarded to the host
    'r.coop && !r.coop.isHost && r.coop.hit(e, t, 16777215, 0, 0, 0);',
    // guest world split (no director/pickups/clock on the guest)
    'this.coop && !this.coop.isHost;',
    // puppets: rendered by DC.renderWorld, driven by net state, never gain XP
    'this.renderCoopPlayers(e)',
    'if (this.remote) {\r\n    if (this.net) {',
    'if (this.remote || (this.run.coop && !this.run.coop.isHost)) return;',
    // run bridge + level sync
    'globalThis.__pb && (globalThis.__pb.run = this.run)',
    'this.coop && this.coop.levelStart(this.player.level)',
    // puppet factory
    'globalThis.__pbMakePuppets = (run, members, meUid) =>',
  ];
  for (const needle of required) {
    if (!src.includes(needle)) {
      console.warn(`[pb-patch] mirror hook missing: ${JSON.stringify(needle.slice(0, 90))}`);
    }
  }
}

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
        const src = await readFile(file, 'utf8');
        assertMirrorHooks(src);
        buf = Buffer.from(applyPatches(src, BUNDLE_PATCHES, rel));
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
    if (!m) return json(res, 404, { error: 'Not found.' });
    try {
      const out = await m.handler(req, res, url, m.params);
      if (out !== undefined && !res.writableEnded) json(res, 200, out);
      return;
    } catch (e) {
      console.error(`${req.method} ${url.pathname}`, e);
      return json(res, 500, { error: 'Internal local server error.' });
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
