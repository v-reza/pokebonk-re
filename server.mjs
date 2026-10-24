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
  SEASON, EVENTS, seasonPayload, boardFor, json, body, applyProfileAction,
} from './firebase/shared.mjs';
import { clanRoutes } from './firebase/clans.mjs';
import { coopRoutes } from './firebase/coop.mjs';
import { socialRoutes, edgeKey } from './firebase/social.mjs';
import { BUNDLE_PATCHES, REDIRECT_PATCHES, applyPatches, assertMirrorHooks } from './tools/bundle-patches.mjs';
import { applyCoopPatches } from './tools/bundle-patches-0.8.29.mjs';

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
store.clans ||= {};     // clanId -> clan document (see firebase/clans.mjs)
store.coopRooms ||= {};  // CODE -> co-op room (signals, chat, members)
store.coopInvites ||= {}; // id -> room invite
store.coopParties ||= {}; // party -> seed (one world per party)
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
  for (const k of ['lastSpecies', 'lastBiome', 'avatar', 'frame', 'title', 'skins', 'team']) {
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
  applyProfileAction(p, { k: 'lab', id: b.id });
  persist();
  json(res, 200, { profile: p });
});

route('POST', '/items/buy', async (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  const b = await body(req) || {};
  const p = acc.profile;
  applyProfileAction(p, { k: 'item', key: b.key });
  persist();
  json(res, 200, { profile: p });
});

route('POST', '/items/archive', async (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  const b = await body(req) || {};
  const p = acc.profile;
  applyProfileAction(p, { k: 'archive', key: b.key, off: b.off });
  persist();
  json(res, 200, { profile: p });
});

route('POST', '/quests/claim', async (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  const b = await body(req) || {};
  const p = acc.profile;
  applyProfileAction(p, { k: 'quest', id: b.id });
  persist();
  json(res, 200, { profile: p });
});

route('POST', '/tasks/claim', async (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  const b = await body(req) || {};
  const p = acc.profile;
  applyProfileAction(p, { k: 'task', period: b.period, slot: b.slot });
  persist();
  json(res, 200, { profile: p });
});

// Batched profile mutations. The 0.8.29 client always has `backend.actions`, so
// lab/item/archive/quest/task go through here and never call the routes above.
route('POST', '/profile/actions', async (req, res) => {
  const acc = requireAccount(req, res);
  if (!acc) return;
  const b = await body(req) || {};
  const list = Array.isArray(b.actions) ? b.actions.slice(0, 64) : [];
  let applied = 0;
  for (const a of list) if (applyProfileAction(acc.profile, a)) applied++;
  persist();
  json(res, 200, { profile: acc.profile, applied });
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
  // Co-op: the seed belongs to the party so every member builds the same world.
  let seed;
  if (b.party) {
    const key = String(b.party);
    if (store.coopParties[key] === undefined) store.coopParties[key] = crypto.randomInt(1, 2 ** 31);
    seed = store.coopParties[key];
  } else {
    seed = b.seed ?? crypto.randomInt(1, 2 ** 31);
  }
  store.runs[id] = { id, account: acc.id, cfg: b, seed, started: now() };
  persist();
  json(res, 200, { id, seed, party: b.party ?? null, ranked: true, boosts: [] });
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

route('GET', '/clans/board', (req, res) => json(res, 200, { entries: [], info: seasonPayload() }));
route('POST', '/clans/claim', (req, res) => json(res, 400, { error: 'Clans are not available in local mode.' }));
route('POST', '/clans/expand', (req, res) => json(res, 400, { error: 'Clans are not available in local mode.' }));

// --- clans: JSON-store side of firebase/clans.mjs (same handlers as --firebase)
const clanApi = {
  me: (req, res) => {
    const acc = accountByToken(req);
    if (!acc) json(res, 401, { error: 'Invalid session.' });
    return acc;
  },
  byName: async (name) => accountByName(name),
  byId: async (id) => store.accounts[id] || null,
  store: {
    get: async (id) => store.clans[id] || null,
    byName: async (name) => {
      const lower = String(name || '').toLowerCase();
      return Object.values(store.clans).find((c) => c.name.toLowerCase() === lower) || null;
    },
    byMember: async (uid) => Object.values(store.clans).find((c) => c.memberIds.includes(uid)) || null,
    list: async () => Object.values(store.clans),
    save: async (clan) => { store.clans[clan.id] = clan; },
    del: async (id) => { delete store.clans[id]; },
  },
};
for (const r of clanRoutes(clanApi).routes) routes.push(r);

// --- co-op rooms (their GT mesh signaling + lobby; same handlers as --firebase)
const coopApi = {
  me: (req, res) => {
    const acc = accountByToken(req);
    if (!acc) json(res, 401, { error: 'Invalid session.' });
    return acc;
  },
  byName: async (name) => accountByName(name),
  byId: async (id) => store.accounts[id] || null,
  enabled: process.env.COOP_ENABLED !== '0',
  store: {
    room: async (code) => store.coopRooms[String(code || '').toUpperCase()] || null,
    roomOf: async (uid) => Object.values(store.coopRooms).find((r) => r.members.some((m) => m.id === uid)) || null,
    saveRoom: async (room) => { store.coopRooms[room.code] = room; },
    delRoom: async (code) => { delete store.coopRooms[String(code || '').toUpperCase()]; },
    invites: async (uid) => Object.values(store.coopInvites).filter((i) => i.to === uid),
    saveInvite: async (i) => { store.coopInvites[i.id] = i; },
    delInvite: async (id) => { delete store.coopInvites[id]; },
    partySeed: async (party) => {
      const key = String(party);
      if (store.coopParties[key] === undefined) store.coopParties[key] = crypto.randomInt(1, 2 ** 31);
      return store.coopParties[key];
    },
  },
};
for (const r of coopRoutes(coopApi).routes) routes.push(r);


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

// 0.8.29 target: same game, rebuilt. Serves redirects + the five co-op hooks
// from tools/bundle-patches-0.8.29.mjs instead of the 0.8.13 string patches.
const NEW_BUNDLES = ['main-CPuTGAQ--mvlr7rzv.js', 'main-DEBvJLhQ-mvl14oup.js'];
const isNewBundle = (rel) => NEW_BUNDLES.some((b) => rel.includes(process.env.PB_NEW_BUNDLE || b));

/** Patched bundle cache: file path -> Buffer. */
const PATCHED = new Map();

// The patch table and the mirror-hook assertions live in tools/bundle-patches.mjs,
// shared with tools/prepatch.mjs so the served and the deployed bundle never drift.

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
    if (ext === '.js' && (rel.includes('main-D5OUVqGK') || isNewBundle(rel))) {
      buf = PATCHED.get(file);
      if (!buf) {
        const src = await readFile(file, 'utf8');
        try {
          if (isNewBundle(rel)) {
            // 0.8.29: redirects first, then the co-op hooks. The old A1-A8
            // patches and the E1-E14 hook checks describe 0.8.13 symbols and
            // must not run against this build.
            const redirected = applyPatches(src, REDIRECT_PATCHES, rel);
            const res = applyCoopPatches(redirected);
            console.log('[pb-patch] ' + rel + ': redirects + ' + res.applied.length + ' co-op hooks');
            buf = Buffer.from(res.source);
          } else {
            assertMirrorHooks(src);
            buf = Buffer.from(applyPatches(src, BUNDLE_PATCHES, rel));
          }
        } catch (e) {
          // Serve the game anyway (single-player still works), but say loudly why
          // co-op will not.
          console.error(String(e.message || e));
          buf = Buffer.from(src);
        }
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
