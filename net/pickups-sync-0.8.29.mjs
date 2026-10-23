// net/pickups-sync-0.8.29.mjs — shared pickups + shared gold for the mvl14oup base.
//
// Upstream has no pickup replication: the pickup store (`sm`) has zero co-op
// references and no pickup field on any message, so coins/candy/balls exist only
// on the client whose world spawned them.
//
// Rule decided for this fork (plan F2): a guest may collect, the host credits.
//   host → all   ['pkp', rows, gold]   visible pickups + party gold
//   guest → host ['pki', hostId]       "I touched pickup X"
//   host → all   ['pkr', hostId]       X is gone (expired, collected, merged)
//   host → all   ['gd', gold]          party gold total
//
// Idempotency: the host keeps a `taken` set, so two guests racing for the same
// pickup credit it once. Every removal is broadcast, so ghosts disappear
// everywhere at the same time.

export const PICKUP_RATE = 1 / 5;   // 5 Hz snapshot cadence
export const PICKUP_NEAR = 70;      // metres around a guest
export const PICKUP_MAX = 200;      // rows per snapshot (matches the coin cap)

/** Stable id for a pickup row. The store reuses freed slots, so include the kind. */
export const rowId = (slot, kind) => slot * 8 + (kind & 7);

/**
 * Host-side view of a pickup store shaped like the game's `sm` class.
 * `rows()` returns the visible pickups with a stable id; `collect(id)` performs
 * the real collection so gold/XP are credited exactly once.
 */
export function storeWorld(store) {
  return {
    rows(limit = PICKUP_MAX) {
      const out = [];
      for (let i = 0; i < store.n && out.length < limit; i++) {
        if (!store.alive[i]) continue;
        out.push({
          id: rowId(i, store.kind[i]),
          kind: store.kind[i],
          x: Math.round(store.x[i] * 100) / 100,
          z: Math.round(store.z[i] * 100) / 100,
          value: Math.round(store.value[i] * 100) / 100,
        });
      }
      return out;
    },
    collect(id) {
      const slot = Math.floor(id / 8);
      if (!store.alive[slot]) return false;
      store.collect(slot);
      return true;
    },
  };
}

export class PickupSync {
  /**
   * @param {object} opts
   * @param {boolean} opts.host
   * @param {(ev: any[], to?: string) => void} opts.send
   * @param {object} opts.world   host: `storeWorld(store)`; guest: `ghostWorld(store)`
   * @param {() => number} [opts.gold]
   * @param {(total: number) => void} [opts.onGold]
   */
  constructor({ host, send, world, gold = () => 0, onGold = null }) {
    this.host = host;
    this.send = send;
    this.world = world;
    this.goldNow = gold;
    this.onGold = onGold;
    this.taken = new Set();     // host: ids already credited
    this.ghosts = new Map();    // guest: id -> local id
    this.sendT = 0;
    this.lastGold = -1;
  }

  /** Host: periodic snapshot + gold. Guest: ignores (the host is authoritative). */
  tick(dt) {
    if (!this.host) return;
    this.sendT += dt;
    if (this.sendT < PICKUP_RATE) return;
    this.sendT = 0;
    const rows = this.world.rows();
    const gold = this.goldNow();
    this.send(['pkp', rows, gold]);
    if (gold !== this.lastGold) {
      this.lastGold = gold;
      this.send(['gd', gold]);
    }
  }

  /** Any: a message from the transport. */
  receive(ev, from) {
    if (!Array.isArray(ev)) return;
    switch (ev[0]) {
      case 'pkp':
        if (this.host) return;
        this.applySnapshot(ev[1], ev[2]);
        break;
      case 'pkr':
        if (this.host) return;
        this.removeGhost(ev[1]);
        break;
      case 'gd':
        if (this.host) return;
        if (this.onGold) this.onGold(ev[1]);
        break;
      case 'pki':
        if (this.host) this.take(ev[1]);
        break;
    }
  }

  /** Host: a peer asked for a pickup. Credits once, then tells everyone. */
  take(id) {
    if (!this.host || this.taken.has(id)) return false;
    this.taken.add(id);
    const ok = this.world.collect(id);
    this.send(['pkr', id]);
    if (ok) {
      const gold = this.goldNow();
      this.lastGold = gold;
      this.send(['gd', gold]);
    }
    return ok;
  }

  /**
   * Guest: called from the patched collect path when the local player touches a
   * pickup. Returns false so the guest never credits gold itself.
   */
  guestCollect(localId) {
    if (this.host) return true;
    const hostId = this.hostIdOf(localId);
    // Not a shared pickup (e.g. a bag reward spawned locally): let it credit.
    if (hostId === null) return true;
    this.send(['pki', hostId], 'host');
    this.removeGhost(hostId);   // optimistic: the host's pkr confirms it
    return false;
  }

  hostIdOf(localId) {
    for (const [hostId, local] of this.ghosts) if (local === localId) return hostId;
    return null;
  }

  applySnapshot(rows, gold) {
    if (!Array.isArray(rows)) return;
    const seen = new Set();
    for (const row of rows) {
      if (!row || typeof row.id !== 'number') continue;
      seen.add(row.id);
      if (this.ghosts.has(row.id)) continue;
      const local = this.world.spawnGhost(row);
      if (local !== null && local !== undefined) this.ghosts.set(row.id, local);
    }
    for (const id of [...this.ghosts.keys()]) {
      if (!seen.has(id)) this.removeGhost(id);
    }
    if (typeof gold === 'number' && this.onGold) this.onGold(gold);
  }

  removeGhost(hostId) {
    if (hostId === null || hostId === undefined) return;
    const local = this.ghosts.get(hostId);
    if (local === undefined) return;
    this.ghosts.delete(hostId);
    this.world.removeGhost(local);
  }

  clear() {
    for (const id of [...this.ghosts.keys()]) this.removeGhost(id);
    this.taken.clear();
  }
}

/**
 * Guest-side view of the same store: materialises a real local pickup (so it
 * attracts, renders and animates like any other) and tracks the mapping.
 *
 * `spawn(kindName, x, y, z, value)` mirrors the game's `sm.spawn`, which returns
 * nothing, so the new slot is located by scanning after the call.
 */
export function ghostWorld(store, kinds = ['xp', 'coin']) {
  return {
    spawnGhost(row) {
      const before = store.n;
      store.spawn(kinds[row.kind] || 'coin', row.x, 0.6, row.z, row.value);
      if (store.n === before) {
        for (let i = 0; i < store.n; i++) {
          if (store.alive[i] && store.kind[i] === row.kind) return i;
        }
        return null;
      }
      for (let i = before; i < store.n; i++) if (store.alive[i]) return i;
      return null;
    },
    removeGhost(local) {
      if (local === null || local === undefined) return;
      if (!store.alive[local]) return;
      store.alive[local] = 0;
      store.count = Math.max(0, store.count - 1);
      store.free.push(local);
    },
  };
}
