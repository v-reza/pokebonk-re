// PokéBonk — shared, mode-agnostic backend helpers.
// Imported by BOTH `server.mjs` (JSON store mode) and `firebase/backend.mjs`
// (Firebase mode) so the account/profile/season/response shapes stay identical
// between the two backends. Keep this file in sync with neither caller changing
// the shapes unilaterally.
import crypto from 'node:crypto';

export const now = () => Date.now();
export const token = () => crypto.randomBytes(24).toString('base64url');
export const uid = () => crypto.randomUUID();

export const DEFAULT_SETTINGS = {
  master: 0.8, music: 0.5, sfx: 0.7, cries: 0.6, quality: 'high', aimMode: 'auto',
  sensitivity: 1, invertY: false, damageNumbers: true, floatText: true, shakeOn: true,
  screenShake: 1, fov: 70, showFps: false, reduceFlashes: false, pixel: 0,
  muteHidden: true, hudScale: 1, hudOpacity: 1, bossBarOpacity: 1, showBanners: true,
  showMinimap: true, showLadder: true, showToasts: true, showStreak: true,
  showItems: true, mapScale: 1, mapIcons: 1, mapNorthUp: false, fxOpacity: 1,
  ownFxOpacity: 1, camDist: 9, calmCandies: false, pickupFx: 'full',
  skipEmptyLevelUp: false, hideOwnFx: false, fixedStick: false, padRumble: true,
  padDead: 0.15, autoUlt: false, ultPose: true, tours: '', hintsSeen: '', tips: true,
};

export function newProfile(name) {
  return {
    v: 1, name, created: now(), stardust: 0, totalStardust: 0,
    unlocked: [], league: [], starter: 0, forms: [], research: {}, captured: {},
    seen: [], played: [], shinies: [], skins: [], lab: {}, biomes: { forest: 0 },
    quests: {}, counters: {}, runs: [], best: {}, times: {}, kills: {}, medals: {},
    endless: {}, settings: { ...DEFAULT_SETTINGS }, lastSpecies: 4,
    lastBiome: 'forest', banished: [], itemsOwned: [], itemsOff: [],
    daily: { idx: 0, ids: [], prog: [0, 0, 0], claimed: [0, 0, 0, 0], rerolls: 0 },
    weekly: { idx: 0, ids: [], prog: [0, 0, 0], claimed: [0, 0, 0, 0], rerolls: 0 },
    dailyStreak: { last: 0, n: 0 }, bag: {}, avatar: '', frame: '', title: '',
    cosmetics: [], events: {},
    // 0.8.27+: wardrobe looks, classic shinies and the 6-slot Team favourites
    skins: [], classics: [], team: [],
  };
}

export function newAccount(name, guest) {
  return {
    id: uid(), name, guest: !!guest, token: token(),
    password: null, created: now(), lastSeen: now(),
    profile: newProfile(name),
  };
}

export const hashPassword = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(pw, salt, 32, (err, key) =>
      err ? reject(err) : resolve(`${salt}:${key.toString('hex')}`)));
export const checkPassword = async (pw, stored) => {
  if (!stored) return false;
  const [salt] = stored.split(':');
  return (await hashPassword(pw, salt)) === stored;
};

// ------------------------------------------------------------ season cfg ---

export const SEASON = {
  n: 2, name: '', start: now() - 86400000, end: now() + 15 * 86400000,
  live: true, dust: 1, message: '', next: null,
};

export const EVENTS = [
  {
    id: 'halloween26',
    name: 'La Noche de la Torre Lavanda',
    desc: 'Halloween en Kanto: sube la Torre Pokémon de Pueblo Lavanda piso a piso.',
    color: '#9a6aff', mode: 'tower', biome: 'graveyard',
    start: now() - 86400000, end: now() + 15 * 86400000,
    live: true, claimable: true, state: 'auto',
    points: { name: 'Velas', icon: 'vela' },
    art: {
      tile: 'ui/events/tower-card.jpg',
      header: 'ui/events/tower.jpg',
      banner: 'ui/events/tower-banner.jpg',
      icon: 'torre',
    },
  },
];

// ------------------------------------------------------------------ api ----

export function json(res, code, payload) {
  const buf = payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload));
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(buf);
}

export async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return undefined; }
}

export const seasonPayload = () => ({ ...SEASON });

// `accounts` is an array of account objects (same shape as the JSON store's
// `Object.values(store.accounts)`). The JSON store passes that array directly;
// the Firebase backend passes `await db.allAccounts()`.
export function boardFor(accounts, mode, season, limit, query, viewer) {
  // The client passes season as "week" (current) or "all" (historical), not a number.
  const current = season === 'week' || season === SEASON.n || season == null;
  const allTime = season === 'all';
  const biome = query.searchParams.get('biome');
  const tier = query.searchParams.get('tier');
  const species = query.searchParams.get('species');
  const sortByTime = mode === 'time';

  // Global boards sum each trainer's best run per region; per-region boards use one run.
  const rows = [];
  for (const a of accounts) {
    const bestByBiome = new Map();
    for (const r of a.profile.runs || []) {
      if (!allTime && !(current && r.season === SEASON.n)) continue;
      if (biome && r.biome !== biome) continue;
      if (tier != null && Number(tier) !== r.tier) continue;
      if (species && String(r.species) !== species) continue;
      if (sortByTime && !r.victory) continue;
      const prev = bestByBiome.get(r.biome);
      const better = !prev
        || (sortByTime ? r.time < prev.time : (r.kills || 0) > (prev.kills || 0));
      if (better) bestByBiome.set(r.biome, r);
    }
    if (!bestByBiome.size) continue;
    let kills = 0;
    let time = 0;
    let last = null;
    for (const r of bestByBiome.values()) {
      kills += r.kills || 0;
      time += r.time || 0;
      if (!last || r.date > last.date) last = r;
    }
    rows.push({
      id: a.id, name: a.name, species: last.finalSpecies ?? last.species,
      kills, time, biome: last.biome, tier: last.tier, date: last.date,
      me: viewer ? a.id === viewer.id : false,
      avatar: a.profile.avatar, frame: a.profile.frame,
      skins: a.profile.skins, title: a.profile.title, tag: '',
      regions: Object.fromEntries([...bestByBiome].map(([b, r]) => [b, sortByTime ? r.time : r.kills || 0])),
    });
  }

  if (sortByTime) rows.sort((x, y) => x.time - y.time);
  else rows.sort((x, y) => y.kills - x.kills);
  const ranked = rows.slice(0, limit).map((e, i) => ({ ...e, rank: i + 1 }));
  return {
    board: `${mode}:${biome ?? 'global'}`, entries: ranked,
    me: ranked.find((e) => e.me) ?? null,
    players: rows.length, season: SEASON.n, ends: SEASON.end,
    info: seasonPayload(),
  };
}

/**
 * Applies one batched profile action (`POST /profile/actions`) to a profile.
 *
 * 0.8.29 sends lab/item/archive/quest/task mutations through the batched
 * endpoint — its API client always has `actions()`, so the per-feature routes
 * are never called any more. Both backends (server.mjs, firebase/backend.mjs)
 * share this reducer so the two paths cannot drift.
 *
 * Returns true only when the action actually mutated the profile.
 */
export function applyProfileAction(p, a) {
  if (!p || !a || typeof a.k !== 'string') return false;
  switch (a.k) {
    case 'lab':
      if (a.id === undefined || a.id === null || a.id === '') return false;
      p.lab[a.id] = (p.lab[a.id] ?? 0) + 1;
      return true;
    case 'item':
      if (!a.key) return false;
      if (!p.itemsOwned.includes(a.key)) p.itemsOwned.push(a.key);
      return true;
    case 'archive':
      if (!a.key) return false;
      p.itemsOff = a.off
        ? [...new Set([...p.itemsOff, a.key])]
        : p.itemsOff.filter((k) => k !== a.key);
      return true;
    case 'quest':
      if (!a.id) return false;
      p.quests[a.id] = 1;
      return true;
    case 'task': {
      const t = p[a.period];
      if (!t || !Number.isInteger(a.slot) || a.slot < 0 || a.slot >= 4) return false;
      t.claimed[a.slot] = 1;
      return true;
    }
    default:
      return false;
  }
}
