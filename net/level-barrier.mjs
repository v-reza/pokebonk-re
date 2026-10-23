// net/level-barrier.mjs — the party-wide level-up gate, transport-agnostic.
//
// This is the behaviour the fork keeps instead of upstream's per-player cards
// (docs/upstream-coop-protocol-diff.md §6.1), factored out of `Coop` so the
// 0.8.29 base can use it without dragging in the whole star-topology session.
//
// Wire (identical to net/coop.mjs, so both sides interoperate):
//   host → all   ['lu', level, seq]   a level-up started; open your card
//   host → all   ['lw', [names]]      who the party is still waiting on
//   host → all   ['lr']               everybody picked; resume
//   guest → host ['lp']               I picked my card
//
// Invariants:
//   * host-only ownership — a guest never starts or releases the barrier
//   * per-player owed counters — two queued level-ups cannot be cleared by one pick
//   * a member that disconnects while owed is released, or the party stalls forever

export class LevelBarrier {
  /**
   * @param {object} opts
   * @param {boolean} opts.host            this client owns the barrier
   * @param {string}  opts.me              own uid
   * @param {string[]} [opts.members]      uids in the party (host side)
   * @param {(ev: any[], to?: string) => void} opts.send  transport
   * @param {(names: string[]) => void} [opts.onWaiting]
   * @param {(level: number) => void} [opts.onOpen]
   * @param {() => void} [opts.onResume]
   * @param {(uid: string) => string} [opts.nameOf]
   */
  constructor(opts) {
    this.host = !!opts.host;
    this.me = opts.me;
    this.send = opts.send;
    this.onWaiting = opts.onWaiting || (() => {});
    this.onOpen = opts.onOpen || (() => {});
    this.onResume = opts.onResume || (() => {});
    this.nameOf = opts.nameOf || ((uid) => uid);
    this.owed = new Map();     // uid -> cards still owed
    this.waiting = new Set();
    this.seq = 0;
    this.level = 0;
    this.open = false;
    this.attachMembers(opts.members || []);
  }

  /** Host: refresh the member list (join/leave). */
  attachMembers(members) {
    if (!this.host) return;
    this.members = new Set(members);
    for (const uid of this.waiting) {
      if (!this.members.has(uid)) this.release(uid);
    }
  }

  /** Host: a member left. Releases it so the party cannot stall on it. */
  leave(uid) {
    if (!this.host) return;
    this.members.delete(uid);
    if (this.waiting.has(uid)) this.release(uid);
  }

  /** Host: a level-up started. Announces and waits for every attached member. */
  start(level) {
    if (!this.host) return;
    this.open = true;
    this.level = level;
    for (const uid of this.members) this.owed.set(uid, (this.owed.get(uid) || 0) + 1);
    if (!this.members.has(this.me)) this.owed.set(this.me, (this.owed.get(this.me) || 0) + 1);
    for (const uid of this.owed.keys()) this.waiting.add(uid);
    this.seq++;
    this.send(['lu', level, this.seq]);
    // Same order as net/coop.mjs (and therefore what a guest observes): the card
    // opens first, then the waiting list renders.
    this.onOpen(level);
    this.announce();
  }

  /** Host: one card was picked by `uid`. */
  pick(uid) {
    if (!this.host || !this.owed.has(uid)) return;
    const left = this.owed.get(uid) - 1;
    if (left > 0) {
      this.owed.set(uid, left);
      return;
    }
    this.owed.delete(uid);
    this.release(uid);
  }

  /** Both: the local player confirmed its card. */
  localPicked() {
    if (this.host) this.pick(this.me);
    else this.send(['lp'], 'host');
  }

  /** Any: a message arrived from the transport. */
  receive(ev, from) {
    if (!Array.isArray(ev)) return;
    switch (ev[0]) {
      case 'lu':
        if (this.host) return;               // host authored it
        this.open = true;
        this.level = ev[1];
        this.onOpen(ev[1]);
        break;
      case 'lw':
        if (this.host) return;
        this.onWaiting(Array.isArray(ev[1]) ? ev[1] : []);
        break;
      case 'lr':
        if (this.host) return;
        this.open = false;
        this.onResume();
        break;
      case 'lp':
        if (this.host && from) this.pick(from);
        break;
    }
  }

  release(uid) {
    this.waiting.delete(uid);
    if (this.waiting.size) {
      this.announce();
      return;
    }
    this.owed.clear();
    this.open = false;
    this.send(['lr']);
    this.onResume();
  }

  announce() {
    const names = [...this.waiting].map((uid) => this.nameOf(uid));
    this.send(['lw', names]);
    this.onWaiting(names);
  }
}
