// PokéBonk — shared social core (friends, presence, rooms, invites).
//
// Used by BOTH backends so the JSON store (`server.mjs`) and the Firebase backend
// (`firebase/backend.mjs`) answer identically:
//   * `socialRoutes(api)` registers the route table. `api` adapts each backend's
//     persistence + auth to a small contract, so the handler logic is written once.
//   * `MemorySocial` is the in-memory implementation of that contract (tests, and
//     the reference the Firestore adapter follows).
//
// Data model (mirrors the reference `pokesurvivor/js/net/social.js`):
//   friend edge  { users:[idA,idB] (sorted), from, to, status:'pending'|'ok',
//                  names:{id:name}, at }
//   presence     { id -> { at, room, play } }     heartbeat, ONLINE_TTL window
//   room         { code, host, open, started, seed, at, m:{uid:{name,dex,shiny,at}} }
//   invite       { from, to, room, name, at }     one per (from,to) pair
//
// A player is in at most one room; the host leaving closes it (the reference
// removes `rooms/{id}` on host disconnect).
import crypto from 'node:crypto';
import { json, body, now } from './shared.mjs';

/** "Online" window. The reference used 40 min on a 30-min beat; the client
 *  beats every ~10 s while a social screen is open, so 2 min is the right TTL. */
export const ONLINE_TTL = 2 * 60 * 1000;
/** Invitations die on their own, like the reference's INVITE_TTL. */
export const INVITE_TTL = 3 * 60 * 1000;
export const MAX_FRIENDS = 100;
export const MAX_MEMBERS = 8;

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const newCode = () => {
  const b = crypto.randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return out;
};

export const edgeKey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

// ------------------------------------------------------------------ routes ----

/**
 * `api` contract (all async):
 *   me(req, res)          -> account|null    (writes the 401 itself)
 *   byId(id)              -> account|null
 *   byName(name)          -> account|null    (exact, case-insensitive)
 *   search(q, limit)      -> account[]       (name substring, case-insensitive)
 *   edges(uid)            -> edge[]          (edges whose `users` include uid)
 *   saveEdge(edge)        -> void            (keyed by edgeKey(users[0], users[1]))
 *   delEdge(key)          -> void
 *   pres(ids)             -> { id: {at,room,play} }   (only the ids asked for)
 *   setPres(id, v)        -> void
 *   room(code)            -> room|null
 *   myRoom(uid)           -> room|null       (the room whose `m` has uid)
 *   saveRoom(room)        -> void
 *   delRoom(code)         -> void
 *   invites(uid)          -> invite[]        (only invites addressed to uid)
 *   saveInvite(inv)       -> void
 *   delInvite(from, to)   -> void
 *   flush()               -> void            (persist; may be a no-op)
 */
export function socialRoutes(api) {
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  const flush = () => { try { api.flush(); } catch { /* best effort */ } };
  const onlineOf = (pres, id) => !!(pres[id] && pres[id].at);

  /** Prune expired invitations for `uid` while reading them. */
  async function invitesNow(uid) {
    const t = now();
    const out = [];
    for (const inv of (await api.invites(uid)) || []) {
      if (!inv) continue;
      if (t - (inv.at || 0) > INVITE_TTL) { await api.delInvite(inv.from, inv.to); continue; }
      out.push(inv);
    }
    return out;
  }

  /** Presence of `ids` (expired heartbeats read as offline). */
  async function presNow(ids) {
    const t = now();
    const raw = (await api.pres(ids)) || {};
    const live = {};
    for (const id of ids) {
      const v = raw[id];
      if (v && t - (v.at || 0) <= ONLINE_TTL) live[id] = v;
    }
    return live;
  }

  const publicRoom = (r) => ({
    code: r.code,
    host: r.host,
    open: r.open !== false,
    started: !!r.started,
    seed: r.started ? r.seed : null,
    // The host's run config (biome/tier/mode): guests build the same world.
    cfg: r.started && r.cfg ? r.cfg : null,
    at: r.at || 0,
    members: Object.entries(r.m || {})
      .map(([uid, v]) => ({ uid, name: v.name || '', dex: v.dex | 0, shiny: !!v.shiny, at: v.at || 0 }))
      .sort((a, b) => (a.uid === r.host ? -1 : b.uid === r.host ? 1 : a.at - b.at)),
  });

  /** Host's run config as published by POST /rooms/:code/start (validated). */
  const runCfg = (c) => {
    if (!c || typeof c !== 'object') return null;
    const out = {};
    if (typeof c.biome === 'string' && /^[a-z0-9-]{1,32}$/.test(c.biome)) out.biome = c.biome;
    if (Number.isInteger(c.tier) && c.tier >= 0 && c.tier <= 20) out.tier = c.tier;
    if (c.mode === 'standard' || c.mode === 'endless' || c.mode === 'tower') out.mode = c.mode;
    return Object.keys(out).length ? out : null;
  };

  /** The `GET /friends` payload; also what the client polls. */
  async function friendsPayload(acc) {
    const edges = ((await api.edges(acc.id)) || []).filter((e) => e && e.users);
    const friendIds = edges
      .filter((e) => e.status === 'ok')
      .map((e) => (e.users[0] === acc.id ? e.users[1] : e.users[0]));
    const [pres, room, invites] = await Promise.all([
      presNow(friendIds),
      api.myRoom(acc.id),
      invitesNow(acc.id),
    ]);
    const friends = [];
    const incoming = [];
    const outgoing = [];
    for (const e of edges) {
      const otherId = e.users[0] === acc.id ? e.users[1] : e.users[0];
      const otherName = (e.names && e.names[otherId]) || '';
      if (e.status === 'ok') {
        const p = pres[otherId];
        friends.push({
          id: otherId,
          name: otherName,
          online: onlineOf(pres, otherId),
          room: (p && p.room) || '',
          play: !!(p && p.play),
          at: e.at || 0,
        });
      } else if (e.to === acc.id) {
        incoming.push({ id: otherId, name: otherName, at: e.at || 0 });
      } else {
        outgoing.push({ id: otherId, name: otherName, at: e.at || 0 });
      }
    }
    friends.sort((a, b) => a.name.localeCompare(b.name));
    incoming.sort((a, b) => (a.at || 0) - (b.at || 0));
    outgoing.sort((a, b) => (a.at || 0) - (b.at || 0));
    const inv = invites.find((i) => i.to === acc.id) || null;
    return {
      friends, incoming, outgoing, max: MAX_FRIENDS,
      room: room ? publicRoom(room) : null,
      invite: inv ? { from: inv.from, name: inv.name, room: inv.room, at: inv.at } : null,
    };
  }

  /** Drop `acc` from `room`; the host leaving (or the last member) closes it. */
  async function leaveRoom(acc, room) {
    const wasHost = room.host === acc.id;
    if (room.m) delete room.m[acc.id];
    if (wasHost || !room.m || !Object.keys(room.m).length) {
      await api.delRoom(room.code);
      for (const inv of (await api.invites(acc.id)) || []) {
        if (inv && inv.room === room.code) await api.delInvite(inv.from, inv.to);
      }
    } else {
      await api.saveRoom(room);
    }
    const p = ((await api.pres([acc.id])) || {})[acc.id];
    if (p && p.room === room.code) await api.setPres(acc.id, { at: now(), room: '', play: false });
  }

  /** Insert `acc` into `room` (joining or accepting an invite). */
  async function enterRoom(acc, room, b) {
    const prev = room.m[acc.id] || {};
    room.m[acc.id] = {
      name: acc.name,
      dex: Number(b.dex ?? prev.dex) | 0,
      shiny: b.shiny != null ? !!b.shiny : !!prev.shiny,
      at: prev.at || now(),
    };
    await api.saveRoom(room);
    await api.setPres(acc.id, { at: now(), room: room.code, play: !!room.started });
  }

  // --- friends

  route('GET', '/friends', async (req, res) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    json(res, 200, await friendsPayload(acc));
  });

  route('POST', '/friends', async (req, res) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    const b = (await body(req)) || {};
    const name = clean(b.name ?? b.user, 24);
    if (!name) return json(res, 400, { error: 'Enter your friend\'s exact nickname.' });
    const other = await api.byName(name);
    if (!other) return json(res, 404, { error: 'No player found with that nickname.' });
    if (other.id === acc.id) return json(res, 400, { error: 'That is you.' });
    const mine = ((await api.edges(acc.id)) || []).filter((e) => e && e.users);
    const existing = mine.find((e) => e.users.includes(other.id));
    if (existing) {
      if (existing.status === 'ok') return json(res, 409, { error: 'You are already friends.' });
      if (existing.to === acc.id) return json(res, 409, { error: 'That player already sent you a request: accept it.' });
      return json(res, 409, { error: 'You already sent a request.' });
    }
    if (mine.filter((e) => e.status === 'ok').length >= MAX_FRIENDS) {
      return json(res, 409, { error: 'Your friends list is full.' });
    }
    await api.saveEdge({
      users: [acc.id, other.id].sort(),
      from: acc.id,
      to: other.id,
      status: 'pending',
      names: { [acc.id]: acc.name, [other.id]: other.name },
      at: now(),
    });
    flush();
    json(res, 200, { state: 'sent', to: { id: other.id, name: other.name } });
  });

  /** The pending edge between `acc` and `otherId`, if any. */
  async function edgeWith(acc, otherId) {
    const mine = (await api.edges(acc.id)) || [];
    return mine.find((e) => e && e.users && e.users.includes(otherId)) || null;
  }

  route('POST', '/friends/requests/:id/accept', async (req, res, url, params) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    const e = await edgeWith(acc, params.id);
    if (!e) return json(res, 404, { error: 'No request found from that player.' });
    if (e.status === 'ok') return json(res, 409, { error: 'You are already friends.' });
    if (e.to !== acc.id) return json(res, 409, { error: 'You sent that request: you cannot accept it.' });
    e.status = 'ok';
    e.at = now();
    e.names = { ...(e.names || {}), [acc.id]: acc.name };
    await api.saveEdge(e);
    flush();
    const other = await api.byId(e.users[0] === acc.id ? e.users[1] : e.users[0]);
    json(res, 200, { state: 'friends', friend: { id: other ? other.id : '', name: other ? other.name : '' } });
  });

  route('POST', '/friends/requests/:id/decline', async (req, res, url, params) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    const e = await edgeWith(acc, params.id);
    if (!e) return json(res, 404, { error: 'No request found from that player.' });
    if (e.status === 'ok') return json(res, 409, { error: 'You are already friends: remove them from your list.' });
    if (e.to !== acc.id) return json(res, 409, { error: 'That request was not sent to you.' });
    await api.delEdge(edgeKey(e.users[0], e.users[1]));
    flush();
    json(res, 200, { state: 'none' });
  });

  route('POST', '/friends/requests/:id/cancel', async (req, res, url, params) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    const e = await edgeWith(acc, params.id);
    if (!e) return json(res, 200, { state: 'none' });
    if (e.status === 'ok') return json(res, 409, { error: 'You are already friends: remove them from your list.' });
    if (e.from !== acc.id) return json(res, 409, { error: 'You did not send that request.' });
    await api.delEdge(edgeKey(e.users[0], e.users[1]));
    flush();
    json(res, 200, { state: 'none' });
  });

  route('POST', '/friends/remove', async (req, res) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    const b = (await body(req)) || {};
    const otherId = clean(b.id ?? b.user, 64);
    if (!otherId) return json(res, 400, { error: 'Missing player.' });
    const e = await edgeWith(acc, otherId);
    if (!e) return json(res, 404, { error: 'Not on your friends list.' });
    await api.delEdge(edgeKey(e.users[0], e.users[1]));
    flush();
    json(res, 200, { state: 'none' });
  });

  // --- presence

  route('POST', '/presence', async (req, res) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    const b = (await body(req)) || {};
    await api.setPres(acc.id, { at: now(), room: clean(b.room, 12), play: !!b.play });
    flush();
    json(res, 200, { online: await onlineOfFriends(acc), ttl: ONLINE_TTL, at: now() });
  });

  route('GET', '/presence', async (req, res) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    json(res, 200, { online: await onlineOfFriends(acc), ttl: ONLINE_TTL, at: now() });
  });

  /** id -> { online, room, play, at } for every accepted friend. */
  async function onlineOfFriends(acc) {
    const mine = (await api.edges(acc.id)) || [];
    const ids = mine
      .filter((e) => e && e.users && e.status === 'ok')
      .map((e) => (e.users[0] === acc.id ? e.users[1] : e.users[0]));
    const pres = await presNow(ids);
    const out = {};
    for (const id of ids) {
      const p = pres[id];
      out[id] = p
        ? { online: true, room: p.room || '', play: !!p.play, at: p.at }
        : { online: false, room: '', play: false, at: 0 };
    }
    return out;
  }

  // --- player search (add-by-name autocomplete; excludes yourself)
  route('GET', '/players/search', async (req, res, url) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    const q = clean(url.searchParams.get('q'), 24).toLowerCase().replace(/^@/, '');
    if (q.length < 2) return json(res, 200, { players: [] });
    const found = ((await api.search(q, 12)) || []).filter((a) => a.id !== acc.id).slice(0, 8);
    const pres = await presNow(found.map((a) => a.id));
    json(res, 200, {
      players: found.map((a) => ({
        id: a.id, name: a.name, online: onlineOf(pres, a.id),
        species: a.profile && a.profile.lastSpecies,
        avatar: a.profile && a.profile.avatar,
      })),
    });
  });

  // --- rooms

  route('POST', '/rooms', async (req, res) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    const b = (await body(req)) || {};
    const cur = await api.myRoom(acc.id);
    if (cur) await leaveRoom(acc, cur);
    let code = newCode();
    for (let i = 0; i < 8 && (await api.room(code)); i++) code = newCode();
    const room = {
      code,
      host: acc.id,
      open: true,
      started: false,
      seed: null,
      at: now(),
      m: {},
    };
    await api.saveRoom(room);
    await enterRoom(acc, room, b);
    flush();
    json(res, 200, { room: publicRoom(room) });
  });

  route('GET', '/rooms/:code', async (req, res, url, params) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    const room = await api.room(String(params.code || '').toUpperCase());
    if (!room) return json(res, 404, { error: 'That room no longer exists.' });
    json(res, 200, { room: publicRoom(room) });
  });

  route('POST', '/rooms/:code/join', async (req, res, url, params) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    const room = await api.room(String(params.code || '').toUpperCase());
    if (!room) return json(res, 404, { error: 'That room no longer exists.' });
    if (!room.m || !room.m[room.host]) {
      await api.delRoom(room.code);
      flush();
      return json(res, 404, { error: 'That room no longer exists.' });
    }
    if (!room.m[acc.id]) {
      if (room.started || room.open === false) return json(res, 409, { error: 'The game in that room has already started.' });
      if (Object.keys(room.m).length >= MAX_MEMBERS) {
        return json(res, 409, { error: `Room is full (max ${MAX_MEMBERS}).` });
      }
    }
    const cur = await api.myRoom(acc.id);
    if (cur && cur.code !== room.code) await leaveRoom(acc, cur);
    await enterRoom(acc, room, (await body(req)) || {});
    flush();
    json(res, 200, { room: publicRoom(room) });
  });

  route('POST', '/rooms/:code/leave', async (req, res, url, params) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    const room = await api.room(String(params.code || '').toUpperCase());
    if (!room || !room.m || !room.m[acc.id]) return json(res, 200, { ok: true });
    await leaveRoom(acc, room);
    flush();
    json(res, 200, { ok: true });
  });

  route('POST', '/rooms/:code/start', async (req, res, url, params) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    const room = await api.room(String(params.code || '').toUpperCase());
    if (!room) return json(res, 404, { error: 'That room no longer exists.' });
    if (room.host !== acc.id) return json(res, 403, { error: 'Only the host can start the game.' });
    const members = Object.keys(room.m || {});
    if (members.length < 2) return json(res, 409, { error: 'You need at least one friend in the room.' });
    const b = (await body(req)) || {};
    room.open = false;
    room.started = true;
    room.seed = Number.isInteger(b.seed) ? b.seed : crypto.randomInt(1, 2 ** 31);
    room.cfg = runCfg(b.cfg);
    room.at = now();
    await api.saveRoom(room);
    for (const uid of members) await api.setPres(uid, { at: now(), room: room.code, play: true });
    for (const inv of (await api.invites(acc.id)) || []) {
      if (inv && inv.room === room.code) await api.delInvite(inv.from, inv.to);
    }
    flush();
    json(res, 200, { room: publicRoom(room), seed: room.seed });
  });

  // --- invites

  route('POST', '/invites', async (req, res) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    const b = (await body(req)) || {};
    const to = clean(b.to, 64);
    if (!to) return json(res, 400, { error: 'Missing player to invite.' });
    if (to === acc.id) return json(res, 400, { error: 'You cannot invite yourself.' });
    const edge = await edgeWith(acc, to);
    if (!edge || edge.status !== 'ok') return json(res, 403, { error: 'You can only invite friends.' });
    const other = await api.byId(to);
    if (!other) return json(res, 404, { error: 'That player no longer exists.' });

    let room = await api.myRoom(acc.id);
    if (!room) {
      // Inviting always means "come to my room": create one if there is none.
      let code = newCode();
      for (let i = 0; i < 8 && (await api.room(code)); i++) code = newCode();
      room = { code, host: acc.id, open: true, started: false, seed: null, at: now(), m: {} };
      await api.saveRoom(room);
      await enterRoom(acc, room, b);
    }
    if (room.host !== acc.id) return json(res, 403, { error: 'Only the room host can invite.' });
    if (room.started) return json(res, 409, { error: 'The game in that room has already started.' });
    if (b.room && String(b.room).toUpperCase() !== room.code) {
      return json(res, 403, { error: 'You can only invite to your own room.' });
    }
    const inv = { from: acc.id, to: other.id, room: room.code, name: acc.name, at: now() };
    await api.saveInvite(inv);
    await api.setPres(acc.id, { at: now(), room: room.code, play: false });
    flush();
    json(res, 200, { invite: inv, room: publicRoom(room) });
  });

  route('GET', '/invites', async (req, res) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    const list = (await invitesNow(acc.id)).filter((i) => i.to === acc.id);
    json(res, 200, {
      invites: list.map((i) => ({ from: i.from, name: i.name, room: i.room, at: i.at })),
      ttl: INVITE_TTL,
    });
  });

  route('POST', '/invites/:from/accept', async (req, res, url, params) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    const inv = (await invitesNow(acc.id)).find((i) => i.to === acc.id && i.from === params.from);
    if (!inv) return json(res, 404, { error: 'The invitation has expired.' });
    await api.delInvite(inv.from, inv.to);
    const room = await api.room(inv.room);
    if (!room) { flush(); return json(res, 404, { error: 'That room no longer exists.' }); }
    if (room.started) { flush(); return json(res, 409, { error: 'The game in that room has already started.' }); }
    const cur = await api.myRoom(acc.id);
    if (cur && cur.code !== room.code) await leaveRoom(acc, cur);
    await enterRoom(acc, room, (await body(req)) || {});
    flush();
    json(res, 200, { room: publicRoom(room) });
  });

  route('POST', '/invites/:from/decline', async (req, res, url, params) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    await api.delInvite(params.from, acc.id);
    flush();
    json(res, 200, { ok: true });
  });

  return { routes, publicRoom };
}

// -------------------------------------------------------------- memory DB ----

/**
 * In-memory implementation of the `api` contract. Used by the tests and as the
 * reference the Firestore adapter mirrors. `accounts` is a Map id -> account.
 */
export class MemorySocial {
  constructor(accounts) {
    this.accounts = accounts;          // Map id -> account (shared with the caller)
    this._edges = new Map();           // key -> edge
    this._pres = new Map();            // id -> { at, room, play }
    this._rooms = new Map();           // code -> room
    this._invites = new Map();         // `${to}|${from}` -> invite
  }

  async me(req, res) {
    const a = req.headers.authorization || '';
    const t = a.startsWith('Bearer ') ? a.slice(7) : null;
    let acc = null;
    if (t) for (const x of this.accounts.values()) if (x.token === t) { acc = x; break; }
    if (!acc) json(res, 401, { error: 'Invalid session.' });
    return acc;
  }

  async byId(id) { return this.accounts.get(id) || null; }

  async byName(name) {
    const k = String(name || '').toLowerCase();
    for (const a of this.accounts.values()) if (a.name.toLowerCase() === k) return a;
    return null;
  }

  async search(q, limit) {
    const ql = String(q || '').toLowerCase();
    const out = [];
    for (const a of this.accounts.values()) {
      if (a.name.toLowerCase().includes(ql)) out.push(a);
      if (out.length >= limit) break;
    }
    return out;
  }

  async edges(uid) { return [...this._edges.values()].filter((e) => e.users.includes(uid)); }
  async saveEdge(e) { this._edges.set(edgeKey(e.users[0], e.users[1]), e); }
  async delEdge(k) { this._edges.delete(k); }

  async pres(ids) {
    const out = {};
    for (const id of ids) if (this._pres.has(id)) out[id] = this._pres.get(id);
    return out;
  }
  async setPres(id, v) { this._pres.set(id, v); }

  async room(code) { return this._rooms.get(code) || null; }
  async myRoom(uid) {
    for (const r of this._rooms.values()) if (r.m && r.m[uid]) return r;
    return null;
  }
  async saveRoom(r) { this._rooms.set(r.code, r); }
  async delRoom(code) { this._rooms.delete(code); }

  async invites(uid) {
    return [...this._invites.values()].filter((i) => i.to === uid);
  }
  async saveInvite(inv) { this._invites.set(`${inv.to}|${inv.from}`, inv); }
  async delInvite(from, to) { this._invites.delete(`${to}|${from}`); }

  flush() { /* nothing to persist */ }
}
