// Unit tests for shared pickups + shared gold (net/pickups-sync-0.8.29.mjs).
// A host sync and one or two guest syncs talk over an in-memory link, using
// fake pickup stores shaped like the game's `sm` class.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PickupSync, storeWorld, ghostWorld, rowId, PICKUP_RATE } from './pickups-sync-0.8.29.mjs';

/** Minimal `sm`-shaped store. */
function fakeStore() {
  return {
    n: 0, count: 0, free: [],
    alive: new Uint8Array(2000), kind: new Uint8Array(2000),
    x: new Float32Array(2000), y: new Float32Array(2000), z: new Float32Array(2000),
    value: new Float32Array(2000),
    collected: [],
    spawn(kind, x, y, z, value) {
      let slot;
      if (this.free.length) slot = this.free.pop();
      else if (this.n < 2000) slot = this.n++;
      else return;
      this.alive[slot] = 1;
      this.kind[slot] = kind === 'xp' ? 0 : 1;
      this.x[slot] = x; this.y[slot] = y; this.z[slot] = z; this.value[slot] = value;
      this.count++;
    },
    collect(slot) {
      this.alive[slot] = 0;
      this.free.push(slot);
      this.count--;
      this.collected.push(slot);
    },
  };
}

function hostWith(store, gold) {
  const sent = [];
  const sync = new PickupSync({
    host: true,
    send: (ev, to) => sent.push({ ev, to }),
    world: storeWorld(store),
    gold: () => gold.value,
  });
  return { sync, sent };
}

function guestWith(store, gold) {
  const sent = [];
  const sync = new PickupSync({
    host: false,
    send: (ev, to) => sent.push({ ev, to }),
    world: ghostWorld(store),
    onGold: (g) => { gold.value = g; },
  });
  return { sync, sent };
}

test('host snapshots its pickups and party gold', () => {
  const store = fakeStore();
  store.spawn('coin', 4, 0.6, 8, 12);
  const gold = { value: 120 };
  const { sync, sent } = hostWith(store, gold);

  sync.tick(PICKUP_RATE);
  assert.equal(sent.length >= 1, true);
  const [pkp, gd] = sent.map((s) => s.ev);
  assert.equal(pkp[0], 'pkp');
  assert.deepEqual(pkp[1], [{ id: rowId(0, 1), kind: 1, x: 4, z: 8, value: 12 }]);
  assert.equal(pkp[2], 120);
  assert.deepEqual(gd, ['gd', 120]);
});

test('guest materialises ghosts from the snapshot and drops expired ones', () => {
  const hostStore = fakeStore();
  hostStore.spawn('coin', 4, 0.6, 8, 12);
  const gold = { value: 120 };
  const host = hostWith(hostStore, gold);
  const guestStore = fakeStore();
  const guest = guestWith(guestStore, gold);

  host.sync.tick(PICKUP_RATE);
  for (const { ev } of host.sent) guest.sync.receive(ev, 'H');
  assert.equal(guestStore.count, 1, 'ghost spawned locally');
  assert.equal(guestStore.kind[0], 1, 'coin kind preserved');
  assert.equal(gold.value, 120, 'guest shows the host gold total');

  // host loses the pickup (expired / merged) → next snapshot has no rows
  hostStore.alive[0] = 0; hostStore.count = 0;
  host.sent.length = 0;
  host.sync.tick(PICKUP_RATE);
  for (const { ev } of host.sent) guest.sync.receive(ev, 'H');
  assert.equal(guestStore.count, 0, 'ghost removed');
});

test('guest collect asks the host, which credits exactly once', () => {
  const hostStore = fakeStore();
  hostStore.spawn('coin', 1, 0.6, 1, 25);
  const gold = { value: 0 };
  const host = hostWith(hostStore, gold);
  const guestStore = fakeStore();
  const guest = guestWith(guestStore, gold);

  host.sync.tick(PICKUP_RATE);
  for (const { ev } of host.sent) guest.sync.receive(ev, 'H');
  host.sent.length = 0;

  // the guest touches its ghost: no local credit
  const allowed = guest.sync.guestCollect(0);
  assert.equal(allowed, false, 'guest never credits locally');
  assert.equal(guestStore.collected.length, 0, 'no local collect ran');
  assert.equal(guest.sent[0].ev[0], 'pki');
  assert.equal(guest.sent[0].to, 'host');

  // host applies the intent
  gold.value = 1000;
  for (const { ev, to } of guest.sent) host.sync.receive(ev, to === 'host' ? 'G' : to);
  assert.deepEqual(hostStore.collected, [0], 'host collected the real pickup');
  const pkr = host.sent.find((s) => s.ev[0] === 'pkr');
  assert.ok(pkr, 'removal broadcast');
  assert.equal(pkr.ev[1], rowId(0, 1));

  // a duplicate intent changes nothing
  host.sync.receive(['pki', rowId(0, 1)], 'G');
  assert.deepEqual(hostStore.collected, [0], 'still credited once');
});

test('two guests racing for the same pickup credit it once', () => {
  const hostStore = fakeStore();
  hostStore.spawn('coin', 2, 0.6, 2, 40);
  const gold = { value: 0 };
  const host = hostWith(hostStore, gold);
  const g1Store = fakeStore(), g2Store = fakeStore();
  const g1 = guestWith(g1Store, gold);
  const g2 = guestWith(g2Store, gold);

  host.sync.tick(PICKUP_RATE);
  for (const { ev } of host.sent) { g1.sync.receive(ev, 'H'); g2.sync.receive(ev, 'H'); }

  g1.sync.guestCollect(0);
  g2.sync.guestCollect(0);
  const id = rowId(0, 1);
  host.sync.receive(['pki', id], 'G1');
  host.sync.receive(['pki', id], 'G2');
  assert.deepEqual(hostStore.collected, [0], 'one credit only');
});

test('a native guest pickup (not shared) still credits locally', () => {
  const store = fakeStore();
  store.spawn('coin', 9, 0.6, 9, 5);
  const gold = { value: 0 };
  const guest = guestWith(store, gold);
  assert.equal(guest.sync.guestCollect(0), true, 'unknown to the ghost table → local credit');
  assert.equal(guest.sent.length, 0, 'no intent sent');
});

test('gold messages update the guest and are ignored by the host', () => {
  const gold = { value: 0 };
  const guest = guestWith(fakeStore(), gold);
  guest.sync.receive(['gd', 777], 'H');
  assert.equal(gold.value, 777);

  const host = hostWith(fakeStore(), gold);
  host.sync.receive(['gd', 5], 'G');
  assert.equal(gold.value, 777, 'host ignores guest gold');
});

test('tick is throttled to the snapshot rate', () => {
  const store = fakeStore();
  store.spawn('xp', 1, 0.6, 1, 3);
  const { sync, sent } = hostWith(store, { value: 0 });
  sync.tick(PICKUP_RATE / 2);
  assert.equal(sent.length, 0, 'nothing sent before the interval');
  sync.tick(PICKUP_RATE / 2 + 0.001);
  assert.equal(sent.length >= 1, true);
});
