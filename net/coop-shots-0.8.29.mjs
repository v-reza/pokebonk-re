// net/coop-shots-0.8.29.mjs — Enemy projectile replication for 0.8.29.
//
// Samples enemy projectiles (slot === -1 in class Xp) on the host at 10 Hz
// and broadcasts snapshots to guests. Guests maintain ghost projectiles.

export const SHOT_RATE = 1 / 10; // 10 Hz snapshot cadence
export const SHOT_MAX = 60;      // max projectiles per snapshot

/**
 * Extracts visible enemy projectiles from store.
 *
 * @param {object} store The projectile store (class `Xp`).
 * @param {number} [slot=-1] Slot filter (-1 for enemy projectiles).
 * @param {number} [limit=SHOT_MAX] Maximum rows to extract.
 * @returns {Array<[number, number, number, number, number, number, number, number, number, number]>}
 */
export function shotsFor(store, slot = -1, limit = SHOT_MAX) {
  if (!store || !store.alive) return [];
  const out = [];
  const n = store.n ?? store.alive.length;
  for (let i = 0; i < n && out.length < limit; i++) {
    if (!store.alive[i]) continue;
    if (slot !== undefined && store.slot && store.slot[i] !== slot) continue;
    const kind = store.shape ? store.shape[i] : (store.kind ? store.kind[i] : 0);
    out.push([
      Math.round(store.x[i] * 100) / 100,
      Math.round(store.y[i] * 100) / 100,
      Math.round(store.z[i] * 100) / 100,
      Math.round((store.vx?.[i] ?? 0) * 100) / 100,
      Math.round((store.vy?.[i] ?? 0) * 100) / 100,
      Math.round((store.vz?.[i] ?? 0) * 100) / 100,
      Math.round(store.life[i] * 100) / 100,
      Math.round((store.rad?.[i] ?? 0.5) * 100) / 100,
      Math.round((store.dmg?.[i] ?? 1) * 10) / 10,
      kind,
    ]);
  }
  return out;
}

export class ShotSync {
  /**
   * @param {object} opts
   * @param {boolean} opts.host
   * @param {(ev: any[]) => void} opts.send
   * @param {object|(() => object)} [opts.projectiles]
   * @param {number} [opts.rate=SHOT_RATE]
   * @param {number} [opts.max=SHOT_MAX]
   */
  constructor({ host, send, projectiles = null, rate = SHOT_RATE, max = SHOT_MAX }) {
    this.host = !!host;
    this.send = send;
    this.projectiles = projectiles;
    this.rate = rate;
    this.max = max;
    this.timer = 0;
    this.ghosts = [];
    this.lastRows = null;
    this.lastSnapshot = null;
  }

  /** Host: periodic sample + broadcast. Guest: ignores. */
  tick(dt) {
    if (!this.host) return;
    this.timer += dt;
    if (this.timer < this.rate) return;
    this.timer = 0;
    const store = typeof this.projectiles === 'function' ? this.projectiles() : this.projectiles;
    if (!store) return;
    const rows = shotsFor(store, -1, this.max);
    this.send(['esn', rows]);
  }

  /** Guest: receive incoming projectile messages. */
  receive(ev) {
    if (!Array.isArray(ev)) return;
    if (ev[0] === 'esn') {
      const rows = ev[1];
      if (!Array.isArray(rows)) return;
      if (this.lastSnapshot === ev || this.lastRows === rows) return;
      this.lastSnapshot = ev;
      this.lastRows = rows;
      this.ghosts = rows.map((r) => ({
        x: r[0], y: r[1], z: r[2],
        vx: r[3], vy: r[4], vz: r[5],
        life: r[6], rad: r[7], dmg: r[8], kind: r[9],
      }));
      return;
    }
    if (ev[0] === 'esc') {
      this.clear();
      return;
    }
  }

  clear() {
    this.ghosts = [];
    this.lastRows = null;
    this.lastSnapshot = null;
  }
}
