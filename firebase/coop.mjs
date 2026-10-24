// firebase/coop.mjs — the `/coop/*` API the 0.8.29 client speaks.
//
// Contract read from the shipped client (main-DEBvJLhQ-mvl14oup.js):
//
//   GET  /coop/access                       -> { show, play }      (boot check)
//   POST /coop/rooms                        {species, skin}       -> payload
//   POST /coop/rooms/:code/join             {species, skin}       -> payload
//   GET  /coop/rooms/:code?after&chat                             -> payload
//   POST /coop/rooms/:code/me               {species?, skin?, ready?} -> payload
//   POST /coop/rooms/:code/settings         {biome, tier}         -> payload
//   POST /coop/rooms/:code/signal           {to, kind, data}      -> payload
//   POST /coop/rooms/:code/kick             {user}                -> payload
//   POST /coop/rooms/:code/invite           {user}                -> 204
//   POST /coop/rooms/:code/start            {}                    -> payload
//   POST /coop/rooms/:code/leave            {}                    -> payload
//   GET  /coop/invites                                            -> [{id, from, code,…}]
//   POST /coop/invites/:id/decline          {}                    -> 204
//   GET  /coop/board?size&biome&tier&season                       -> { entries }
//
// "payload" = { room, me, signals, chat }:
//   room    { code, host, version, state:'lobby'|'started', biome, tier, party, seed,
//             members:[{ id, slot, name, species, member, skin, tag, ready }] }
//   signals [{ id, from, to, kind, data }]   id strictly increasing per room
//   chat    [{ id, from, text }]             id strictly increasing per room
//
// The client polls with `after=<lastSignalId>&chat=<lastChatId>` and merges by id,
// bumps `version` on every mutation, and treats a 403/404/410 as "room closed".

import { json, body } from './shared.mjs';

export const COOP_MAX_MEMBERS = 4;

// The 0.8.29 client validates the code as /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/:
// ambiguous glyphs (I, L, O, 0, 1) are excluded, so we must never emit them.
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;

/**
 * ICE configuration handed to the browser (0.8.34 asks for it before creating
 * peer connections). STUN only by default; set COOP_ICE_SERVERS to a JSON array
 * to add TURN, e.g. [{"urls":"turn:host:3478","username":"u","credential":"p"}].
 */
export const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export function iceServers(env = process.env) {
  const raw = env.COOP_ICE_SERVERS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch { /* fall through to defaults */ }
  }
  return DEFAULT_ICE_SERVERS;
}

const randomCode = () =>
  Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
const ROOM_TTL_MS = 45 * 60 * 1000;   // idle rooms are collected lazily

const nowMs = () => Date.now();

/** Public projection of a room (never leaks another player's token). */
function payload(room, meId, after = 0, chatAfter = 0) {
  return {
    room: {
      code: room.code,
      host: room.host,
      version: room.version,
      state: room.state,
      biome: room.biome,
      tier: room.tier,
      party: room.party,
      seed: room.seed,
      members: room.members.map((m) => ({
        id: m.id, slot: m.slot, name: m.name, species: m.species,
        member: m.member, skin: m.skin, tag: m.tag, ready: m.ready,
      })),
    },
    me: meId,
    signals: room.signals.filter((s) => s.id > after && (s.to === meId || s.to === '*')),
    chat: room.chat.filter((c) => c.id > chatAfter),
  };
}

function bump(room) {
  room.version++;
  room.at = nowMs();
}

function addMember(room, acc, species, skin) {
  const used = new Set(room.members.map((m) => m.slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  const member = {
    id: acc.id,
    slot,
    name: acc.name,
    species: species | 0 || acc.profile.lastSpecies || 4,
    member: acc.profile.starter ?? 0,
    skin: skin ?? null,
    tag: acc.profile.clanTag ?? null,
    guest: !!acc.guest,
    ready: false,
  };
  room.members.push(member);
  return member;
}

/**
 * @param {object} api
 * @param {(req,res)=>Promise<object|null>} api.me   authenticated account (answers 401 itself)
 * @param {(name:string)=>Promise<object|null>} api.byName
 * @param {(uid:string)=>Promise<object|null>} api.byId
 * @param {object} api.store  db.coop()
 * @param {boolean} [api.enabled]  feature flag reported by /coop/access
 */
export function coopRoutes(api) {
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });
  const enabled = api.enabled !== false;

  /** Loads a room for the caller; answers the right status when unusable. */
  const roomFor = async (req, res, code, { host = false } = {}) => {
    const acc = await api.me(req, res);
    if (!acc) return null;
    const room = await api.store.room(code);
    if (!room) { json(res, 404, { error: 'The room has closed.' }); return null; }
    if (!room.members.some((m) => m.id === acc.id)) {
      json(res, 403, { error: 'You are not in that room.' });
      return null;
    }
    if (host && room.host !== acc.id) {
      json(res, 403, { error: 'Only the host can do that.' });
      return null;
    }
    return { acc, room };
  };

  route('GET', '/coop/access', async (req, res) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    json(res, 200, { show: enabled, play: enabled });
  });

  route('GET', '/coop/ice', async (req, res) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    json(res, 200, { servers: iceServers() });
  });

  route('POST', '/coop/rooms', async (req, res) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    if (!enabled) return json(res, 403, { error: 'Co-op is paused.' });
    const b = (await body(req)) || {};
    // One room per player. Re-creating while already in a lobby returns that same
    // room instead of destroying it — a double click used to invalidate the code
    // the player had just been shown.
    const existing = await api.store.roomOf(acc.id);
    if (existing) {
      if (existing.state === 'lobby') return json(res, 200, payload(existing, acc.id));
      await api.store.delRoom(existing.code);
    }
    // Upstream validates the code client-side: exactly 4 letters/digits
    // ("El código tiene 4 letras o números"), and the join widget has 4 tiles.
    let code = '';
    for (let i = 0; i < 20 && !code; i++) {
      const candidate = randomCode();
      if (!(await api.store.room(candidate))) code = candidate;
    }
    if (!code) return json(res, 503, { error: 'Could not allocate a room code.' });
    const room = {
      code,
      host: acc.id,
      version: 1,
      state: 'lobby',
      biome: 'forest',
      tier: 1,
      party: null,
      seed: null,
      at: nowMs(),
      signals: [],
      chat: [],
      members: [],
      nextSignal: 1,
      nextChat: 1,
    };
    addMember(room, acc, b.species, b.skin);
    await api.store.saveRoom(room);
    json(res, 200, payload(room, acc.id));
  });

  route('POST', '/coop/rooms/:code/join', async (req, res, _url, params) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    if (!enabled) return json(res, 403, { error: 'Co-op is paused.' });
    const room = await api.store.room(params.code);
    if (!room) return json(res, 404, { error: 'The room has closed.' });
    if (room.state === 'started') return json(res, 400, { error: 'That run already started.' });
    if (room.members.length >= COOP_MAX_MEMBERS) return json(res, 400, { error: 'That room is full.' });
    if (room.members.some((m) => m.id === acc.id)) return json(res, 200, payload(room, acc.id));
    const b = (await body(req)) || {};
    addMember(room, acc, b.species, b.skin);
    bump(room);
    await api.store.saveRoom(room);
    json(res, 200, payload(room, acc.id));
  });

  route('GET', '/coop/rooms/:code', async (req, res, url, params) => {
    const ctx = await roomFor(req, res, params.code);
    if (!ctx) return;
    const after = Math.max(0, Math.trunc(Number(url.searchParams.get('after')) || 0));
    const chatAfter = Math.max(0, Math.trunc(Number(url.searchParams.get('chat')) || 0));
    json(res, 200, payload(ctx.room, ctx.acc.id, after, chatAfter));
  });

  route('POST', '/coop/rooms/:code/me', async (req, res, _url, params) => {
    const ctx = await roomFor(req, res, params.code);
    if (!ctx) return;
    const b = (await body(req)) || {};
    const me = ctx.room.members.find((m) => m.id === ctx.acc.id);
    if (b.species !== undefined) me.species = b.species | 0;
    if (b.skin !== undefined) me.skin = b.skin ?? null;
    if (b.ready !== undefined) me.ready = !!b.ready;
    bump(ctx.room);
    await api.store.saveRoom(ctx.room);
    json(res, 200, payload(ctx.room, ctx.acc.id));
  });

  route('POST', '/coop/rooms/:code/settings', async (req, res, _url, params) => {
    const ctx = await roomFor(req, res, params.code, { host: true });
    if (!ctx) return;
    const b = (await body(req)) || {};
    if (typeof b.biome === 'string') ctx.room.biome = b.biome;
    if (Number.isFinite(+b.tier)) ctx.room.tier = Math.max(1, Math.trunc(+b.tier));
    bump(ctx.room);
    await api.store.saveRoom(ctx.room);
    json(res, 200, payload(ctx.room, ctx.acc.id));
  });

  route('POST', '/coop/rooms/:code/signal', async (req, res, _url, params) => {
    const ctx = await roomFor(req, res, params.code);
    if (!ctx) return;
    const b = (await body(req)) || {};
    if (typeof b.kind !== 'string' || typeof b.to !== 'string') {
      return json(res, 400, { error: 'Invalid signal.' });
    }
    // Signals are signaling-plane data (SDP/ICE): keep them room-scoped and capped.
    ctx.room.signals.push({ id: ctx.room.nextSignal++, from: ctx.acc.id, to: b.to, kind: b.kind, data: b.data ?? null });
    if (ctx.room.signals.length > 400) ctx.room.signals = ctx.room.signals.slice(-200);
    bump(ctx.room);
    await api.store.saveRoom(ctx.room);
    json(res, 200, payload(ctx.room, ctx.acc.id));
  });

  route('POST', '/coop/rooms/:code/kick', async (req, res, _url, params) => {
    const ctx = await roomFor(req, res, params.code, { host: true });
    if (!ctx) return;
    const b = (await body(req)) || {};
    ctx.room.members = ctx.room.members.filter((m) => m.id !== b.user);
    bump(ctx.room);
    await api.store.saveRoom(ctx.room);
    json(res, 200, payload(ctx.room, ctx.acc.id));
  });

  route('POST', '/coop/rooms/:code/invite', async (req, res, _url, params) => {
    const ctx = await roomFor(req, res, params.code);
    if (!ctx) return;
    const b = (await body(req)) || {};
    const target = b.user ? await api.byId(b.user) : b.name ? await api.byName(b.name) : null;
    if (!target) return json(res, 404, { error: 'Player not found.' });
    if (target.id === ctx.acc.id) return json(res, 400, { error: 'That is you.' });
    if (ctx.room.members.length >= COOP_MAX_MEMBERS) return json(res, 400, { error: 'That room is full.' });
    if (!ctx.room.members.some((m) => m.id === target.id)) {
      await api.store.saveInvite({
        id: ctx.room.code,
        code: ctx.room.code,
        from: {
          id: ctx.acc.id,
          name: ctx.acc.name,
          avatar: ctx.acc.profile.avatar ?? '',
          frame: ctx.acc.profile.frame ?? '',
          species: ctx.acc.profile.lastSpecies ?? 4,
          skins: ctx.acc.profile.skins ?? [],
        },
        to: target.id,
        created: nowMs(),
      });
    }
    json(res, 204, undefined);
  });

  route('POST', '/coop/rooms/:code/start', async (req, res, _url, params) => {
    const ctx = await roomFor(req, res, params.code, { host: true });
    if (!ctx) return;
    // Party-scoped seed: every member's `/runs` ticket must carry this one, so the
    // room announces exactly what the ticket will return.
    if (!ctx.room.party) ctx.room.party = `party-${ctx.room.code.toLowerCase()}`;
    ctx.room.seed = await api.store.partySeed(ctx.room.party);
    ctx.room.state = 'started';
    bump(ctx.room);
    await api.store.saveRoom(ctx.room);
    json(res, 200, payload(ctx.room, ctx.acc.id));
  });

  route('POST', '/coop/rooms/:code/leave', async (req, res, _url, params) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    const room = await api.store.room(params.code);
    if (!room) return json(res, 200, { room: null, me: acc.id, signals: [], chat: [] });
    room.members = room.members.filter((m) => m.id !== acc.id);
    if (!room.members.length) {
      await api.store.delRoom(room.code);
      return json(res, 200, { room: null, me: acc.id, signals: [], chat: [] });
    }
    if (room.host === acc.id) {
      room.host = room.members.slice().sort((a, b) => a.slot - b.slot)[0].id;
      room.state = 'lobby';
    }
    bump(room);
    await api.store.saveRoom(room);
    json(res, 200, payload(room, acc.id));
  });

  route('POST', '/coop/rooms/:code/chat', async (req, res, _url, params) => {
    const ctx = await roomFor(req, res, params.code);
    if (!ctx) return;
    const b = (await body(req)) || {};
    const text = String(b.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (text) {
      ctx.room.chat.push({ id: ctx.room.nextChat++, from: ctx.acc.id, text });
      if (ctx.room.chat.length > 80) ctx.room.chat = ctx.room.chat.slice(-80);
      bump(ctx.room);
      await api.store.saveRoom(ctx.room);
    }
    json(res, 200, payload(ctx.room, ctx.acc.id));
  });

  // Team standing for the room's map/difficulty (0.8.34 renders it in the room).
  route('GET', '/coop/rooms/:code/standing', async (req, res, _url, params) => {
    const ctx = await roomFor(req, res, params.code);
    if (!ctx) return;
    // Upstream only ranks teams where every member has a real account; guests
    // make the team unranked, which the room UI states explicitly.
    const ranked = ctx.room.members.every((m) => !m.guest);
    json(res, 200, {
      biome: ctx.room.biome,
      tier: ctx.room.tier,
      ranked,
      best: null,
      teams: 0,
    });
  });

  route('GET', '/coop/invites', async (req, res) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    json(res, 200, await api.store.invites(acc.id));
  });

  route('POST', '/coop/invites/:id/decline', async (req, res, _url, params) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    await api.store.delInvite(params.id);
    json(res, 204, undefined);
  });

  route('GET', '/coop/board', async (req, res) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    json(res, 200, { entries: [] });
  });

  return { routes };
}
