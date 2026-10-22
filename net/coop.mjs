// ============ coop.mjs — host-authoritative co-op for PokéBonk ============
// Ported and adapted from pokesurvivor/js/net/coop.js (G.Coop) for PokéBonk's
// entity model. The protocol and rates are unchanged; only the game-side field
// mapping changes.
//
// Who owns what (host-authoritative, NOT deterministic lockstep):
//   HOST      enemies (spawn, AI, hp, death), ground pickups, team XP/level,
//             the clock and the end of the run.
//   EACH ONE  its own Pokémon: position, hp, its own attacks and what hits it.
//             Its hits on enemies are forwarded to the host, which applies them.
//
// Guests render REMOTE COPIES of the host's enemies and remote copies of their
// teammates. A guest never simulates enemies, pickups, team XP or the clock.
//
// Messages (over net.mjs, ~15×/s direct, 3×/s relay):
//   guest -> host  { k:'f', p:[state], ev:[events] }
//   host -> guest  { k:'f', t, lv, xp, xn, ki, bo, co, p:{uid:[state]},
//                    e:[[slot,x,y,hp,anim,dir,status]], ev:[events] }
//   host -> all    { k:'start', seed, host, members:[{uid,name,dex,shiny}] }
//
// RNG note: host-authoritative replication does NOT require a deterministic RNG.
// The host's seeded RNG (kc) is never refactored or replicated; guests simply
// consume the state the host produces.
//
// ---------------------------------------------------------------------------
// FIELD MAPPING — PokéBonk `Sd` enemy manager (parallel typed arrays, no objects)
// ---------------------------------------------------------------------------
// PokéBonk keeps every enemy as a row across 66 parallel typed arrays, addressed
// by a SLOT INDEX (0..2199). There are no per-enemy objects and no enemy ids.
// A slot's meaning is STABLE until compaction: Sd.kill(slot) frees the slot onto
// the `free` list and it may be reused by a later Sd.spawn(). For co-op this
// requires:
//   1. Slots MUST be made stable for the lifetime of a live enemy (see
//      INTEGRATION.md): do not reuse a slot while a guest still knows it, or
//      give each live enemy a monotonically increasing slot id and reconcile
//      via the `ed`/`eg`/`ne` events below. The codec below assumes the former.
//   2. Guests need a REMOTE SIDECAR: a `remoteSlots = new Uint8Array(2200)`
//      marking which slots are the host's remote enemies, plus small parallel
//      arrays for the interpolated position/velocity (`net.vx/vy`, age, last).
//
// Wire enemy row  [slot, x, y, hp, anim, dir, status]:
//   slot   Int32 slot index into the Sd arrays (stable for the enemy's life)
//   x      Sd.x[slot]        (horizontal, world X)
//   y      Sd.z[slot]        (horizontal depth, world Z — PokéBonk's "y" is
//                             height and is NOT sent; the guest recomputes it
//                             from the terrain)
//   hp     ceil(Sd.hp[slot]) current HP
//   anim   coarse anim code (PokéBonk's `anim` is a phase float, not a name):
//            0 walk (default), 1 attack (atkAnim>0), 2 idle (frozen||sleep),
//            3 hurt (dying>0)
//   dir    sprite direction row, 8-way, from Sd.fx[slot]/Sd.fz[slot] (dirOf)
//   status bitmask: 1 burn (Sd.burn>0), 2 poison (Sd.poison>0),
//           4 shield (Sd.shield>0), 8 slow (Sd.hazSlow<1)
//
// ---------------------------------------------------------------------------
// FIELD MAPPING — player state (wire array)  [x,y,angle,walking,hp,maxHp,dead,
//   level,aim,xpMul,reviveT,choosing,doneSeq,watching]
// ---------------------------------------------------------------------------
//   0 x        round(pos.x)
//   1 y        round(pos.z)          (horizontal depth)
//   2 angle    facing angle (atan2(facing.x, facing.z))
//   3 walking  speedNow > 0.1 ? 1 : 0
//   4 hp       round(hp)
//   5 maxHp    round(maxHp)
//   6 dead     dead ? 1 : 0
//   7 level    level
//   8 aim      attack aim angle (atan2(run.lastAim.x, run.lastAim.z))
//   9 xpMul    bonus damage / team XP contribution (round2)
//  10 reviveT  revive timer or 0 (round2)
//  11 choosing level-up card open ? 1 : 0
//  12 doneSeq  level card chosen sequence
//  13 watching uid of the teammate being spectated, or ''
// ---------------------------------------------------------------------------

import * as Net from './net.mjs';

// Message rates and culling (unchanged from the reference).
export const NEAR = 950;                 // enemy radius sent per guest
export const RATE_FAST = 1 / 15;         // 15 Hz direct
export const RATE_SLOW = 1 / 3;          // 3 Hz relay fallback
export const DIRECT_TIMEOUT = 9000;      // ms to get a direct channel
export const ALLOW_RELAY = true;
export const TURN_ON = false;

// Enemy anim codes (see field-mapping table above).
export const ANIM = { WALK: 0, ATTACK: 1, IDLE: 2, HURT: 3 };
// Enemy status bitmask.
export const ST = { BURN: 1, POISON: 2, SHIELD: 4, SLOW: 8 };
// Player state indices (see field-mapping table above).
export const P = {
  X: 0, Y: 1, ANGLE: 2, WALKING: 3, HP: 4, MAXHP: 5, DEAD: 6, LEVEL: 7,
  AIM: 8, XPMUL: 9, REVIVE: 10, CHOOSING: 11, DONESEQ: 12, WATCHING: 13
};
// Enemy row indices.
export const E = { SLOT: 0, X: 1, Y: 2, HP: 3, ANIM: 4, DIR: 5, STATUS: 6 };

const r1 = v => Math.round(v);
const r2 = v => Math.round(v * 100) / 100;
/** Network number: non-numeric falls back to `def`, then clamped to [lo, hi]. */
export const num = (v, def, lo, hi) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;

/** 8-way sprite direction row from a facing vector (fx, fz). 0 = +z, clockwise. */
export function dirOf(fx, fz) {
  if (fx === 0 && fz === 0) return 0;
  const a = Math.atan2(fx, fz);                       // 0 = facing +z, +x = +π/2
  return ((Math.round((a + Math.PI) / (Math.PI / 4)) % 8) + 8) % 8;
}

// ---------------------------------------------------------------------------
// Pure serializers / readers (unit-testable, no game or net dependency)
// ---------------------------------------------------------------------------

/**
 * Collect the host's live enemies near (nearX, nearZ) from the `Sd` typed arrays
 * into plain rows ready for serializeEnemyFrame.
 * @param sd  Sd-shaped manager: { n, alive, x, z, hp, anim, atkAnim, dying, fx,
 *            fz, burn, poison, shield, hazSlow, frozen, sleep } (typed arrays
 *            indexed by slot). This is the ONLY place that reads Sd arrays by
 *            SLOT INDEX.
 */
export function collectEnemySlots(sd, nearX, nearZ, near = NEAR) {
  const out = [];
  const r2n = near * near;
  for (let i = 0; i < sd.n; i++) {
    if (!sd.alive[i] || sd.dying[i] > 0) continue;
    const dx = sd.x[i] - nearX, dz = sd.z[i] - nearZ;
    if (dx * dx + dz * dz > r2n) continue;
    out.push(enemyRowOf(sd, i));
  }
  return out;
}

/** Build one plain enemy row { slot,x,y,hp,anim,dir,status } from Sd slot `i`. */
export function enemyRowOf(sd, i) {
  const anim = sd.dying[i] > 0 ? ANIM.HURT
    : sd.atkAnim[i] > 0 ? ANIM.ATTACK
    : (sd.frozen[i] > 0 || sd.sleep[i] > 0) ? ANIM.IDLE : ANIM.WALK;
  const status = (sd.burn[i] > 0 ? ST.BURN : 0)
    | (sd.poison[i] > 0 ? ST.POISON : 0)
    | (sd.shield[i] > 0 ? ST.SHIELD : 0)
    | (sd.hazSlow[i] < 1 ? ST.SLOW : 0);
  return {
    slot: i, x: sd.x[i], y: sd.z[i], hp: Math.ceil(sd.hp[i]),
    anim, dir: dirOf(sd.fx[i], sd.fz[i]), status
  };
}

/**
 * Serialize enemy rows to the wire: [[slot,x,y,hp,anim,dir,status], ...].
 * @param enemySlots array of plain rows (from collectEnemySlots / enemyRowOf).
 */
export function serializeEnemyFrame(enemySlots) {
  return enemySlots.map(e =>
    [e.slot, r1(e.x), r1(e.y), Math.ceil(e.hp), e.anim, e.dir, e.status]);
}

/** Serialize one player's state to the wire array (see P indices). */
export function serializePlayerState(p) {
  return [
    r1(p.x), r1(p.y), r2(p.angle), p.walking ? 1 : 0, r1(p.hp), r1(p.maxHp),
    p.dead ? 1 : 0, r1(p.level ?? 1), r2(p.aim ?? p.angle), r2(p.xpMul ?? 1),
    r2(p.reviveT ?? 0), p.choosing ? 1 : 0, p.doneSeq ?? 0, p.watching ?? ''
  ];
}

/** Read one enemy wire row into a plain row object. */
export function readEnemyFrame(a) {
  if (!Array.isArray(a)) a = [];
  return {
    slot: num(a[E.SLOT], 0, 0, 1e6),
    x: num(a[E.X], 0, -1e6, 1e6),
    y: num(a[E.Y], 0, -1e6, 1e6),
    hp: num(a[E.HP], 0, 0, 1e7),
    anim: num(a[E.ANIM], 0, 0, 3),
    dir: num(a[E.DIR], 0, 0, 7),
    status: num(a[E.STATUS], 0, 0, 15)
  };
}

/** Read a list of enemy wire rows. */
export function readEnemyList(list) {
  return (Array.isArray(list) ? list : []).map(readEnemyFrame);
}

/** Read one player state wire array into a plain object (clamped, see P indices). */
export function readPlayerState(a) {
  if (!Array.isArray(a)) a = [];
  return {
    x: num(a[P.X], 0, -1e6, 1e6),
    y: num(a[P.Y], 0, -1e6, 1e6),
    angle: num(a[P.ANGLE], 0, -10, 10),
    walking: a[P.WALKING] ? 1 : 0,
    hp: num(a[P.HP], 0, 0, 1e6),
    maxHp: num(a[P.MAXHP], 1, 1, 1e6),
    dead: a[P.DEAD] ? 1 : 0,
    level: num(a[P.LEVEL], 1, 1, 999),
    aim: num(a[P.AIM], 0, -10, 10),
    xpMul: num(a[P.XPMUL], 1, 0.1, 20),
    reviveT: num(a[P.REVIVE], 0, 0, 60),
    choosing: a[P.CHOOSING] === undefined ? undefined : a[P.CHOOSING] ? 1 : 0,
    doneSeq: num(a[P.DONESEQ], 0, 0, 1e9),
    watching: typeof a[P.WATCHING] === 'string' ? a[P.WATCHING].slice(0, 64) : ''
  };
}

// ---------------------------------------------------------------------------
// Message builders (schema; values are the plain objects from the readers above)
// ---------------------------------------------------------------------------

/** Guest -> host frame. */
export function buildGuestFrame(state, ev = []) {
  return { k: 'f', p: state, ev };
}

/** Host -> guest frame. */
export function buildHostFrame({ t, lv, xp, xn, ki, bo, co, p, e, ev }) {
  return { k: 'f', t, lv, xp, xn, ki, bo, co, p, e, ev };
}

/** Host -> all start message. */
export function buildStart({ seed, host, members }) {
  return { k: 'start', seed, host, members };
}

// ---------------------------------------------------------------------------
// Coop controller (host/guest state machine) — adapted from coop.js
// ---------------------------------------------------------------------------
// The game is reached ONLY through the injected `game` adapter, so this module
// stays browser-independent and unit-testable. See INTEGRATION.md for how each
// adapter method maps to a main.pretty.js hook.

const COLORS = ['#ffcb3d', '#5fc8ff', '#7ee07a', '#ff8ad8'];
const STALL_MS = 2500;

export class Coop {
  /**
   * @param net   the net.mjs module (or a compatible stub with open/close/send/
   *              toHost/broadcast/on/onPeer/mode/slow/uid/isHost/hostUid).
   * @param game  adapter (see INTEGRATION.md): {
   *   // called on everyone
   *   levelStart(lv), resume(), waiting(names), over(data), lost(msg),
   *   syncTeam({time,level,xp,xpNext,kills,bosses,coins}), shiny(dex),
   *   // host only (enemy/pickup/team simulation)
   *   enemyAdded(e), enemyGone(e, died), hurtShown(e, dmg, color),
   *   enemyShot(p, type), pickupAdded(o), pickupGone(id), say(text, secs),
   *   // guest only (remote rendering)
   *   addRemoteEnemy(slot, row, meta), removeRemoteEnemy(slot, died),
   *   applyRemoteEnemy(slot, row), ghostCast(pl, ...), item(id), mateLeft(m)
   * }
   */
  constructor(net, game) {
    this.net = net;
    this.game = game;
    this.active = false;
    this.host = false;
    this.me = null;
    this.hostUid = null;
    this.local = null;
    this.mates = new Map();      // uid -> { uid, name, color, pl, connected, q, flushT, xpMul }
    this.outEv = [];
    this.flushT = 0;
    this.hitFrom = null;
    this.waiting = new Set();
    this.hostAway = false;
    this.stalled = false;
    this.lastHostAt = 0;
    this.levelSeq = 0;
    this.levelNow = 1;
    this.seenSeq = 0;
    this.doneSeq = 0;
    this.members = [];
    this._onMsg = null;
    this._onPeer = null;
  }

  rateFor(u) { return this.net.slow(u) ? RATE_SLOW : RATE_FAST; }

  /** cfg { seed, host, members }; pl your Player (already created); cb game adapter. */
  begin(cfg, pl, cb) {
    this.active = true;
    this.me = this.net.getUid();
    this.hostUid = cfg.host;
    this.host = this.me === this.hostUid;
    this.local = pl;
    this.game = cb || this.game;
    this.members = cfg.members;
    this.mates.clear();
    this.outEv = [];
    this.flushT = 0;
    this.waiting = new Set();
    this.hostAway = false;
    this.stalled = false;
    this.lastHostAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.levelSeq = 0;
    this.levelNow = 1;
    this.seenSeq = 0;
    this.doneSeq = 0;
    const members = cfg.members;
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const x = (i - (members.length - 1) / 2) * 34, y = 0;
      if (m.uid === this.me) {
        pl.x = x; pl.z = y; pl.uid = this.me; pl.coopHost = this.host; pl.tagColor = COLORS[i % COLORS.length];
        continue;
      }
      const mate = {
        uid: m.uid, name: m.name, color: COLORS[i % COLORS.length],
        pl: { uid: m.uid, name: m.name, tag: m.name, tagColor: COLORS[i % COLORS.length], remote: true, x, y, dead: false },
        connected: true, q: [], flushT: 0, xpMul: 1, state: null
      };
      mate.pl.net = { x, y, ang: Math.PI / 2, walk: 0, hp: 1, maxHp: 1, dead: 0 };
      this.mates.set(m.uid, mate);
    }
    if (this._onMsg) this.net.off(this._onMsg);
    if (this._onPeer) { /* onPeer is additive in net.mjs; we keep our own binding */ }
    this._onMsg = (from, msg) => this.onMessage(from, msg);
    this._onPeer = (u, mode) => this.onPeer(u, mode);
    this.net.on(this._onMsg);
    this.net.onPeer(this._onPeer);
  }

  end() {
    this.active = false;
    this.host = false;
    this.local = null;
    this.mates.clear();
    this.outEv = [];
    this.waiting = new Set();
    if (this._onMsg) { this.net.off(this._onMsg); this._onMsg = null; }
  }

  players() {
    const out = [this.local];
    for (const m of this.mates.values()) if (m.connected) out.push(m.pl);
    return out;
  }
  puppets() {
    const out = [];
    for (const m of this.mates.values()) if (m.connected) out.push(m.pl);
    return out;
  }

  // --- state of a player ---
  myState() { return serializePlayerState(this.stateOf(this.local)); }

  /** Adapter hook: the integration supplies a function mapping a Yg player to a
   *  plain state object. Overridden per-game; default reads common fields. */
  stateOf(pl) {
    return this._stateOf ? this._stateOf(pl) : {
      x: pl.pos ? pl.pos.x : pl.x, y: pl.pos ? pl.pos.z : pl.y,
      angle: pl.angle ?? 0, walking: pl.walking ? 1 : 0,
      hp: pl.hp, maxHp: pl.maxHp, dead: pl.dead ? 1 : 0, level: pl.level,
      aim: pl.aim ?? 0, xpMul: pl.xpMul, reviveT: pl.reviveT,
      choosing: this.game && this.game.choosing ? this.game.choosing() : 0,
      doneSeq: this.doneSeq, watching: this.game && this.game.watching ? this.game.watching() : ''
    };
  }

  // --- host: events ---
  emit(ev, except) {
    if (!this.host) return;
    for (const m of this.mates.values()) if (m.connected && m.uid !== except) m.q.push(ev);
  }

  // --- host: frame ---
  hostFrame(m) {
    const g = this.game;
    const st = g.team();
    const p = { [this.me]: this.myState() };
    for (const o of this.mates.values()) if (o.connected && o.uid !== m.uid && o.state) p[o.uid] = o.state;
    const ev = m.q; m.q = [];
    return buildHostFrame({
      t: r2(st.time), lv: st.level, xp: r2(st.xp), xn: st.xpNext, ki: st.kills,
      bo: st.bosses, co: st.coins, p, e: g.enemyList ? g.enemyList(this.me) : [],
      ev
    });
  }

  flushAll() { for (const m of this.mates.values()) if (m.connected) this.net.send(m.uid, this.hostFrame(m)); }

  flushClient(force) {
    if (!force && !this.outEv.length && this.flushT > 0) return;
    this.net.toHost(buildGuestFrame(this.myState(), this.outEv));
    this.outEv = [];
  }

  /** Called every frame (also on the level-up screen). */
  tick(dt) {
    if (!this.active) return;
    if (this.host) {
      for (const m of this.mates.values()) {
        if (!m.connected) continue;
        m.flushT -= dt;
        if (m.flushT > 0) continue;
        m.flushT = this.rateFor(m.uid);
        this.net.send(m.uid, this.hostFrame(m));
      }
    } else {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (!this.stalled && now - this.lastHostAt > STALL_MS) { this.stalled = true; this.updateAway(); }
      this.flushT -= dt;
      if (this.flushT <= 0) {
        this.flushT = this.rateFor(this.hostUid);
        this.net.toHost(buildGuestFrame(this.myState(), this.outEv));
        this.outEv = [];
      }
    }
  }

  // --- receive ---
  onMessage(from, msg) {
    if (!msg) return;
    if (msg.k === 'start') { if (this.game.startCoop) this.game.startCoop(msg); return; }
    if (!this.active || msg.k !== 'f') return;
    if (this.host) this.onClientFrame(from, msg);
    else if (from === this.hostUid) this.onHostFrame(msg);
  }

  onPeer(u, mode) {
    if (!this.active || (mode !== 'closed' && mode !== 'failed')) return;
    if (this.host) this.mateGone(u);
    else if (u === this.hostUid) {
      const cb = this.game.lost; this.end();
      if (cb) cb('Se ha perdido la conexión con el anfitrión.');
    }
  }

  mateGone(u) {
    const m = this.mates.get(u);
    if (!m || !m.connected) return;
    m.connected = false;
    if (this.waiting.has(u)) this.picked(u);
    if (this.game.mateLeft) this.game.mateLeft(m);
  }

  // --- host: incoming guest frame ---
  onClientFrame(from, msg) {
    const m = this.mates.get(from);
    if (!m || !m.connected) return;
    if (msg.p) {
      m.state = msg.p;
      m.pl.net = readPlayerState(msg.p);
      m.xpMul = m.pl.net.xpMul || 1;
    }
    for (const ev of msg.ev || []) {
      switch (ev[0]) {
        case 'h': {
          const e = this.game.getEnemy ? this.game.getEnemy(ev[1]) : null;
          if (!e) break;
          this.hitFrom = from;
          if (this.game.applyHit) this.game.applyHit(e, ev[2], ev[3], ev[4], ev[5], ev[6]);
          this.hitFrom = null;
          break;
        }
        case 's': {
          const e = this.game.getEnemy ? this.game.getEnemy(ev[1]) : null;
          if (!e) break;
          if (this.game.applyStatus) this.game.applyStatus(e, ev[2], ev[3]);
          break;
        }
        case 'c':
          if (this.game.ghostCast) this.game.ghostCast(m.pl, ev[1], ev[2], ev[3], ev[4]);
          this.emit(['c', from, ev[1], ev[2], ev[3], ev[4]], from);
          break;
        case 'lp': this.picked(from); break;
        case 'bye': this.mateGone(from); break;
      }
    }
  }

  // --- guest: incoming host frame ---
  onHostFrame(msg) {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.lastHostAt = now;
    if (this.stalled) { this.stalled = false; this.updateAway(); }
    for (const ev of msg.ev || []) this.applyHostEvent(ev);
    this.game.syncTeam({
      time: msg.t, level: msg.lv, xp: msg.xp, xpNext: msg.xn, kills: msg.ki,
      bosses: msg.bo, coins: msg.co
    });
    for (const u in msg.p || {}) {
      const m = this.mates.get(u);
      if (m) m.pl.net = readPlayerState(msg.p[u]);
    }
    if (msg.lu && msg.lu[0] > this.doneSeq && (msg.lu[0] > this.seenSeq || !(this.game.inLevelUp && this.game.inLevelUp()))) {
      this.seenSeq = msg.lu[0];
      if (this.game.levelStart) this.game.levelStart(msg.lu[1]);
    } else if (!msg.lu && this.game.inLevelUp && this.game.inLevelUp()) {
      if (this.game.resume) this.game.resume();
    }
    for (const a of msg.e || []) {
      if (this.game.applyRemoteEnemy) this.game.applyRemoteEnemy(a, now);
    }
  }

  applyHostEvent(ev) {
    const g = this.game;
    switch (ev[0]) {
      case 'ne': if (g.addRemoteEnemy) g.addRemoteEnemy(ev); break;
      case 'ed': if (g.removeRemoteEnemy) g.removeRemoteEnemy(ev[1], true); break;
      case 'eg': if (g.removeRemoteEnemy) g.removeRemoteEnemy(ev[1], false); break;
      case 'hn': if (g.showRemoteHurt) g.showRemoteHurt(ev[1], ev[2], ev[3]); break;
      case 'c': { const m = this.mates.get(ev[1]); if (m && g.ghostCast) g.ghostCast(m.pl, ev[2], ev[3], ev[4], ev[5]); break; }
      case 'pk': if (g.addRemotePickup) g.addRemotePickup(ev[1], ev[2], ev[3], ev[4], ev[5]); break;
      case 'pc': if (g.removeRemotePickup) g.removeRemotePickup(ev[1]); break;
      case 'say': if (g.say) g.say(ev[1], ev[2]); break;
      case 'lu': if (!ev[2] || ev[2] > this.seenSeq) { this.seenSeq = ev[2] || this.seenSeq; if (g.levelStart) g.levelStart(ev[1]); } break;
      case 'lw': if (g.waiting) g.waiting(ev[1]); break;
      case 'lr': if (g.resume) g.resume(); break;
      case 'ha': this.hostAway = !!ev[1]; this.updateAway(); break;
      case 'sh': if (g.shiny) g.shiny(ev[1]); break;
      case 'ov': { const cb = g.over; const d = ev[1]; this.end(); if (cb) cb(d); break; }
      case 'mag': if (g.pullAll) g.pullAll(); break;
    }
  }

  updateAway() {
    if (this.game.away) this.game.away(this.hostAway || this.stalled ? this.nameOf(this.hostUid) : null);
  }

  nameOf(u) { return u === this.me ? 'Tú' : (this.mates.get(u) || {}).name || '?'; }

  // --- hooks called by the game ---
  /** Your attack: others repeat it as a ghost. */
  cast(pl, m) {
    if (!this.active || pl !== this.local) return;
    if (this.host) this.emit(['c', this.me, m.id, m.lvl, r2(pl.aim), m.evolved ? 1 : 0]);
    else this.outEv.push(['c', m.id, m.lvl, r2(pl.aim), m.evolved ? 1 : 0]);
  }

  /** Guest: your hit on an enemy goes to the host. */
  hit(e, d, color, dx, dy, knock) { this.outEv.push(['h', e, d, color, r1(dx), r1(dy), knock || 0]); }
  status(e, kind, val) { this.outEv.push(['s', e, kind, val]); }

  /** Host hooks. */
  hurtShown(e, d, color) { this.emitNear(['hn', e, d, color], e.x, e.y, this.hitFrom); }
  enemyAdded(e) {
    this.emit(['ne', e.slot, e.species, r1(e.x), r1(e.z), e.boss ? 1 : 0, e.shiny ? 1 : 0, Math.ceil(e.maxHp), r2(e.dmg), e.behavior]);
  }
  enemyGone(e, died) { this.emit([died ? 'ed' : 'eg', e.slot]); }
  enemyShot(p, type) { this.emit(['es', r1(p.x), r1(p.y), r1(p.vx), r1(p.vy), r2(p.dmg), p.r, p.life, type, p.cat]); }
  pickupAdded(o) { this.emit(['pk', o.id, o.kind, r1(o.x), r1(o.z), o.value]); }
  pickupGone(id) { this.emit(['pc', id]); }
  say(text, secs) { this.emit(['say', text, secs]); }

  /** Host: someone picked up an item. */
  collected(p, who) {
    this.emit(['pc', p.id]);
    if (p.kind === 'magnet') this.emit(['mag']);
  }

  shinyCaught(e) { this.emit(['sh', e.species]); }

  // --- shared level-up card ---
  levelStart(level) {
    this.waiting = new Set([this.me]);
    for (const m of this.mates.values()) if (m.connected) this.waiting.add(m.uid);
    this.levelSeq++; this.levelNow = level;
    this.emit(['lu', level, this.levelSeq]);
    this.flushAll();
    if (this.game.levelStart) this.game.levelStart(level);
    this.sendWaiting();
  }

  sendWaiting() {
    const names = [...this.waiting].map(u => this.nameOf(u));
    this.emit(['lw', names]);
    if (this.game.waiting) this.game.waiting(names);
  }

  picked(u) {
    if (!this.waiting.delete(u)) return;
    if (this.waiting.size) { this.sendWaiting(); return; }
    this.emit(['lr']);
    this.flushAll();
    if (this.game.resume) this.game.resume();
  }

  localPicked() {
    if (this.host) this.picked(this.me);
    else { this.doneSeq = this.seenSeq; this.outEv.push(['lp']); this.flushClient(true); }
  }

  over(data) {
    this.emit(['ov', data]);
    this.flushAll();
    this.end();
  }

  emitNear(ev, x, y, except) {
    for (const m of this.mates.values()) {
      if (!m.connected || m.uid === except) continue;
      const v = m.pl;
      const dx = v.x - x, dy = (v.y || 0) - y;
      if (dx * dx + dy * dy > 700 * 700) continue;
      if (m.q.length > 400) continue;
      m.q.push(ev);
    }
  }

  // --- public ---
  broadcast(ev) { this.emit(ev); }
  toHost(ev) { if (this.active && !this.host) { this.outEv.push(ev); this.flushClient(true); } }
  mate(u) { return this.mates.get(u); }
  get matesList() { return [...this.mates.values()]; }
  get isHost() { return this.active && this.host; }
}
