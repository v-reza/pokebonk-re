// firebase/clans.mjs — clan domain + routes for the local backend.
//
// 0.8.29 added the clan guide, join requirements and leader succession, and its
// client calls twelve management routes our fork answered with a flat
// "Clans are not available locally." This module implements them against a small
// clan store (`db.clans()`), following the same adapter style as social.mjs.
//
// Wire contract read from the 0.8.29 client:
//   POST /clans                 {name, tag, emblem?, access?}      -> {clan, profile}
//   POST /clans/:id/join        {message?}                         -> {clan} | {request:true}
//   POST /clans/settings        {req…, access?}                    -> {clan}
//   POST /clans/guide           {text}                             -> {clan}
//   POST /clans/notice          {text}                             -> {clan}
//   POST /clans/invite          {name}                             -> 204
//   POST /clans/uninvite        {id}                               -> {clan}
//   POST /clans/kick            {user}                             -> {clan}
//   POST /clans/role            {user, role}                       -> {clan}
//   POST /clans/leave           {}                                 -> {clan:null}
//   POST /clans/disband         {confirm}                          -> 204
//   POST /clans/rename          {name, tag?}                       -> {clan, profile}
//   POST /clans/emblem          {emblem}                           -> {clan}
//   POST /clans/mute            {user, hours}                      -> {clan}
//
// Succession (0.8.29 rule, from the shipped string): if the leader has not been
// seen for 7 days, leadership moves to the officer seen in the last 3 days with
// the most clan points; if there is none, to a member. It is applied on every
// read/write that materialises a clan, so no timer is required.

import { json, body } from './shared.mjs';

export const CLAN_RULES = Object.freeze({
  LEADER_IDLE_MS: 7 * 24 * 60 * 60 * 1000,
  OFFICER_ACTIVE_MS: 3 * 24 * 60 * 60 * 1000,
  MAX_NAME: 24,
  MAX_TAG: 5,
  MAX_GUIDE: 2000,
  MAX_NOTICE: 280,
  MAX_MEMBERS: 30,
  ROLES: ['leader', 'officer', 'member'],
});

const nowMs = () => Date.now();

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function newClan({ id, name, tag, emblem = '', access = 'open', owner }) {
  return {
    id,
    name: clean(name, CLAN_RULES.MAX_NAME),
    tag: clean(tag, CLAN_RULES.MAX_TAG),
    emblem: clean(emblem, 32),
    access: access === 'request' ? 'request' : 'open',
    created: nowMs(),
    points: 0,
    cap: 10,
    leader: owner.id,
    members: [{ id: owner.id, name: owner.name, role: 'leader', points: 0, joined: nowMs(), lastSeen: nowMs() }],
    memberIds: [owner.id],
    requests: [],
    invites: [],
    mutes: {},
    guide: { text: '', at: 0, by: '' },
    notice: { text: '', at: 0, by: '' },
    settings: { reqLeague: 0, reqWins: 0, reqAge: 0, reqRank: 0 },
    activity: [],
  };
}

/** Applies leader succession in place. Returns the promoted member, or null. */
export function maintainClan(clan, at = nowMs()) {
  const leader = clan.members.find((m) => m.role === 'leader');
  if (!leader) return null;
  if (at - (leader.lastSeen || 0) < CLAN_RULES.LEADER_IDLE_MS) return null;
  const byPoints = (a, b) => (b.points || 0) - (a.points || 0);
  const officers = clan.members
    .filter((m) => m.role === 'officer' && at - (m.lastSeen || 0) < CLAN_RULES.OFFICER_ACTIVE_MS)
    .sort(byPoints);
  const pool = officers.length ? officers : clan.members.filter((m) => m.role === 'member').sort(byPoints);
  if (!pool.length) return null;
  const next = pool[0];
  leader.role = 'officer';
  next.role = 'leader';
  clan.leader = next.id;
  clan.activity.unshift({ at, kind: 'succession', text: `${next.name} is the new leader.` });
  clan.activity = clan.activity.slice(0, 50);
  return next;
}

/** Marks a member as seen (drives succession). */
export function touchMember(clan, uid, at = nowMs()) {
  const m = clan.members.find((x) => x.id === uid);
  if (m) m.lastSeen = at;
  return m || null;
}

const role = (clan, uid) => clan.members.find((m) => m.id === uid)?.role || null;
const isStaff = (clan, uid) => ['leader', 'officer'].includes(role(clan, uid));

/** Client-facing projection. Staff-only fields are trimmed for plain members. */
export function publicClan(clan, viewerId) {
  const staff = isStaff(clan, viewerId);
  return {
    id: clan.id,
    name: clan.name,
    tag: clan.tag,
    emblem: clan.emblem,
    access: clan.access,
    created: clan.created,
    points: clan.points,
    cap: clan.cap,
    max: clan.cap,
    leader: clan.leader,
    role: role(clan, viewerId),
    members: clan.members.map((m) => ({
      id: m.id, name: m.name, role: m.role, points: m.points || 0,
      joined: m.joined, lastSeen: m.lastSeen,
      muted: (clan.mutes[m.id] || 0) > nowMs(),
    })),
    guide: clan.guide,
    notice: clan.notice,
    settings: clan.settings,
    requests: staff ? clan.requests : [],
    invites: staff ? clan.invites : [],
    activity: clan.activity.slice(0, 20),
  };
}

/**
 * @param {object} api
 * @param {(req,res)=>Promise<object|null>} api.me        authenticated account or null (already answered)
 * @param {(name:string)=>Promise<object|null>} api.byName
 * @param {(id:string)=>Promise<object|null>} api.byId
 * @param {object} api.store                              db.clans()
 */
export function clanRoutes(api) {
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  /** Loads the caller's clan (materialising succession) or answers 400. */
  const requireClan = async (req, res, { staff = false } = {}) => {
    const acc = await api.me(req, res);
    if (!acc) return null;
    const clan = await api.store.byMember(acc.id);
    if (!clan) {
      json(res, 400, { error: 'You are not in a clan.' });
      return null;
    }
    if (maintainClan(clan)) await api.store.save(clan);
    touchMember(clan, acc.id);
    if (staff && !isStaff(clan, acc.id)) {
      json(res, 403, { error: 'Only the leader and officers can do that.' });
      return null;
    }
    return { acc, clan };
  };

  const need = (acc, clan, roles) => {
    if (roles && !roles.includes(role(clan, acc.id))) {
      return { error: 'Only the leader and officers can do that.' };
    }
    return null;
  };

  route('POST', '/clans', async (req, res) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    if (await api.store.byMember(acc.id)) return json(res, 400, { error: 'You are already in a clan.' });
    const b = (await body(req)) || {};
    const name = clean(b.name, CLAN_RULES.MAX_NAME);
    const tag = clean(b.tag, CLAN_RULES.MAX_TAG);
    if (!name) return json(res, 400, { error: 'Pick a clan name.' });
    if (!tag) return json(res, 400, { error: 'Pick a clan tag.' });
    if (await api.store.byName(name)) return json(res, 409, { error: 'That name is already in use.' });
    const clan = newClan({ id: `clan-${nowMs().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name, tag, emblem: b.emblem, access: b.access, owner: acc });
    await api.store.save(clan);
    json(res, 200, { clan: publicClan(clan, acc.id), profile: acc.profile });
  });

  route('GET', '/clans/status', async (req, res) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    const clan = await api.store.byMember(acc.id);
    let view = null;
    if (clan) {
      maintainClan(clan);
      touchMember(clan, acc.id);
      await api.store.save(clan);
      view = publicClan(clan, acc.id);
    }
    json(res, 200, {
      clan: view,
      mail: 0,
      requests: view && isStaff(clan, acc.id) ? clan.requests.length : 0,
      friends: 0,
      rewards: 0,
      board: 0,
    });
  });

  route('GET', '/clans/search', async (req, res) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    const q = clean(new URL(req.url, 'http://x').searchParams.get('q') || '', 24).toLowerCase();
    const all = await api.store.list();
    const clans = all
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.tag.toLowerCase().includes(q))
      .slice(0, 30)
      .map((c) => ({
        id: c.id, name: c.name, tag: c.tag, emblem: c.emblem,
        access: c.access, members: c.members.length, max: c.cap, points: c.points || 0,
      }));
    json(res, 200, { clans });
  });

  route('GET', '/clans/:id', async (req, res, _url, params) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    const clan = await api.store.get(params.id);
    if (!clan) return json(res, 404, { error: 'Clan not found.' });
    if (maintainClan(clan)) await api.store.save(clan);
    json(res, 200, publicClan(clan, acc.id));
  });

  route('POST', '/clans/:id/join', async (req, res, _url, params) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    if (await api.store.byMember(acc.id)) return json(res, 400, { error: 'You are already in a clan.' });
    const clan = await api.store.get(params.id);
    if (!clan) return json(res, 404, { error: 'Clan not found.' });
    const b = (await body(req)) || {};
    if (clan.members.length >= clan.cap) return json(res, 400, { error: 'That clan is full.' });
    const s = clan.settings;
    const p = acc.profile;
    if (s.reqLeague && p.league.length < s.reqLeague) return json(res, 400, { error: 'You do not meet the requirements.' });
    if (s.reqWins && (p.counters?.wins || 0) < s.reqWins) return json(res, 400, { error: 'You do not meet the requirements.' });
    if (s.reqAge && (nowMs() - (p.created || nowMs())) < s.reqAge * 24 * 3600 * 1000) {
      return json(res, 400, { error: 'You do not meet the requirements.' });
    }
    if (clan.access === 'request') {
      if (!clan.requests.some((r) => r.id === acc.id)) {
        clan.requests.push({
          id: acc.id, name: acc.name, message: clean(b.message, 140), at: nowMs(),
          summary: { league: p.league.length, wins: p.counters?.wins || 0, created: p.created },
        });
        await api.store.save(clan);
      }
      return json(res, 200, { request: true });
    }
    clan.members.push({ id: acc.id, name: acc.name, role: 'member', points: 0, joined: nowMs(), lastSeen: nowMs() });
    clan.memberIds.push(acc.id);
    await api.store.save(clan);
    json(res, 200, { clan: publicClan(clan, acc.id) });
  });

  route('POST', '/clans/settings', async (req, res) => {
    const ctx = await requireClan(req, res, { staff: true });
    if (!ctx) return;
    if (role(ctx.clan, ctx.acc.id) !== 'leader') return json(res, 403, { error: 'Only the leader can change the settings.' });
    const b = (await body(req)) || {};
    const s = ctx.clan.settings;
    for (const k of ['reqLeague', 'reqWins', 'reqAge', 'reqRank']) {
      if (Number.isFinite(+b[k])) s[k] = Math.max(0, Math.min(1000, Math.trunc(+b[k])));
    }
    if (b.access) ctx.clan.access = b.access === 'request' ? 'request' : 'open';
    await api.store.save(ctx.clan);
    json(res, 200, { clan: publicClan(ctx.clan, ctx.acc.id) });
  });

  route('POST', '/clans/guide', async (req, res) => {
    const ctx = await requireClan(req, res, { staff: true });
    if (!ctx) return;
    const b = (await body(req)) || {};
    ctx.clan.guide = { text: String(b.text ?? '').slice(0, CLAN_RULES.MAX_GUIDE), at: nowMs(), by: ctx.acc.name };
    await api.store.save(ctx.clan);
    json(res, 200, { clan: publicClan(ctx.clan, ctx.acc.id) });
  });

  route('POST', '/clans/notice', async (req, res) => {
    const ctx = await requireClan(req, res, { staff: true });
    if (!ctx) return;
    const b = (await body(req)) || {};
    ctx.clan.notice = { text: String(b.text ?? '').slice(0, CLAN_RULES.MAX_NOTICE), at: nowMs(), by: ctx.acc.name };
    await api.store.save(ctx.clan);
    json(res, 200, { clan: publicClan(ctx.clan, ctx.acc.id) });
  });

  route('POST', '/clans/invite', async (req, res) => {
    const ctx = await requireClan(req, res, { staff: true });
    if (!ctx) return;
    const b = (await body(req)) || {};
    const target = await api.byName(clean(b.name, 24));
    if (!target) return json(res, 404, { error: 'Player not found.' });
    if (ctx.clan.members.some((m) => m.id === target.id)) return json(res, 400, { error: 'Already in the clan.' });
    if (ctx.clan.members.length + ctx.clan.invites.length >= ctx.clan.cap) {
      return json(res, 400, { error: 'That clan is full.' });
    }
    if (!ctx.clan.invites.some((i) => i.id === target.id)) {
      ctx.clan.invites.push({ id: target.id, name: target.name, at: nowMs(), by: ctx.acc.name });
      await api.store.save(ctx.clan);
    }
    json(res, 204, undefined);
  });

  route('POST', '/clans/uninvite', async (req, res) => {
    const ctx = await requireClan(req, res, { staff: true });
    if (!ctx) return;
    const b = (await body(req)) || {};
    ctx.clan.invites = ctx.clan.invites.filter((i) => i.id !== b.id);
    await api.store.save(ctx.clan);
    json(res, 200, { clan: publicClan(ctx.clan, ctx.acc.id) });
  });

  route('POST', '/clans/kick', async (req, res) => {
    const ctx = await requireClan(req, res, { staff: true });
    if (!ctx) return;
    const b = (await body(req)) || {};
    if (b.user === ctx.acc.id) return json(res, 400, { error: 'Use leave to leave the clan.' });
    const victim = ctx.clan.members.find((m) => m.id === b.user);
    if (!victim) return json(res, 404, { error: 'Player not in the clan.' });
    if (victim.role === 'leader') return json(res, 403, { error: 'The leader cannot be kicked.' });
    if (victim.role === 'officer' && role(ctx.clan, ctx.acc.id) !== 'leader') {
      return json(res, 403, { error: 'Only the leader can remove an officer.' });
    }
    ctx.clan.members = ctx.clan.members.filter((m) => m.id !== b.user);
    ctx.clan.memberIds = ctx.clan.memberIds.filter((id) => id !== b.user);
    delete ctx.clan.mutes[b.user];
    await api.store.save(ctx.clan);
    json(res, 200, { clan: publicClan(ctx.clan, ctx.acc.id) });
  });

  route('POST', '/clans/role', async (req, res) => {
    const ctx = await requireClan(req, res, { staff: true });
    if (!ctx) return;
    if (role(ctx.clan, ctx.acc.id) !== 'leader') return json(res, 403, { error: 'Only the leader can change roles.' });
    const b = (await body(req)) || {};
    if (!CLAN_RULES.ROLES.includes(b.role) || b.role === 'leader') {
      return json(res, 400, { error: 'Invalid role.' });
    }
    const target = ctx.clan.members.find((m) => m.id === b.user);
    if (!target) return json(res, 404, { error: 'Player not in the clan.' });
    target.role = b.role;
    await api.store.save(ctx.clan);
    json(res, 200, { clan: publicClan(ctx.clan, ctx.acc.id) });
  });

  route('POST', '/clans/leave', async (req, res) => {
    const ctx = await requireClan(req, res);
    if (!ctx) return;
    const wasLeader = role(ctx.clan, ctx.acc.id) === 'leader';
    ctx.clan.members = ctx.clan.members.filter((m) => m.id !== ctx.acc.id);
    ctx.clan.memberIds = ctx.clan.memberIds.filter((id) => id !== ctx.acc.id);
    delete ctx.clan.mutes[ctx.acc.id];
    if (!ctx.clan.members.length) {
      await api.store.del(ctx.clan.id);
      return json(res, 200, { clan: null });
    }
    if (wasLeader) maintainClan({ ...ctx.clan, members: ctx.clan.members.map((m) => ({ ...m, lastSeen: 0 })) }, nowMs());
    await api.store.save(ctx.clan);
    json(res, 200, { clan: null });
  });

  route('POST', '/clans/disband', async (req, res) => {
    const ctx = await requireClan(req, res, { staff: true });
    if (!ctx) return;
    if (role(ctx.clan, ctx.acc.id) !== 'leader') return json(res, 403, { error: 'Only the leader can disband the clan.' });
    const b = (await body(req)) || {};
    if (!b.confirm) return json(res, 400, { error: 'Confirmation required.' });
    await api.store.del(ctx.clan.id);
    json(res, 204, undefined);
  });

  route('POST', '/clans/rename', async (req, res) => {
    const ctx = await requireClan(req, res, { staff: true });
    if (!ctx) return;
    if (role(ctx.clan, ctx.acc.id) !== 'leader') return json(res, 403, { error: 'Only the leader can rename the clan.' });
    const b = (await body(req)) || {};
    const name = b.name === undefined ? ctx.clan.name : clean(b.name, CLAN_RULES.MAX_NAME);
    const tag = b.tag === undefined ? ctx.clan.tag : clean(b.tag, CLAN_RULES.MAX_TAG);
    if (!name || !tag) return json(res, 400, { error: 'Pick a clan name and tag.' });
    const other = await api.store.byName(name);
    if (other && other.id !== ctx.clan.id) return json(res, 409, { error: 'That name is already in use.' });
    ctx.clan.name = name;
    ctx.clan.tag = tag;
    await api.store.save(ctx.clan);
    json(res, 200, { clan: publicClan(ctx.clan, ctx.acc.id), profile: ctx.acc.profile });
  });

  route('POST', '/clans/emblem', async (req, res) => {
    const ctx = await requireClan(req, res, { staff: true });
    if (!ctx) return;
    if (role(ctx.clan, ctx.acc.id) !== 'leader') return json(res, 403, { error: 'Only the leader can change the emblem.' });
    const b = (await body(req)) || {};
    ctx.clan.emblem = clean(b.emblem, 32);
    await api.store.save(ctx.clan);
    json(res, 200, { clan: publicClan(ctx.clan, ctx.acc.id) });
  });

  route('POST', '/clans/mute', async (req, res) => {
    const ctx = await requireClan(req, res, { staff: true });
    if (!ctx) return;
    const b = (await body(req)) || {};
    const target = ctx.clan.members.find((m) => m.id === b.user);
    if (!target) return json(res, 404, { error: 'Player not in the clan.' });
    if (target.role === 'leader') return json(res, 403, { error: 'The leader cannot be muted.' });
    const hours = Math.max(0, Math.min(24 * 30, Number(b.hours) || 0));
    if (hours === 0) delete ctx.clan.mutes[b.user];
    else ctx.clan.mutes[b.user] = nowMs() + hours * 3600 * 1000;
    await api.store.save(ctx.clan);
    json(res, 200, { clan: publicClan(ctx.clan, ctx.acc.id) });
  });

  route('POST', '/clans/chat', async (req, res) => {
    const ctx = await requireClan(req, res);
    if (!ctx) return;
    if ((ctx.clan.mutes[ctx.acc.id] || 0) > nowMs()) return json(res, 403, { error: 'You are muted.' });
    const b = (await body(req)) || {};
    const text = String(b.text ?? '').trim().slice(0, 200);
    if (text) {
      ctx.clan.activity.unshift({ at: nowMs(), kind: 'chat', by: ctx.acc.name, text });
      ctx.clan.activity = ctx.clan.activity.slice(0, 50);
      await api.store.save(ctx.clan);
    }
    json(res, 200, { ok: true });
  });

  route('POST', '/clans/react', (req, res) => json(res, 204, undefined));
  route('GET', '/clans/:id/chat', async (req, res, _url, params) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    const clan = await api.store.get(params.id);
    if (!clan) return json(res, 404, { error: 'Clan not found.' });
    json(res, 200, clan.activity.filter((a) => a.kind === 'chat').slice(0, 50));
  });
  route('GET', '/clans/:id/activity', async (req, res, _url, params) => {
    const acc = await api.me(req, res);
    if (!acc) return;
    const clan = await api.store.get(params.id);
    if (!clan) return json(res, 404, { error: 'Clan not found.' });
    json(res, 200, clan.activity.slice(0, 50));
  });

  return { routes };
}
