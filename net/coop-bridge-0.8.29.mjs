// net/coop-bridge-0.8.29.mjs — the `globalThis.__pbCoop` bridge for the mvl14oup base.
//
// The bundle patches in tools/bundle-patches-0.8.29.mjs only call into this object;
// they never touch game logic. Everything here is plain JS, so the party-wide
// level-up barrier is testable without a browser.
//
// Patched call sites (see tools/bundle-patches-0.8.29.mjs):
//   openLevel(run, open)   end of the level-up routine — hands the stock opener in
//   localPicked(run)       in the card callback's `finally` — every confirm path
//
// Roles (`docs/upstream-coop-protocol-diff.md` §6.1):
//   host    announces the level, then opens its own card
//   guest   stashes the opener; the card opens only when the host's `lu` arrives
//   no session — the opener runs immediately, exactly like stock
//
// Transport is injected: `attachSession({ send })` wires the barrier to whatever
// channel the fork uses, and the fork feeds incoming messages back through
// `receive(ev, from)`.

import { LevelBarrier } from './level-barrier.mjs';
import { PickupSync, storeWorld, ghostWorld } from './pickups-sync-0.8.29.mjs';
import { ShotSync } from './coop-shots-0.8.29.mjs';

export const BRIDGE_KEY = '__pbCoop';

/** Run fields the barrier writes when the party resumes. */
export const RUN_FIELDS = Object.freeze({
  pending: 'pendingLevels',
  state: 'state',
  playing: 'play',
});

function resumeRun(run) {
  if (!run) return;
  if (typeof run.ui?.hideModal === 'function') run.ui.hideModal();
  run[RUN_FIELDS.pending] = 0;
  run[RUN_FIELDS.state] = RUN_FIELDS.playing;
  if (typeof run.resume === 'function') run.resume();
}

/**
 * Creates the bridge and installs it on `target` (default `globalThis`).
 *
 * @param {object} [opts]
 * @param {object} [opts.target]        object to receive the bridge (tests pass a plain object)
 * @param {(names: string[]) => void} [opts.onWaiting]  HUD hook for the waiting list
 */
export function installBridge({ target = globalThis, onWaiting = null } = {}) {
  let barrier = null;
  let pickups = null;
  let shots = null;
  let run = null;
  let opener = null;
  let cardWaiting = false;
  let waitingNames = [];

  const api = {
    /** True while a session owns level-ups and this client is not the host. */
    isGuest() {
      return !!barrier && !barrier.host;
    },
    /** True when a co-op session owns level-ups. */
    active() {
      return !!barrier;
    },
    /**
     * True for a guest in a co-op session: the host owns the wave director, so
     * guests must not spawn monsters of their own (one shared world).
     */
    skipSpawns() {
      return !!barrier && !barrier.host;
    },
    /** The current waiting list, for a HUD that polls instead of subscribing. */
    waiting() {
      return waitingNames.slice();
    },
    /** The run object, learned from a patched call or an explicit bind. */
    bind(currentRun) {
      if (currentRun) run = currentRun;
      return api;
    },
    run() {
      return run;
    },

    /**
     * Attach the co-op session. `send(ev, to?)` publishes barrier messages;
     * the fork calls `receive(ev, from)` for messages it receives.
     *
     * Passing `net` (net/net.mjs) instead of `send` uses `broadcast` for party
     * messages and `send(hostUid, …)` for guest picks.
     */
    attachSession({ host, me, members = [], send = null, net = null, nameOf = null }) {
      const publish = send || ((ev, to) => {
        if (!net) return;
        // `'host'` is the barrier's sentinel; net.mjs addresses the host by uid.
        if (to === 'host') net.toHost(ev);
        else if (to) net.send(to, ev);
        else net.broadcast(ev);
      });
      barrier = new LevelBarrier({
        host,
        me,
        members,
        send: publish,
        nameOf: nameOf || ((uid) => uid),
        onOpen: (level) => {
          if (barrier.host) return; // host opens its own card in openLevel()
          if (opener) {
            const open = opener;
            opener = null;
            open();
            return;
          }
          cardWaiting = true; // `lu` beat the guest's local level-up
        },
        onResume: () => {
          opener = null;
          cardWaiting = false;
          resumeRun(run);
        },
        onWaiting: (names) => {
          waitingNames = names.slice();
          if (onWaiting) onWaiting(waitingNames);
        },
      });
      return api;
    },

    /**
     * Attach shared pickups + shared gold to the current session.
     * Host: publishes its store and credits every accepted intent.
     * Guest: materialises ghosts and asks the host for every pickup it touches.
     */
    attachPickups({ store, kinds = ['xp', 'coin'], run: currentRun = null }) {
      if (!barrier || !store) return api;
      if (currentRun) run = currentRun;
      pickups = new PickupSync({
        host: barrier.host,
        send: (ev, to) => barrier.send(ev, to),
        world: barrier.host ? storeWorld(store) : ghostWorld(store, kinds),
        gold: () => run?.gold ?? 0,
        onGold: (total) => {
          if (run) run.gold = total;
        },
      });
      return api;
    },
    /** True while shared pickups are attached. */
    pickupsActive() {
      return !!pickups;
    },
    /**
     * Patched call site: the local player is about to collect a pickup.
     * Returns false when a guest must not credit it locally (the host will).
     */
    pickupCollected(_run, store, slot) {
      if (!pickups) return true;
      if (pickups.host) return true;
      // A guest's local ghost slot doubles as the mapping key.
      return pickups.guestCollect(slot);
    },
    /** Per-frame hook: drives the host snapshot cadence. */
    tick(currentRun, dt) {
      if (currentRun) run = currentRun;
      if (pickups) pickups.tick(dt);
    },

    /** Attach enemy projectile replication. */
    attachShots({ projectiles, run: currentRun = null }) {
      if (!barrier || !projectiles) return api;
      if (currentRun) run = currentRun;
      shots = new ShotSync({
        host: barrier.host,
        send: (ev) => barrier.send(ev),
        projectiles,
      });
      return api;
    },
    shotsActive() {
      return !!shots;
    },
    tickShots(currentRun, dt) {
      if (currentRun) run = currentRun;
      if (shots) shots.tick(dt);
    },

    /**
     * Broadcasts authoritative damage number from host to peers.
     * Guests render via run.ui.popup().
     */
    damageNumber(currentRun, x, y, z, dmg, color = '#ffffff') {
      if (currentRun) run = currentRun;
      if (!barrier || !barrier.host) return;
      if (!dmg || dmg <= 0) return;
      const roundedDmg = Math.round(dmg * 10) / 10;
      barrier.send([
        'hn',
        Math.round(x * 100) / 100,
        Math.round(y * 100) / 100,
        Math.round(z * 100) / 100,
        roundedDmg,
        color || '#ffffff',
      ]);
    },

    /** Detach (and clear) the session. */
    detach() {
      pickups?.clear();
      pickups = null;
      shots?.clear();
      shots = null;
      barrier = null;
      opener = null;
      cardWaiting = false;
      waitingNames = [];
      return api;
    },

    /** Transport entry point: a co-op message arrived. */
    receive(ev, from) {
      if (ev && typeof ev === 'object' && !Array.isArray(ev) && ev.t === 'pb' && Array.isArray(ev.l)) {
        ev = ev.l;
      }
      if (!Array.isArray(ev)) return;
      if (ev[0] === 'pkp' || ev[0] === 'pkr' || ev[0] === 'pki' || ev[0] === 'gd') {
        pickups?.receive(ev, from);
        return;
      }
      if (ev[0] === 'esn' || ev[0] === 'esc') {
        shots?.receive(ev);
        return;
      }
      if (ev[0] === 'hn') {
        const [, x, y, z, dmg, color] = ev;
        if (run && run.ui && typeof run.ui.popup === 'function') {
          run.ui.popup(x, y, z, String(dmg), color || '#ffffff', 0.9);
        }
        return;
      }
      if (barrier) barrier.receive(ev, from);
    },

    /**
     * Subscribe the bridge to net/net.mjs. Barrier messages are bare arrays;
     * frame objects (`{k:'f'}` etc.) are left for the rest of the co-op layer.
     */
    bindNet(net) {
      net.on((from, msg) => {
        if (Array.isArray(msg)) api.receive(msg, from);
      });
      return api;
    },

    /** A party member left; releases it so the barrier cannot stall. */
    leave(uid) {
      barrier?.leave(uid);
    },

    /**
     * Patched call site: the stock routine is about to open the local card.
     * Host: announce, then open. Guest: stash and wait for `lu`.
     * No session: open exactly as stock does.
     */
    openLevel(currentRun, open) {
      if (currentRun) run = currentRun;
      if (!barrier) {
        open();
        return;
      }
      if (barrier.host) {
        barrier.start(run?.player?.level ?? 1);
        open();
        return;
      }
      opener = open;
      if (cardWaiting) {
        cardWaiting = false;
        const staged = opener;
        opener = null;
        staged();
      }
    },

    /** Patched call site: the local card was confirmed (pick/reroll/banish/skip). */
    localPicked(currentRun) {
      if (currentRun) run = currentRun;
      barrier?.localPicked();
    },

    /** Test/teardown helper: forget session and run. */
    reset() {
      pickups?.clear();
      pickups = null;
      shots?.clear();
      shots = null;
      barrier = null;
      run = null;
      opener = null;
      cardWaiting = false;
      waitingNames = [];
    },
  };

  target[BRIDGE_KEY] = api;
  return api;
}
