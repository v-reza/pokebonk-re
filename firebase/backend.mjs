// PokéBonk — Firebase backend.
//
// Implements the SAME ~50-route REST API as `server.mjs`, but persists against
// Firebase (Firestore + RTDB + Firebase Auth) instead of the local JSON store.
//
// Design:
//   * The route handlers are written against a small async `DB` interface (see
//     the `MemoryDB` class below for the contract), so the mapping logic is
//     testable against an in-memory fake with no Firebase SDK installed.
//   * `FirestoreDB` is the real adapter: it lazily imports `firebase-admin`,
//     so merely importing this module (or running the tests) never requires the
//     SDK. If `firebase-admin`/`@google-cloud/firestore` are not installed the
//     module still loads; only `createFirebaseDB()` throws.
//   * Account/profile shapes, season/event config and response helpers come
//     from `./shared.mjs` so both backends stay byte-identical in shape.
//
// Free-tier decisions (documented for the README):
//   * One Firestore document write per run finish (the `saves/{uid}` doc).
//     Run history lives in `saves/{uid}.profile.runs` (same as the JSON store),
//     NOT in a separate Firestore collection.
//   * Checkpoints are NEVER written to Firestore. Active run metadata and
//     checkpoints go to RTDB under `runs/{runId}`.
//   * Profile saves are debounced (>=65s between Firestore writes per user);
//     auth-critical writes (create/login/upgrade/rename/delete/run-finish) flush
//     immediately.
//   * Presence is a 30-minute heartbeat to `pres/{uid}`.
import crypto from 'node:crypto';
import {
  now, token, newProfile, newAccount, hashPassword, checkPassword,
  SEASON, EVENTS, seasonPayload, boardFor, json, body, applyProfileAction,
} from './shared.mjs';
import { socialRoutes, edgeKey, ONLINE_TTL } from './social.mjs';
import { clanRoutes } from './clans.mjs';
import { coopRoutes } from './coop.mjs';

const SAVE_GAP_MS = 65 * 1000;             // debounced profile save gap
const PRESENCE_MS = 30 * 60 * 1000;        // presence heartbeat gap
const AUTH_EMAIL_DOMAIN = 'pokebonk.local'; // synthetic emails for Email+Password

const bearer = (req) => {
  const a = req.headers.authorization || '';
  return a.startsWith('Bearer ') ? a.slice(7) : null;
};

const slug = (name) =>
  String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'player';

// ---------------------------------------------------------------- routing ----

export function matchRoute(routes, method, pathname) {
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

// Builds the full route table against a DB. Returns `{ match }` with the same
// shape as server.mjs's `matchRoute`, so server.mjs can dispatch identically.
export function createBackend(db) {
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  const requireAccount = async (req, res) => {
    const t = bearer(req);
    const acc = t ? await db.byToken(t) : null;
    if (!acc) json(res, 401, { error: 'Invalid session.' });
    return acc;
  };

  // Null-safe lookup for the leaderboard viewer (no 401 — boards are public).
  const optionalAccount = async (req) => {
    const t = bearer(req);
    return t ? await db.byToken(t) : null;
  };

  // --- status / meta
  route('GET', '/status', () => ({
    maintenance: { on: false, title: '', message: '', eta: 0 },
    bypass: false, season: seasonPayload(), events: EVENTS,
    registration: { inviteOnly: false },
  }));

  route('GET', '/news', () => []);
  route('GET', '/version.json', () => ({ build: 'firebase', version: '0.0.0' }));

  // --- auth
  route('POST', '/auth/guest', async (req, res) => {
    const name = `Guest ${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const acc = await db.createGuest(name);
    json(res, 200, { id: acc.id, name: acc.name, token: acc.token, guest: true });
  });

  route('GET', '/auth/me', async (req, res) => {
    const acc = await requireAccount(req, res);
    if (!acc) return;
    acc.lastSeen = now();
    await db.save(acc);
    json(res, 200, { id: acc.id, name: acc.name, guest: acc.guest, created: acc.created });
  });

  route('GET', '/auth/name', async (req, res, url) => {
    const name = url.searchParams.get('name') || '';
    const taken = name.length >= 3 && name.length <= 16 ? !!(await db.byName(name)) : false;
    json(res, 200, { ok: name.length >= 3 && name.length <= 16 && !taken, name });
  });

  route('POST', '/auth/register', async (req, res) => {
    const b = (await body(req)) || {};
    if (!b.name || !b.password) return json(res, 400, { error: 'Missing data.' });
    try {
      const acc = await db.createRegistered(b.name, b.password);
      json(res, 200, { id: acc.id, name: acc.name, token: acc.token, guest: false });
    } catch (e) {
      if (e && e.code === 'CONFLICT') return json(res, 409, { error: 'That name is already in use.' });
      throw e;
    }
  });

  route('POST', '/auth/login', async (req, res) => {
    const b = (await body(req)) || {};
    const acc = await db.login(b.name, b.password);
    if (!acc) return json(res, 401, { error: 'Incorrect name or password.' });
    json(res, 200, { id: acc.id, name: acc.name, token: acc.token, guest: false });
  });

  route('POST', '/auth/logout', (req, res) => json(res, 204, undefined));

  route('POST', '/auth/upgrade', async (req, res) => {
    const acc = await requireAccount(req, res);
    if (!acc) return;
    const b = (await body(req)) || {};
    try {
      await db.upgrade(acc, b.name, b.password);
      json(res, 200, { id: acc.id, name: acc.name, token: acc.token, guest: false });
    } catch (e) {
      if (e && e.code === 'CONFLICT') return json(res, 409, { error: 'That name is already in use.' });
      throw e;
    }
  });

  // --- profile
  route('GET', '/profile', async (req, res) => {
    const acc = await requireAccount(req, res);
    if (!acc) return;
    json(res, 200, { profile: acc.profile, now: now() });
  });

  route('PUT', '/profile/prefs', async (req, res) => {
    const acc = await requireAccount(req, res);
    if (!acc) return;
    const b = (await body(req)) || {};
    const p = acc.profile;
    if (b.settings && typeof b.settings === 'object') p.settings = { ...p.settings, ...b.settings };
    for (const k of ['lastSpecies', 'lastBiome', 'avatar', 'frame', 'title', 'skins', 'team']) {
      if (b[k] !== undefined) p[k] = b[k];
    }
    await db.save(acc);
    json(res, 204, undefined);
  });

  route('POST', '/profile/starter', async (req, res) => {
    const acc = await requireAccount(req, res);
    if (!acc) return;
    const b = (await body(req)) || {};
    const p = acc.profile;
    const id = Number(b.id);
    if (![1, 4, 7].includes(id)) return json(res, 400, { error: 'Invalid starter.' });
    p.starter = id;
    p.lastSpecies = id;
    if (!p.league.includes(id)) p.league.push(id);
    if (!p.unlocked.includes(id)) p.unlocked.push(id);
    await db.save(acc);
    json(res, 200, { profile: p });
  });

  route('POST', '/lab/buy', async (req, res) => {
    const acc = await requireAccount(req, res);
    if (!acc) return;
    const b = (await body(req)) || {};
    const p = acc.profile;
    applyProfileAction(p, { k: 'lab', id: b.id });
    await db.save(acc);
    json(res, 200, { profile: p });
  });

  route('POST', '/items/buy', async (req, res) => {
    const acc = await requireAccount(req, res);
    if (!acc) return;
    const b = (await body(req)) || {};
    const p = acc.profile;
    applyProfileAction(p, { k: 'item', key: b.key });
    await db.save(acc);
    json(res, 200, { profile: p });
  });

  route('POST', '/items/archive', async (req, res) => {
    const acc = await requireAccount(req, res);
    if (!acc) return;
    const b = (await body(req)) || {};
    const p = acc.profile;
    applyProfileAction(p, { k: 'archive', key: b.key, off: b.off });
    await db.save(acc);
    json(res, 200, { profile: p });
  });

  route('POST', '/quests/claim', async (req, res) => {
    const acc = await requireAccount(req, res);
    if (!acc) return;
    const b = (await body(req)) || {};
    const p = acc.profile;
    applyProfileAction(p, { k: 'quest', id: b.id });
    await db.save(acc);
    json(res, 200, { profile: p });
  });

  route('POST', '/tasks/claim', async (req, res) => {
    const acc = await requireAccount(req, res);
    if (!acc) return;
    const b = (await body(req)) || {};
    const p = acc.profile;
    applyProfileAction(p, { k: 'task', period: b.period, slot: b.slot });
    await db.save(acc);
    json(res, 200, { profile: p });
  });

  route('POST', '/tasks/reroll', async (req, res) => {
    const acc = await requireAccount(req, res);
    if (!acc) return;
    json(res, 200, { profile: acc.profile });
  });

  // Batched profile mutations. The 0.8.29 client always has `backend.actions`,
  // so it sends lab/item/archive/quest/task through here and never calls the
  // per-feature routes above; without this route those purchases are lost.
  route('POST', '/profile/actions', async (req, res) => {
    const acc = await requireAccount(req, res);
    if (!acc) return;
    const b = (await body(req)) || {};
    const list = Array.isArray(b.actions) ? b.actions.slice(0, 64) : [];
    let applied = 0;
    for (const a of list) if (applyProfileAction(acc.profile, a)) applied++;
    await db.save(acc);
    json(res, 200, { profile: acc.profile, applied });
  });

  route('GET', '/records', async (req, res) => {
    const acc = await requireAccount(req, res);
    if (!acc) return;
    json(res, 200, []);
  });
  route('GET', '/records/endless', async (req, res) => {
    const acc = await requireAccount(req, res);
    if (!acc) return;
    json(res, 200, []);
  });

  // --- boards
  route('GET', '/leaderboard', async (req, res, url) => {
    const accounts = await db.allAccounts();
    json(res, 200, boardFor(
      accounts,
      url.searchParams.get('mode') || 'kills',
      url.searchParams.get('season') || 'week',
      Number(url.searchParams.get('limit') || 50),
      url,
      await optionalAccount(req),
    ));
  });
  route('GET', '/leaderboard/pokemon', () => ({ entries: [] }));
  route('GET', '/seasons/awards', (req, res) => json(res, 200, []));
  route('POST', '/seasons/claim', async (req, res) => {
    const acc = await requireAccount(req, res);
    if (!acc) return;
    json(res, 200, { profile: acc.profile });
  });

  // --- events
  route('GET', '/events/:id', (req, res, url, params) => {
    const ev = EVENTS.find((e) => e.id === params.id);
    if (!ev) return json(res, 404, { error: 'Event not found.' });
    json(res, 200, { event: ev, track: [], quests: [], points: 0, claimed: [] });
  });
  route('POST', '/events/:id/track', async (req, res) => {
    const acc = await requireAccount(req, res);
    if (!acc) return;
    json(res, 200, { profile: acc.profile });
  });
  route('POST', '/events/:id/quest', async (req, res) => {
    const acc = await requireAccount(req, res);
    if (!acc) return;
    json(res, 200, { profile: acc.profile });
  });

  // --- players
  route('GET', '/players', async (req, res, url) => {
    const id = url.searchParams.get('id');
    const name = url.searchParams.get('name');
    const acc = id ? await db.byId(id) : await db.byName(name);
    if (!acc) return json(res, 404, { error: 'Player not found.' });
    json(res, 200, {
      id: acc.id, name: acc.name, created: acc.created,
      species: acc.profile.lastSpecies, avatar: acc.profile.avatar,
      frame: acc.profile.frame, title: acc.profile.title, skins: acc.profile.skins,
      league: acc.profile.league, kills: {}, records: [], runs: [],
    });
  });
  // `/players/search` (name search, excluding yourself) is registered by the
  // shared social route table below, so both backends answer identically.
  route('POST', '/players/:id/report', (req, res) => json(res, 204, undefined));

  // --- runs
  route('POST', '/runs', async (req, res) => {
    const acc = await requireAccount(req, res);
    if (!acc) return;
    const b = (await body(req)) || {};
    const id = await db.newRunId();
    // Co-op: every member of a party must build the SAME world, so the seed
    // belongs to the party, not to the individual ticket (0.8.29 sends `party`).
    const seed = b.party
      ? await db.coop().partySeed(String(b.party))
      : (b.seed ?? crypto.randomInt(1, 2 ** 31));
    const run = {
      id, account: acc.id, cfg: b,
      seed, started: now(),
    };
    await db.putRun(run);
    json(res, 200, { id, seed, party: b.party ?? null, ranked: true, boosts: [] });
  });

  route('GET', '/runs/:id/build', async (req, res, url, params) => {
    const run = await db.getRun(params.id);
    if (!run) return json(res, 404, { error: 'Run not found.' });
    json(res, 200, { run: run.cfg, seed: run.seed });
  });

  route('POST', '/runs/:id/checkpoint', async (req, res, url, params) => {
    const run = await db.getRun(params.id);
    if (!run) return json(res, 404, { error: 'Run not found.' });
    const b = (await body(req)) || {};
    run.cps = (run.cps || []).concat(b.cps || []).slice(-600);
    await db.putRun(run);
    json(res, 204, undefined);
  });

  route('POST', '/runs/:id/finish', async (req, res, url, params) => {
    const acc = await requireAccount(req, res);
    if (!acc) return;
    const b = (await body(req)) || {};
    const result = b.result || {};
    const p = acc.profile;
    const run = await db.getRun(params.id);
    if (run) {
      run.finished = now();
      await db.putRun(run);
    }

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
    await db.save(acc);
    // Run finish is the one guaranteed Firestore write per run.
    await db.flush(acc.id);

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
  route('POST', '/clans/claim', (req, res) => json(res, 400, { error: 'Clans are not available locally.' }));
  route('POST', '/clans/expand', (req, res) => json(res, 400, { error: 'Clans are not available locally.' }));

  // --- clans: creation, membership, guide/notice, management, succession.
  // 0.8.29 added the guide, join requirements and leader succession; these are
  // the routes its client calls (see firebase/clans.mjs for the wire contract).
  for (const r of clanRoutes({
    me: async (req, res) => requireAccount(req, res),
    byName: (name) => db.byName(name),
    byId: (id) => db.byId(id),
    store: db.clans(),
  }).routes) routes.push(r);

  // --- social (friends, presence, rooms, invites) — shared with server.mjs so
  // both backends answer identically. `db.social()` is the persistence adapter.
  for (const r of socialRoutes(socialApi(db)).routes) routes.push(r);

  // --- co-op room service (their GT mesh signaling + lobby; see firebase/coop.mjs)
  for (const r of coopRoutes({
    me: async (req, res) => requireAccount(req, res),
    byName: (name) => db.byName(name),
    byId: (id) => db.byId(id),
    store: db.coop(),
    enabled: process.env.COOP_ENABLED !== '0',
  }).routes) routes.push(r);

  route('POST', '/feedback', (req, res) => json(res, 204, undefined));

  route('POST', '/account/rename', async (req, res) => {
    const acc = await requireAccount(req, res);
    if (!acc) return;
    const b = (await body(req)) || {};
    try {
      await db.rename(acc, b.name);
      json(res, 200, { name: acc.name });
    } catch (e) {
      if (e && e.code === 'CONFLICT') return json(res, 409, { error: 'That name is already in use.' });
      throw e;
    }
  });
  route('GET', '/account/rename', (req, res) => json(res, 200, { wait: 0 }));
  route('POST', '/account/reset', async (req, res) => {
    const acc = await requireAccount(req, res);
    if (!acc) return;
    acc.profile = newProfile(acc.name);
    await db.save(acc);
    await db.flush(acc.id);
    json(res, 200, { ok: true });
  });
  route('POST', '/account/delete', async (req, res) => {
    const acc = await requireAccount(req, res);
    if (!acc) return;
    await db.deleteAccount(acc.id);
    json(res, 200, { ok: true });
  });

  return { match: (method, pathname) => matchRoute(routes, method, pathname) };
}

/**
 * Adapter between `firebase/social.mjs`'s route table and the DB contract.
 * Everything the social core needs already exists on the DB interface except
 * the collections themselves, so the adapter owns the storage layer:
 *   MemoryDB   -> plain Maps on the instance (cheap, used by the tests)
 *   FirestoreDB-> `social_edges`, `social_pres`, `social_rooms`, `social_invites`
 */
function socialApi(db) {
  const store = db.social();
  return {
    me: async (req, res) => {
      const t = bearer(req);
      const acc = t ? await db.byToken(t) : null;
      if (!acc) json(res, 401, { error: 'Invalid session.' });
      return acc;
    },
    byId: (id) => db.byId(id),
    byName: (name) => db.byName(name),
    search: (q, limit) => db.searchByName(q, limit),
    edges: (uid) => store.edges(uid),
    saveEdge: (e) => store.saveEdge(e),
    delEdge: (k) => store.delEdge(k),
    pres: (ids) => store.pres(ids),
    setPres: (id, v) => store.setPres(id, v),
    room: (code) => store.room(code),
    myRoom: (uid) => store.myRoom(uid),
    saveRoom: (r) => store.saveRoom(r),
    delRoom: (code) => store.delRoom(code),
    invites: (uid) => store.invites(uid),
    saveInvite: (i) => store.saveInvite(i),
    delInvite: (from, to) => store.delInvite(from, to),
    flush: () => store.flush(),
  };
}

// ---------------------------------------------------------------- MemoryDB ----

// In-memory implementation of the DB contract. Mirrors the JSON store's data
// model and semantics; used by the test suite and as a reference for the
// Firebase adapter. Mutations happen in place (like `store` in server.mjs).
export class MemoryDB {
  constructor() {
    this.accounts = new Map(); // id -> account
    this.runs = new Map();     // id -> run
    this.nextRun = 1;
    this._byName = new Map();  // lowercase name -> id
  }

  async createGuest(name) {
    const acc = newAccount(name, true);
    this.accounts.set(acc.id, acc);
    this._byName.set(acc.name.toLowerCase(), acc.id);
    return acc;
  }

  async createRegistered(name, password) {
    if (this._byName.has(name.toLowerCase())) throw { code: 'CONFLICT' };
    const acc = newAccount(name, false);
    acc.password = await hashPassword(password);
    this.accounts.set(acc.id, acc);
    this._byName.set(acc.name.toLowerCase(), acc.id);
    return acc;
  }

  async login(name, password) {
    const acc = await this.byName(name);
    if (!acc || !(await checkPassword(password, acc.password))) return null;
    acc.token = token();
    acc.lastSeen = now();
    return acc;
  }

  async upgrade(account, name, password) {
    const existing = this._byName.get(name.toLowerCase());
    if (existing && existing !== account.id) throw { code: 'CONFLICT' };
    this._byName.delete(account.name.toLowerCase());
    account.name = name;
    account.guest = false;
    account.password = await hashPassword(password);
    account.profile.name = name;
    this._byName.set(name.toLowerCase(), account.id);
  }

  async rename(account, newName) {
    const existing = this._byName.get(newName.toLowerCase());
    if (existing && existing !== account.id) throw { code: 'CONFLICT' };
    this._byName.delete(account.name.toLowerCase());
    account.name = newName;
    account.profile.name = newName;
    this._byName.set(newName.toLowerCase(), account.id);
  }

  async deleteAccount(id) {
    const acc = this.accounts.get(id);
    if (acc) this._byName.delete(acc.name.toLowerCase());
    this.accounts.delete(id);
  }

  async byToken(t) {
    for (const a of this.accounts.values()) if (a.token === t) return a;
    return null;
  }

  async byId(id) { return this.accounts.get(id) || null; }

  async byName(name) {
    const id = this._byName.get(String(name || '').toLowerCase());
    return id ? this.accounts.get(id) || null : null;
  }

  async searchByName(q, limit) {
    const ql = String(q).toLowerCase();
    const out = [];
    for (const a of this.accounts.values()) {
      if (a.name.toLowerCase().includes(ql)) out.push(a);
      if (out.length >= limit) break;
    }
    return out;
  }

  async allAccounts() { return [...this.accounts.values()]; }

  /**
   * Social collections (friends, presence, rooms, invites). In memory these are
   * plain Maps; the Firestore adapter persists the same shapes.
   */
  social() {
    if (!this._social) {
      const edges = new Map(), pres = new Map(), rooms = new Map(), invites = new Map();
      this._social = {
        edges: async (uid) => [...edges.values()].filter((e) => e.users.includes(uid)),
        saveEdge: async (e) => { edges.set(edgeKey(e.users[0], e.users[1]), e); },
        delEdge: async (k) => { edges.delete(k); },
        pres: async (ids) => {
          const out = {};
          for (const id of ids) if (pres.has(id)) out[id] = pres.get(id);
          return out;
        },
        setPres: async (id, v) => { pres.set(id, v); },
        room: async (code) => rooms.get(code) || null,
        myRoom: async (uid) => {
          for (const r of rooms.values()) if (r.m && r.m[uid]) return r;
          return null;
        },
        saveRoom: async (r) => { rooms.set(r.code, r); },
        delRoom: async (code) => { rooms.delete(code); },
        invites: async (uid) => [...invites.values()].filter((i) => i.to === uid),
        saveInvite: async (i) => { invites.set(`${i.to}|${i.from}`, i); },
        delInvite: async (from, to) => { invites.delete(`${to}|${from}`); },
        flush: () => { /* nothing to persist */ },
      };
    }
    return this._social;
  }

  /**
   * Clan documents. Same adapter shape as `social()`; the Firestore adapter
   * persists the identical objects in a `clans` collection.
   */
  clans() {
    if (!this._clans) {
      const byId = new Map();
      const byName = new Map();
      const byMember = new Map();
      const reindex = () => {
        byName.clear();
        byMember.clear();
        for (const clan of byId.values()) {
          byName.set(clan.name.toLowerCase(), clan.id);
          for (const uid of clan.memberIds) byMember.set(uid, clan.id);
        }
      };
      this._clans = {
        get: async (id) => byId.get(id) || null,
        byName: async (name) => {
          const id = byName.get(String(name || '').toLowerCase());
          return id ? byId.get(id) || null : null;
        },
        byMember: async (uid) => {
          const id = byMember.get(uid);
          return id ? byId.get(id) || null : null;
        },
        list: async () => [...byId.values()],
        save: async (clan) => { byId.set(clan.id, clan); reindex(); },
        del: async (id) => { byId.delete(id); reindex(); },
      };
    }
    return this._clans;
  }

  /** Co-op rooms + invites + party seeds (same shape as `clans()`). */
  coop() {
    if (!this._coop) {
      const rooms = new Map(), invites = new Map(), parties = new Map();
      this._coop = {
        room: async (code) => rooms.get(String(code || '').toUpperCase()) || null,
        roomOf: async (uid) => [...rooms.values()].find((r) => r.members.some((m) => m.id === uid)) || null,
        saveRoom: async (room) => { rooms.set(room.code, room); },
        delRoom: async (code) => { rooms.delete(String(code || '').toUpperCase()); },
        invites: async (uid) => [...invites.values()].filter((i) => i.to === uid),
        saveInvite: async (i) => { invites.set(i.id, i); },
        delInvite: async (id) => { invites.delete(id); },
        partySeed: async (party) => {
          if (!parties.has(party)) parties.set(party, Math.floor(Math.random() * 2 ** 31));
          return parties.get(party);
        },
      };
    }
    return this._coop;
  }

  async save(account) { /* mutated in place; nothing to persist */ }

  async flush(id) { /* no-op */ }

  async newRunId() { return `run-${this.nextRun++}`; }

  async getRun(id) { return this.runs.get(id) || null; }

  async putRun(run) { this.runs.set(run.id, run); }
}

// -------------------------------------------------------------- FirestoreDB ----

const toDoc = (acc) => {
  const { id, ...rest } = acc;
  return { ...rest, nameLower: String(acc.name).toLowerCase() };
};
const fromDoc = (id, data) => ({ id, ...data });

// Real Firebase adapter. Lazily imports `firebase-admin`; see createFirebaseDB.
export class FirestoreDB {
  constructor(admin, { projectId, databaseURL }) {
    this.admin = admin;
    this.auth = admin.auth();
    this.db = admin.firestore();
    this.rtdb = null;
    if (databaseURL) {
      try { this.rtdb = admin.database(); } catch { this.rtdb = null; }
    }
    this._runsMem = new Map(); // fallback when RTDB is not configured
    this._cache = new Map();   // uid -> account (recently touched)
    this._dirty = new Set();
    this._timers = new Map();
    this._lastWrite = new Map();
    this._lastPres = new Map();
  }

  // -- Firestore write plumbing (debounced) --

  _scheduleFlush(uid) {
    if (this._timers.has(uid)) return;
    const last = this._lastWrite.get(uid) || 0;
    const delay = Math.max(1000, last + SAVE_GAP_MS - Date.now());
    const t = setTimeout(() => {
      this._timers.delete(uid);
      this._write(uid).catch((e) => console.error('firestore flush failed', e));
    }, delay);
    this._timers.set(uid, t);
  }

  _clearTimer(uid) {
    if (this._timers.has(uid)) {
      clearTimeout(this._timers.get(uid));
      this._timers.delete(uid);
    }
  }

  async _write(uid) {
    const acc = this._cache.get(uid);
    if (!acc) return;
    this._dirty.delete(uid);
    await this.db.collection('saves').doc(uid).set(toDoc(acc));
    this._lastWrite.set(uid, Date.now());
  }

  // immediate write (auth-critical durability: create/login/upgrade/rename/delete)
  async _putSave(acc) {
    this._cache.set(acc.id, acc);
    this._dirty.delete(acc.id);
    this._clearTimer(acc.id);
    await this.db.collection('saves').doc(acc.id).set(toDoc(acc));
    this._lastWrite.set(acc.id, Date.now());
  }

  _maybeHeartbeat(acc) {
    const last = this._lastPres.get(acc.id) || 0;
    if (Date.now() - last < PRESENCE_MS) return;
    this._lastPres.set(acc.id, Date.now());
    this.db.collection('pres').doc(acc.id)
      .set({ name: acc.name, lastSeen: Date.now() })
      .catch(() => {});
  }

  // -- DB contract --

  async createGuest(name) {
    const user = await this.auth.createUser({ displayName: name });
    const acc = newAccount(name, true);
    acc.id = user.uid;
    await this._putSave(acc);
    return acc;
  }

  async createRegistered(name, password) {
    const existing = await this.byName(name);
    if (existing) throw { code: 'CONFLICT' };
    const email = `${slug(name)}-${crypto.randomBytes(4).toString('hex')}@${AUTH_EMAIL_DOMAIN}`;
    const user = await this.auth.createUser({ email, password, displayName: name });
    const acc = newAccount(name, false);
    acc.id = user.uid;
    acc.email = email;
    acc.password = await hashPassword(password);
    await this._putSave(acc);
    return acc;
  }

  async login(name, password) {
    const acc = await this.byName(name);
    if (!acc || !(await checkPassword(password, acc.password))) return null;
    acc.token = token();
    acc.lastSeen = now();
    await this._putSave(acc);
    return acc;
  }

  async upgrade(account, name, password) {
    const existing = await this.byName(name);
    if (existing && existing.id !== account.id) throw { code: 'CONFLICT' };
    account.name = name;
    account.guest = false;
    account.password = await hashPassword(password);
    account.profile.name = name;
    // Best-effort: give the anonymous Firebase user a display name + password.
    await this.auth.updateUser(account.id, { displayName: name, password }).catch(() => {});
    await this._putSave(account);
  }

  async rename(account, newName) {
    const existing = await this.byName(newName);
    if (existing && existing.id !== account.id) throw { code: 'CONFLICT' };
    account.name = newName;
    account.profile.name = newName;
    await this.auth.updateUser(account.id, { displayName: newName }).catch(() => {});
    await this._putSave(account);
  }

  async deleteAccount(id) {
    this._cache.delete(id);
    this._dirty.delete(id);
    this._clearTimer(id);
    await this.auth.deleteUser(id).catch(() => {});
    await this.db.collection('saves').doc(id).delete();
  }

  async byToken(t) {
    for (const a of this._cache.values()) if (a.token === t) return a;
    const q = await this.db.collection('saves').where('token', '==', t).limit(1).get();
    if (q.empty) return null;
    const d = q.docs[0];
    const acc = fromDoc(d.id, d.data());
    this._cache.set(acc.id, acc);
    return acc;
  }

  async byId(id) {
    const cached = this._cache.get(id);
    if (cached) return cached;
    const d = await this.db.collection('saves').doc(id).get();
    if (!d.exists) return null;
    const acc = fromDoc(id, d.data());
    this._cache.set(id, acc);
    return acc;
  }

  async byName(name) {
    const k = String(name || '').toLowerCase();
    for (const a of this._cache.values()) if (a.name.toLowerCase() === k) return a;
    const q = await this.db.collection('saves').where('nameLower', '==', k).limit(1).get();
    if (q.empty) return null;
    const d = q.docs[0];
    const acc = fromDoc(d.id, d.data());
    this._cache.set(acc.id, acc);
    return acc;
  }

  async searchByName(q, limit) {
    const ql = String(q).toLowerCase();
    const snap = await this.db.collection('saves').get();
    const out = [];
    for (const d of snap.docs) {
      const acc = fromDoc(d.id, d.data());
      if (acc.name.toLowerCase().includes(ql)) out.push(acc);
      if (out.length >= limit) break;
    }
    return out;
  }

  async allAccounts() {
    const snap = await this.db.collection('saves').get();
    return snap.docs.map((d) => fromDoc(d.id, d.data()));
  }

  async save(account) {
    this._cache.set(account.id, account);
    this._dirty.add(account.id);
    this._scheduleFlush(account.id);
    this._maybeHeartbeat(account);
  }

  async flush(id) {
    const acc = this._cache.get(id);
    if (!acc) return;
    this._clearTimer(id);
    await this._write(id);
  }

  async newRunId() { return `run-${crypto.randomUUID()}`; }

  async getRun(id) {
    if (!this.rtdb) return this._runsMem.get(id) || null;
    const snap = await this.rtdb.ref(`runs/${id}`).once('value');
    return snap.val() || null;
  }

  async putRun(run) {
    if (!this.rtdb) { this._runsMem.set(run.id, run); return; }
    await this.rtdb.ref(`runs/${run.id}`).set(run);
  }

  /**
   * Social collections. Kept out of `saves/{uid}` so the big profile document is
   * never rewritten by a heartbeat, a friend request or a room change:
   *   social_edges/{uidA_uidB}   { users, from, to, status, names, at }
   *   social_pres/{uid}          { at, room, play }
   *   social_rooms/{code}        { code, host, open, started, seed, at, m }
   *   social_invites/{to_from}   { from, to, room, name, at }
   * Reads are point reads by key except `edges(uid)`, which uses the `users`
   * array-contains index (2 reads per friend list load, as in the reference).
   */
  social() {
    if (this._social) return this._social;
    const col = (name) => this.db.collection(name);
    const mem = {
      edges: new Map(), pres: new Map(), rooms: new Map(), invites: new Map(),
    };
    const doc = (name, id) => col(name).doc(id);
    this._social = {
      edges: async (uid) => {
        try {
          const q = await col('social_edges').where('users', 'array-contains', uid).get();
          return q.docs.map((d) => ({ ...d.data() }));
        } catch {
          return [...mem.edges.values()].filter((e) => e.users.includes(uid));
        }
      },
      saveEdge: async (e) => {
        const k = edgeKey(e.users[0], e.users[1]);
        mem.edges.set(k, e);
        await doc('social_edges', k).set({ ...e });
      },
      delEdge: async (k) => {
        mem.edges.delete(k);
        await doc('social_edges', k).delete().catch(() => {});
      },
      pres: async (ids) => {
        if (!ids.length) return {};
        const out = {};
        try {
          const snaps = await this.db.getAll(...ids.map((id) => doc('social_pres', id)));
          for (const s of snaps) if (s.exists) out[s.id] = s.data();
        } catch {
          for (const id of ids) if (mem.pres.has(id)) out[id] = mem.pres.get(id);
        }
        return out;
      },
      setPres: async (id, v) => {
        mem.pres.set(id, v);
        await doc('social_pres', id).set({ ...v }).catch(() => {});
      },
      room: async (code) => {
        try {
          const s = await doc('social_rooms', code).get();
          return s.exists ? s.data() : (mem.rooms.get(code) || null);
        } catch {
          return mem.rooms.get(code) || null;
        }
      },
      myRoom: async (uid) => {
        // The room lives in Firestore, but the API runs on every lambda instance
        // (and on any horizontally scaled host): the in-process map only holds
        // the rooms THIS instance wrote. Reading it alone made /friends report
        // "no room" whenever the poll landed on another instance, which the
        // client shows as "The room has closed" (and leaves the player with no
        // lobby, so they cannot choose a Pokémon). `uids` is the queryable copy
        // of the member map's keys.
        try {
          const q = await col('social_rooms').where('uids', 'array-contains', uid).limit(1).get();
          if (!q.empty) {
            const r = q.docs[0].data();
            mem.rooms.set(r.code, r);
            return r;
          }
          // A successful query is authoritative: this player is in no room.
          // Only legacy docs (written before `uids` existed) have no entry to
          // find here, so the instance map is consulted for those alone.
        } catch {
          // Query unavailable (missing index/rule): this instance's map is all
          // that is left.
        }
        for (const r of mem.rooms.values()) {
          if (r.m && r.m[uid] && !Array.isArray(r.uids)) return r;
        }
        return null;
      },
      saveRoom: async (r) => {
        const uids = Object.keys(r.m || {});
        mem.rooms.set(r.code, { ...r, uids });
        // `uids` mirrors Object.keys(r.m): Firestore cannot query dynamic map
        // keys, so membership has to be an array field.
        await doc('social_rooms', r.code).set({ ...r, uids }).catch(() => {});
      },
      delRoom: async (code) => {
        mem.rooms.delete(code);
        await doc('social_rooms', code).delete().catch(() => {});
      },
      invites: async (uid) => {
        try {
          const q = await col('social_invites').where('to', '==', uid).get();
          return q.docs.map((d) => ({ ...d.data() }));
        } catch {
          return [...mem.invites.values()].filter((i) => i.to === uid);
        }
      },
      saveInvite: async (i) => {
        mem.invites.set(`${i.to}|${i.from}`, i);
        await doc('social_invites', `${i.to}_${i.from}`).set({ ...i });
      },
      delInvite: async (from, to) => {
        mem.invites.delete(`${to}|${from}`);
        await doc('social_invites', `${to}_${from}`).delete().catch(() => {});
      },
      flush: () => {},
    };
    return this._social;
  }

  /** Co-op rooms, invites and party seeds (Firestore + in-process fallback). */
  coop() {
    if (!this._coopStore) {
      const rooms = new Map(), invites = new Map(), parties = new Map();
      const rdoc = (code) => this.db.collection('coop_rooms').doc(String(code));
      const idoc = (id) => this.db.collection('coop_invites').doc(String(id));
      const pdoc = (party) => this.db.collection('coop_parties').doc(String(party));
      this._coopStore = {
        room: async (code) => {
          const key = String(code || '').toUpperCase();
          try { const d = await rdoc(key).get(); if (d.exists) { rooms.set(key, d.data()); return d.data(); } } catch {}
          return rooms.get(key) || null;
        },
        roomOf: async (uid) => {
          for (const r of rooms.values()) if (r.members.some((m) => m.id === uid)) return r;
          try {
            const q = await this.db.collection('coop_rooms').where('memberIds', 'array-contains', uid).limit(1).get();
            if (!q.empty) { const r = q.docs[0].data(); rooms.set(r.code, r); return r; }
          } catch {}
          return null;
        },
        saveRoom: async (room) => {
          rooms.set(room.code, room);
          await rdoc(room.code).set({ ...room, memberIds: room.members.map((m) => m.id) });
        },
        delRoom: async (code) => {
          const key = String(code || '').toUpperCase();
          rooms.delete(key);
          await rdoc(key).delete().catch(() => {});
        },
        invites: async (uid) => {
          try {
            const q = await this.db.collection('coop_invites').where('to', '==', uid).get();
            return q.docs.map((d) => d.data());
          } catch { return [...invites.values()].filter((i) => i.to === uid); }
        },
        saveInvite: async (i) => { invites.set(i.id, i); await idoc(i.id).set(i).catch(() => {}); },
        delInvite: async (id) => { invites.delete(id); await idoc(id).delete().catch(() => {}); },
        partySeed: async (party) => {
          if (parties.has(party)) return parties.get(party);
          try {
            const d = await pdoc(party).get();
            if (d.exists) { parties.set(party, d.data().seed); return d.data().seed; }
          } catch {}
          const seed = Math.floor(Math.random() * 2 ** 31);
          parties.set(party, seed);
          await pdoc(party).set({ party, seed }).catch(() => {});
          return seed;
        },
      };
    }
    return this._coopStore;
  }

  /** Clan documents: Firestore `clans/{id}` with an in-process fallback. */
  clans() {
    if (!this._clansStore) {
      const mem = new Map();
      const doc = (id) => this.db.collection('clans').doc(id);
      const col = () => this.db.collection('clans');
      const cache = (clan) => { if (clan) mem.set(clan.id, clan); return clan; };
      this._clansStore = {
        get: async (id) => {
          try {
            const s = await doc(id).get();
            if (s.exists) return cache({ ...s.data() });
          } catch { /* fall through to the instance map */ }
          return mem.get(id) || null;
        },
        byName: async (name) => {
          const lower = String(name || '').toLowerCase();
          try {
            const q = await col().where('nameLower', '==', lower).limit(1).get();
            if (!q.empty) return cache({ ...q.docs[0].data() });
          } catch { /* index unavailable */ }
          for (const c of mem.values()) if (c.name.toLowerCase() === lower) return c;
          return null;
        },
        byMember: async (uid) => {
          try {
            const q = await col().where('memberIds', 'array-contains', uid).limit(1).get();
            if (!q.empty) return cache({ ...q.docs[0].data() });
          } catch { /* index unavailable */ }
          for (const c of mem.values()) if (c.memberIds.includes(uid)) return c;
          return null;
        },
        list: async () => {
          try {
            const q = await col().limit(200).get();
            return q.docs.map((d) => cache({ ...d.data() }));
          } catch {
            return [...mem.values()];
          }
        },
        save: async (clan) => {
          cache(clan);
          // `nameLower`/`memberIds` are the queryable copies of data Firestore
          // cannot index directly (case-insensitive name, membership).
          await doc(clan.id).set({
            ...clan,
            nameLower: clan.name.toLowerCase(),
            memberIds: [...clan.memberIds],
          });
        },
        del: async (id) => {
          mem.delete(id);
          await doc(id).delete().catch(() => {});
        },
      };
    }
    return this._clansStore;
  }
}

// Initialise `firebase-admin` and return a FirestoreDB. Throws a clear error if
// the SDK is not installed. `options`:
//   { serviceAccount: <path|object>, projectId, databaseURL }
export async function createFirebaseDB(options = {}) {
  let admin;
  try {
    admin = (await import('firebase-admin')).default;
  } catch (e) {
    throw new Error(
      'firebase-admin is not installed. Run: npm install firebase-admin' +
      ' and provide FIREBASE_SERVICE_ACCOUNT / FIREBASE_PROJECT_ID / FIREBASE_DATABASE_URL.',
    );
  }
  if (admin.apps.length === 0) {
    const opts = {};
    if (options.serviceAccount) {
      opts.credential = admin.credential.cert(options.serviceAccount);
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT) {
      const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
      opts.credential = sa ? admin.credential.cert(JSON.parse(sa)) : admin.credential.applicationDefault();
    } else {
      opts.credential = admin.credential.applicationDefault();
    }
    if (options.projectId || process.env.FIREBASE_PROJECT_ID) {
      opts.projectId = options.projectId || process.env.FIREBASE_PROJECT_ID;
    }
    if (options.databaseURL || process.env.FIREBASE_DATABASE_URL) {
      opts.databaseURL = options.databaseURL || process.env.FIREBASE_DATABASE_URL;
    }
    admin.initializeApp(opts);
  }
  return new FirestoreDB(admin, {
    projectId: options.projectId || process.env.FIREBASE_PROJECT_ID,
    databaseURL: options.databaseURL || process.env.FIREBASE_DATABASE_URL,
  });
}

// Convenience: create the DB + route table in one step.
export async function initFirebaseBackend(options) {
  const db = await createFirebaseDB(options);
  return { db, ...createBackend(db) };
}
